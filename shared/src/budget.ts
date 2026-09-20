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

/** One recorded dollar, and where it came from. */
export interface CostEntryView {
  id: string
  budgetCodeId: string
  budgetCode: string
  kind: 'committed' | 'actual' | 'pending' | 'forecast'
  amount: string
  quantity: string | null
  description: string
  incurredOn: string
  sourceRecordId: string | null
  /** The record it came off, named as the job names it, or null for a hand entry. */
  source: string | null
  /** True when the posting worker wrote it, which means it will keep itself current. */
  posted: boolean
  enteredBy: string | null
}

export interface BudgetView {
  /** False for somebody who may see the budget but not what it costs. */
  costsVisible: boolean
  lines: BudgetLineSummary[]
}

const MONEY = /^-?\d{1,16}(\.\d{1,2})?$/

/**
 * Four decimal places, because the column has four and a quantity is not
 * money: 0.3333 of an acre is a real number somebody types.
 */
const QUANTITY = /^\d{1,14}(\.\d{1,4})?$/

function assertQuantity(value: string): void {
  if (!QUANTITY.test(value)) {
    throw new ValidationError('That is not a quantity', [
      { field: 'quantity', message: 'Use a positive number, at most four decimal places' },
    ])
  }
}

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

  /**
   * Whether this actor may invent a cost code.
   *
   * Exposed because the WBS functions themselves are primitives with no
   * permission checks, and a cost code is part of the financial structure:
   * anybody who can invent one can make the budget say whatever they like.
   * The check belongs with the budget, so it lives here rather than being
   * written out again at the route.
   */
  async assertCanManageCodes(actor: Actor, projectId: string): Promise<void> {
    await withTenant(this.db, actor.tenantId, async (tx) => {
      const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
      if (!hasPrivilege(access, 'budget', 'manage_codes') && !access.isCompanyAdmin) {
        throw new PermissionDeniedError('You cannot manage cost codes on this project', {
          tool: 'budget',
          privilege: 'manage_codes',
        })
      }
    })
  }

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
      /**
       * Units placed, for a line that is bought by the unit.
       *
       * This travelled nowhere for a while, and the consequence was quiet: the
       * budget view rolls `quantity_to_date` up from actual-kind cost entries,
       * so with nothing ever writing the column it summed to zero forever. The
       * one number a superintendent is shown INSTEAD of dollars read as "none
       * installed" on a job that was half built.
       */
      quantity?: string
      description?: string
      sourceRecordId?: string
      incurredOn?: string
    },
  ): Promise<{ id: string }> {
    assertMoney(input.amount, 'amount')
    if (input.quantity !== undefined && input.quantity !== '') assertQuantity(input.quantity)
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await assertCanManage(tx, actor, input.projectId)
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO cost_entries
           (tenant_id, project_id, budget_code_id, kind, amount, description, source_record_id, incurred_on, created_by, quantity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::date, CURRENT_DATE), $9, $10)
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
          input.quantity === undefined || input.quantity === '' ? null : input.quantity,
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
   * What is actually behind a budget line.
   *
   * A budget screen that shows only the rolled-up total invites the one
   * mistake that is expensive to unwind: somebody sees $40,000 actual against
   * a line, does not recognise it, and enters the invoice they are holding a
   * second time. The posting worker writes cost entries from records; a person
   * writes them by hand; both land in the same column and the total cannot
   * tell you which. So the entries are listed, each one saying where it came
   * from, before anybody is asked to add another.
   */
  async costs(
    actor: Actor,
    projectId: string,
    filter: { budgetCodeId?: string } = {},
  ): Promise<{ entries: CostEntryView[] }> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      if (!(await costVisibility(tx, actor, projectId))) {
        throw new PermissionDeniedError('You cannot see cost figures on this project', { tool: 'budget' })
      }
      const { rows } = await tx.query<Record<string, string | null>>(
        `SELECT ce.id, ce.budget_code_id, bc.display AS budget_code, ce.kind, ce.amount,
                ce.quantity, ce.description,
                to_char(ce.incurred_on, 'YYYY-MM-DD') AS incurred_on,
                ce.source_record_id, ce.source_event, ce.source_invoice_id,
                r.designation AS source_designation, r.title AS source_title,
                inv.number AS source_invoice_number,
                u.name AS entered_by
           FROM cost_entries ce
           JOIN budget_codes bc ON bc.id = ce.budget_code_id AND bc.tenant_id = ce.tenant_id
           LEFT JOIN records r ON r.id = ce.source_record_id AND r.tenant_id = ce.tenant_id
           LEFT JOIN invoices inv ON inv.id = ce.source_invoice_id AND inv.tenant_id = ce.tenant_id
           LEFT JOIN users u ON u.id = ce.created_by AND u.tenant_id = ce.tenant_id
          WHERE ce.tenant_id = $1 AND ce.project_id = $2
            AND ($3::uuid IS NULL OR ce.budget_code_id = $3)
          ORDER BY ce.incurred_on DESC, ce.created_at DESC`,
        [actor.tenantId, projectId, filter.budgetCodeId ?? null],
      )
      return {
        entries: rows.map((r) => ({
          id: r['id'] as string,
          budgetCodeId: r['budget_code_id'] as string,
          budgetCode: r['budget_code'] as string,
          kind: r['kind'] as CostEntryView['kind'],
          amount: r['amount'] as string,
          quantity: r['quantity'] ?? null,
          description: r['description'] ?? '',
          incurredOn: r['incurred_on'] as string,
          sourceRecordId: r['source_record_id'] ?? null,
          // A record it was posted from, named the way the job names it, so
          // "SC-004" is recognisable without opening anything.
          source: r['source_designation']
            ? `${r['source_designation']}${r['source_title'] ? ` · ${r['source_title']}` : ''}`
            : r['source_invoice_number']
              ? `Payment application ${r['source_invoice_number']}`
              : null,
          // Written by the product rather than typed by the person named in
          // created_by. An approved payment application counts: the approver
          // is on the row, but they did not enter the cost, and telling them
          // apart is the entire reason this list exists.
          posted: r['source_event'] !== null || r['source_invoice_id'] !== null,
          enteredBy: r['entered_by'] ?? null,
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
