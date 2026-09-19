import { withTenant, type Db } from './db.js'
import { NotFoundError, PermissionDeniedError, ValidationError } from './errors.js'
import type { Actor } from './kernel.js'
import { hasLevel, hasPrivilege } from './permissions.js'
import { loadAccess } from './repositories/permissions.js'

/**
 * Subcontracts and purchase orders: the promise to pay somebody.
 *
 * A commitment is not one number, it is a schedule of values: a list of lines,
 * each against a budget code, each with its own amount. That is what a sub
 * bills against, what retainage is released against, and what makes a progress
 * invoice checkable rather than a matter of opinion. A commitment stored as a
 * single total is the thing that forces every contractor back into a
 * spreadsheet.
 *
 * Executing is a separate act from drafting, and it is the line the whole
 * module is built around. Before execution a commitment is a proposal and
 * counts for nothing. After execution it is a contract somebody signed, its
 * lines are frozen, and its value only changes through a change order.
 */

export interface CommitmentLineInput {
  budgetCodeId: string
  description: string
  amount: string
}

export interface CommitmentSummary {
  commitmentId: string
  kind: 'subcontract' | 'purchase_order'
  number: string
  title: string
  status: 'draft' | 'out_for_signature' | 'executed' | 'closed' | 'void'
  vendorOrgId: string
  retainagePercent: string
  originalValue: string
  executedChanges: string
  currentValue: string
}

const MONEY = /^-?\d{1,16}(\.\d{1,2})?$/

function assertMoney(value: string, field: string): void {
  if (!MONEY.test(value)) {
    throw new ValidationError('That is not an amount', [
      { field, message: 'Use a plain decimal amount, at most two decimal places' },
    ])
  }
}

async function assertCanManage(tx: Db, actor: Actor, projectId: string): Promise<void> {
  const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
  if (!hasLevel(access, 'commitments', 'standard')) {
    throw new PermissionDeniedError('You cannot manage commitments on this project', { tool: 'commitments' })
  }
}

export class CommitmentService {
  constructor(private readonly db: Db) {}

