import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { BudgetService } from '../../src/budget.js'
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
import { createBudgetCode, retireBudgetCode } from '../../src/wbs.js'

/**
 * The budget.
 *
 * Two stored facts per line and everything else derived. The tests that earn
 * their place are the ones asserting a number nobody stored: if the current
 * budget or the projected cost were ever cached, two screens in this product
 * would start disagreeing about the same job.
 */

let pool: Pool
let budget: BudgetService
let tenantId: string
let projectId: string
let pm: Actor
let superintendent: Actor
let trade: Actor
let concreteLabor: string
let electrical: string

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  budget = new BudgetService(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Ardley Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@ardley.test', name: 'Ada Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const subOrg = await createOrganization(tx, tenantId, {
      name: 'Nimbus Electric',
      kind: 'specialty_contractor',
      trade: 'Electrical',
    })
    const employee = await findTemplateByName(tx, tenantId, 'company', 'Employee')
    const collaborator = await findTemplateByName(tx, tenantId, 'company', 'Collaborator')

    const pmId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@ardley.test',
      name: 'Ari Doss',
      companyPermissionTemplateId: employee,
    })
    const superId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'super@ardley.test',
      name: 'Sid Marsh',
      companyPermissionTemplateId: employee,
    })
    const tradeId = await createUser(tx, tenantId, {
      organizationId: subOrg,
      email: 'pm@nimbus.test',
      name: 'Nell Frost',
      companyPermissionTemplateId: collaborator,
    })

    projectId = await createProject(tx, tenantId, { number: '27-100', name: 'Ardley Yard' })
    await addProjectMember(tx, tenantId, { projectId, userId: pmId, permissionTemplateName: 'Project Manager' })
    await addProjectMember(tx, tenantId, { projectId, userId: superId, permissionTemplateName: 'Superintendent' })
    await addProjectMember(tx, tenantId, { projectId, userId: tradeId, permissionTemplateName: 'Trade Partner' })

    pm = { tenantId, userId: pmId }
    superintendent = { tenantId, userId: superId }
    trade = { tenantId, userId: tradeId }
  })

  concreteLabor = (await createBudgetCode(pool, tenantId, {
    projectId,
    values: { cost_code: '03 00 00', cost_type: 'L' },
  })).id
  electrical = (await createBudgetCode(pool, tenantId, {
    projectId,
    values: { cost_code: '26 00 00', cost_type: 'S' },
  })).id
})

afterAll(async () => {
  await pool.end()
})

const lineFor = async (code: string) => (await budget.summary(pm, projectId)).find((l) => l.budgetCode === code)

describe('a budget line', () => {
  it('starts as the number somebody bought the job at', async () => {
    await budget.addLine(pm, {
      projectId,
      budgetCodeId: concreteLabor,
      description: 'Concrete labor',
      originalAmount: '480000.00',
    })
    const line = await lineFor('03 00 00.L')
    expect(line?.originalAmount).toBe('480000.00')
    expect(line?.currentBudget).toBe('480000.00')
    expect(line?.projectedOverUnder).toBe('480000.00')
  })

  it('refuses an amount that is not an amount', async () => {
    await expect(
      budget.addLine(pm, { projectId, budgetCodeId: electrical, originalAmount: '1,250,000' }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      budget.addLine(pm, { projectId, budgetCodeId: electrical, originalAmount: '1000.005' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('will not take budget against a retired code', async () => {
    const dead = await createBudgetCode(pool, tenantId, {
      projectId,
      values: { cost_code: '09 00 00', cost_type: 'S' },
    })
    await withTenant(pool, tenantId, (tx) => retireBudgetCode(tx, tenantId, dead.id))
    await expect(
      budget.addLine(pm, { projectId, budgetCodeId: dead.id, originalAmount: '1000.00' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('numbers nobody stored', () => {
  it('adds approved revisions to the original rather than editing it', async () => {
    const line = await lineFor('03 00 00.L')
    await budget.revise(pm, {
      budgetLineId: line!.budgetLineId,
      amount: '64000.00',
      reason: 'CE-004, rock at the north footing',
    })
    await budget.revise(pm, {
      budgetLineId: line!.budgetLineId,
      amount: '-12000.00',
      reason: 'Transfer to 26 00 00 for the temporary power scope',
    })

    const after = await lineFor('03 00 00.L')
    // The original is still the original. Six months into a job a PM needs to
    // see both what was bought and every hand that moved it since.
    expect(after?.originalAmount).toBe('480000.00')
    expect(after?.approvedRevisions).toBe('52000.00')
    expect(after?.currentBudget).toBe('532000.00')
  })

  it('refuses a revision with no reason, because the reason is the point', async () => {
    const line = await lineFor('03 00 00.L')
    await expect(
      budget.revise(pm, { budgetLineId: line!.budgetLineId, amount: '100.00', reason: '   ' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('projects conservatively: the larger of committed and actual, plus pending', async () => {
    await budget.addLine(pm, {
      projectId,
      budgetCodeId: electrical,
      description: 'Electrical subcontract',
      originalAmount: '1250000.00',
    })
    // Subcontract signed for 1.2M, 300k billed so far, and a 90k change
    // sitting unapproved.
    await budget.recordCost(pm, {
      projectId,
      budgetCodeId: electrical,
      kind: 'committed',
      amount: '1200000.00',
      description: 'Nimbus Electric subcontract',
    })
    await budget.recordCost(pm, {
      projectId,
      budgetCodeId: electrical,
      kind: 'actual',
      amount: '300000.00',
      description: 'Invoices 1 through 3',
    })
    await budget.recordCost(pm, {
      projectId,
      budgetCodeId: electrical,
      kind: 'pending',
      amount: '90000.00',
      description: 'Pending change for the temporary power scope',
    })

    const line = await lineFor('26 00 00.S')
    // Not 1.2M + 300k: the invoices are drawn against the commitment, and
    // adding them would double count. A projection that flatters the job is
    // worse than no projection.
    expect(line?.projectedCost).toBe('1290000.00')
    expect(line?.projectedOverUnder).toBe('-40000.00')
  })
})

describe('who may see the money', () => {
  it('shows a superintendent the budget without the dollars', async () => {
    // Quantities yes, cost figures no. Putting a job's margin on a jobsite
    // iPad is how it reaches a subcontractor.
    await expect(budget.summary(superintendent, projectId)).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it('shows a trade partner nothing at all', async () => {
    await expect(budget.summary(trade, projectId)).rejects.toBeInstanceOf(PermissionDeniedError)
    await expect(
      budget.addLine(trade, { projectId, budgetCodeId: electrical, originalAmount: '1.00' }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })
})
