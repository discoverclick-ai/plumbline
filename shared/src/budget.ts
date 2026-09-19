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

/**
 * Money is nullable here for one reason: plenty of people on a job may see the
 * budget and may not see what it costs. A superintendent manages production,
 * and putting the job's margin on a jobsite iPad is how it reaches a
 * subcontractor. They get the units; the dollars come back null.
 */
export interface BudgetLineSummary {
  budgetLineId: string
  budgetCodeId: string
  budgetCode: string
  description: string
  unitOfMeasure: string | null
  originalQuantity: string | null
  quantityToDate: string
  originalAmount: string | null
  approvedRevisions: string | null
  currentBudget: string | null
  committedCost: string | null
  actualCost: string | null
  pendingCost: string | null
  projectedCost: string | null
  projectedOverUnder: string | null
}

export interface BudgetView {
  /** False for somebody who may see the budget but not what it costs. */
  costsVisible: boolean
  lines: BudgetLineSummary[]
}

const MONEY = /^-?\d{1,16}(\.\d{1,2})?$/

function assertMoney(value: string, field: string): void {
  if (!MONEY.test(value)) {
    throw new ValidationError('That is not an amount', [
      { field, message: 'Use a plain decimal amount, at most two decimal places' },
    ])
  }
}

/** Seeing the budget and seeing what it costs are two different permissions. */
async function costVisibility(tx: Db, actor: Actor, projectId: string): Promise<boolean> {
  const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
  if (!hasLevel(access, 'budget', 'read_only')) {
    throw new PermissionDeniedError('You cannot see the budget on this project', { tool: 'budget' })
  }
  return hasPrivilege(access, 'budget', 'view_costs') || access.isCompanyAdmin
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

  /**
   * Every derived number, computed one way, for every screen and every agent.
   *
   * A reader without `view_costs` gets the same rows with every money field
   * null, rather than an error. An error there would mean a Budget tab that
   * opens onto a refusal, and a tab that cannot be opened is worse than no
   * tab; nulls mean a superintendent sees the scopes and the quantities,
   * which are the numbers they actually act on.
   */
  async summary(actor: Actor, projectId: string): Promise<BudgetView> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const costsVisible = await costVisibility(tx, actor, projectId)
      const { rows } = await tx.query<Record<string, string | null>>(
        `SELECT budget_line_id, budget_code_id, budget_code, description,
                unit_of_measure, original_quantity, quantity_to_date,
                original_amount, approved_revisions, current_budget,
                committed_cost, actual_cost, pending_cost, projected_cost, projected_over_under
           FROM budget_summary
          WHERE tenant_id = $1 AND project_id = $2
          ORDER BY budget_code`,
        [actor.tenantId, projectId],
      )
      const money = (value: string | null | undefined): string | null => (costsVisible ? (value ?? null) : null)
      return {
        costsVisible,
        lines: rows.map((r) => ({
          budgetLineId: r['budget_line_id'] as string,
          budgetCodeId: r['budget_code_id'] as string,
          budgetCode: r['budget_code'] as string,
          description: r['description'] as string,
          unitOfMeasure: r['unit_of_measure'] ?? null,
          originalQuantity: r['original_quantity'] ?? null,
          quantityToDate: (r['quantity_to_date'] ?? '0') as string,
          originalAmount: money(r['original_amount']),
          approvedRevisions: money(r['approved_revisions']),
          currentBudget: money(r['current_budget']),
          committedCost: money(r['committed_cost']),
          actualCost: money(r['actual_cost']),
          pendingCost: money(r['pending_cost']),
          projectedCost: money(r['projected_cost']),
          projectedOverUnder: money(r['projected_over_under']),
        })),
      }
    })
  }

  /**
   * For callers that hand over the actual figures, such as the accounting
   * export. Separate from `summary` on purpose: a route that read the summary
   * and then exported costs regardless of what came back would leak them.
   */
  async assertCostsVisible(actor: Actor, projectId: string): Promise<void> {
    await withTenant(this.db, actor.tenantId, async (tx) => {
      if (!(await costVisibility(tx, actor, projectId))) {
        throw new PermissionDeniedError('You cannot see cost figures on this project', { tool: 'budget' })
      }
    })
  }
}