  async create(
    actor: Actor,
    input: {
      projectId: string
      kind: 'subcontract' | 'purchase_order'
      number: string
      title: string
      vendorOrgId: string
      retainagePercent?: string
      lines: CommitmentLineInput[]
    },
  ): Promise<{ id: string }> {
    if (input.lines.length === 0) {
      throw new ValidationError('A commitment needs a schedule of values', [
        { field: 'lines', message: 'Add at least one line' },
      ])
    }
    for (const line of input.lines) assertMoney(line.amount, 'lines')

    return withTenant(this.db, actor.tenantId, async (tx) => {
      await assertCanManage(tx, actor, input.projectId)
      await this.assertCodesBelong(tx, actor.tenantId, input.projectId, input.lines.map((l) => l.budgetCodeId))

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO commitments
           (tenant_id, project_id, kind, number, title, vendor_org_id, retainage_percent, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          actor.tenantId,
          input.projectId,
          input.kind,
          input.number,
          input.title,
          input.vendorOrgId,
          input.retainagePercent ?? '0',
          actor.userId,
        ],
      )
      const id = rows[0]?.id as string

      let order = 0
      for (const line of input.lines) {
        order += 10
        await tx.query(
          `INSERT INTO commitment_lines (tenant_id, commitment_id, budget_code_id, description, amount, sort_order)
                VALUES ($1, $2, $3, $4, $5, $6)`,
          [actor.tenantId, id, line.budgetCodeId, line.description, line.amount, order],
        )
      }
      return { id }
    })
  }

  /**
   * Signs it.
   *
   * The lines are frozen from here: changing what a signed subcontract says
   * without the other party executing a change order is not an edit, it is a
   * forgery, and the fact that our database would let us do it silently is
   * exactly why this check lives in code rather than in a policy document.
   */
  async execute(actor: Actor, commitmentId: string, executedOn?: string): Promise<void> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const commitment = await this.load(tx, actor.tenantId, commitmentId)
      const access = await loadAccess(tx, {
        userId: actor.userId,
        tenantId: actor.tenantId,
        projectId: commitment.project_id,
      })
      if (!hasPrivilege(access, 'commitments', 'execute') && !access.isCompanyAdmin) {
        throw new PermissionDeniedError('You cannot execute commitments', { tool: 'commitments' })
      }
      if (commitment.status === 'executed' || commitment.status === 'closed') {
        throw new ValidationError('That commitment is already executed', [
          { field: 'status', message: 'Already executed' },
        ])
      }
      await tx.query(
        `UPDATE commitments SET status = 'executed', executed_on = COALESCE($2::date, CURRENT_DATE), version = version + 1
          WHERE tenant_id = $1 AND id = $3`,
        [actor.tenantId, executedOn ?? null, commitmentId],
      )
    })
  }

  async addLine(actor: Actor, commitmentId: string, line: CommitmentLineInput): Promise<void> {
    assertMoney(line.amount, 'amount')
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const commitment = await this.load(tx, actor.tenantId, commitmentId)
      await assertCanManage(tx, actor, commitment.project_id)
      if (commitment.status !== 'draft' && commitment.status !== 'out_for_signature') {
        throw new ValidationError('That commitment is signed', [
          { field: 'commitmentId', message: 'Change an executed commitment with a change order, not an edit' },
        ])
      }
      await this.assertCodesBelong(tx, actor.tenantId, commitment.project_id, [line.budgetCodeId])
      await tx.query(
        `INSERT INTO commitment_lines (tenant_id, commitment_id, budget_code_id, description, amount, sort_order)
              VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM commitment_lines WHERE commitment_id = $2))`,
        [actor.tenantId, commitmentId, line.budgetCodeId, line.description, line.amount],
      )
    })
  }

  /** A change to a signed contract, as its own instrument with its own number. */
  async addChangeOrder(
    actor: Actor,
    input: {
      commitmentId: string
      number: string
      title: string
      sourceRecordId?: string
      lines: CommitmentLineInput[]
    },
  ): Promise<{ id: string }> {
    if (input.lines.length === 0) {
      throw new ValidationError('A change order needs lines', [{ field: 'lines', message: 'Add at least one line' }])
    }
    for (const line of input.lines) assertMoney(line.amount, 'lines')

    return withTenant(this.db, actor.tenantId, async (tx) => {
      const commitment = await this.load(tx, actor.tenantId, input.commitmentId)
      await assertCanManage(tx, actor, commitment.project_id)
      await this.assertCodesBelong(tx, actor.tenantId, commitment.project_id, input.lines.map((l) => l.budgetCodeId))

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO commitment_change_orders
           (tenant_id, commitment_id, number, title, source_record_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          actor.tenantId,
          input.commitmentId,
          input.number,
          input.title,
          input.sourceRecordId ?? null,
          actor.userId,
        ],
      )
      const id = rows[0]?.id as string

      let order = 0
      for (const line of input.lines) {
        order += 10
        await tx.query(
          `INSERT INTO commitment_change_order_lines
             (tenant_id, change_order_id, budget_code_id, description, amount, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [actor.tenantId, id, line.budgetCodeId, line.description, line.amount, order],
        )
      }
      return { id }
    })
  }

  async executeChangeOrder(actor: Actor, changeOrderId: string, executedOn?: string): Promise<void> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<{ project_id: string; status: string }>(
        `SELECT c.project_id, co.status
           FROM commitment_change_orders co
           JOIN commitments c ON c.id = co.commitment_id
          WHERE co.tenant_id = $1 AND co.id = $2`,
        [actor.tenantId, changeOrderId],
      )
      const row = rows[0]
      if (!row) throw new NotFoundError('commitment change order', changeOrderId)

      const access = await loadAccess(tx, {
        userId: actor.userId,
        tenantId: actor.tenantId,
        projectId: row.project_id,
      })
      if (!hasPrivilege(access, 'commitments', 'execute') && !access.isCompanyAdmin) {
        throw new PermissionDeniedError('You cannot execute commitment change orders', { tool: 'commitments' })
      }
      await tx.query(
        `UPDATE commitment_change_orders
            SET status = 'executed', executed_on = COALESCE($2::date, CURRENT_DATE)
          WHERE tenant_id = $1 AND id = $3`,
        [actor.tenantId, executedOn ?? null, changeOrderId],
      )
    })
  }

  async summary(actor: Actor, projectId: string): Promise<CommitmentSummary[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
      if (!hasLevel(access, 'commitments', 'read_only')) {
        throw new PermissionDeniedError('You cannot see commitments on this project', { tool: 'commitments' })
      }
      const { rows } = await tx.query<Record<string, string>>(
        `SELECT commitment_id, kind, number, title, status, vendor_org_id, retainage_percent,
                original_value, executed_changes, current_value
           FROM commitment_summary
          WHERE tenant_id = $1 AND project_id = $2
          ORDER BY number`,
        [actor.tenantId, projectId],
      )
      return rows.map((r) => ({
        commitmentId: r['commitment_id'] as string,
        kind: r['kind'] as CommitmentSummary['kind'],
        number: r['number'] as string,
        title: r['title'] as string,
        status: r['status'] as CommitmentSummary['status'],
        vendorOrgId: r['vendor_org_id'] as string,
        retainagePercent: r['retainage_percent'] as string,
        originalValue: r['original_value'] as string,
        executedChanges: r['executed_changes'] as string,
        currentValue: r['current_value'] as string,
      }))
    })
  }

  private async load(
    tx: Db,
    tenantId: string,
    commitmentId: string,
  ): Promise<{ project_id: string; status: string }> {
    const { rows } = await tx.query<{ project_id: string; status: string }>(
      `SELECT project_id, status FROM commitments WHERE tenant_id = $1 AND id = $2`,
      [tenantId, commitmentId],
    )
    const row = rows[0]
    if (!row) throw new NotFoundError('commitment', commitmentId)
    return row
  }

  /**
   * A commitment line pointing at another project's budget code would post
   * cost against a job the vendor is not on. Cheap to check, invisible when
   * it goes wrong.
   */
  private async assertCodesBelong(
    tx: Db,
    tenantId: string,
    projectId: string,
    codeIds: string[],
  ): Promise<void> {
    const unique = [...new Set(codeIds)]
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM budget_codes
        WHERE tenant_id = $1 AND project_id = $2 AND id = ANY($3::uuid[]) AND retired_at IS NULL`,
      [tenantId, projectId, unique],
    )
    if (rows.length !== unique.length) {
      throw new ValidationError('A line points at a budget code that is not on this project', [
        { field: 'budgetCodeId', message: 'Unknown or retired budget code for this project' },
      ])
    }
  }
}
