import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { BudgetService } from '../../src/budget.js'
import { createPool, withTenant } from '../../src/db.js'
import { FinancialPostingService } from '../../src/financial-posting.js'
import { RecordKernel, type Actor } from '../../src/kernel.js'
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
 * The seam between the jobsite and the money.
 *
 * A change event executed by an owner and a T&M ticket signed by a super are
 * both somebody agreeing to pay. Until this worker existed the budget only
 * knew what a project engineer remembered to type into it, which is the gap
 * every contractor fills with a spreadsheet.
 */

let pool: Pool
let kernel: RecordKernel
let budget: BudgetService
let posting: FinancialPostingService
let tenantId: string
let projectId: string
let gc: Actor
let owner: Actor
let sub: Actor
let concreteCode: string

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  kernel = new RecordKernel(pool)
  budget = new BudgetService(pool)
  posting = new FinancialPostingService(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Dunmore Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@dunmore.test', name: 'Dee Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const ownerOrg = await createOrganization(tx, tenantId, { name: 'Dunmore Holdings', kind: 'owner' })
    const subOrg = await createOrganization(tx, tenantId, {
      name: 'Pike Excavation',
      kind: 'specialty_contractor',
      trade: 'Earthwork',
    })
    const employee = await findTemplateByName(tx, tenantId, 'company', 'Employee')
    const collaborator = await findTemplateByName(tx, tenantId, 'company', 'Collaborator')

    const gcId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@dunmore.test',
      name: 'Dana Poe',
      companyPermissionTemplateId: employee,
    })
    const ownerId = await createUser(tx, tenantId, {
      organizationId: ownerOrg,
      email: 'pm@holdings.test',
      name: 'Ola Vance',
      companyPermissionTemplateId: collaborator,
    })
    const subId = await createUser(tx, tenantId, {
      organizationId: subOrg,
      email: 'pm@pike.test',
      name: 'Piet Kane',
      companyPermissionTemplateId: collaborator,
    })

    projectId = await createProject(tx, tenantId, { number: '27-400', name: 'Dunmore Fields' })
    await addProjectMember(tx, tenantId, { projectId, userId: gcId, permissionTemplateName: 'Project Manager' })
    await addProjectMember(tx, tenantId, { projectId, userId: ownerId, permissionTemplateName: 'Project Manager' })
    await addProjectMember(tx, tenantId, { projectId, userId: subId, permissionTemplateName: 'Trade Partner' })

    gc = { tenantId, userId: gcId }
    owner = { tenantId, userId: ownerId }
    sub = { tenantId, userId: subId }
  })

  concreteCode = (await createBudgetCode(pool, tenantId, {
    projectId,
    values: { cost_code: '03 00 00', cost_type: 'S' },
  })).id
  await budget.addLine(gc, {
    projectId,
    budgetCodeId: concreteCode,
    description: 'Concrete',
    originalAmount: '400000.00',
  })
})

afterAll(async () => {
  await pool.end()
})

const concreteLine = async () =>
  (await budget.summary(gc, projectId)).lines.find((l) => l.budgetCode === '03 00 00.S')

async function executedChange(title: string, amount: number, code: string | null) {
  const body = {
    description: 'Rock below the design bearing elevation.',
    cause: 'Unforeseen Condition',
    ...(code ? { budget_code: code } : {}),
  }
  const created = await kernel.create(gc, {
    projectId,
    typeKey: 'change_event',
    title,
    body,
    participants: [
      { userId: gc.userId, role: 'assignee' },
      { userId: owner.userId, role: 'approver' },
    ],
  })
  const priced = { ...body, cost_impact: amount, schedule_impact_days: 4, scope_of_work: 'Over-excavate and replace.' }
  await kernel.transition(gc, created.record.id, { transitionKey: 'record_pricing', body: priced })
  await kernel.transition(gc, created.record.id, { transitionKey: 'submit_to_owner' })
  await kernel.transition(owner, created.record.id, { transitionKey: 'approve' })
  await kernel.transition(gc, created.record.id, {
    transitionKey: 'execute',
    body: { ...priced, owner_reference: 'OCO-011' },
  })
  return created.record.id
}

