import { withTenant, type Db } from '../db.js'
import { NotFoundError, PermissionDeniedError } from '../errors.js'
import type { Actor } from '../kernel.js'
import { hasPrivilege } from '../permissions.js'
import { loadAccess } from '../repositories/permissions.js'

/**
 * The claim file.
 *
 * Construction disputes are not decided on who was right. They are decided on
 * who can show, eighteen months later, what happened and when they said so.
 * The contractor with a timestamped photograph, a notice served inside the
 * window and a schedule showing the float it consumed wins a claim the other
 * side believes it should have won.
 *
 * Today that file is assembled by a project engineer under deposition
 * pressure, from email, from a phone that has been wiped, and from a schedule
 * nobody kept a copy of. Most of it cannot be assembled at all.
 *
 * This is not a table. It is a query, and that is the point: every piece of
 * it was already recorded as a side effect of doing the work, so the file
 * exists continuously rather than being reconstructed. Nothing here creates
 * or interprets anything. If a section is empty it says so, loudly, because
 * a gap the contractor knows about is worth more than one their counsel finds
 * in a deposition.
 */

export interface ClaimFileSection<T> {
  items: T[]
  /** Set when the section is empty for a reason worth printing. */
  gap: string | null
}

export interface ClaimFile {
  assembledAt: string
  project: { number: string; name: string }

  clock: {
    id: string
    state: string
    obligationType: string
    consequence: string
    occurredAt: string
    awarenessAt: string | null
    startedAt: string
    dueAt: string
    satisfiedAt: string | null
  } | null

  /** The clause, as printed, with the words the obligation relied on. */
  citation: {
    documentTitle: string
    documentKind: string
    clauseNumber: string | null
    page: number | null
    quote: string
    clauseText: string
  } | null

  /** How the deadline was reached, frozen at the time it was computed. */
  computation: Record<string, unknown> | null

  trigger: { designation: string; title: string; typeKey: string; occurredAt: string } | null

  /**
   * The evidence, with its timestamps and where it was taken.
   *
   * This is the section that is normally impossible. A geotagged note made at
   * 07:14 on the morning of the discovery is a stronger position than any
   * reconstruction, and this product happens to already hold it.
   */
  evidence: ClaimFileSection<{
    kind: string
    capturedAt: string
    latitude: string | null
    longitude: string | null
    capturedBy: string
    text: string | null
  }>

  notice: {
    designation: string
    status: string
    noticeType: string | null
    addressedTo: string | null
    deliveryMethod: string | null
    deliveredOn: string | null
    proofOfDelivery: string | null
    issuedAt: string | null
  } | null

  /** What the delay actually cost, in days of float on the programme. */
  scheduleImpact: ClaimFileSection<{
    activityCode: string
    activityName: string
    startAt: string | null
    totalFloatDays: string | null
    scheduleName: string
    dataDate: string | null
  }>

  /** Every hand-off, in order, which is the chronology counsel will want. */
  chronology: ClaimFileSection<{ at: string; event: string; actor: string | null; detail: string }>

  correspondence: ClaimFileSection<{ at: string; author: string; body: string }>

  /** Stated rather than implied. A file that hides its holes is worth less. */
  gaps: string[]
}

export class ClaimFileService {
  constructor(private readonly db: Db) {}

