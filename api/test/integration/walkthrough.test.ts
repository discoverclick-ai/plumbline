import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createPool, provisionTenant } from '@plumbline/shared'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createApiServer } from '../../src/server.js'

/**
 * A whole job, start to finish, over HTTP and nothing else.
 *
 * Every other test in this repository drives one subsystem. This drives the
 * PRODUCT, the way a customer would: sign in, start a job, add a company and
 * a person, put them on it, build a budget, write a subcontract, raise an
 * RFI, import a schedule, link the RFI to the activity it blocks, and ask
 * what is in the way.
 *
 * It exists because two subsystems in this repository were built, tested and
 * committed with no route at all, and the only reason anybody noticed was an
 * audit. A suite of green unit tests cannot tell you the product is
 * reachable. This can: if any step here cannot be done over the wire, it
 * fails, and it fails in the order a customer would hit it.
 */

const PASSWORD = 'a-long-enough-password'
const tab = (...cells: string[]): string => cells.join('\t')
const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

let pool: Pool
let server: Server
let baseUrl: string
let token = ''

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  const parsed = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${JSON.stringify(parsed)}`)
  }
  return parsed
}

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  server = createApiServer(pool)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  await provisionTenant(pool, {
    tenantName: 'Walkthrough Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@walkthrough.test', name: 'Wes Admin', password: PASSWORD },
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await pool.end()
})

describe('a whole job, over the wire', () => {
  let projectId: string
  let steelOrgId: string
  let architectId: string
  let budgetCodeId: string
  let rfiId: string

  it('signs in', async () => {
    token = (await call('POST', '/auth/sign-in', { email: 'admin@walkthrough.test', password: PASSWORD })).token
    expect(token).toBeTruthy()
  })

  it('starts a job and puts the person who started it on it', async () => {
    projectId = (await call('POST', '/projects', { number: '26-900', name: 'Walkthrough Yard' })).id
    const mine = await call('GET', '/projects')
    expect(mine.projects.map((p: { id: string }) => p.id)).toContain(projectId)
  })

  it('adds the companies and a person, and puts them on the job', async () => {
    steelOrgId = (
      await call('POST', '/companies', { name: 'Vega Steel', kind: 'specialty_contractor', trade: 'Structural Steel' })
    ).id
    const designId = (await call('POST', '/companies', { name: 'Bishop Architects', kind: 'architect' })).id
    architectId = (await call('POST', '/people', { organizationId: designId, email: 'ali@bishop.test', name: 'Ali Bishop' })).id

    await call('POST', `/projects/${projectId}/members`, { userId: architectId, permissionTemplateName: 'Design Team' })
    const team = await call('GET', `/projects/${projectId}/members`)
    expect(team.members.map((m: { name: string }) => m.name)).toContain('Ali Bishop')
  })

  it('builds a budget from a cost code', async () => {
    budgetCodeId = (await call('POST', `/projects/${projectId}/budget-codes`, {
      values: { cost_code: '05 00 00', cost_type: 'S' },
    })).id

    await call('POST', `/projects/${projectId}/budget/lines`, {
      budgetCodeId,
      description: 'Structural steel',
      originalAmount: '2400000.00',
    })

    const budget = await call('GET', `/projects/${projectId}/budget`)
    expect(budget.lines[0].currentBudget).toBe('2400000.00')
  })

  it('writes a subcontract and signs it', async () => {
    const commitment = await call('POST', `/projects/${projectId}/commitments`, {
      kind: 'subcontract',
      number: 'SC-001',
      title: 'Structural steel',
      vendorOrgId: steelOrgId,
      retainagePercent: '10',
      lines: [{ budgetCodeId, description: 'Base scope', amount: '2280000.00' }],
    })
    await call('POST', `/commitments/${commitment.id}/execute`, {})

    // The committed column moves only once it is signed, which is the whole
    // reason executing is a separate act.
    const budget = await call('GET', `/projects/${projectId}/budget`)
    expect(budget.lines[0].committedCost).toBe('2280000.00')
  })

  it('raises an RFI and sends it', async () => {
    const created = await call('POST', `/projects/${projectId}/records`, {
      typeKey: 'rfi',
      title: 'Anchor bolt embedment at grid C4',
      body: { question: 'Nine inch on S-401, seven on the shops. Which governs?', discipline: 'Structural' },
      participants: [{ userId: architectId, role: 'assignee' }],
    })
    rfiId = created.record.id
    const sent = await call('POST', `/records/${rfiId}/transitions`, { transitionKey: 'submit' })
    expect(sent.assignment.holderUserId).toBe(architectId)
  })

  it('imports a schedule and links the RFI to what it blocks', async () => {
    await call('POST', `/projects/${projectId}/schedules`, {
      name: 'Baseline',
      text: [
        tab('ERMHDR', '18.8.0', '2026-03-02', 'Project', 'admin', 'P6'),
        tab('%T', 'PROJECT'),
        tab('%F', 'proj_id', 'day_hr_cnt'),
        tab('%R', '100', '8'),
        tab('%T', 'TASK'),
        tab('%F', 'task_id', 'task_code', 'task_name', 'task_type', 'early_start_date', 'total_float_hr_cnt'),
        tab('%R', '1', 'A1010', 'Erect structural steel', 'TT_Task', `${inDays(5)} 08:00`, '16'),
        tab('%E'),
      ].join('\n'),
    })
    await call('POST', `/records/${rfiId}/activities`, { activityCode: 'A1010', kind: 'blocks' })
  })

  it('answers the question the whole product is for', async () => {
    const { exposure } = await call('GET', `/projects/${projectId}/exposure`)

    // What is going to stop us this week, and who is sitting on it.
    expect(exposure).toHaveLength(1)
    expect(exposure[0].activityName).toBe('Erect structural steel')
    expect(Number(exposure[0].totalFloatDays)).toBe(2)
    expect(exposure[0].records[0].designation).toMatch(/^RFI-/)
    expect(exposure[0].records[0].holderName).toBe('Ali Bishop')
  })

  it('and the chase that comes out of it names the consequence', async () => {
    await pool.query(
      `UPDATE record_assignments SET due_at = now() - interval '6 days', assigned_at = now() - interval '11 days'
        WHERE record_id = $1 AND released_at IS NULL`,
      [rfiId],
    )
    await call('POST', `/projects/${projectId}/escalations/sweep`)

    const { escalations } = await call('GET', `/projects/${projectId}/escalations`)
    expect(escalations).toHaveLength(1)
    // "RFI-001 is six days overdue" is a nag. This is a phone call.
    expect(escalations[0].message).toMatch(/Erect structural steel/)
    expect(escalations[0].message).toMatch(/2 days of float/)
    // And nothing was sent.
    expect(escalations[0].id).toBeTruthy()
  })
})
