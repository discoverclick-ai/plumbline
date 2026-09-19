import { withTenant, type Db } from './db.js'
import { NotFoundError, PermissionDeniedError, ValidationError } from './errors.js'
import type { Actor } from './kernel.js'
import { loadAccess } from './repositories/permissions.js'

/**
 * Chasing.
 *
 * The most valuable thing an agent can do on a construction project is not
 * drafting. It is noticing that RFI-014 has been with the architect for eleven
 * days against a seven day turnaround, that the steel it blocks erects on
 * Thursday, and that nobody has said anything.
 *
 * That job is done today by a project engineer with a spreadsheet and a Friday
 * afternoon, and it is done badly everywhere, because it is tedious and the
 * cost of missing one is invisible until it is enormous.
 */

export interface EscalationRule {
  level: 'reminder' | 'overdue' | 'escalated' | 'critical'
  /**
   * Days past due. Negative means BEFORE the due date, which is the only one
   * that ever prevents anything: a reminder two days out is worth ten
   * escalations a week late.
   */
  daysPastDue: number
}

/**
 * The ladder, and it is deliberately short.
 *
 * One nudge before it is due, one when it goes over, one to the manager, one
 * when it has stopped being a paperwork problem. Four rungs is enough to be
 * taken seriously and few enough that each one still means something.
 */
export const DEFAULT_LADDER: EscalationRule[] = [
  { level: 'reminder', daysPastDue: -2 },
  { level: 'overdue', daysPastDue: 1 },
  { level: 'escalated', daysPastDue: 5 },
  { level: 'critical', daysPastDue: 14 },
]

export interface OverdueItem {
  recordId: string
  projectId: string
  assignmentId: string
  designation: string
  title: string
  typeKey: string
  expectedAction: string
  holderId: string
  holderName: string
  creatorId: string | null
  dueAt: Date | null
  daysWaiting: number
  daysPastDue: number | null
}

export interface EscalationDraft {
  recordId: string
  level: EscalationRule['level']
  holderId: string
  notifiedId: string
  reason: string
  message: string
}

/**
 * The level this item has reached, or null.
 *
 * Only the HIGHEST rung that applies, so an item fourteen days late produces
 * one critical escalation rather than four of everything on the way up.
 */
export function levelFor(item: OverdueItem, ladder: EscalationRule[] = DEFAULT_LADDER): EscalationRule | null {
  if (item.daysPastDue === null) return null
  let reached: EscalationRule | null = null
  for (const rule of ladder) {
    if (item.daysPastDue >= rule.daysPastDue) reached = rule
  }
  return reached
}

/** Who hears about it. The ladder is explicit so nobody is escalated by surprise. */
export function audienceFor(item: OverdueItem, level: EscalationRule['level']): string {
  // Reminder and overdue go to the person holding it. Escalated and critical
  // go to whoever raised it, because they are the one carrying the
  // consequence and the one who can decide to work around it.
  if (level === 'reminder' || level === 'overdue') return item.holderId
  return item.creatorId ?? item.holderId
}

/**
 * You have to be on the job to hear about it.
 *
 * Row-level security stops a tenant reading another tenant's work, and it is
 * the only boundary these queries had. Inside one tenant it says nothing about
 * projects, so a plain tenant-scoped SELECT hands a trade partner on the
 * parking structure every overdue item on the hospital: designation, title,
 * who is sitting on it. Harmless while the only caller was a worker sweeping
 * on a schedule, which is how it got written; not harmless the moment somebody
 * else's agent can call it with a project id it guessed.
 */
async function assertOnProject(db: Db, actor: Actor, projectId: string): Promise<void> {
  // Filtered on the tenant, not left to row-level security: RLS confines the
  // application role and this codebase also runs on connections it does not
  // confine, so an unfiltered lookup answers yes for another tenant's project.
  const { rows } = await db.query('SELECT 1 FROM projects WHERE tenant_id = $1 AND id = $2', [
    actor.tenantId,
    projectId,
  ])
  if (rows.length === 0) throw new NotFoundError('project', projectId)

  const access = await loadAccess(db, { userId: actor.userId, tenantId: actor.tenantId, projectId })
  if (!access.isProjectMember && !access.isCompanyAdmin) {
    throw new PermissionDeniedError('You are not on this project')
  }
}

export class EscalationService {
  constructor(
    private readonly db: Db,
    private readonly ladder: EscalationRule[] = DEFAULT_LADDER,
  ) {}

