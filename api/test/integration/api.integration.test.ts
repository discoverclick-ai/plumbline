import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import {
  addProjectMember,
  createOrganization,
  createPool,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
  withTenant,
} from '@plumbline/shared'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createApiServer } from '../../src/server.js'

/**
 * The API over a real database and a real HTTP socket. These assert the two
 * things a client depends on and unit tests cannot show: that a permission
 * failure comes back as 403 rather than a 500, and that the workflow can be
 * driven end to end over the wire by a caller who knows nothing but the record
 * type registry.
 */

let pool: Pool
let server: Server
let baseUrl: string

let pmToken: string
let architectToken: string
let tradeToken: string
let projectId: string
let architectUserId: string

const PASSWORD = 'a-long-enough-password'

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  return { status: res.status, body: await res.json() }
}

async function signIn(email: string): Promise<string> {
  const res = await call('POST', '/auth/sign-in', { body: { email, password: PASSWORD } })
  expect(res.status).toBe(200)
  return res.body.token as string
}

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  server = createApiServer(pool)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const tenant = await provisionTenant(pool, {
    tenantName: 'Cross Creek Construction',
    admin: { email: 'admin@crosscreek.test', name: 'Avery Admin', password: PASSWORD },
  })

  await withTenant(pool, tenant.tenantId, async (tx) => {
    const design = await createOrganization(tx, tenant.tenantId, { name: 'Lark Design', kind: 'architect' })
    const trades = await createOrganization(tx, tenant.tenantId, {
      name: 'Bellweather Mechanical',
      kind: 'specialty_contractor',
    })

    const pmId = await createUser(tx, tenant.tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@crosscreek.test',
      name: 'Pat Moreno',
      password: PASSWORD,
      companyPermissionTemplateId: await findTemplateByName(tx, tenant.tenantId, 'company', 'Employee'),
    })
    architectUserId = await createUser(tx, tenant.tenantId, {
      organizationId: design,
      email: 'aor@lark.test',
      name: 'Lee Lark',
      password: PASSWORD,
      companyPermissionTemplateId: await findTemplateByName(tx, tenant.tenantId, 'company', 'Collaborator'),
    })
    const tradeId = await createUser(tx, tenant.tenantId, {
      organizationId: trades,
      email: 'foreman@bellweather.test',
      name: 'Bo Bell',
      password: PASSWORD,
      companyPermissionTemplateId: await findTemplateByName(tx, tenant.tenantId, 'company', 'Collaborator'),
    })

    projectId = await createProject(tx, tenant.tenantId, { number: '26-004', name: 'Cross Creek Medical Office' })

    for (const [userId, template] of [
      [pmId, 'Project Manager'],
      [architectUserId, 'Design Team'],
      [tradeId, 'Trade Partner'],
    ] as const) {
      await addProjectMember(tx, tenant.tenantId, {
        projectId,
        userId,
        permissionTemplateId: await findTemplateByName(tx, tenant.tenantId, 'project', template),
      })
    }
  })

  pmToken = await signIn('pm@crosscreek.test')
  architectToken = await signIn('aor@lark.test')
  tradeToken = await signIn('foreman@bellweather.test')
})

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  await pool?.end()
})

describe('authentication', () => {
  it('refuses an unauthenticated request', async () => {
    const res = await call('GET', '/projects')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('unauthenticated')
  })

  it('refuses a wrong password without saying which half was wrong', async () => {
    const res = await call('POST', '/auth/sign-in', {
      body: { email: 'pm@crosscreek.test', password: 'not-the-password' },
    })
    expect(res.status).toBe(401)
    expect(res.body.message).toBe('Email or password is incorrect')
  })

  it('stops a token working the moment the session is signed out', async () => {
    const token = await signIn('pm@crosscreek.test')
    expect((await call('GET', '/me', { token })).status).toBe(200)
    expect((await call('POST', '/auth/sign-out', { token })).status).toBe(200)
    expect((await call('GET', '/me', { token })).status).toBe(401)
  })
})

