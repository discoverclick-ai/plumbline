import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { BudgetService } from '../../src/budget.js'
import { createPool, withTenant } from '../../src/db.js'
import { RecordKernel, type Actor } from '../../src/kernel.js'
import { PortfolioService } from '../../src/portfolio.js'
import {
  addProjectMember,
  createOrganization,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
} from '../../src/provisioning.js'
import { clearRecordTypeCache } from '../../src/repositories/record-types.js'
import { createBudgetCode } from '../../src/wbs.js'

/**
 * The company view.
 *
 * This screen replaced a table of project names and contract values, which
 * told a project manager running six jobs nothing at all. The question they
 * have when they sign in is which job is on fire, so the assertions that earn
 * their place are the ones about the numbers that answer it — and about who
 * is allowed to see which of them.
 */

let pool: Pool
let portfolio: PortfolioService
let kernel: RecordKernel
let tenantId: string
let busy: string
let quiet: string
let unrelated: string
let pm: Actor
let trade: Actor
let tradeUserId: string

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  portfolio = new PortfolioService(pool)
  kernel = new RecordKernel(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Portfolio Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@portfolio.test', name: 'Pat Admin', password: 'a-long-enough-password' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const steel = await createOrganization(tx, tenantId, {
      name: 'Rowan Steel',
      kind: 'specialty_contractor',
      trade: 'Structural Steel',
    })
    const employee = await findTemplateByName(tx, tenantId, 'company', 'Employee')
    const collaborator = await findTemplateByName(tx, tenantId, 'company', 'Collaborator')

    const pmId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@portfolio.test',
      name: 'Paz Moreau',
      companyPermissionTemplateId: employee,
    })
    tradeUserId = await createUser(tx, tenantId, {
      organizationId: steel,
      email: 'foreman@rowan.test',
      name: 'Rob Rowan',
      companyPermissionTemplateId: collaborator,
    })

    busy = await createProject(tx, tenantId, { number: '26-201', name: 'Cascade Tower' })
    quiet = await createProject(tx, tenantId, { number: '26-202', name: 'Pier Nine Fitout' })
    // A job the PM is NOT on. Its numbers must never reach them.
    unrelated = await createProject(tx, tenantId, { number: '26-203', name: 'Somebody Elses Job' })

    for (const projectId of [busy, quiet]) {
      await addProjectMember(tx, tenantId, { projectId, userId: pmId, permissionTemplateName: 'Project Manager' })
      await addProjectMember(tx, tenantId, {
        projectId,
        userId: tradeUserId,
        permissionTemplateName: 'Trade Partner',
      })
    }
    pm = { tenantId, userId: pmId }
    trade = { tenantId, userId: tradeUserId }
  })

  // Two open records on the busy job, one of them sitting with the foreman.
  const rfi = await kernel.create(pm, {
    projectId: busy,
    typeKey: 'rfi',
    title: 'Embed depth at grid B2',
    body: { question: 'Which embedment governs?', discipline: 'Structural' },
    participants: [{ userId: tradeUserId, role: 'assignee' }],
  })
  await kernel.transition(pm, rfi.record.id, { transitionKey: 'submit' })

  await kernel.create(pm, {
    projectId: busy,
    typeKey: 'observation',
    title: 'Standing water at the east slab',
    body: { description: 'Standing water at the east slab.', observation_type: 'Quality' },
    participants: [],
  })
})

afterAll(async () => {
  await pool.end()
  clearRecordTypeCache()
})

describe('which job is on fire', () => {
  it('counts what is open and what is in your court, per job', async () => {
    const { projects } = await portfolio.summary(pm)
    const cascade = projects.find((p) => p.number === '26-201')
    const pier = projects.find((p) => p.number === '26-202')

    expect(cascade?.openRecords).toBe(2)
    expect(pier?.openRecords).toBe(0)
    // The RFI went to the foreman, so it is in their court. The observation
    // was raised with nobody assigned, which leaves it with the person who
    // raised it — that is the kernel's rule, and it is the right one: an
    // observation nobody owns is the observer's until they hand it on.
    expect(cascade?.mine).toBe(1)
    expect(cascade?.lastActivityAt).not.toBeNull()
    // A job nobody has touched says so, rather than reporting a date that is
    // really the day somebody created it.
    expect(pier?.lastActivityAt).toBeNull()
  })

  it('puts the work in the holder\'s own court', async () => {
    const { projects } = await portfolio.summary(trade)
    const cascade = projects.find((p) => p.number === '26-201')
    expect(cascade?.mine).toBe(1)
  })

  it('never reports a job you are not on', async () => {
    const { projects } = await portfolio.summary(pm)
    // The whole screen is per-project counts. One row leaking is one job's
    // workload, budget and activity handed to somebody with no part in it.
    expect(projects.map((p) => p.number)).not.toContain('26-203')
    expect(projects).toHaveLength(2)
  })

  it('shows a company administrator every job', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE tenant_id = $1 AND email = 'admin@portfolio.test'`,
      [tenantId],
    )
    const admin = { tenantId, userId: rows[0]!.id }
    const { projects } = await portfolio.summary(admin)
    expect(projects.map((p) => p.number)).toContain('26-203')
  })
})

describe('the money on the company view', () => {
  beforeAll(async () => {
    const budget = new BudgetService(pool)
    const code = await createBudgetCode(pool, tenantId, {
      projectId: busy,
      values: { cost_code: '05 00 00', cost_type: 'S' },
    })
    await budget.addLine(pm, {
      projectId: busy,
      budgetCodeId: code.id,
      description: 'Structural steel',
      originalAmount: '1000000.00',
    })
    await budget.recordCost(pm, {
      projectId: busy,
      budgetCodeId: code.id,
      kind: 'actual',
      amount: '1250000.00',
      description: 'Overrun',
    })
  })

  it('sums the view rather than storing a total', async () => {
    const { projects } = await portfolio.summary(pm)
    const cascade = projects.find((p) => p.number === '26-201')
    expect(cascade?.currentBudget).toBe('1000000.00')
    // Negative means over, which is the only direction anybody reacts to.
    expect(cascade?.projectedOverUnder).toBe('-250000.00')
  })

  it('nulls the money for somebody who may not see it', async () => {
    const { projects } = await portfolio.summary(trade)
    const cascade = projects.find((p) => p.number === '26-201')
    // The row is still there with its counts. A trade partner needs to know
    // the job exists and what is waiting on them; the margin is not theirs.
    expect(cascade).toBeDefined()
    expect(cascade?.currentBudget).toBeNull()
    expect(cascade?.projectedOverUnder).toBeNull()
  })
})
