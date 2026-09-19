import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { BudgetService } from '../../src/budget.js'
import { CommitmentService } from '../../src/commitments.js'
import { createPool, withTenant } from '../../src/db.js'
import { PermissionDeniedError, ValidationError } from '../../src/errors.js'
import { InvoicingService } from '../../src/invoicing.js'
import type { Actor } from '../../src/kernel.js'
import {
  addProjectMember,
  createOrganization,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
} from '../../src/provisioning.js'
import { createBudgetCode } from '../../src/wbs.js'

/**
 * The loop that decides whether a subcontractor makes payroll.
 *
 * Two things have to be right. Over-billing must be refused cumulatively
 * rather than per invoice, because the question is never "is this invoice too
 * big" but "have they now billed more than the line is worth". And nothing
 * gets paid without a lien waiver on file, because "we paid them without one"
 * ends with a lien on the owner's building and the GC paying twice.
 */

let pool: Pool
let invoicing: InvoicingService
let commitments: CommitmentService
let budget: BudgetService
let tenantId: string
let projectId: string
let gc: Actor
let sub: Actor
let commitmentId: string
let roughIn: string
let trim: string
let electrical: string

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  invoicing = new InvoicingService(pool)
  commitments = new CommitmentService(pool)
  budget = new BudgetService(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Calder Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@calder.test', name: 'Cal Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  let vendorOrgId = ''
  await withTenant(pool, tenantId, async (tx) => {
    vendorOrgId = await createOrganization(tx, tenantId, {
      name: 'Wren Electric',
      kind: 'specialty_contractor',
      trade: 'Electrical',
    })
    const employee = await findTemplateByName(tx, tenantId, 'company', 'Employee')
    const collaborator = await findTemplateByName(tx, tenantId, 'company', 'Collaborator')

    const gcId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@calder.test',
      name: 'Cam Ash',
      companyPermissionTemplateId: employee,
    })
    const subId = await createUser(tx, tenantId, {
      organizationId: vendorOrgId,
      email: 'pm@wren.test',
      name: 'Wyn Hale',
      companyPermissionTemplateId: collaborator,
    })

    projectId = await createProject(tx, tenantId, { number: '27-300', name: 'Calder Works' })
    await addProjectMember(tx, tenantId, { projectId, userId: gcId, permissionTemplateName: 'Project Manager' })
    await addProjectMember(tx, tenantId, { projectId, userId: subId, permissionTemplateName: 'Trade Partner' })

    gc = { tenantId, userId: gcId }
    sub = { tenantId, userId: subId }
  })

  electrical = (await createBudgetCode(pool, tenantId, { projectId, values: { cost_code: '26 00 00', cost_type: 'S' } })).id
  await budget.addLine(gc, { projectId, budgetCodeId: electrical, description: 'Electrical', originalAmount: '500000.00' })

  const created = await commitments.create(gc, {
    projectId,
    kind: 'subcontract',
    number: 'SC-100',
    title: 'Electrical',
    vendorOrgId,
    retainagePercent: '10.00',
    lines: [
      { budgetCodeId: electrical, description: 'Rough-in', amount: '300000.00' },
      { budgetCodeId: electrical, description: 'Trim', amount: '100000.00' },
    ],
  })
  commitmentId = created.id
  await commitments.execute(gc, commitmentId)

  const lines = await invoicing.lineBilling(gc, commitmentId)
  roughIn = lines.find((l) => l.scheduledValue === '300000.00')!.commitmentLineId
  trim = lines.find((l) => l.scheduledValue === '100000.00')!.commitmentLineId
})

afterAll(async () => {
  await pool.end()
})