  /** Everything owed on a project, with how late it is. */
  async overdue(actor: Actor, projectId: string): Promise<OverdueItem[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await assertOnProject(tx, actor, projectId)
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT r.id AS record_id, r.project_id, a.id AS assignment_id, r.designation, r.title, r.type_key,
                a.expected_action, a.holder_user_id, u.name AS holder_name, a.due_at,
                EXTRACT(DAY FROM now() - a.assigned_at)::int AS days_waiting,
                CASE WHEN a.due_at IS NULL THEN NULL
                     ELSE EXTRACT(DAY FROM now() - a.due_at)::int END AS days_past_due,
                (SELECT p.user_id FROM record_participants p
                  WHERE p.record_id = r.id AND p.role = 'creator' LIMIT 1) AS creator_id
           FROM record_assignments a
           JOIN records r ON r.id = a.record_id AND r.tenant_id = a.tenant_id
           JOIN users u ON u.id = a.holder_user_id AND u.tenant_id = a.tenant_id
          WHERE a.tenant_id = $1 AND r.project_id = $2 AND a.released_at IS NULL
          ORDER BY a.due_at NULLS LAST`,
        [actor.tenantId, projectId],
      )
      return rows.map((r) => ({
        recordId: r['record_id'] as string,
        projectId: r['project_id'] as string,
        assignmentId: r['assignment_id'] as string,
        designation: r['designation'] as string,
        title: r['title'] as string,
        typeKey: r['type_key'] as string,
        expectedAction: r['expected_action'] as string,
        holderId: r['holder_user_id'] as string,
        holderName: r['holder_name'] as string,
        creatorId: (r['creator_id'] as string | null) ?? null,
        dueAt: (r['due_at'] as Date | null) ?? null,
        daysWaiting: Number(r['days_waiting'] ?? 0),
        daysPastDue: r['days_past_due'] === null ? null : Number(r['days_past_due']),
      }))
    })
  }

  /**
   * Works the queue and drafts what is worth chasing.
   *
   * Drafts. Nothing is sent: the same gate as every other agent here, for the
   * same reason. An agent that emails a client's architect unsupervised is one
   * incident away from being switched off entirely.
   */
  async sweep(actor: Actor, projectId: string): Promise<{ drafted: number; skipped: number }> {
    const items = await this.overdue(actor, projectId)
    let drafted = 0
    let skipped = 0

    for (const item of items) {
      const rule = levelFor(item, this.ladder)
      if (!rule) {
        skipped += 1
        continue
      }
      const notifiedId = audienceFor(item, rule.level)
      const draft = this.compose(item, rule.level)

      const inserted = await withTenant(this.db, actor.tenantId, async (tx) => {
        // Once per level per record. A daily nag is a filter rule inside a
        // week, and after that nothing the system sends is read again.
        const { rowCount } = await tx.query(
          `INSERT INTO escalations
             (tenant_id, project_id, record_id, assignment_id, level, holder_id, notified_id,
              days_waiting, due_at, reason, drafted_message)
           VALUES ($1, $2, $3, $4, $5::escalation_level, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (record_id, level) DO NOTHING`,
          [
            actor.tenantId,
            item.projectId,
            item.recordId,
            item.assignmentId,
            rule.level,
            item.holderId,
            notifiedId,
            item.daysWaiting,
            item.dueAt,
            draft.reason,
            draft.message,
          ],
        )
        return rowCount ?? 0
      })

      if (inserted > 0) drafted += 1
      else skipped += 1
    }

    return { drafted, skipped }
  }

  /**
   * The words.
   *
   * Written to be sent by a person to another person on a job, which means no
   * "this is an automated reminder" and no apology. A chase that reads as
   * machinery is one the recipient learns to ignore, and one the sender is
   * embarrassed to have their name on.
   */
  private compose(item: OverdueItem, level: EscalationRule['level']): { reason: string; message: string } {
    const late = item.daysPastDue ?? 0
    const reason =
      level === 'reminder'
        ? `${item.designation} is due in ${Math.abs(late)} day${Math.abs(late) === 1 ? '' : 's'} and has been with ${item.holderName} for ${item.daysWaiting}.`
        : `${item.designation} is ${late} day${late === 1 ? '' : 's'} past due with ${item.holderName}, ${item.daysWaiting} days after it was assigned.`

    const message =
      level === 'reminder'
        ? `${item.designation} — ${item.title}\n\nThis is due in ${Math.abs(late)} day${Math.abs(late) === 1 ? '' : 's'}. ${item.expectedAction}.`
        : level === 'critical'
          ? `${item.designation} — ${item.title}\n\nThis has been outstanding ${late} days past its due date. ${item.expectedAction}. Let me know today whether this is coming, or we will proceed on the basis that it is not and price the consequence.`
          : `${item.designation} — ${item.title}\n\nThis went past due ${late} day${late === 1 ? '' : 's'} ago. ${item.expectedAction}. Can you let me know where it stands?`

    return { reason, message }
  }

  async pending(actor: Actor, projectId: string): Promise<
    { id: string; recordId: string; level: string; reason: string; message: string; notifiedId: string }[]
  > {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await assertOnProject(tx, actor, projectId)
      const { rows } = await tx.query<Record<string, string>>(
        `SELECT id, record_id, level, reason, drafted_message, notified_id
           FROM escalations
          WHERE tenant_id = $1 AND project_id = $2 AND approved_at IS NULL AND dismissed_at IS NULL
          ORDER BY created_at DESC`,
        [actor.tenantId, projectId],
      )
      return rows.map((r) => ({
        id: r['id'] as string,
        recordId: r['record_id'] as string,
        level: r['level'] as string,
        reason: r['reason'] as string,
        message: r['drafted_message'] as string,
        notifiedId: r['notified_id'] as string,
      }))
    })
  }

  async approve(actor: Actor, escalationId: string): Promise<void> {
    await this.decide(actor, escalationId, 'approved')
  }

  async dismiss(actor: Actor, escalationId: string): Promise<void> {
    await this.decide(actor, escalationId, 'dismissed')
  }

  private async decide(actor: Actor, escalationId: string, decision: 'approved' | 'dismissed'): Promise<void> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<{ approved_at: Date | null; dismissed_at: Date | null }>(
        `SELECT approved_at, dismissed_at FROM escalations WHERE tenant_id = $1 AND id = $2`,
        [actor.tenantId, escalationId],
      )
      const existing = rows[0]
      if (!existing) throw new NotFoundError('escalation', escalationId)
      if (existing.approved_at || existing.dismissed_at) {
        throw new ValidationError('That escalation has already been decided', [
          { field: 'id', message: 'Already decided' },
        ])
      }
      const column = decision === 'approved' ? 'approved' : 'dismissed'
      await tx.query(
        `UPDATE escalations SET ${column}_by = $3, ${column}_at = now() WHERE tenant_id = $1 AND id = $2`,
        [actor.tenantId, escalationId, actor.userId],
      )
    })
  }
}
