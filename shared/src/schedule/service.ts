import { withTenant, type Db } from '../db.js'
import { NotFoundError, PermissionDeniedError, ValidationError } from '../errors.js'
import type { Actor } from '../kernel.js'
import { hasLevel, hasPrivilege } from '../permissions.js'
import { loadAccess } from '../repositories/permissions.js'
import { activitiesFromXer, parseXer, type ImportedActivity, type ImportedSchedule } from './xer.js'

/**
 * The schedule, and the one question anybody asks it.
 *
 * Not "when does the job finish". What a superintendent asks every morning is
 * what is going to stop us this week and who is sitting on it, and answering
 * that needs two things joined that no product joins: the activity starting
 * Thursday with two days of float, and the RFI that has been with the
 * architect for eleven days.
 *
 * So `exposure()` is the method this file exists for. Everything else gets
 * the activities in the door so that query has something to read.
 */

export interface ScheduleRow {
  id: string
  name: string
  source: string
  dataDate: string | null
  isBaseline: boolean
  isCurrent: boolean
  importedAt: string
  activityCount: number
}

export interface ActivityRow {
  activityCode: string
  name: string
  wbsPath: string | null
  startAt: string | null
  finishAt: string | null
  actualStart: string | null
  actualFinish: string | null
  totalFloatDays: string | null
  isCritical: boolean
  isMilestone: boolean
  predecessors: string[]
}

/**
 * One line of the morning meeting.
 *
 * An activity, when it starts, how much room it has, and what is currently
 * in the way. `daysOfFloat` and `longestWaitDays` next to each other is the
 * whole point: an RFI sitting eleven days against an activity with two days
 * of float is not a paperwork problem, it is a delay that has already
 * happened and nobody has said so.
 */
export interface ExposureRow {
  activityCode: string
  activityName: string
  startAt: string | null
  finishAt: string | null
  totalFloatDays: string | null
  isCritical: boolean
  openRecords: number
  longestWaitDays: number | null
  /** Negative once the wait has eaten the float. */
  floatRemainingDays: number | null
  records: { recordId: string; designation: string; title: string; status: string; holderName: string | null }[]
}

export interface ScheduleImportResult {
  scheduleId: string
  imported: number
  rejected: { reason: string; row: string }[]
  dataDate: string | null
  /** Links that now point at an activity code this schedule does not contain. */
  orphanedLinks: { recordDesignation: string; activityCode: string }[]
}

export class ScheduleService {
  constructor(private readonly db: Db) {}

  /**
   * Imports a P6 export and makes it the current schedule.
   *
   * Every import is a NEW schedule. The old one is kept, always, because "the
   * schedule said we had four days of float when we raised this" is the
   * sentence a delay claim is built on, and a table that overwrites cannot
   * say it.
   */
  async importXer(
    actor: Actor,
    input: { projectId: string; name: string; text: string; asBaseline?: boolean },
  ): Promise<ScheduleImportResult> {
    const parsed = activitiesFromXer(parseXer(input.text))
    return this.store(actor, { ...input, source: 'primavera_xer', parsed })
  }

  /** The same path for anything already normalised, e.g. a CSV mapping. */
  async importActivities(
    actor: Actor,
    input: { projectId: string; name: string; activities: ImportedActivity[]; dataDate?: string; asBaseline?: boolean },
  ): Promise<ScheduleImportResult> {
    return this.store(actor, {
      ...input,
      source: 'csv',
      parsed: {
        activities: input.activities,
        dataDate: input.dataDate ?? null,
        meta: {},
        rejected: [],
      },
    })
  }

