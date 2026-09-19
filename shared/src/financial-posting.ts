import type { Db } from './db.js'

/**
 * From a condition on site to a dollar in the budget.
 *
 * A change event that has been executed and a T&M ticket that has been signed
 * are both somebody agreeing to pay. Until now both stopped at a workflow
 * state, which meant the budget only ever knew what a project engineer
 * remembered to type into it.
 *
 * This reads the event log forward and posts what it finds. The kernel is not
 * taught about finance and finance is not taught about workflows; the seam
 * between them is a durable cursor over an append-only log, which is also the
 * only seam that survives a replay.
 *
 * Runs on an operator connection across every tenant, like the notification
 * worker, because a cursor over a global log is a global thing.
 */

export interface PostingResult {
  scanned: number
  posted: number
  skipped: { eventId: number; reason: string }[]
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
}

export class FinancialPostingService {
  constructor(private readonly db: Db) {}

  async post(limit = 500): Promise<PostingResult> {
    const { rows: cursorRows } = await this.db.query<{ last_event_id: string }>(
      `SELECT last_event_id FROM financial_posting_cursor WHERE name = 'financial_posting'`,
    )
    const cursor = Number(cursorRows[0]?.last_event_id ?? 0)

    const { rows: events } = await this.db.query<EventRow>(
      `SELECT id, tenant_id, project_id, record_id, type_key, event, payload, actor_user_id
         FROM record_events
        WHERE id > $1 AND type_key IN ('change_event', 't_and_m_ticket')
        ORDER BY id
        LIMIT $2`,
      [cursor, limit],
    )

    const result: PostingResult = { scanned: events.length, posted: 0, skipped: [] }
    let highest = cursor

    for (const event of events) {
      highest = Math.max(highest, Number(event.id))
      // The kernel writes this as `to`, not `toStatus`. Reading the wrong key
      // gave a worker that scanned every event, posted nothing and reported
      // success, which is the failure mode a cursor-based worker is most
      // prone to and hardest to notice.
      const to = typeof event.payload['to'] === 'string' ? event.payload['to'] : null
      if (event.event !== 'record.transitioned') continue

      if (event.type_key === 'change_event' && to === 'executed') {
        await this.postExecutedChange(event, result)
      } else if (event.type_key === 't_and_m_ticket' && to === 'signed') {
        await this.postSignedTicket(event, result)
      }
    }

    // The cursor advances past events we deliberately skipped as well as ones
    // we posted. A skip that came back on every pass would be an infinite
    // retry loop of a decision that is not going to change.
    if (highest > cursor) {
      await this.db.query(
        `UPDATE financial_posting_cursor SET last_event_id = $1, updated_at = now() WHERE name = 'financial_posting'`,
        [highest],
      )
    }
    return result
  }

  /**
   * An executed change order revises the budget.
   *
   * A revision rather than a cost entry, because an approved change is the
   * owner agreeing that the budget is bigger, which is a different fact from
   * the money having been spent. Conflating the two is how a job appears to
   * be under budget for the entire month between approval and invoice.
   */
  private async postExecutedChange(event: EventRow, result: PostingResult): Promise<void> {
    const record = await this.loadRecord(event)
    if (!record) return

    const amount = asAmount(record.body['cost_impact'])
    if (amount === null) {
      result.skipped.push({ eventId: Number(event.id), reason: 'no cost impact on the change event' })
      return
    }
    const codeId = await this.resolveBudgetCode(event, record.body['budget_code'])
    if (!codeId) {
      result.skipped.push({ eventId: Number(event.id), reason: 'no budget code on the change event' })
      return
    }

    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM budget_lines WHERE tenant_id = $1 AND project_id = $2 AND budget_code_id = $3`,
      [event.tenant_id, event.project_id, codeId],
    )
    const lineId = rows[0]?.id
    if (!lineId) {
      // Deliberately not created. A budget line appearing because somebody
      // executed a change order is a line nobody chose, and the first anybody
      // would know is the job cost report growing a row.
      result.skipped.push({ eventId: Number(event.id), reason: 'no budget line for that code yet' })
      return
    }

    const { rowCount } = await this.db.query(
      `INSERT INTO budget_revisions (tenant_id, budget_line_id, amount, reason, source_record_id, created_by, source_event)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source_event) WHERE source_event IS NOT NULL DO NOTHING`,
      [
        event.tenant_id,
        lineId,
        amount,
        `${record.designation} executed: ${record.title}`,
        event.record_id,
        event.actor_user_id ?? record.createdBy,
        Number(event.id),
      ],
    )
    result.posted += rowCount ?? 0
  }

  /**
   * A signed T&M ticket is pending cost.
   *
   * Pending rather than actual, because signing agrees the hours happened, not
   * that anybody has been paid for them. It becomes actual when the invoice
   * carrying it is paid, which is a separate fact with a separate date, and
   * the two are weeks apart on every job.
   */
  private async postSignedTicket(event: EventRow, result: PostingResult): Promise<void> {
    const record = await this.loadRecord(event)
    if (!record) return

    const codeId = await this.resolveBudgetCode(event, record.body['budget_code'])
    if (!codeId) {
      result.skipped.push({ eventId: Number(event.id), reason: 'no budget code on the ticket' })
      return
    }
    // Hours alone cannot reach the budget: the rates that turn hours into
    // dollars live in the subcontract, not in this record. Posting a zero
    // because the amount is missing would be worse than posting nothing,
    // because a zero looks like a decision somebody made.
    const amount = asAmount(record.body['cost_impact'])
    if (amount === null) {
      result.skipped.push({ eventId: Number(event.id), reason: 'no extended amount on the ticket' })
      return
    }

    const { rowCount } = await this.db.query(
      `INSERT INTO cost_entries
         (tenant_id, project_id, budget_code_id, kind, amount, description, source_record_id, created_by, source_event)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8)
       ON CONFLICT (source_event) WHERE source_event IS NOT NULL DO NOTHING`,
      [
        event.tenant_id,
        event.project_id,
        codeId,
        amount,
        `${record.designation} signed: ${record.title}`,
        event.record_id,
        event.actor_user_id,
        Number(event.id),
      ],
    )
    result.posted += rowCount ?? 0
  }

  private async loadRecord(
    event: EventRow,
  ): Promise<{ body: Record<string, unknown>; designation: string; title: string; createdBy: string } | null> {
    const { rows } = await this.db.query<{
      body: Record<string, unknown>
      designation: string
      title: string
      created_by: string
    }>(
      `SELECT body, designation, title, created_by FROM records WHERE tenant_id = $1 AND id = $2`,
      [event.tenant_id, event.record_id],
    )
    const row = rows[0]
    return row ? { body: row.body, designation: row.designation, title: row.title, createdBy: row.created_by } : null
  }

  /** The budget code as a person writes it, resolved to the row it names on this project. */
  private async resolveBudgetCode(event: EventRow, value: unknown): Promise<string | null> {
    if (typeof value !== 'string' || value.trim() === '') return null
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM budget_codes
        WHERE tenant_id = $1 AND project_id = $2 AND display = $3 AND retired_at IS NULL`,
      [event.tenant_id, event.project_id, value.trim()],
    )
    return rows[0]?.id ?? null
  }
}

/** Money out of a JSONB body, which may hold it as a number or a string. */
function asAmount(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toFixed(2)
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return Number(value.trim()).toFixed(2)
  }
  return null
}