describe('billing against a schedule of values', () => {
  it('bills per line, because one percentage is an invoice nobody can check', async () => {
    const { id } = await invoicing.createInvoice(sub, {
      commitmentId,
      number: '1',
      periodStart: '2026-04-01',
      periodEnd: '2026-04-30',
      lines: [
        // 90% of rough-in, 10% of trim. "The sub is 60% done" is not a fact.
        { commitmentLineId: roughIn, amount: '270000.00', retainageAmount: '27000.00' },
        { commitmentLineId: trim, amount: '10000.00', retainageAmount: '1000.00' },
      ],
    })

    const invoice = (await invoicing.summary(gc, commitmentId)).find((i) => i.invoiceId === id)
    expect(invoice?.billedThisPeriod).toBe('280000.00')
    expect(invoice?.retainageWithheld).toBe('28000.00')
    expect(invoice?.amountDue).toBe('252000.00')
  })

  it('refuses an over-billing cumulatively, not per invoice', async () => {
    // 270k already billed on a 300k line. Asking for 40k more is only wrong
    // when you count what came before, which is the whole point.
    await expect(
      invoicing.createInvoice(sub, {
        commitmentId,
        number: '2',
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
        lines: [{ commitmentLineId: roughIn, amount: '40000.00' }],
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('says exactly how much is left, because the sub has to rebill it', async () => {
    const failure = await invoicing
      .createInvoice(sub, {
        commitmentId,
        number: '3',
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
        lines: [{ commitmentLineId: roughIn, amount: '40000.00' }],
      })
      .catch((err: unknown) => err as ValidationError)
    expect((failure as ValidationError).issues[0]?.message).toContain('30000.00')
  })

  it('will not bill against a line on a different contract', async () => {
    const other = await commitments.create(gc, {
      projectId,
      kind: 'purchase_order',
      number: 'PO-100',
      title: 'Gear',
      vendorOrgId: (await withTenant(pool, tenantId, (tx) =>
        createOrganization(tx, tenantId, { name: 'Halden Supply', kind: 'supplier' }),
      )),
      lines: [{ budgetCodeId: electrical, description: 'Switchgear', amount: '80000.00' }],
    })
    await commitments.execute(gc, other.id)
    await expect(
      invoicing.createInvoice(sub, {
        commitmentId,
        number: '4',
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
        lines: [{ commitmentLineId: (await invoicing.lineBilling(gc, other.id))[0]!.commitmentLineId, amount: '100.00' }],
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('will not bill against an unsigned contract', async () => {
    const draft = await commitments.create(gc, {
      projectId,
      kind: 'subcontract',
      number: 'SC-101',
      title: 'Not signed',
      vendorOrgId: (await withTenant(pool, tenantId, (tx) =>
        createOrganization(tx, tenantId, { name: 'Pell Mechanical', kind: 'specialty_contractor' }),
      )),
      lines: [{ budgetCodeId: electrical, description: 'Scope', amount: '10000.00' }],
    })
    await expect(
      invoicing.createInvoice(sub, {
        commitmentId: draft.id,
        number: '1',
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
        lines: [{ commitmentLineId: (await invoicing.lineBilling(gc, draft.id))[0]!.commitmentLineId, amount: '100.00' }],
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('nothing gets paid without a lien waiver', () => {
  it('refuses payment until the waiver is on file, then posts the cost', async () => {
    const invoices = await invoicing.summary(gc, commitmentId)
    const first = invoices.find((i) => i.number === '1')!

    await invoicing.submit(sub, first.invoiceId)
    await invoicing.approve(gc, first.invoiceId)

    // Approved and still unpayable. "We paid them without one" ends with a
    // lien on the owner's building and the GC paying twice.
    await expect(invoicing.markPaid(gc, first.invoiceId)).rejects.toBeInstanceOf(ValidationError)

    await invoicing.recordLienWaiver(gc, first.invoiceId)
    await invoicing.markPaid(gc, first.invoiceId)

    // And paid money is actual cost, posted here rather than by a separate
    // hand: a payment the job cost report never saw is how a project shows a
    // profit it does not have.
    const line = (await budget.summary(gc, projectId)).find((l) => l.budgetCode === '26 00 00.S')
    expect(line?.actualCost).toBe('252000.00')
  })

  it('will not pay something nobody approved', async () => {
    const { id } = await invoicing.createInvoice(sub, {
      commitmentId,
      number: '5',
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30',
      lines: [{ commitmentLineId: trim, amount: '5000.00' }],
    })
    await invoicing.recordLienWaiver(gc, id)
    await expect(invoicing.markPaid(gc, id)).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('retainage', () => {
  it('releases per line and never more than was held', async () => {
    const invoices = await invoicing.summary(gc, commitmentId)
    const first = invoices.find((i) => i.number === '1')!
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM invoice_lines WHERE invoice_id = $1 AND commitment_line_id = $2`,
      [first.invoiceId, trim],
    )
    const lineId = rows[0]!.id

    await expect(invoicing.releaseRetainage(gc, lineId, '5000.00')).rejects.toBeInstanceOf(ValidationError)
    await invoicing.releaseRetainage(gc, lineId, '1000.00')

    const billing = (await invoicing.lineBilling(gc, commitmentId)).find((l) => l.commitmentLineId === trim)
    expect(billing?.retainageReleased).toBe('1000.00')
  })
})

describe('who may do what with an invoice', () => {
  it('lets a sub submit and not approve their own', async () => {
    const { id } = await invoicing.createInvoice(sub, {
      commitmentId,
      number: '6',
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
      lines: [{ commitmentLineId: trim, amount: '5000.00' }],
    })
    await invoicing.submit(sub, id)
    await expect(invoicing.approve(sub, id)).rejects.toBeInstanceOf(PermissionDeniedError)
    await expect(invoicing.markPaid(sub, id)).rejects.toBeInstanceOf(PermissionDeniedError)
  })
})
