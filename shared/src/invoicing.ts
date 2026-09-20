import { withTenant, type Db } from './db.js'
import { NotFoundError, PermissionDeniedError, ValidationError } from './errors.js'
import type { Actor } from './kernel.js'
import { hasLevel, hasPrivilege } from './permissions.js'
import { loadAccess } from './repositories/permissions.js'

/**
 * Invoices, retainage, and the money actually leaving.
 *
 * This is the loop every contractor cares about more than any feature in any
 * construction platform, because it decides whether they make payroll on the
 * fifteenth. It is also the one where being wrong is expensive in a way that
 * nothing else here is: an over-billing nobody caught means a general
 * contractor has paid out more than they hold, and the money is gone.
 *
 * So the over-billing check is not a form validation. It reads the billed-to-
 * date view, cumulatively across every invoice that is not void or rejected,
 * and refuses. It is stated once and every path goes through it.
 */

export interface InvoiceLineInput {
  commitmentLineId: string
  amount: string
  /** Withheld this period. Usually the commitment's retainage percent, but stored per line because it varies. */
  retainageAmount?: string
}

export interface InvoiceSummary {
  invoiceId: string
  commitmentId: string
  number: string
  status: 'draft' | 'submitted' | 'under_review' | 'approved' | 'rejected' | 'paid' | 'void'
  periodStart: string
  periodEnd: string
  lienWaiverReceived: boolean
  billedThisPeriod: string
  retainageWithheld: string
  retainageReleased: string
  amountDue: string
}

export interface LineBilling {
  commitmentLineId: string
  scheduledValue: string
  billedToDate: string
  retainageHeld: string
  retainageReleased: string
  remaining: string
}

const MONEY = /^\d{1,16}(\.\d{1,2})?$/

function assertMoney(value: string, field: string): void {
  if (!MONEY.test(value)) {
    throw new ValidationError('That is not an amount', [
      { field, message: 'Use a plain positive decimal amount, at most two decimal places' },
    ])
  }
}

/** Cents, as an integer, so arithmetic on money never touches a float. */
function cents(value: string): bigint {
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole as string) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2) || '0')
}

export class InvoicingService {
  constructor(private readonly db: Db) {}

  async createInvoice(
    actor: Actor,
    input: {
      commitmentId: string
      number: string
      periodStart: string
      periodEnd: string
      lines: InvoiceLineInput[]
    },
  ): Promise<{ id: string }> {
    if (input.lines.length === 0) {
      throw new ValidationError('An invoice needs at least one line', [
        { field: 'lines', message: 'Bill against at least one schedule of values line' },
      ])
    }
    for (const line of input.lines) {
      assertMoney(line.amount, 'lines')
      if (line.retainageAmount) assertMoney(line.retainageAmount, 'lines')
    }

    return withTenant(this.db, actor.tenantId, async (tx) => {
      const commitment = await this.loadCommitment(tx, actor.tenantId, input.commitmentId)
      const access = await loadAccess(tx, {
        userId: actor.userId,
        tenantId: actor.tenantId,
        projectId: commitment.project_id,
      })
      if (!hasLevel(access, 'invoicing', 'standard') && !hasPrivilege(access, 'invoicing', 'submit')) {
        throw new PermissionDeniedError('You cannot invoice on this project', { tool: 'invoicing' })
      }
      if (commitment.status !== 'executed') {
        throw new ValidationError('That commitment is not executed', [
          { field: 'commitmentId', message: 'Bill against a signed contract, not a draft' },
        ])
      }

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO invoices (tenant_id, project_id, commitment_id, number, period_start, period_end, created_by)
              VALUES ($1, $2, $3, $4, $5::date, $6::date, $7)
         RETURNING id`,
        [
          actor.tenantId,
          commitment.project_id,
          input.commitmentId,
          input.number,
          input.periodStart,
          input.periodEnd,
          actor.userId,
        ],
      )
      const id = rows[0]?.id as string

      for (const line of input.lines) {
        await this.addLineChecked(tx, actor.tenantId, id, input.commitmentId, line)
      }
      return { id }
    })
  }

  /**
   * The over-billing refusal.
   *
   * Cumulative across every invoice that is not void or rejected, because the
   * question is never "is this invoice too big" but "have they now billed
   * more than the line is worth". Billing more than a line's scheduled value
   * is the most common way a GC ends up having paid out more than they hold.
   */
  private async addLineChecked(
    tx: Db,
    tenantId: string,
    invoiceId: string,
    commitmentId: string,
    line: InvoiceLineInput,
  ): Promise<void> {
    const { rows } = await tx.query<{
      scheduled_value: string
      billed_to_date: string
      commitment_id: string
    }>(
      `SELECT scheduled_value, billed_to_date, commitment_id
         FROM commitment_line_billing
        WHERE tenant_id = $1 AND commitment_line_id = $2`,
      [tenantId, line.commitmentLineId],
    )
    const billing = rows[0]
    if (!billing) throw new NotFoundError('commitment line', line.commitmentLineId)
    if (billing.commitment_id !== commitmentId) {
      throw new ValidationError('That line is on a different contract', [
        { field: 'commitmentLineId', message: 'Bill each line against its own commitment' },
      ])
    }

    const scheduled = cents(billing.scheduled_value)
    const already = cents(billing.billed_to_date)
    const asking = cents(line.amount)
    if (already + asking > scheduled) {
      const remaining = Number(scheduled - already) / 100
      throw new ValidationError('That would bill more than the line is worth', [
        {
          field: 'amount',
          message: `Only ${remaining.toFixed(2)} remains on this line; ${line.amount} was requested`,
        },
      ])
    }

    await tx.query(
      `INSERT INTO invoice_lines (tenant_id, invoice_id, commitment_line_id, amount, retainage_amount)
            VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, invoiceId, line.commitmentLineId, line.amount, line.retainageAmount ?? '0'],
    )
  }

