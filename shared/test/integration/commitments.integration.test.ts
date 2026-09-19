import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { BudgetService } from '../../src/budget.js'
import { CommitmentService } from '../../src/commitments.js'
import { createPool, withTenant } from '../../src/db.js'
import { PermissionDeniedError, ValidationError } from '../../src/errors.js'
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
 * Subcontracts and purchase orders.
 *
 * The test that matters most is the one proving an unsigned contract counts
 * for nothing. A contractor who books an out-for-signature subcontract as
 * committed cost is reporting a number the other party has not agreed to, and
 * that is how a job looks fine right up until it does not.
 */

let pool: Pool
let commitments: CommitmentService
let budget: BudgetService
let tenantId: string
let projectId: string
let pm: Actor
let superintendent: Actor
let vendorOrgId: string
let electrical: string
let concrete: string
let otherProjectCode: string

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  commitments = new CommitmentService(pool)
  budget = new BudgetService(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Brackett Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@brackett.test', name: 'Bo Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    vendorOrgId = await createOrganization(tx, tenantId, {
      name: 'Kestrel Electric',
      kind: 'specialty_contractor',
      trade: 'Electrical',
    })
    const employee = await findTemplateByName(tx, tenantId, 'company', 'Employee')

    const pmId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@brackett.test',
      name: 'Bea Rowe',
      companyPermissionTemplateId: employee,
    })
    const superId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'super@brackett.test',
      name: 'Sal Reed',
      companyPermissionTemplateId: employee,
    })

    projectId = await createProject(tx, tenantId, { number: '27-200', name: 'Brackett Mills' })
    await addProjectMember(tx, tenantId, { projectId, userId: pmId, permissionTemplateName: 'Project Manager' })
    await addProjectMember(tx, tenantId, { projectId, userId: superId, permissionTemplateName: 'Superintendent' })

    pm = { tenantId, userId: pmId }
    superintendent = { tenantId, userId: superId }
  })

  electrical = (await createBudgetCode(pool, tenantId, { projectId, values: { cost_code: '26 00 00', cost_type: 'S' } })).id
  concrete = (await createBudgetCode(pool, tenantId, { projectId, values: { cost_code: '03 00 00', cost_type: 'S' } })).id

  const other = await withTenant(pool, tenantId, (tx) =>
    createProject(tx, tenantId, { number: '27-201', name: 'Brackett Annex' }),
  )
  otherProjectCode = (await createBudgetCode(pool, tenantId, {
    projectId: other,
    values: { cost_code: '26 00 00', cost_type: 'S' },
  })).id

  await budget.addLine(pm, { projectId, budgetCodeId: electrical, description: 'Electrical', originalAmount: '1400000.00' })
})

afterAll(async () => {
  await pool.end()
})

const committedFor = async (code: string) =>
  (await budget.summary(pm, projectId)).lines.find((l) => l.budgetCode === code)?.committedCost

async function subcontract(number: string, amount: string) {
  return commitments.create(pm, {
    projectId,
    kind: 'subcontract',
    number,
    title: 'Electrical subcontract',
    vendorOrgId,
    retainagePercent: '10.00',
    lines: [
      { budgetCodeId: electrical, description: 'Base building electrical', amount },
    ],
  })
}

describe('a commitment is a schedule of values, not a number', () => {
  it('carries a line per scope per budget code', async () => {
    const { id } = await commitments.create(pm, {
      projectId,
      kind: 'subcontract',
      number: 'SC-001',
      title: 'Electrical and temporary power',
      vendorOrgId,
      lines: [
        { budgetCodeId: electrical, description: 'Base building electrical', amount: '1100000.00' },
        { budgetCodeId: concrete, description: 'Equipment pads', amount: '40000.00' },
      ],
    })
    const summary = (await commitments.summary(pm, projectId)).find((c) => c.commitmentId === id)
    expect(summary?.originalValue).toBe('1140000.00')
    expect(summary?.currentValue).toBe('1140000.00')
  })

  it('refuses a commitment with no lines at all', async () => {
    await expect(
      commitments.create(pm, {
        projectId,
        kind: 'purchase_order',
        number: 'PO-001',
        title: 'Empty',
        vendorOrgId,
        lines: [],
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses a line pointing at another project’s budget code', async () => {
    // Otherwise the vendor posts cost against a job they are not on, and
    // nothing about the resulting number looks wrong.
    await expect(
      commitments.create(pm, {
        projectId,
        kind: 'subcontract',
        number: 'SC-BAD',
        title: 'Wrong project',
        vendorOrgId,
        lines: [{ budgetCodeId: otherProjectCode, description: 'Nope', amount: '1000.00' }],
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('an unsigned contract counts for nothing', () => {
  it('does not commit a draft against the budget', async () => {
    const before = await committedFor('26 00 00.S')
    await subcontract('SC-010', '900000.00')
    // Still a proposal. A contractor booking this as committed is reporting a
    // number the other party has not agreed to.
    expect(await committedFor('26 00 00.S')).toBe(before)
  })

  it('commits it the moment somebody signs', async () => {
    const before = Number(await committedFor('26 00 00.S'))
    const { id } = await subcontract('SC-011', '250000.00')
    await commitments.execute(pm, id)
    expect(Number(await committedFor('26 00 00.S'))).toBe(before + 250000)
  })

  it('will not execute the same commitment twice', async () => {
    const { id } = await subcontract('SC-012', '1000.00')
    await commitments.execute(pm, id)
    await expect(commitments.execute(pm, id)).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('changing a signed contract', () => {
  it('will not let anybody edit the lines of one', async () => {
    const { id } = await subcontract('SC-020', '500000.00')
    await commitments.execute(pm, id)
    // Changing what a signed subcontract says without the other party
    // executing a change order is not an edit, it is a forgery.
    await expect(
      commitments.addLine(pm, id, { budgetCodeId: electrical, description: 'Quietly added', amount: '50000.00' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('moves the value only once the change order is executed', async () => {
    const { id } = await subcontract('SC-021', '600000.00')
    await commitments.execute(pm, id)
    const before = Number(await committedFor('26 00 00.S'))

    const co = await commitments.addChangeOrder(pm, {
      commitmentId: id,
      number: 'CO-001',
      title: 'Added generator feeders',
      lines: [{ budgetCodeId: electrical, description: 'Generator feeders', amount: '75000.00' }],
    })
    // Drafted, not signed, so nothing moves.
    expect(Number(await committedFor('26 00 00.S'))).toBe(before)

    await commitments.executeChangeOrder(pm, co.id)
    expect(Number(await committedFor('26 00 00.S'))).toBe(before + 75000)

    const summary = (await commitments.summary(pm, projectId)).find((c) => c.commitmentId === id)
    // The original stays visible. The other party signed it.
    expect(summary?.originalValue).toBe('600000.00')
    expect(summary?.executedChanges).toBe('75000.00')
    expect(summary?.currentValue).toBe('675000.00')
  })
})

describe('who may commit the company', () => {
  it('keeps a superintendent out of the contracts entirely', async () => {
    await expect(commitments.summary(superintendent, projectId)).rejects.toBeInstanceOf(PermissionDeniedError)
    await expect(
      commitments.create(superintendent, {
        projectId,
        kind: 'subcontract',
        number: 'SC-NOPE',
        title: 'Not theirs to sign',
        vendorOrgId,
        lines: [{ budgetCodeId: electrical, description: 'x', amount: '1.00' }],
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })
})
