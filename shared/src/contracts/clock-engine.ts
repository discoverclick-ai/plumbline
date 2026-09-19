import type { Db } from '../db.js'
import { withTenant } from '../db.js'
import { RecordKernel, type Actor } from '../kernel.js'
import {
  computeDeadline,
  warnAt,
  type DurationUnit,
  type ProjectCalendar,
  DEFAULT_CALENDAR,
} from './calendar.js'

/**
 * The clock engine.
 *
 * Reads the event log forward from a durable cursor, matches each event
 * against the accepted obligations on its project, and where one matches,
 * starts a clock: an `obligation_clocks` row plus a `notice` record sitting in
 * `watching` with the computed deadline on it.
 *
 * Three things this deliberately does not do.
 *
 * It does not put the notice in anybody's court at fire time. A system that
 * filled a PM's queue with speculative notices would be ignored inside a
 * week, and an ignored warning is worse than none because it trains people to
 * dismiss the real one. Promotion happens when a human confirms the trigger
 * or when the warning time arrives, whichever is first, and the automatic
 * half is what stops an unconfirmed clock expiring quietly.
 *
 * It does not send anything. Issuing a notice is a human transition, always.
 *
 * And it does not recompute. Every deadline is frozen with the arithmetic
 * that produced it at the moment it was produced, because holidays get edited
 * and work weeks get corrected, and the deadline somebody served against has
 * to stay the one the system actually showed them.
 *
 * Runs on an operator connection across every tenant, like the notification
 * and posting workers, because a cursor over a global log is a global thing.
 */

export interface FireResult {
  scanned: number
  started: number
  /** Matched an obligation but could not start, with the reason. */
  skipped: { eventId: number; obligationId: string; reason: string }[]
}

export interface PromotionResult {
  promoted: number
  expired: number
}

interface EventRow {
  id: string
  tenant_id: string
  project_id: string
  record_id: string
  type_key: string
  event: string
  payload: Record<string, unknown>
  actor_user_id: string | null
  occurred_at: Date
}

interface ObligationRow {
  id: string
  project_id: string
  document_id: string
  clause_id: string
  clause_number: string | null
  quote: string
  obligation_type: string
  trigger_match: Record<string, unknown>
  trigger_description: string
  duration_value: number
  duration_unit: DurationUnit
  deadline_basis: string
  counts_start_day: boolean
  rolls_forward: boolean
  consequence: string
}

export class ClockEngine {
  private readonly kernel: RecordKernel

  constructor(private readonly db: Db) {
    this.kernel = new RecordKernel(db)
  }