  async submit(actor: Actor, invoiceId: string): Promise<void> {
    await this.move(actor, invoiceId, {
      from: ['draft', 'rejected'],
      to: 'submitted',
      privilege: 'submit',
      stamp: 'submitted_at',
    })
  }

  /**
   * Approval, which is where the lien waiver check lives.
   *
   * "We paid them without one" is a story that ends in a lien on the owner's
   * building, and the GC pays twice. Tracked on the invoice rather than in a
   * folder somebody forgets to check.
   */
  async approve(actor: Actor, invoiceId: string): Promise<void> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const invoice = await this.loadInvoice(tx, actor.tenantId, invoiceId)
      await this.assertPrivilege(tx, actor, invoice.project_id, 'review')
      if (invoice.status !== 'submitted' && invoice.status !== 'under_review') {
        throw new ValidationError('That invoice is not awaiting review', [
          { field: 'status', message: `Cannot approve an invoice that is ${invoice.status}` },
        ])
      }
      await tx.query(
        `UPDATE invoices SET status = 'approved', approved_at = now(), version = version + 1
          WHERE tenant_id = $1 AND id = $2`,
        [actor.tenantId, invoiceId],
      )
    })
  }

  async reject(actor: Actor, invoiceId: string, reason: string): Promise<void> {
    if (!reason?.trim()) {
      throw new ValidationError('A rejection needs a reason', [
        { field: 'reason', message: 'Say what is wrong with the invoice' },
      ])
    }
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const invoice = await this.loadInvoice(tx, actor.tenantId, invoiceId)
      await this.assertPrivilege(tx, actor, invoice.project_id, 'review')
      await tx.query(
        `UPDATE invoices SET status = 'rejected', rejection_reason = $3, version = version + 1
          WHERE tenant_id = $1 AND id = $2`,
        [actor.tenantId, invoiceId, reason.trim()],
      )
    })
  }

  async recordLienWaiver(actor: Actor, invoiceId: string): Promise<void> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const invoice = await this.loadInvoice(tx, actor.tenantId, invoiceId)
      await this.assertPrivilege(tx, actor, invoice.project_id, 'review')
      await tx.query(`UPDATE invoices SET lien_waiver_received = TRUE WHERE tenant_id = $1 AND id = $2`, [
        actor.tenantId,
        invoiceId,
      ])
    })
  }

  async markPaid(actor: Actor, invoiceId: string): Promise<void> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const invoice = await this.loadInvoice(tx, actor.tenantId, invoiceId)
      await this.assertPrivilege(tx, actor, invoice.project_id, 'pay')
      if (invoice.status !== 'approved') {
        throw new ValidationError('That invoice is not approved', [
          { field: 'status', message: 'Only an approved invoice can be paid' },
        ])
      }
      if (!invoice.lien_waiver_received) {
        throw new ValidationError('No lien waiver on file', [
          { field: 'lienWaiver', message: 'Record the signed lien waiver before paying' },
        ])
      }
      await tx.query(
        `UPDATE invoices SET status = 'paid', paid_at = now(), version = version + 1
          WHERE tenant_id = $1 AND id = $2`,
        [actor.tenantId, invoiceId],
      )
      // Paid money is actual cost. Posted here rather than by a separate hand,
      // because a payment the job cost report never saw is how a project shows
      // a profit it does not have.
      await tx.query(
        // Naming the invoice is not bookkeeping tidiness. Written with a
        // NULL source and the approver in created_by, this entry looked
        // exactly like something a person typed, so a PM reading the line
        // had no way to tell the invoice in their hand was already in the
        // number — and entering it again is the expensive mistake.
        `INSERT INTO cost_entries
           (tenant_id, project_id, budget_code_id, kind, amount, description, source_invoice_id, created_by)
         SELECT il.tenant_id, i.project_id, cl.budget_code_id, 'actual',
                SUM(il.amount - il.retainage_amount + il.retainage_released),
                'Invoice ' || i.number, i.id, $3
           FROM invoice_lines il
           JOIN invoices i ON i.id = il.invoice_id
           JOIN commitment_lines cl ON cl.id = il.commitment_line_id
          WHERE i.tenant_id = $1 AND i.id = $2
          -- One entry per code, not per invoice line. An invoice routinely
          -- bills two commitment lines that carry the same budget code, and
          -- splitting those into two identical-looking rows tells a reader
          -- nothing except that they might be a duplicate. Summed, the row
          -- means what it says: this is what this application put against
          -- this code.
          GROUP BY il.tenant_id, i.project_id, cl.budget_code_id, i.number, i.id`,
        [actor.tenantId, invoiceId, actor.userId],
      )
    })
  }

  /**
   * Releases retainage on a line.
   *
   * Per line rather than per job, because lines release at different times:
   * stored materials often carry none, and a closed-out scope releases long
   * before the job does.
   */
  async releaseRetainage(actor: Actor, invoiceLineId: string, amount: string): Promise<void> {
    assertMoney(amount, 'amount')
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<{
        project_id: string
        retainage_amount: string
        retainage_released: string
      }>(
        `SELECT i.project_id, il.retainage_amount, il.retainage_released
           FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
          WHERE il.tenant_id = $1 AND il.id = $2`,
        [actor.tenantId, invoiceLineId],
      )
      const line = rows[0]
      if (!line) throw new NotFoundError('invoice line', invoiceLineId)
      await this.assertPrivilege(tx, actor, line.project_id, 'release_retainage')

      if (cents(line.retainage_released) + cents(amount) > cents(line.retainage_amount)) {
        throw new ValidationError('That would release more than is held', [
          { field: 'amount', message: `Only ${line.retainage_amount} was withheld on this line` },
        ])
      }
      await tx.query(
        `UPDATE invoice_lines SET retainage_released = retainage_released + $3
          WHERE tenant_id = $1 AND id = $2`,
        [actor.tenantId, invoiceLineId, amount],
      )
    })
  }

  async summary(actor: Actor, commitmentId: string): Promise<InvoiceSummary[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const commitment = await this.loadCommitment(tx, actor.tenantId, commitmentId)
      const access = await loadAccess(tx, {
        userId: actor.userId,
        tenantId: actor.tenantId,
        projectId: commitment.project_id,
      })
      if (!hasLevel(access, 'invoicing', 'read_only')) {
        throw new PermissionDeniedError('You cannot see invoices on this project', { tool: 'invoicing' })
      }
      const { rows } = await tx.query<Record<string, string | boolean>>(
        `SELECT invoice_id, commitment_id, number, status, period_start, period_end, lien_waiver_received,
                billed_this_period, retainage_withheld, retainage_released, amount_due
           FROM invoice_summary
          WHERE tenant_id = $1 AND commitment_id = $2
          ORDER BY period_end, number`,
        [actor.tenantId, commitmentId],
      )
      return rows.map((r) => ({
        invoiceId: r['invoice_id'] as string,
        commitmentId: r['commitment_id'] as string,
        number: r['number'] as string,
        status: r['status'] as InvoiceSummary['status'],
        periodStart: String(r['period_start']),
        periodEnd: String(r['period_end']),
        lienWaiverReceived: r['lien_waiver_received'] === true,
        billedThisPeriod: r['billed_this_period'] as string,
        retainageWithheld: r['retainage_withheld'] as string,
        retainageReleased: r['retainage_released'] as string,
        amountDue: r['amount_due'] as string,
      }))
    })
  }

  async lineBilling(actor: Actor, commitmentId: string): Promise<LineBilling[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const commitment = await this.loadCommitment(tx, actor.tenantId, commitmentId)
      const access = await loadAccess(tx, {
        userId: actor.userId,
        tenantId: actor.tenantId,
        projectId: commitment.project_id,
      })
      if (!hasLevel(access, 'invoicing', 'read_only')) {
        throw new PermissionDeniedError('You cannot see invoices on this project', { tool: 'invoicing' })
      }
      const { rows } = await tx.query<Record<string, string>>(
        `SELECT commitment_line_id, scheduled_value, billed_to_date, retainage_held, retainage_released, remaining
           FROM commitment_line_billing
          WHERE tenant_id = $1 AND commitment_id = $2`,
        [actor.tenantId, commitmentId],
      )
      return rows.map((r) => ({
        commitmentLineId: r['commitment_line_id'] as string,
        scheduledValue: r['scheduled_value'] as string,
        billedToDate: r['billed_to_date'] as string,
        retainageHeld: r['retainage_held'] as string,
        retainageReleased: r['retainage_released'] as string,
        remaining: r['remaining'] as string,
      }))
    })
  }

  private async move(
    actor: Actor,
    invoiceId: string,
    spec: { from: string[]; to: string; privilege: string; stamp?: string },
  ): Promise<void> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const invoice = await this.loadInvoice(tx, actor.tenantId, invoiceId)
      await this.assertPrivilege(tx, actor, invoice.project_id, spec.privilege)
      if (!spec.from.includes(invoice.status)) {
        throw new ValidationError(`An invoice that is ${invoice.status} cannot be ${spec.to}`, [
          { field: 'status', message: `Cannot go from ${invoice.status} to ${spec.to}` },
        ])
      }
      const stamp = spec.stamp ? `, ${spec.stamp} = now()` : ''
      await tx.query(
        `UPDATE invoices SET status = $3::invoice_status, version = version + 1${stamp}
          WHERE tenant_id = $1 AND id = $2`,
        [actor.tenantId, invoiceId, spec.to],
      )
    })
  }

  private async assertPrivilege(tx: Db, actor: Actor, projectId: string, privilege: string): Promise<void> {
    const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
    if (!hasPrivilege(access, 'invoicing', privilege) && !access.isCompanyAdmin) {
      throw new PermissionDeniedError(`You cannot ${privilege.replace(/_/g, ' ')} invoices`, { tool: 'invoicing' })
    }
  }

  private async loadCommitment(
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

  private async loadInvoice(
    tx: Db,
    tenantId: string,
    invoiceId: string,
  ): Promise<{ project_id: string; status: string; lien_waiver_received: boolean }> {
    const { rows } = await tx.query<{
      project_id: string
      status: string
      lien_waiver_received: boolean
    }>(`SELECT project_id, status, lien_waiver_received FROM invoices WHERE tenant_id = $1 AND id = $2`, [
      tenantId,
      invoiceId,
    ])
    const row = rows[0]
    if (!row) throw new NotFoundError('invoice', invoiceId)
    return row
  }
}