  async assemble(actor: Actor, clockId: string): Promise<ClaimFile> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows: clockRows } = await tx.query<Record<string, unknown>>(
        `SELECT k.id, k.state::text AS state, k.project_id, k.occurred_at, k.awareness_at, k.started_at,
                k.due_at, k.satisfied_at, k.computation, k.triggering_record_id, k.notice_record_id,
                o.obligation_type::text AS obligation_type, o.consequence::text AS consequence, o.quote,
                c.clause_number, c.page, c.text AS clause_text,
                d.title AS document_title, d.kind::text AS document_kind, d.counterparty_org_id,
                p.number AS project_number, p.name AS project_name
           FROM obligation_clocks k
           JOIN contract_obligations o ON o.id = k.obligation_id
           JOIN contract_clauses c ON c.id = o.clause_id
           JOIN contract_documents d ON d.id = o.document_id
           JOIN projects p ON p.id = k.project_id AND p.tenant_id = k.tenant_id
          WHERE k.tenant_id = $1 AND k.id = $2`,
        [actor.tenantId, clockId],
      )
      const clock = clockRows[0]
      if (!clock) throw new NotFoundError('clock', clockId)

      const projectId = clock['project_id'] as string
      const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })

      // The whole file, or none of it. A claim file with the clause cut out
      // of the middle is not a claim file, so the check is the one that
      // governs the clause itself: you read the instrument you signed, and
      // `view_terms` extends that to the rest of the job.
      //
      // `contracts: read_only` is NOT enough on its own, and an earlier
      // version stopped there. Every trade partner holds that level so they
      // can read their own subcontract, and it let a sub assemble the full
      // file for a clause of the PRIME — clause text included. Exactly the
      // leak the instrument list already refuses, through a side door.
      const counterparty = (clock['counterparty_org_id'] as string | null) ?? null
      const { rows: mine } = await tx.query<{ organization_id: string }>(
        'SELECT organization_id FROM users WHERE tenant_id = $1 AND id = $2',
        [actor.tenantId, actor.userId],
      )
      const myOrg = mine[0]?.organization_id ?? null
      const mayRead =
        access.isCompanyAdmin ||
        hasPrivilege(access, 'contracts', 'view_terms') ||
        (counterparty !== null && counterparty === myOrg)
      if (!mayRead) {
        throw new PermissionDeniedError('You cannot assemble a claim file on this instrument', { tool: 'contracts' })
      }

      const triggerRecordId = (clock['triggering_record_id'] as string | null) ?? null
      const noticeRecordId = (clock['notice_record_id'] as string | null) ?? null
      const gaps: string[] = []

      const trigger = triggerRecordId ? await this.loadTrigger(tx, actor.tenantId, triggerRecordId) : null
      const evidence = await this.loadEvidence(tx, actor.tenantId, triggerRecordId)
      const notice = noticeRecordId ? await this.loadNotice(tx, actor.tenantId, noticeRecordId) : null
      const scheduleImpact = await this.loadScheduleImpact(tx, actor.tenantId, projectId, triggerRecordId)
      const chronology = await this.loadChronology(tx, actor.tenantId, [triggerRecordId, noticeRecordId])
      const correspondence = await this.loadCorrespondence(tx, actor.tenantId, [triggerRecordId, noticeRecordId])

      // Gaps named at the top, in the order they weaken the file.
      if (!notice) {
        gaps.push('No notice record exists for this clock. Nothing was served.')
      } else if (notice.status !== 'issued' && notice.status !== 'acknowledged') {
        gaps.push(`The notice is ${notice.status}, not issued. There is no evidence it reached the other party.`)
      } else if (!notice.deliveredOn) {
        gaps.push('The notice is marked issued but records no delivery date.')
      }
      if (clock['state'] === 'expired') {
        gaps.push('The deadline passed without the notice being served. The contract states a consequence for this.')
      }
      if (evidence.gap) gaps.push(evidence.gap)
      if (scheduleImpact.gap) gaps.push(scheduleImpact.gap)
      if (!clock['awareness_at']) {
        gaps.push(
          'No timestamped record of when the condition was first observed, so awareness rests on recollection.',
        )
      }

      return {
        assembledAt: new Date().toISOString(),
        project: { number: clock['project_number'] as string, name: clock['project_name'] as string },
        clock: {
          id: clock['id'] as string,
          state: clock['state'] as string,
          obligationType: clock['obligation_type'] as string,
          consequence: clock['consequence'] as string,
          occurredAt: iso(clock['occurred_at']),
          awarenessAt: clock['awareness_at'] ? iso(clock['awareness_at']) : null,
          startedAt: iso(clock['started_at']),
          dueAt: iso(clock['due_at']),
          satisfiedAt: clock['satisfied_at'] ? iso(clock['satisfied_at']) : null,
        },
        citation: {
          documentTitle: clock['document_title'] as string,
          documentKind: clock['document_kind'] as string,
          clauseNumber: (clock['clause_number'] as string | null) ?? null,
          page: clock['page'] === null ? null : Number(clock['page']),
          quote: clock['quote'] as string,
          clauseText: clock['clause_text'] as string,
        },
        computation: (clock['computation'] as Record<string, unknown> | null) ?? null,
        trigger,
        evidence,
        notice,
        scheduleImpact,
        chronology,
        correspondence,
        gaps,
      }
    })
  }

  private async loadTrigger(
    tx: Db,
    tenantId: string,
    recordId: string,
  ): Promise<ClaimFile['trigger']> {
    const { rows } = await tx.query<Record<string, unknown>>(
      'SELECT designation, title, type_key, created_at FROM records WHERE tenant_id = $1 AND id = $2',
      [tenantId, recordId],
    )
    const row = rows[0]
    if (!row) return null
    return {
      designation: row['designation'] as string,
      title: row['title'] as string,
      typeKey: row['type_key'] as string,
      occurredAt: iso(row['created_at']),
    }
  }

  private async loadEvidence(tx: Db, tenantId: string, recordId: string | null): Promise<ClaimFile['evidence']> {
    if (!recordId) return { items: [], gap: 'No record is linked to this clock, so no field evidence is attached.' }

    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT c.kind::text AS kind, c.captured_at, c.latitude, c.longitude, c.text, u.name AS captured_by
         FROM captures c
         JOIN capture_proposals p ON p.capture_id = c.id
         JOIN users u ON u.id = c.captured_by AND u.tenant_id = c.tenant_id
        WHERE c.tenant_id = $1 AND p.record_id = $2
        ORDER BY c.captured_at`,
      [tenantId, recordId],
    )

    const items = rows.map((r) => ({
      kind: r['kind'] as string,
      capturedAt: iso(r['captured_at']),
      latitude: r['latitude'] === null ? null : String(r['latitude']),
      longitude: r['longitude'] === null ? null : String(r['longitude']),
      capturedBy: r['captured_by'] as string,
      text: (r['text'] as string | null) ?? null,
    }))

    return {
      items,
      gap:
        items.length === 0
          ? 'This record was typed rather than captured in the field, so there is no timestamped or located evidence behind it.'
          : null,
    }
  }

  private async loadNotice(tx: Db, tenantId: string, recordId: string): Promise<ClaimFile['notice']> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT r.designation, r.status, r.body,
              (SELECT h.occurred_at FROM record_state_history h
                WHERE h.record_id = r.id AND h.to_status = 'issued'
                ORDER BY h.occurred_at LIMIT 1) AS issued_at
         FROM records r WHERE r.tenant_id = $1 AND r.id = $2`,
      [tenantId, recordId],
    )
    const row = rows[0]
    if (!row) return null
    const body = (row['body'] as Record<string, unknown>) ?? {}
    return {
      designation: row['designation'] as string,
      status: row['status'] as string,
      noticeType: str(body['notice_type']),
      addressedTo: str(body['addressed_to']),
      deliveryMethod: str(body['delivery_method']),
      deliveredOn: str(body['delivered_on']),
      proofOfDelivery: str(body['proof_of_delivery']),
      issuedAt: row['issued_at'] ? iso(row['issued_at']) : null,
    }
  }

  private async loadScheduleImpact(
    tx: Db,
    tenantId: string,
    projectId: string,
    recordId: string | null,
  ): Promise<ClaimFile['scheduleImpact']> {
    if (!recordId) return { items: [], gap: 'No record is linked, so no schedule impact can be shown.' }

    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT a.activity_code, a.name, to_char(a.start_at, 'YYYY-MM-DD') AS start_at, a.total_float_days,
              s.name AS schedule_name, to_char(s.data_date, 'YYYY-MM-DD') AS data_date
         FROM activity_links l
         JOIN schedules s ON s.tenant_id = l.tenant_id AND s.project_id = l.project_id AND s.is_current
         JOIN schedule_activities a ON a.schedule_id = s.id AND a.activity_code = l.activity_code
        WHERE l.tenant_id = $1 AND l.project_id = $2 AND l.record_id = $3 AND l.kind = 'blocks'
        ORDER BY a.total_float_days NULLS LAST`,
      [tenantId, projectId, recordId],
    )

    const items = rows.map((r) => ({
      activityCode: r['activity_code'] as string,
      activityName: r['name'] as string,
      startAt: (r['start_at'] as string | null) ?? null,
      totalFloatDays: r['total_float_days'] === null ? null : String(r['total_float_days']),
      scheduleName: r['schedule_name'] as string,
      dataDate: (r['data_date'] as string | null) ?? null,
    }))

    return {
      items,
      gap:
        items.length === 0
          ? 'Nothing on the schedule is linked to this record, so the delay cannot be quantified in days.'
          : null,
    }
  }

  private async loadChronology(
    tx: Db,
    tenantId: string,
    recordIds: (string | null)[],
  ): Promise<ClaimFile['chronology']> {
    const ids = recordIds.filter((id): id is string => id !== null)
    if (ids.length === 0) return { items: [], gap: 'No records are linked to this clock.' }

    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT h.occurred_at, h.from_status, h.to_status, h.transition_key, h.note, r.designation,
              u.name AS actor
         FROM record_state_history h
         JOIN records r ON r.id = h.record_id AND r.tenant_id = h.tenant_id
    LEFT JOIN users u ON u.id = h.actor_user_id AND u.tenant_id = h.tenant_id
        WHERE h.tenant_id = $1 AND h.record_id = ANY($2::uuid[])
        ORDER BY h.occurred_at`,
      [tenantId, ids],
    )

    return {
      items: rows.map((r) => ({
        at: iso(r['occurred_at']),
        event: `${r['designation']}: ${r['from_status'] ?? 'created'} → ${r['to_status']}`,
        actor: (r['actor'] as string | null) ?? null,
        // The note a person typed at the transition, when there was one. It
        // is often the only contemporaneous explanation of WHY, and why is
        // the question a deposition is actually about.
        detail: (r['note'] as string | null) ?? (r['transition_key'] as string | null) ?? '',
      })),
      gap: null,
    }
  }

  private async loadCorrespondence(
    tx: Db,
    tenantId: string,
    recordIds: (string | null)[],
  ): Promise<ClaimFile['correspondence']> {
    const ids = recordIds.filter((id): id is string => id !== null)
    if (ids.length === 0) return { items: [], gap: null }

    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT c.created_at, c.body, u.name AS author
         FROM record_comments c
         JOIN users u ON u.id = c.author_user_id AND u.tenant_id = c.tenant_id
        WHERE c.tenant_id = $1 AND c.record_id = ANY($2::uuid[])
        ORDER BY c.created_at`,
      [tenantId, ids],
    )

    return {
      items: rows.map((r) => ({
        at: iso(r['created_at']),
        author: r['author'] as string,
        body: r['body'] as string,
      })),
      gap: null,
    }
  }
}

/**
 * The file as a document somebody can hand to counsel.
 *
 * Markdown, deliberately: it survives email, it diffs, and it prints. A PDF
 * renderer here would be a dependency and a format nobody can check.
 *
 * The gaps go at the TOP. A file that leads with its evidence and buries its
 * holes is a file whose holes get found by the other side, and the whole
 * value of assembling this continuously is knowing where they are while there
 * is still time to close them.
 */
export function renderClaimFile(file: ClaimFile): string {
  const out: string[] = []
  const write = (line = ''): void => void out.push(line)

  write(`# Claim file — ${file.project.number} ${file.project.name}`)
  write()
  write(`Assembled ${file.assembledAt}. Every item below was recorded when it happened.`)
  write()

  if (file.gaps.length > 0) {
    write('## What is missing')
    write()
    write('Stated first, because a gap found here is one there may still be time to close.')
    write()
    for (const gap of file.gaps) write(`- ${gap}`)
    write()
  }

  if (file.clock) {
    write('## The obligation')
    write()
    write(`| | |`)
    write(`|---|---|`)
    write(`| Type | ${file.clock.obligationType} |`)
    write(`| Consequence of lateness | ${file.clock.consequence} |`)
    write(`| Condition occurred | ${file.clock.occurredAt} |`)
    write(`| First evidenced | ${file.clock.awarenessAt ?? 'not evidenced'} |`)
    write(`| Clock started | ${file.clock.startedAt} |`)
    write(`| Deadline | ${file.clock.dueAt} |`)
    write(`| Outcome | ${file.clock.state} |`)
    write()
  }

  if (file.citation) {
    write('## The clause relied on')
    write()
    write(
      `${file.citation.documentTitle} (${file.citation.documentKind})` +
        `${file.citation.clauseNumber ? `, clause ${file.citation.clauseNumber}` : ''}` +
        `${file.citation.page ? `, page ${file.citation.page}` : ''}`,
    )
    write()
    write(`> ${file.citation.quote}`)
    write()
    write('<details><summary>The clause in full, as printed</summary>')
    write()
    write('```')
    write(file.citation.clauseText)
    write('```')
    write()
    write('</details>')
    write()
  }

  if (file.computation) {
    write('## How the deadline was calculated')
    write()
    write('Frozen at the time it was computed, so a later correction to the calendar cannot change it.')
    write()
    for (const step of (file.computation['steps'] as string[] | undefined) ?? []) write(`- ${step}`)
    for (const note of (file.computation['notes'] as string[] | undefined) ?? []) write(`- ${note}`)
    write()
  }

  write('## The evidence')
  write()
  if (file.evidence.items.length === 0) {
    write(file.evidence.gap ?? 'None.')
  } else {
    for (const item of file.evidence.items) {
      const where = item.latitude && item.longitude ? ` at ${item.latitude}, ${item.longitude}` : ''
      write(`- **${item.capturedAt}** — ${item.kind} by ${item.capturedBy}${where}`)
      if (item.text) write(`  > ${item.text.replace(/\n/g, '\n  > ')}`)
    }
  }
  write()

  write('## The notice')
  write()
  if (!file.notice) {
    write('No notice was raised.')
  } else {
    write(`${file.notice.designation}, ${file.notice.status}.`)
    write()
    write(`- Addressed to: ${file.notice.addressedTo ?? 'not recorded'}`)
    write(`- Delivered: ${file.notice.deliveredOn ?? 'not recorded'} by ${file.notice.deliveryMethod ?? 'unknown means'}`)
    write(`- Proof: ${file.notice.proofOfDelivery ?? 'not recorded'}`)
  }
  write()

  write('## The schedule impact')
  write()
  if (file.scheduleImpact.items.length === 0) {
    write(file.scheduleImpact.gap ?? 'None recorded.')
  } else {
    for (const item of file.scheduleImpact.items) {
      write(
        `- **${item.activityName}** (${item.activityCode}) starting ${item.startAt ?? 'unscheduled'}, ` +
          `${item.totalFloatDays ?? 'unknown'} days of float per ${item.scheduleName}` +
          `${item.dataDate ? ` at data date ${item.dataDate}` : ''}`,
      )
    }
  }
  write()

  write('## Chronology')
  write()
  for (const entry of file.chronology.items) {
    write(
      `- **${entry.at}** ${entry.event}${entry.actor ? ` (${entry.actor})` : ''}` +
        `${entry.detail ? ` — ${entry.detail}` : ''}`,
    )
  }
  if (file.chronology.items.length === 0) write('Nothing recorded.')
  write()

  if (file.correspondence.items.length > 0) {
    write('## Correspondence')
    write()
    for (const entry of file.correspondence.items) {
      write(`**${entry.at}** — ${entry.author}`)
      write()
      write(`> ${entry.body.replace(/\n/g, '\n> ')}`)
      write()
    }
  }

  return out.join('\n')
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}