describe('the record surface', () => {
  it('publishes the type registry, so a client can render a tool it has never seen', async () => {
    const res = await call('GET', '/record-types', { token: pmToken })
    expect(res.status).toBe(200)
    const keys = res.body.types.map((t: { key: string }) => t.key)
    expect(keys).toContain('rfi')
    expect(keys).toContain('submittal')
    const rfi = res.body.types.find((t: { key: string }) => t.key === 'rfi')
    expect(rfi.fields.some((f: { key: string }) => f.key === 'question')).toBe(true)
    expect(rfi.states.map((s: { key: string }) => s.key)).toContain('answered')
  })

  it('drives an RFI from creation to close over HTTP', async () => {
    const created = await call('POST', `/projects/${projectId}/records`, {
      token: pmToken,
      body: {
        typeKey: 'rfi',
        title: 'Duct routing conflict above grid 7',
        body: { question: 'Confirm clearance for the 24in duct above the corridor ceiling.' },
        participants: [{ userId: architectUserId, role: 'assignee' }],
      },
    })
    expect(created.status).toBe(201)
    expect(created.body.record.status).toBe('draft')
    const recordId = created.body.record.id as string

    const submitted = await call('POST', `/records/${recordId}/transitions`, {
      token: pmToken,
      body: { transitionKey: 'submit' },
    })
    expect(submitted.status).toBe(200)
    expect(submitted.body.record.ballInCourtUserId).toBe(architectUserId)

    // The architect's own workload, with no project named.
    const workload = await call('GET', '/ball-in-court', { token: architectToken })
    expect(workload.body.entries.some((e: { recordId: string }) => e.recordId === recordId)).toBe(true)

    const answered = await call('POST', `/records/${recordId}/transitions`, {
      token: architectToken,
      body: { transitionKey: 'answer', body: { answer: 'Reroute per sketch SK-12; clearance holds at 9in.' } },
    })
    expect(answered.status).toBe(200)
    expect(answered.body.record.status).toBe('answered')

    const closed = await call('POST', `/records/${recordId}/transitions`, {
      token: pmToken,
      body: { transitionKey: 'close' },
    })
    expect(closed.status).toBe(200)
    expect(closed.body.record.closedAt).not.toBeNull()

    const history = await call('GET', `/records/${recordId}/history`, { token: pmToken })
    expect(history.body.states.map((s: { transitionKey: string }) => s.transitionKey)).toEqual([
      'create',
      'submit',
      'answer',
      'close',
    ])
  })

  it('returns 403, not 500, when the actor may not run the transition', async () => {
    const created = await call('POST', `/projects/${projectId}/records`, {
      token: pmToken,
      body: {
        typeKey: 'rfi',
        title: 'Not the trade partner’s to answer',
        body: { question: 'Confirm anchor spacing.' },
        participants: [{ userId: architectUserId, role: 'assignee' }],
      },
    })
    await call('POST', `/records/${created.body.record.id}/transitions`, {
      token: pmToken,
      body: { transitionKey: 'submit' },
    })

    const refused = await call('POST', `/records/${created.body.record.id}/transitions`, {
      token: tradeToken,
      body: { transitionKey: 'answer', body: { answer: 'sure' } },
    })
    expect(refused.status).toBe(403)
    expect(refused.body.error).toBe('permission_denied')
  })

  it('returns 422 with per-field issues when the body is wrong', async () => {
    const res = await call('POST', `/projects/${projectId}/records`, {
      token: pmToken,
      body: { typeKey: 'rfi', title: 'Missing the question', body: { cost_impact: 'Perhaps' } },
    })
    expect(res.status).toBe(422)
    const fields = res.body.issues.map((i: { field: string }) => i.field)
    expect(fields).toContain('question')
    expect(fields).toContain('cost_impact')
  })

  it('tells each user what they may do, so the UI does not offer refused buttons', async () => {
    const pmView = await call('GET', `/me?projectId=${projectId}`, { token: pmToken })
    expect(pmView.body.tools.rfis.level).toBe('standard')
    expect(pmView.body.tools.rfis.privileges).toContain('respond')

    const tradeView = await call('GET', `/me?projectId=${projectId}`, { token: tradeToken })
    expect(tradeView.body.tools.rfis.level).toBe('read_only')
    expect(tradeView.body.tools.daily_log.level).toBe('none')
  })

  it('shows a user only the projects they are on', async () => {
    const res = await call('GET', '/projects', { token: tradeToken })
    expect(res.status).toBe(200)
    expect(res.body.projects).toHaveLength(1)
    expect(res.body.projects[0].number).toBe('26-004')
  })

  it('answers 404 for an unknown route and 405 for the wrong method', async () => {
    expect((await call('GET', '/nope', { token: pmToken })).status).toBe(404)
    expect((await call('DELETE', '/projects', { token: pmToken })).status).toBe(405)
  })
})