describe('an executed change order reaches the budget', () => {
  it('revises the line rather than posting a cost', async () => {
    const before = await concreteLine()
    await executedChange('Rock at the north footing', 84200, '03 00 00.S')
    await posting.post()

    const after = await concreteLine()
    // A revision, not a cost entry. An approved change is the owner agreeing
    // the budget is bigger, which is a different fact from the money having
    // been spent, and conflating them makes a job look under budget for the
    // whole month between approval and invoice.
    expect(after?.approvedRevisions).toBe('84200.00')
    expect(after?.currentBudget).toBe('484200.00')
    expect(after?.actualCost).toBe(before?.actualCost)
  })

  it('says which change event moved the money', async () => {
    const { rows } = await pool.query<{ reason: string; source_record_id: string }>(
      `SELECT reason, source_record_id FROM budget_revisions WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tenantId],
    )
    expect(rows[0]?.reason).toContain('executed')
    expect(rows[0]?.reason).toContain('Rock at the north footing')
    expect(rows[0]?.source_record_id).toBeTruthy()
  })

  it('does not post twice when the log is replayed', async () => {
    const before = (await concreteLine())?.approvedRevisions
    await pool.query(`UPDATE financial_posting_cursor SET last_event_id = 0 WHERE name = 'financial_posting'`)
    await posting.post()
    expect((await concreteLine())?.approvedRevisions).toBe(before)
  })

  it('skips a change with no budget code rather than guessing one', async () => {
    const before = (await concreteLine())?.approvedRevisions
    await executedChange('Unfiled change', 5000, null)
    const result = await posting.post()

    expect((await concreteLine())?.approvedRevisions).toBe(before)
    expect(result.skipped.some((s) => s.reason.includes('no budget code'))).toBe(true)
  })

  it('will not invent a budget line nobody created', async () => {
    // A line appearing because somebody executed a change order is a line
    // nobody chose, and the first anybody knows is the cost report growing a
    // row.
    const unbudgeted = await createBudgetCode(pool, tenantId, {
      projectId,
      values: { cost_code: '31 00 00', cost_type: 'S' },
    })
    await executedChange('Earthwork change with no line', 12000, unbudgeted.display)
    const result = await posting.post()

    expect(result.skipped.some((s) => s.reason.includes('no budget line'))).toBe(true)
    const { lines } = await budget.summary(gc, projectId)
    expect(lines.map((l) => l.budgetCode)).not.toContain('31 00 00.S')
  })
})

describe('a signed T&M ticket', () => {
  it('lands as pending cost, not actual, because nobody has been paid', async () => {
    const before = await concreteLine()
    const ticket = await kernel.create(sub, {
      projectId,
      typeKey: 't_and_m_ticket',
      title: 'Dewatering at the north footing',
      body: {
        work_date: '2026-04-02',
        description: 'Pumped and hauled standing water to reach the footing.',
        authorized_by: 'Dana Poe',
        labor_hours: 12,
        budget_code: '03 00 00.S',
        cost_impact: 4800,
      },
      participants: [{ userId: gc.userId, role: 'approver' }],
    })
    await kernel.transition(sub, ticket.record.id, { transitionKey: 'submit' })
    await kernel.transition(gc, ticket.record.id, { transitionKey: 'sign' })
    await posting.post()

    const after = await concreteLine()
    // Signing agrees the hours happened. It does not agree anybody has been
    // paid, and those two facts are weeks apart on every job.
    expect(after?.pendingCost).toBe('4800.00')
    expect(after?.actualCost).toBe(before?.actualCost)
  })

  it('posts nothing for a ticket still awaiting signature', async () => {
    const before = (await concreteLine())?.pendingCost
    const ticket = await kernel.create(sub, {
      projectId,
      typeKey: 't_and_m_ticket',
      title: 'Unsigned extra work',
      body: {
        work_date: '2026-04-03',
        description: 'More dewatering.',
        authorized_by: 'Dana Poe',
        labor_hours: 6,
        budget_code: '03 00 00.S',
        cost_impact: 2400,
      },
      participants: [{ userId: gc.userId, role: 'approver' }],
    })
    await kernel.transition(sub, ticket.record.id, { transitionKey: 'submit' })
    await posting.post()
    expect((await concreteLine())?.pendingCost).toBe(before)
  })
})

describe('what the worker refuses to guess', () => {
  it('skips a signed ticket with hours but no extended amount', async () => {
    const before = (await concreteLine())?.pendingCost
    const ticket = await kernel.create(sub, {
      projectId,
      typeKey: 't_and_m_ticket',
      title: 'Hours with no money on them',
      body: {
        work_date: '2026-04-05',
        description: 'Extra hand digging around the conduit.',
        authorized_by: 'Dana Poe',
        labor_hours: 9,
        budget_code: '03 00 00.S',
      },
      participants: [{ userId: gc.userId, role: 'approver' }],
    })
    await kernel.transition(sub, ticket.record.id, { transitionKey: 'submit' })
    await kernel.transition(gc, ticket.record.id, { transitionKey: 'sign' })
    const result = await posting.post()

    // The rates that turn nine hours into dollars are in the subcontract, not
    // here. Posting a zero would look like a decision somebody made.
    expect((await concreteLine())?.pendingCost).toBe(before)
    expect(result.skipped.some((s) => s.reason.includes('no extended amount'))).toBe(true)
  })
})