  async fire(limit = 500): Promise<FireResult> {
    const { rows: cursorRows } = await this.db.query<{ last_event_id: string }>(
      'SELECT last_event_id FROM clock_engine_cursor WHERE id = 1',
    )
    const cursor = Number(cursorRows[0]?.last_event_id ?? 0)

    const { rows: events } = await this.db.query<EventRow>(
      `SELECT id, tenant_id, project_id, record_id, type_key, event, payload, actor_user_id, occurred_at
         FROM record_events WHERE id > $1 ORDER BY id LIMIT $2`,
      [cursor, limit],
    )

    const result: FireResult = { scanned: events.length, started: 0, skipped: [] }
    let highest = cursor

    for (const event of events) {
      highest = Math.max(highest, Number(event.id))
      // A notice's own events must never start clocks. Without this a notice
      // that matches a notice-of-claim trigger spawns another notice, and the
      // engine writes itself an infinite queue overnight.
      if (event.type_key === 'notice') continue

      const obligations = await this.matching(event)
      for (const obligation of obligations) {
        try {
          const started = await this.start(event, obligation)
          if (started) result.started += 1
        } catch (err) {
          // Loud, and the cursor still advances. A clock that failed to start
          // is a gap somebody has to see; a worker that retries the same
          // failing event forever is a gap nobody ever sees.
          result.skipped.push({
            eventId: Number(event.id),
            obligationId: obligation.id,
            reason: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    if (highest > cursor) {
      await this.db.query('UPDATE clock_engine_cursor SET last_event_id = $1, updated_at = now() WHERE id = 1', [
        highest,
      ])
    }
    return result
  }

  /**
   * Which accepted obligations this event satisfies.
   *
   * The match is `{type_key, event}` against the event log, plus an optional
   * `to` for transitions, so an obligation can fire on "an observation was
   * raised" or on "a change event reached executed" without the engine
   * knowing anything about either record type.
   */
  private async matching(event: EventRow): Promise<ObligationRow[]> {
    const { rows } = await this.db.query<ObligationRow>(
      `SELECT o.id, o.project_id, o.document_id, o.clause_id, c.clause_number, o.quote,
              o.obligation_type::text AS obligation_type, o.trigger_match, o.trigger_description,
              o.duration_value, o.duration_unit::text AS duration_unit,
              o.deadline_basis::text AS deadline_basis,
              o.counts_start_day, o.rolls_forward, o.consequence::text AS consequence
         FROM contract_obligations o
         JOIN contract_clauses c ON c.id = o.clause_id
        WHERE o.tenant_id = $1 AND o.project_id = $2
          AND o.status = 'accepted' AND o.trigger_kind = 'record_event'
          AND o.trigger_match @> $3::jsonb`,
      [event.tenant_id, event.project_id, JSON.stringify({ type_key: event.type_key, event: event.event })],
    )

    // `to` is checked here rather than in the containment query because the
    // kernel writes it into the payload, not into a column, and an obligation
    // that does not care about it must still match.
    return rows.filter((o) => {
      const wanted = o.trigger_match['to']
      if (wanted === undefined || wanted === null) return true
      return event.payload['to'] === wanted
    })
  }

  private async start(event: EventRow, obligation: ObligationRow): Promise<boolean> {
    const calendar = await this.calendarFor(event.tenant_id, event.project_id)

    // Awareness, when the contract measures from it, is the earliest moment we
    // can prove we knew. The event that raised the record IS that moment: a
    // timestamped note from the field is a stronger evidentiary position than
    // most contractors can construct after the fact. Where the two differ the
    // engine takes the earlier, because a later start date is a later
    // deadline, and a late deadline is the failure this exists to prevent.
    const occurredAt = event.occurred_at
    const awarenessAt = await this.awarenessFor(event)
    const startedAt =
      obligation.deadline_basis === 'from_awareness' && awarenessAt
        ? awarenessAt < occurredAt
          ? awarenessAt
          : occurredAt
        : occurredAt

    const { dueAt, computation } = computeDeadline({
      startedAt,
      value: obligation.duration_value,
      unit: obligation.duration_unit,
      calendar,
      countStartDay: obligation.counts_start_day,
      rollForward: obligation.rolls_forward,
    })
    const warn = warnAt(startedAt, dueAt, calendar)

    // The clock row goes in FIRST, before the notice record exists.
    //
    // The other order is the obvious one and it is wrong: creating the notice
    // and then hitting the idempotency conflict leaves an orphan notice
    // behind on every replay, so a cursor reset would quietly fill a project
    // with duplicate drafts nobody raised. Winning the insert is what earns
    // the right to create a record.
    const won = await withTenant(this.db, event.tenant_id, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO obligation_clocks
           (tenant_id, project_id, obligation_id, triggering_event_id, triggering_record_id,
            occurred_at, awareness_at, started_at, due_at, warn_at, computation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         ON CONFLICT (obligation_id, triggering_event_id) WHERE triggering_event_id IS NOT NULL
           DO NOTHING
         RETURNING id`,
        [
          event.tenant_id,
          event.project_id,
          obligation.id,
          Number(event.id),
          event.record_id,
          occurredAt,
          awarenessAt,
          startedAt,
          dueAt,
          warn,
          JSON.stringify({
            ...computation,
            obligationType: obligation.obligation_type,
            deadlineBasis: obligation.deadline_basis,
            consequence: obligation.consequence,
            clauseNumber: obligation.clause_number,
            quote: obligation.quote,
            triggeredBy: { eventId: Number(event.id), typeKey: event.type_key, event: event.event },
          }),
        ],
      )
      return rows[0]?.id ?? null
    })

    // Replay is normal: a cursor reset re-reads the log, and this is what
    // makes that safe rather than duplicating every notice on the job.
    if (!won) return false

    const { drafter: actor, approver } = await this.holdersFor(event)
    if (!actor) {
      // The clock still exists and still counts down. A project with nobody
      // who may raise a notice is a configuration problem, and burying it
      // would mean the deadline passes with nothing on any screen.
      await withTenant(this.db, event.tenant_id, (tx) =>
        tx.query(
          `UPDATE obligation_clocks
              SET computation = computation || jsonb_build_object('warning', $2::text), updated_at = now()
            WHERE id = $1`,
          [
            won,
            'No user on this project may raise a notice, so this clock has no record behind it. Grant somebody the notices tool.',
          ],
        ),
      )
      return true
    }

    const view = await this.kernel.create(actor, {
      projectId: event.project_id,
      typeKey: 'notice',
      title: this.titleFor(obligation),
      body: {
        notice_type: NOTICE_TYPE_BY_OBLIGATION[obligation.obligation_type] ?? 'Other',
        clause_reference: obligation.clause_number ?? 'See contract',
        addressed_to: 'To be confirmed',
        event_date: civilOf(occurredAt),
        ...(awarenessAt ? { awareness_date: civilOf(awarenessAt) } : {}),
        description: `${obligation.trigger_description}\n\nTriggered by ${event.type_key} ${event.record_id}.\n\nThe contract says, at ${obligation.clause_number ?? 'the cited clause'}:\n\n"${obligation.quote}"`,
      },
      // Both roles are filled at creation. A notice raised with nobody to
      // approve it is a draft that can never be served, which on a five day
      // window is the same outcome as never raising it. On a small job these
      // are the same person, and that is fine: the `issue` privilege is what
      // separates drafting from serving, not the ball.
      participants: [
        { userId: actor.userId, role: 'assignee' as const },
        { userId: approver ?? actor.userId, role: 'approver' as const },
      ],
    })

    await withTenant(this.db, event.tenant_id, (tx) =>
      tx.query('UPDATE obligation_clocks SET notice_record_id = $2, updated_at = now() WHERE id = $1', [
        won,
        view.record.id,
      ]),
    )
    return true
  }

  /**
   * Moves clocks into somebody's court, and marks the ones that ran out.
   *
   * The promotion is the safety net. A clock nobody confirmed still lands on
   * a desk before it matters, which is the difference between this and a
   * report somebody reads on a Friday.
   */
  async promote(now: Date = new Date()): Promise<PromotionResult> {
    const { rows } = await this.db.query<{
      id: string
      tenant_id: string
      notice_record_id: string | null
      due_at: Date
      warn_at: Date
      state: string
      obligation_type: string
      clause_number: string | null
    }>(
      `SELECT k.id, k.tenant_id, k.notice_record_id, k.due_at, k.warn_at, k.state::text AS state,
              o.obligation_type::text AS obligation_type, c.clause_number
         FROM obligation_clocks k
         JOIN contract_obligations o ON o.id = k.obligation_id
         JOIN contract_clauses c ON c.id = o.clause_id
        WHERE k.state IN ('watching', 'in_court')
          AND (k.warn_at <= $1 OR k.due_at <= $1)
        ORDER BY k.due_at`,
      [now],
    )

    const result: PromotionResult = { promoted: 0, expired: 0 }

    for (const clock of rows) {
      if (clock.due_at <= now) {
        // Expired. Never deleted and never auto-closed: the fact that a
        // deadline passed unanswered is itself evidence, and a system that
        // tidied it away would be destroying the record of its own failure.
        await this.db.query(
          `UPDATE obligation_clocks SET state = 'expired', updated_at = now() WHERE id = $1 AND state <> 'expired'`,
          [clock.id],
        )
        result.expired += 1
        continue
      }

      if (clock.state !== 'watching') continue

      await withTenant(this.db, clock.tenant_id, async (tx) => {
        await tx.query(
          `UPDATE obligation_clocks SET state = 'in_court', promoted_at = now(), updated_at = now() WHERE id = $1`,
          [clock.id],
        )
        if (!clock.notice_record_id) return
        // The deadline goes onto the assignment the record already has. The
        // notice does not move state: it is still a draft nobody has written.
        // What changes is that it is now due, and the screens that show
        // overdue work already exist.
        await tx.query(
          `UPDATE record_assignments
              SET due_at = $2,
                  expected_action = $3
            WHERE record_id = $1 AND released_at IS NULL`,
          [
            clock.notice_record_id,
            clock.due_at,
            `Give written notice under ${clock.clause_number ?? 'the contract'} or record why none is required`,
          ],
        )
      })
      result.promoted += 1
    }

    return result
  }

  /**
   * Discharge: a notice that reached `issued` satisfies its clock.
   *
   * Read from the event log rather than hooked into the kernel, for the same
   * reason the posting worker is: the kernel does not learn about contracts,
   * and a seam that is a log survives a replay.
   */
  async reconcile(): Promise<{ satisfied: number; stoodDown: number }> {
    const { rows } = await this.db.query<{ id: string; record_id: string; to: string }>(
      `SELECT k.id, k.notice_record_id AS record_id, r.status AS to
         FROM obligation_clocks k
         JOIN records r ON r.id = k.notice_record_id
        WHERE k.state IN ('watching', 'in_court', 'expired')
          AND r.status IN ('issued', 'acknowledged', 'not_required')`,
    )

    let satisfied = 0
    let stoodDown = 0
    for (const row of rows) {
      const state = row.to === 'not_required' ? 'waived' : 'satisfied'
      // A stood-down clock keeps its reason on the notice record, which is
      // where a person wrote it. Copying it here would let the two drift.
      await this.db.query(
        `UPDATE obligation_clocks
            SET state = $2::clock_state, satisfied_at = now(), satisfied_by_record_id = $3, updated_at = now()
          WHERE id = $1`,
        [row.id, state, row.record_id],
      )
      if (state === 'satisfied') satisfied += 1
      else stoodDown += 1
    }
    return { satisfied, stoodDown }
  }

  private async calendarFor(tenantId: string, projectId: string): Promise<ProjectCalendar> {
    const { rows } = await this.db.query<{ work_days: number[]; time_zone: string }>(
      'SELECT work_days, time_zone FROM project_calendars WHERE tenant_id = $1 AND project_id = $2',
      [tenantId, projectId],
    )
    const { rows: holidays } = await this.db.query<{ observed_on: string }>(
      `SELECT to_char(observed_on, 'YYYY-MM-DD') AS observed_on
         FROM project_holidays WHERE tenant_id = $1 AND project_id = $2`,
      [tenantId, projectId],
    )
    const row = rows[0]
    return {
      workDays: row?.work_days ?? DEFAULT_CALENDAR.workDays,
      timeZone: row?.time_zone ?? DEFAULT_CALENDAR.timeZone,
      holidays: holidays.map((h) => h.observed_on),
    }
  }

  /**
   * The earliest timestamped evidence that we knew.
   *
   * The capture signal behind the triggering record, when there is one. This
   * is the argument for the whole product in one query: a contractor who can
   * show a geotagged photograph timed to the hour is in a position no
   * reconstruction eighteen months later can reach.
   */
  private async awarenessFor(event: EventRow): Promise<Date | null> {
    // captured_at, not created_at. A phone in a basement uploads hours later
    // and the difference is routinely the whole notice window on a short
    // clause; counting from the upload would hand away days we can prove we
    // did not have.
    const { rows } = await this.db.query<{ captured_at: Date | null }>(
      `SELECT min(c.captured_at) AS captured_at
         FROM captures c
         JOIN capture_proposals p ON p.capture_id = c.id
        WHERE c.tenant_id = $1 AND p.record_id = $2`,
      [event.tenant_id, event.record_id],
    )
    return rows[0]?.captured_at ?? null
  }

  /**
   * Who the notice is raised as.
   *
   * The person whose action started the clock, when they may raise a notice;
   * otherwise anybody on the project who may. Never a service account: a
   * record with no person behind it is one the permission model cannot reason
   * about, and this system has exactly one rule it will not bend.
   */
  private async holdersFor(event: EventRow): Promise<{ drafter: Actor | null; approver: string | null }> {
    const { rows } = await this.db.query<{ user_id: string; may_issue: boolean }>(
      `SELECT DISTINCT m.user_id,
              EXISTS (SELECT 1 FROM template_granular_permissions g
                       WHERE g.template_id = t.id AND g.tool_key = 'notices' AND g.privilege = 'issue')
                AS may_issue
         FROM project_memberships m
         JOIN permission_templates t ON t.id = m.permission_template_id
         JOIN template_tool_permissions p ON p.template_id = t.id
        WHERE m.tenant_id = $1 AND m.project_id = $2
          AND p.tool_key = 'notices' AND p.level IN ('standard', 'admin')
        ORDER BY m.user_id`,
      [event.tenant_id, event.project_id],
    )
    if (rows.length === 0) return { drafter: null, approver: null }

    const eligible = rows.map((r) => r.user_id)
    // The person whose action started the clock drafts it, when they may.
    // They were there; they know what happened.
    const drafterId =
      event.actor_user_id && eligible.includes(event.actor_user_id) ? event.actor_user_id : eligible[0]!
    const approver = rows.find((r) => r.may_issue && r.user_id !== drafterId)?.user_id ?? null

    return { drafter: { tenantId: event.tenant_id, userId: drafterId }, approver }
  }

  private titleFor(obligation: ObligationRow): string {
    const label = OBLIGATION_LABELS[obligation.obligation_type] ?? 'Contract notice'
    return obligation.clause_number ? `${label} (${obligation.clause_number})` : label
  }
}

const OBLIGATION_LABELS: Record<string, string> = {
  notice_of_delay: 'Notice of delay',
  notice_of_change: 'Notice of a change in the work',
  notice_of_claim: 'Notice of claim',
  differing_site_conditions: 'Notice of differing site conditions',
  weather_day: 'Notice of a weather day',
  cure_period: 'Notice to cure',
  submittal_turnaround: 'Submittal turnaround',
  rfi_response_time: 'RFI response time',
  payment_application_window: 'Payment application window',
  payment_due: 'Payment due',
  retainage_release: 'Retainage release',
  substantial_completion: 'Substantial completion',
  liquidated_damages: 'Liquidated damages',
  insurance_certificate: 'Insurance certificate',
  safety_reporting: 'Safety reporting',
  closeout_submission: 'Closeout submission',
}

/** Obligation types to the vocabulary the notice record type already uses. */
const NOTICE_TYPE_BY_OBLIGATION: Record<string, string> = {
  notice_of_delay: 'Delay',
  notice_of_change: 'Change in the Work',
  notice_of_claim: 'Claim',
  differing_site_conditions: 'Differing Site Conditions',
  weather_day: 'Weather Day',
  cure_period: 'Cure',
}

function civilOf(at: Date): string {
  return at.toISOString().slice(0, 10)
}