  private async store(
    actor: Actor,
    input: {
      projectId: string
      name: string
      source: 'primavera_xer' | 'msproject_xml' | 'csv' | 'manual'
      parsed: ImportedSchedule
      asBaseline?: boolean
    },
  ): Promise<ScheduleImportResult> {
    if (input.parsed.activities.length === 0) {
      // Refused, not stored empty. A schedule with no activities would become
      // the current one and quietly empty every lookahead on the job.
      throw new ValidationError('That file produced no activities', [
        {
          field: 'text',
          message: input.parsed.rejected[0]?.reason ?? 'Nothing in the file could be read as an activity',
        },
      ])
    }

    return withTenant(this.db, actor.tenantId, async (tx) => {
      await this.assertPrivilege(tx, actor, input.projectId, 'import')
      if (input.asBaseline) await this.assertPrivilege(tx, actor, input.projectId, 'set_baseline')

      // Only one current and only one baseline per project, enforced by
      // partial unique indexes, so the old flags come off first.
      await tx.query('UPDATE schedules SET is_current = FALSE WHERE tenant_id = $1 AND project_id = $2', [
        actor.tenantId,
        input.projectId,
      ])
      if (input.asBaseline) {
        await tx.query('UPDATE schedules SET is_baseline = FALSE WHERE tenant_id = $1 AND project_id = $2', [
          actor.tenantId,
          input.projectId,
        ])
      }

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO schedules (tenant_id, project_id, name, source, data_date, is_baseline, is_current,
                                imported_by, source_meta)
              VALUES ($1, $2, $3, $4::schedule_source, $5::date, $6, TRUE, $7, $8::jsonb)
           RETURNING id`,
        [
          actor.tenantId,
          input.projectId,
          input.name,
          input.source,
          input.parsed.dataDate,
          input.asBaseline === true,
          actor.userId,
          JSON.stringify(input.parsed.meta),
        ],
      )
      const scheduleId = rows[0]!.id

      for (const [index, activity] of input.parsed.activities.entries()) {
        await tx.query(
          `INSERT INTO schedule_activities
             (tenant_id, schedule_id, activity_code, name, wbs_path, start_at, finish_at, actual_start,
              actual_finish, duration_days, remaining_days, percent_complete, total_float_days,
              free_float_days, is_critical, is_milestone, predecessors, responsible, order_index)
           VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8::date, $9::date, $10, $11, $12, $13, $14,
                   $15, $16, $17::text[], $18, $19)`,
          [
            actor.tenantId,
            scheduleId,
            activity.activityCode,
            activity.name,
            activity.wbsPath,
            activity.startAt,
            activity.finishAt,
            activity.actualStart,
            activity.actualFinish,
            activity.durationDays,
            activity.remainingDays,
            activity.percentComplete,
            activity.totalFloatDays,
            activity.freeFloatDays,
            activity.isCritical,
            activity.isMilestone,
            activity.predecessors,
            activity.responsible,
            index,
          ],
        )
      }

      // Links survive an import because they point at an activity CODE, not
      // at a row. But a code that has disappeared from the new schedule is a
      // link that now points at nothing, and that is worth saying out loud:
      // an activity deleted from the programme usually means somebody
      // resequenced the work, and the RFI attached to it still matters.
      const { rows: orphans } = await tx.query<{ designation: string; activity_code: string }>(
        `SELECT r.designation, l.activity_code
           FROM activity_links l
           JOIN records r ON r.id = l.record_id
          WHERE l.tenant_id = $1 AND l.project_id = $2
            AND NOT EXISTS (
              SELECT 1 FROM schedule_activities a
               WHERE a.schedule_id = $3 AND a.activity_code = l.activity_code
            )`,
        [actor.tenantId, input.projectId, scheduleId],
      )

      return {
        scheduleId,
        imported: input.parsed.activities.length,
        rejected: input.parsed.rejected,
        dataDate: input.parsed.dataDate,
        orphanedLinks: orphans.map((o) => ({ recordDesignation: o.designation, activityCode: o.activity_code })),
      }
    })
  }

  async schedules(actor: Actor, projectId: string): Promise<ScheduleRow[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await this.assertReadable(tx, actor, projectId)
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT s.id, s.name, s.source::text AS source, s.data_date, s.is_baseline, s.is_current, s.imported_at,
                (SELECT count(*) FROM schedule_activities a WHERE a.schedule_id = s.id)::int AS activity_count
           FROM schedules s
          WHERE s.tenant_id = $1 AND s.project_id = $2
          ORDER BY s.imported_at DESC`,
        [actor.tenantId, projectId],
      )
      return rows.map((r) => ({
        id: r['id'] as string,
        name: r['name'] as string,
        source: r['source'] as string,
        dataDate: asDate(r['data_date']),
        isBaseline: r['is_baseline'] === true,
        isCurrent: r['is_current'] === true,
        importedAt: (r['imported_at'] as Date).toISOString(),
        activityCount: Number(r['activity_count'] ?? 0),
      }))
    })
  }

  /**
   * The lookahead: what starts in the next N weeks.
   *
   * Three weeks by default, because that is the window a superintendent can
   * actually do something about. A six week lookahead is a document; a three
   * week one is a conversation.
   */
  async lookahead(actor: Actor, projectId: string, weeks = 3): Promise<ActivityRow[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await this.assertReadable(tx, actor, projectId)
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT a.activity_code, a.name, a.wbs_path, a.start_at, a.finish_at, a.actual_start, a.actual_finish,
                a.total_float_days, a.is_critical, a.is_milestone, a.predecessors::text[] AS predecessors
           FROM schedules s
           JOIN schedule_activities a ON a.schedule_id = s.id
          WHERE s.tenant_id = $1 AND s.project_id = $2 AND s.is_current
            AND a.actual_finish IS NULL
            AND a.start_at <= (current_date + ($3 * 7))
          ORDER BY a.start_at NULLS LAST, a.total_float_days NULLS LAST`,
        [actor.tenantId, projectId, weeks],
      )
      return rows.map(toActivity)
    })
  }

  /**
   * What is going to stop us, ordered by how little room is left.
   *
   * The float remaining is computed here rather than in the view because it
   * is a judgement, not a fact: it says what the float WOULD be if the thing
   * that is waiting resolves today. A scheduler would not sign it, and it is
   * the number that gets somebody to pick up the phone.
   */
  async exposure(actor: Actor, projectId: string): Promise<ExposureRow[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await this.assertReadable(tx, actor, projectId)

      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT e.activity_code, e.activity_name, e.start_at, e.finish_at, e.total_float_days,
                e.is_critical, e.open_records, e.longest_wait_days
           FROM schedule_exposure e
          WHERE e.tenant_id = $1 AND e.project_id = $2 AND e.open_records > 0
          ORDER BY e.total_float_days NULLS LAST, e.start_at NULLS LAST`,
        [actor.tenantId, projectId],
      )

      const { rows: linked } = await tx.query<Record<string, unknown>>(
        `SELECT l.activity_code, r.id AS record_id, r.designation, r.title, r.status, u.name AS holder_name
           FROM activity_links l
           JOIN records r ON r.id = l.record_id
      LEFT JOIN record_assignments asg ON asg.record_id = r.id AND asg.released_at IS NULL
      LEFT JOIN users u ON u.id = asg.holder_user_id AND u.tenant_id = l.tenant_id
          WHERE l.tenant_id = $1 AND l.project_id = $2 AND l.kind = 'blocks'
          ORDER BY r.designation`,
        [actor.tenantId, projectId],
      )

      const byActivity = new Map<string, ExposureRow['records']>()
      for (const row of linked) {
        const code = row['activity_code'] as string
        byActivity.set(code, [
          ...(byActivity.get(code) ?? []),
          {
            recordId: row['record_id'] as string,
            designation: row['designation'] as string,
            title: row['title'] as string,
            status: row['status'] as string,
            holderName: (row['holder_name'] as string | null) ?? null,
          },
        ])
      }

      return rows.map((r) => {
        const float = r['total_float_days'] === null ? null : Number(r['total_float_days'])
        const waited = r['longest_wait_days'] === null ? null : Number(r['longest_wait_days'])
        return {
          activityCode: r['activity_code'] as string,
          activityName: r['activity_name'] as string,
          startAt: asDate(r['start_at']),
          finishAt: asDate(r['finish_at']),
          totalFloatDays: r['total_float_days'] === null ? null : String(r['total_float_days']),
          isCritical: r['is_critical'] === true,
          openRecords: Number(r['open_records'] ?? 0),
          longestWaitDays: waited,
          floatRemainingDays: float === null || waited === null ? null : float - waited,
          records: byActivity.get(r['activity_code'] as string) ?? [],
        }
      })
    })
  }

  async link(
    actor: Actor,
    input: { recordId: string; activityCode: string; kind?: 'blocks' | 'informs' | 'delivers' | 'documents'; note?: string },
  ): Promise<void> {
    await withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<{ project_id: string }>(
        'SELECT project_id FROM records WHERE tenant_id = $1 AND id = $2',
        [actor.tenantId, input.recordId],
      )
      const record = rows[0]
      if (!record) throw new NotFoundError('record', input.recordId)
      await this.assertPrivilege(tx, actor, record.project_id, 'link')

      // Checked against the CURRENT schedule, not against every schedule ever
      // imported. A typo'd code would otherwise sit in the table looking like
      // a link and matching nothing forever.
      const { rows: found } = await tx.query(
        `SELECT 1 FROM schedules s JOIN schedule_activities a ON a.schedule_id = s.id
          WHERE s.tenant_id = $1 AND s.project_id = $2 AND s.is_current AND a.activity_code = $3`,
        [actor.tenantId, record.project_id, input.activityCode],
      )
      if (found.length === 0) {
        throw new ValidationError(`No activity ${input.activityCode} on the current schedule`, [
          { field: 'activityCode', message: 'Use an activity code from the current schedule' },
        ])
      }

      await tx.query(
        `INSERT INTO activity_links (tenant_id, project_id, record_id, activity_code, kind, note, created_by)
              VALUES ($1, $2, $3, $4, $5::activity_link_kind, $6, $7)
         ON CONFLICT (record_id, activity_code, kind) DO UPDATE SET note = EXCLUDED.note`,
        [
          actor.tenantId,
          record.project_id,
          input.recordId,
          input.activityCode,
          input.kind ?? 'blocks',
          input.note ?? null,
          actor.userId,
        ],
      )
    })
  }

  /** What a record is holding up, for the record's own screen. */
  async linksFor(actor: Actor, recordId: string): Promise<(ActivityRow & { kind: string })[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT l.kind::text AS kind, a.activity_code, a.name, a.wbs_path, a.start_at, a.finish_at,
                a.actual_start, a.actual_finish, a.total_float_days, a.is_critical, a.is_milestone,
                a.predecessors::text[] AS predecessors
           FROM activity_links l
           JOIN schedules s ON s.project_id = l.project_id AND s.tenant_id = l.tenant_id AND s.is_current
           JOIN schedule_activities a ON a.schedule_id = s.id AND a.activity_code = l.activity_code
          WHERE l.tenant_id = $1 AND l.record_id = $2
          ORDER BY a.total_float_days NULLS LAST`,
        [actor.tenantId, recordId],
      )
      return rows.map((r) => ({ ...toActivity(r), kind: r['kind'] as string }))
    })
  }

  private async assertReadable(tx: Db, actor: Actor, projectId: string): Promise<void> {
    const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
    if (!hasLevel(access, 'schedule', 'read_only') && !access.isCompanyAdmin) {
      throw new PermissionDeniedError('You cannot see the schedule on this project', { tool: 'schedule' })
    }
  }

  private async assertPrivilege(tx: Db, actor: Actor, projectId: string, privilege: string): Promise<void> {
    const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
    if (!hasPrivilege(access, 'schedule', privilege) && !access.isCompanyAdmin) {
      throw new PermissionDeniedError(`You cannot ${privilege.replace(/_/g, ' ')} on this project`, {
        tool: 'schedule',
        privilege,
      })
    }
  }
}

function toActivity(r: Record<string, unknown>): ActivityRow {
  return {
    activityCode: r['activity_code'] as string,
    name: r['name'] as string,
    wbsPath: (r['wbs_path'] as string | null) ?? null,
    startAt: asDate(r['start_at']),
    finishAt: asDate(r['finish_at']),
    actualStart: asDate(r['actual_start']),
    actualFinish: asDate(r['actual_finish']),
    totalFloatDays: r['total_float_days'] === null ? null : String(r['total_float_days']),
    isCritical: r['is_critical'] === true,
    isMilestone: r['is_milestone'] === true,
    predecessors: (r['predecessors'] as string[] | null) ?? [],
  }
}

function asDate(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
}
