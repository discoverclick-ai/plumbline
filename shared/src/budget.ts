import { withTenant, type Db } from './db.js'
import { NotFoundError, PermissionDeniedError, ValidationError } from './errors.js'
import type { Actor } from './kernel.js'
import { hasLevel, hasPrivilege } from './permissions.js'
import { loadAccess } from './repositories/permissions.js'

/**
 * The budget.
 *
 * Two stored facts per line, an original amount and an append-only set of
 * approved revisions, and everything else derived by the budget_summary view.
 * That split is the whole design. Storing a "current budget" column is how two
 * screens in the same product end up disagreeing about the same job, and once
 * that happens nobody trusts either number again.
 *
 * Money is handled as strings on the way in and out. A JavaScript number
 * cannot hold a cent reliably past about nine trillion, and more to the point
 * it cannot hold 0.1 at all; the database column is NUMERIC and the boundary
 * of this module is where that stops being negotiable.
 */

export interface BudgetLineSummary {
  budgetLineId: string
  budgetCodeId: string
  budgetCode: string
  description: string
  originalAmount: string
  approvedRevisions: string
  currentBudget: string
  committedCost: string
  actualCost: string
  pendingCost: string
  projectedCost: string
  projectedOverUnder: string
}

const MONEY = /^-?\d{1,16}(\.\d{1,2})?$/

function assertMoney(value: string, field: string): void {
  if (!MONEY.test(value)) {
    throw new ValidationError('That is not an amount', [
      { field, message: 'Use a plain decimal amount, at most two decimal places' },
    ])
  }
}

/** Reading cost figures is its own privilege: plenty of people on a job may see quantities and not dollars. */
async function assertCanSeeCosts(tx: Db, actor: Actor, projectId: string): Promise<void> {
  const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
  if (!hasLevel(access, 'budget', 'read_only')) {
    throw new PermissionDeniedError('You cannot see the budget on this project', { tool: 'budget' })
  }
  if (!hasPrivilege(access, 'budget', 'view_costs') && !access.isCompanyAdmin) {
    throw new PermissionDeniedError('You cannot see cost figures on this project', { tool: 'budget' })
  }
}

async function assertCanManage(tx: Db, actor: Actor, projectId: string): Promise<void> {
  const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
  if (!hasLevel(access, 'budget', 'standard')) {
    throw new PermissionDeniedError('You cannot change the budget on this project', { tool: 'budget' })
  }
}

export class BudgetService {
  constructor(private readonly db: Db) {}

  async addLine(
    actor: Actor,
    input: {
      projectId: string
      budgetCodeId: string
      description?: string
      originalAmount: string
      unitOfMeasure?: string
      originalQuantity?: string
    },
  ): Promise<{ id: string }> {
    assertMoney(input.originalAmount, 'originalAmount')
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await assertCanManage(tx, actor, input.projectId)

      const { rows: codeRows } = await tx.query<{ id: string; retired_at: Date | null }>(
        `SELECT id, retired_at FROM budget_codes WHERE tenant_id = $1 AND id = $2 AND project_id = $3`,
        [actor.tenantId, input.budgetCodeId, input.projectId],
      )
      const code = codeRows[0]
      if (!code) throw new NotFoundError('budget code', input.budgetCodeId)
      if (code.retired_at) {
        throw new ValidationError('That budget code is retired', [
          { field: 'budgetCodeId', message: 'Retired codes cannot take new budget' },
        ])
      }

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO budget_lines
           (tenant_id, project_id, budget_code_id, description, original_amount, unit_of_measure, original_quantity)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          actor.tenantId,
          input.projectId,
          input.budgetCodeId,
          input.description ?? '',
          input.originalAmount,
          input.unitOfMeasure ?? null,
          input.originalQuantity ?? null,
        ],
      )
      return { id: rows[0]?.id as string }
    })
  }

  /**
   * Moves money, as an append-only fact.
   *
   * Never by editing the original amount. The original is what was budgeted
   * when the job was bought, and a project manager six months in needs to see
   * both that number and every hand that moved it since. Editing it erases
   * the argument.
   */
  async revise(
    actor: Actor,
    input: { budgetLineId: string; amount: string; reason: string; sourceRecordId?: string },
  ): Promise<void> {
    assertMoney(input.amount, 'amount')
    if (!input.reason?.trim()) {
      throw new ValidationError('A revision needs a reason', [
        { field: 'reason', message: 'Say why the money moved' },
      ])
    }
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<{ project_id: string }>(
        `SELECT project_id FROM budget_lines WHERE tenant_id = $1 AND id = $2`,
        [actor.tenantId, input.budgetLineId],
      )
      const line = rows[0]
      if (!line) throw new NotFoundError('budget line', input.budgetLineId)
      await assertCanManage(tx, actor, line.project_id)

      await tx.query(
        `INSERT INTO budget_revisions (tenant_id, budget_line_id, amount, reason, source_record_id, created_by)
              VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          actor.tenantId,
          input.budgetLineId,
          input.amount,
          input.reason.trim(),
          input.sourceRecordId ?? null,
          actor.userId,
        ],
      )
    })
  }

  /** Records cost against a code. The one write path for every kind of dollar. */
  async recordCost(
    actor: Actor,
    input: {
      projectId: string
      budgetCodeId: string
      kind: 'committed' | 'actual' | 'pending' | 'forecast'
      amount: string
      description?: string
      sourceRecordId?: string
      incurredOn?: string
    },
  ): Promise<{ id: string }> {
    assertMoney(input.amount, 'amount')
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await assertCanManage(tx, actor, input.projectId)
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO cost_entries
           (tenant_id, project_id, budget_code_id, kind, amount, description, source_record_id, incurred_on, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::date, CURRENT_DATE), $9)
         RETURNING id`,
        [
          actor.tenantId,
          input.projectId,
          input.budgetCodeId,
          input.kind,
          input.amount,
          input.description ?? '',
          input.sourceRecordId ?? null,
          input.incurredOn ?? null,
          actor.userId,
        ],
      )
      return { id: rows[0]?.id as string }
    })
  }

  /** Every derived number, computed one way, for every screen and every agent. */
  async summary(actor: Actor, projectId: string): Promise<BudgetLineSummary[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await assertCanSeeCosts(tx, actor, projectId)
      const { rows } = await tx.query<Record<string, string>>(
        `SELECT budget_line_id, budget_code_id, budget_code, description,
                original_amount, approved_revisions, current_budget,
                committed_cost, actual_cost, pending_cost, projected_cost, projected_over_under
           FROM budget_summary
          WHERE tenant_id = $1 AND project_id = $2
          ORDER BY budget_code`,
        [actor.tenantId, projectId],
      )
      return rows.map((r) => ({
        budgetLineId: r['budget_line_id'] as string,
        budgetCodeId: r['budget_code_id'] as string,
        budgetCode: r['budget_code'] as string,
        description: r['description'] as string,
        originalAmount: r['original_amount'] as string,
        approvedRevisions: r['approved_revisions'] as string,
        currentBudget: r['current_budget'] as string,
        committedCost: r['committed_cost'] as string,
        actualCost: r['actual_cost'] as string,
        pendingCost: r['pending_cost'] as string,
        projectedCost: r['projected_cost'] as string,
        projectedOverUnder: r['projected_over_under'] as string,
      }))
    })
  }
}
