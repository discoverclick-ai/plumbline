import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { BudgetService } from '../../src/budget.js'
import { CommitmentService } from '../../src/commitments.js'
import { createPool, withTenant } from '../../src/db.js'
import { buildErpBatch, CsvErpAdapter } from '../../src/erp/index.js'
import type { Actor } from '../../src/kernel.js'
import {
  addProjectMember,
  createOrganization,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
} from '../../src/provisioning.js'
import { addSegmentValue, createBudgetCode } from '../../src/wbs.js'

/**
 * Handing the numbers to the system that writes the cheques.
 *
 * The test worth having is that a budget code arrives DECOMPOSED. Handing an
 * accounting package the string "03 00 00.L.T2" is useless; handing it a cost
 * code, a cost type and a sub job in their own columns is an import, and that
 * is the only reason the work breakdown structure was built the way it was.
 */

let pool: Pool
let tenantId: string
let projectId: string
let gc: Actor

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  const budget = new BudgetService(pool)
  const commitments = new CommitmentService(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Ferris Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@ferris.test', name: 'Fin Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  let vendorOrgId = ''
  await withTenant(pool, tenantId, async (tx) => {
    vendorOrgId = await createOrganization(tx, tenantId, {
      name: 'Orr Concrete',
      kind: 'specialty_contractor',
      trade: 'Concrete',
    })
    const gcId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@ferris.test',
      name: 'Fay Orr',
      companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Employee'),
    })
    // A project name with a comma in it, because that is Tuesday.
    projectId = await createProject(tx, tenantId, { number: '27-500', name: 'Ferris Point, Phase II' })
    await addProjectMember(tx, tenantId, { projectId, userId: gcId, permissionTemplateName: 'Project Manager' })
    await addSegmentValue(tx, tenantId, { segmentKey: 'sub_job', code: 'T2', label: 'Tower 2', projectId })
    gc = { tenantId, userId: gcId }
  })

  const code = await createBudgetCode(pool, tenantId, {
    projectId,
    values: { cost_code: '03 00 00', cost_type: 'L', sub_job: 'T2' },
  })
  const empty = await createBudgetCode(pool, tenantId, {
    projectId,
    values: { cost_code: '09 00 00', cost_type: 'M' },
  })

  await budget.addLine(gc, {
    projectId,
    budgetCodeId: code.id,
    description: 'Concrete labor, tower two',
    originalAmount: '480000.00',
  })
  // A line with a budget and no cost against it, to prove zero rows are
  // dropped rather than exported as noise.
  await budget.addLine(gc, { projectId, budgetCodeId: empty.id, description: 'Finishes', originalAmount: '0.00' })

  const commitment = await commitments.create(gc, {
    projectId,
    kind: 'subcontract',
    number: 'SC-500',
    title: 'Concrete',
    vendorOrgId,
    lines: [{ budgetCodeId: code.id, description: 'Tower two slabs', amount: '420000.00' }],
  })
  await commitments.execute(gc, commitment.id)
})

afterAll(async () => {
  await pool.end()
})

describe('an accounting batch', () => {
  it('decomposes the budget code into the segments an ERP already understands', async () => {
    const batch = await withTenant(pool, tenantId, (tx) => buildErpBatch(tx, tenantId, projectId))
    const line = batch.lines.find((l) => l.kind === 'budget' && l.budgetCode === '03 00 00.L.T2')

    expect(line?.segments).toEqual({ cost_code: '03 00 00', cost_type: 'L', sub_job: 'T2' })
    expect(line?.amount).toBe('480000.00')
  })

  it('carries the committed figure from the signed subcontract', async () => {
    const batch = await withTenant(pool, tenantId, (tx) => buildErpBatch(tx, tenantId, projectId))
    const committed = batch.lines.find((l) => l.kind === 'committed')
    expect(committed?.amount).toBe('420000.00')
  })

  it('leaves out rows with nothing on them', async () => {
    const batch = await withTenant(pool, tenantId, (tx) => buildErpBatch(tx, tenantId, projectId))
    // A controller scrolling past four hundred zero rows stops reading.
    expect(batch.lines.some((l) => Number(l.amount) === 0)).toBe(false)
    expect(batch.lines.some((l) => l.budgetCode === '09 00 00.M')).toBe(false)
  })
})

describe('the CSV every accounting package can import', () => {
  it('puts each segment in its own column', async () => {
    const batch = await withTenant(pool, tenantId, (tx) => buildErpBatch(tx, tenantId, projectId))
    const file = await new CsvErpAdapter().format(batch)

    const [header, ...rows] = file.body.trim().split('\n')
    expect(header?.split(',')).toEqual([
      'project_number',
      'project_name',
      'budget_code',
      'cost_code',
      'cost_type',
      'sub_job',
      'kind',
      'amount',
      'description',
      'reference',
    ])
    expect(rows.length).toBeGreaterThan(0)
    expect(file.contentType).toBe('text/csv')
  })

  it('quotes a field containing a comma instead of splitting the row', async () => {
    const batch = await withTenant(pool, tenantId, (tx) => buildErpBatch(tx, tenantId, projectId))
    const file = await new CsvErpAdapter().format(batch)
    // "Ferris Point, Phase II" must survive as one column, or every row after
    // it lands one column to the right and the import balances to nothing.
    expect(file.body).toContain('"Ferris Point, Phase II"')
    const dataRow = file.body.trim().split('\n')[1] as string
    expect(dataRow.split(',').length).toBeGreaterThan(10)
  })

  it('escapes a quote by doubling it', async () => {
    const batch = await withTenant(pool, tenantId, (tx) => buildErpBatch(tx, tenantId, projectId))
    batch.lines[0]!.description = 'The "north" bay'
    const file = await new CsvErpAdapter().format(batch)
    expect(file.body).toContain('"The ""north"" bay"')
  })
})
