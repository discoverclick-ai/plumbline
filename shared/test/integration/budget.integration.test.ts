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

const lineFor = async (code: string) => (await budget.summary(pm, projectId)).lines.find((l) => l.budgetCode === code)

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
    // 1.2M brought across from the accounting system, 300k billed so far,
    // and a 90k change sitting unapproved. A committed figure from an ERP
    // import lands here; one from a signed subcontract comes from the
    // commitment itself, which the commitments suite covers.
    await budget.recordCost(pm, {
      projectId,
      budgetCodeId: electrical,
      kind: 'committed',
      amount: '1200000.00',
      description: 'Imported from Sage: Nimbus Electric subcontract',
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

describe('what is behind a line', () => {
  it('names where every dollar came from', async () => {
    // The point of the listing. A budget line says $300,000 actual against
    // electrical; that total cannot tell a project manager whether the
    // invoice in their hand is already one of those dollars. Entering it
    // twice is the natural mistake and it is expensive to unwind.
    const { entries } = await budget.costs(pm, projectId, { budgetCodeId: electrical })
    expect(entries.map((e) => e.kind).sort()).toEqual(['actual', 'committed', 'pending'])

    const actual = entries.find((e) => e.kind === 'actual')
    expect(actual?.amount).toBe('300000.00')
    expect(actual?.description).toBe('Invoices 1 through 3')
    // Typed by a person, so it is theirs to correct and nothing will keep
    // it current. The posting worker's entries say the opposite.
    expect(actual?.posted).toBe(false)
    expect(actual?.enteredBy).toBe('Ari Doss')
    expect(actual?.source).toBeNull()
  })

  it('filters to the code asked for', async () => {
    const all = await budget.costs(pm, projectId)
    const one = await budget.costs(pm, projectId, { budgetCodeId: concreteLabor })
    expect(all.entries.length).toBeGreaterThan(one.entries.length)
    expect(one.entries.every((e) => e.budgetCodeId === concreteLabor)).toBe(true)
  })

  it('records the units placed, not just the dollars', async () => {
    // This column travelled nowhere for a while. The budget view rolls
    // quantity_to_date up from actual-kind entries, so with nothing writing
    // it the one number a superintendent is shown INSTEAD of dollars summed
    // to zero forever: "none installed" on a job that was half built.
    await budget.recordCost(pm, {
      projectId,
      budgetCodeId: concreteLabor,
      kind: 'actual',
      amount: '18400.00',
      quantity: '240.5',
      description: 'Slab on grade, pour 2',
    })
    const view = await budget.summary(superintendent, projectId)
    const line = view.lines.find((l) => l.budgetCodeId === concreteLabor)
    expect(line?.quantityToDate).toBe('240.5000')
    // And still no dollars, which is the whole reason the column matters.
    expect(line?.actualCost).toBeNull()
  })

  it('refuses a quantity that is not one', async () => {
    await expect(
      budget.recordCost(pm, {
        projectId,
        budgetCodeId: concreteLabor,
        kind: 'actual',
        amount: '1.00',
        quantity: '240.5 CY',
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('shows a superintendent no entries at all', async () => {
    // Not an empty list. The summary nulls the money and keeps the rows
    // because a budget tab has to open; a list of individual costs has no
    // such excuse, and every row of it is a dollar figure.
    await expect(budget.costs(superintendent, projectId)).rejects.toBeInstanceOf(PermissionDeniedError)
  })
})

describe('who may see the money', () => {
  it('shows a superintendent the scopes and the quantities, and no dollars', async () => {
    // Quantities yes, cost figures no. Putting a job's margin on a jobsite
    // iPad is how it reaches a subcontractor. Refusing outright would mean a
    // Budget tab that opens onto an error, which is worse than no tab.
    const view = await budget.summary(superintendent, projectId)
    expect(view.costsVisible).toBe(false)
    expect(view.lines.length).toBeGreaterThan(0)

    const line = view.lines[0]
    expect(line?.budgetCode).toBeTruthy()
    expect(line?.description).toBeTruthy()
    expect(line?.currentBudget).toBeNull()
    expect(line?.committedCost).toBeNull()
    expect(line?.projectedOverUnder).toBeNull()
  })

  it('still refuses a superintendent the accounting export', async () => {
    // The summary returns nulls rather than refusing, so anything that hands
    // over real figures has to ask separately or it leaks the whole budget.
    await expect(budget.assertCostsVisible(superintendent, projectId)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    )
  })

  it('shows a trade partner nothing at all', async () => {
    await expect(budget.summary(trade, projectId)).rejects.toBeInstanceOf(PermissionDeniedError)
    await expect(
      budget.addLine(trade, { projectId, budgetCodeId: electrical, originalAmount: '1.00' }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })
})
