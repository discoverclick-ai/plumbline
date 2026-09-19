import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import {
  addProjectMember,
  createBudgetCode,
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
import type { InterpretationProvider, ProviderRequest, ProviderResponse } from '@plumbline/shared'

/** Scripted interpreter: the capture routes are exercised with no network. */
class ScriptedProvider implements InterpretationProvider {
  readonly name = 'scripted'
  private readonly queue: unknown[] = []
  push(output: unknown): void {
    this.queue.push(output)
  }
  async interpret(_request: ProviderRequest): Promise<ProviderResponse> {
    const next = this.queue.shift()
    if (next === undefined) throw new Error('ScriptedProvider ran out of queued outputs')
    return {
      output: next,
      model: 'claude-opus-5',
      usage: { inputTokens: 900, outputTokens: 140, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }
  }
}

const scripted = new ScriptedProvider()

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
let tenant: { tenantId: string; organizationId: string; adminUserId: string }

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

/** Bytes in, bytes out, plus the response headers a download depends on. */
async function raw(
  method: string,
  path: string,
  options: { token?: string; contentType?: string; headers?: Record<string, string>; body?: Buffer } = {},
): Promise<{ status: number; headers: Record<string, string>; bytes: Buffer }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.contentType ? { 'content-type': options.contentType } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    },
    ...(options.body === undefined ? {} : { body: new Uint8Array(options.body) }),
  })
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    bytes: Buffer.from(await res.arrayBuffer()),
  }
}

async function signIn(email: string): Promise<string> {
  const res = await call('POST', '/auth/sign-in', { body: { email, password: PASSWORD } })
  expect(res.status).toBe(200)
  return res.body.token as string
}

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  server = createApiServer(pool, { interpretationProvider: scripted })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tenant = await provisionTenant(pool, {
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
        permissionTemplateName: template,
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

    // A trade partner may raise an RFI and send it, which needs `standard`,
    // and may not answer one. Asserting the level alone hid the fact that
    // read_only plus a create privilege produced an RFI nobody could submit.
    const tradeView = await call('GET', `/me?projectId=${projectId}`, { token: tradeToken })
    expect(tradeView.body.tools.rfis.level).toBe('standard')
    expect(tradeView.body.tools.rfis.privileges).toContain('create')
    expect(tradeView.body.tools.rfis.privileges).not.toContain('respond')
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

/**
 * The capture pipeline over HTTP, with a scripted interpreter. No network, no
 * key: the provider seam exists precisely so this is testable.
 */
describe('the capture pipeline', () => {
  it('goes from a field capture to an accepted record, and refuses to skip the gate', async () => {
    const captured = await call('POST', `/projects/${projectId}/captures`, {
      token: tradeToken,
      body: {
        kind: 'photo',
        text: 'Photo shows a missing guardrail at the level 4 stair opening.',
        storageKey: 'captures/2026/03/guardrail.jpg',
        contentType: 'image/jpeg',
        byteSize: 1_800_000,
      },
    })
    // A trade partner may always send signal, whatever else they may not do.
    expect(captured.status).toBe(201)
    expect(captured.body.status).toBe('received')

    scripted.push({
      typeKey: 'observation',
      title: 'Missing guardrail at level 4 stair',
      fields: [
        { key: 'description', value: 'Guardrail missing at the level 4 stair opening.' },
        { key: 'observation_type', value: 'Safety' },
      ],
      participants: [],
      confidence: 0.91,
      rationale: 'The photo shows an unsafe condition on site.',
    })

    const interpreted = await call('POST', `/captures/${captured.body.id}/interpret`, { token: tradeToken })
    expect(interpreted.status).toBe(200)
    expect(interpreted.body.status).toBe('pending')
    expect(interpreted.body.recordId).toBeNull()

    const inbox = await call('GET', `/projects/${projectId}/proposals`, { token: pmToken })
    expect(inbox.body.proposals.some((p: { id: string }) => p.id === interpreted.body.id)).toBe(true)

    // The trade partner drafted it but cannot decide it.
    const refused = await call('POST', `/proposals/${interpreted.body.id}/reject`, {
      token: tradeToken,
      body: { note: 'not mine to judge' },
    })
    expect(refused.status).toBe(403)

    const accepted = await call('POST', `/proposals/${interpreted.body.id}/accept`, { token: pmToken })
    expect(accepted.status).toBe(200)
    expect(accepted.body.record.record.designation).toMatch(/^OBS-\d{3}$/)
    expect(accepted.body.proposal.status).toBe('accepted')

    const stats = await call('GET', `/projects/${projectId}/capture-stats`, { token: pmToken })
    expect(stats.body.accepted).toBeGreaterThan(0)
    expect(stats.body.costMicros).toBeGreaterThan(0)
  })
})

describe('the money, over HTTP', () => {
  it('walks a budget line, a signed subcontract and an invoice through the API', async () => {
    // A budget code, made the way the WBS module makes them.
    const codeId = (
      await createBudgetCode(pool, tenant.tenantId, {
        projectId,
        values: { cost_code: '26 00 00', cost_type: 'S' },
      })
    ).id

    const line = await call('POST', `/projects/${projectId}/budget/lines`, {
      token: pmToken,
      body: { budgetCodeId: codeId, description: 'Electrical', originalAmount: '400000.00' },
    })
    expect(line.status).toBe(200)

    const budget = await call('GET', `/projects/${projectId}/budget`, { token: pmToken })
    expect(budget.body.lines[0].currentBudget).toBe('400000.00')
    // Nothing is committed until somebody signs something.
    expect(budget.body.lines[0].committedCost).toBe('0')

    const vendorOrgId = await withTenant(pool, tenant.tenantId, (tx) =>
      createOrganization(tx, tenant.tenantId, { name: 'Api Electric', kind: 'specialty_contractor' }),
    )
    const commitment = await call('POST', `/projects/${projectId}/commitments`, {
      token: pmToken,
      body: {
        kind: 'subcontract',
        number: 'SC-API-1',
        title: 'Electrical',
        vendorOrgId,
        retainagePercent: '10.00',
        lines: [{ budgetCodeId: codeId, description: 'Rough-in', amount: '200000.00' }],
      },
    })
    expect(commitment.status).toBe(200)

    const executed = await call('POST', `/commitments/${commitment.body.id}/execute`, { token: pmToken, body: {} })
    expect(executed.status).toBe(200)

    const afterSigning = await call('GET', `/projects/${projectId}/budget`, { token: pmToken })
    expect(afterSigning.body.lines[0].committedCost).toBe('200000.00')

    const billing = await call('GET', `/commitments/${commitment.body.id}/invoices`, { token: pmToken })
    const invoice = await call('POST', `/commitments/${commitment.body.id}/invoices`, {
      token: pmToken,
      body: {
        number: '1',
        periodStart: '2026-04-01',
        periodEnd: '2026-04-30',
        lines: [
          { commitmentLineId: billing.body.lines[0].commitmentLineId, amount: '50000.00', retainageAmount: '5000.00' },
        ],
      },
    })
    expect(invoice.status).toBe(200)

    // Over-billing is refused at the API too, with the remaining balance.
    const tooMuch = await call('POST', `/commitments/${commitment.body.id}/invoices`, {
      token: pmToken,
      body: {
        number: '2',
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
        lines: [{ commitmentLineId: billing.body.lines[0].commitmentLineId, amount: '200000.00' }],
      },
    })
    expect(tooMuch.status).toBe(422)
    expect(JSON.stringify(tooMuch.body)).toContain('150000.00')
  })

  it('keeps a trade partner out of the budget entirely', async () => {
    const res = await call('GET', `/projects/${projectId}/budget`, { token: tradeToken })
    expect(res.status).toBe(403)
  })
})

describe('attachments, over HTTP', () => {
  it('uploads raw bytes and hands them back with a download disposition', async () => {
    const created = await call('POST', `/projects/${projectId}/records`, {
      token: pmToken,
      body: {
        typeKey: 'observation',
        title: 'Attachment round trip',
        body: { description: 'Something worth a photo.', observation_type: 'Quality' },
      },
    })

    const pdf = Buffer.from('%PDF-1.7 sketch')
    const upload = await raw('POST', `/records/${created.body.record.id}/attachments`, {
      token: pmToken,
      contentType: 'application/pdf',
      headers: { 'x-filename': encodeURIComponent('SK-12 detail.pdf') },
      body: pdf,
    })
    // This is the assertion that would have caught `binary` being dropped in
    // the route builder: without it the upload goes through the JSON parser.
    expect(upload.status).toBe(200)

    const listed = await call('GET', `/records/${created.body.record.id}/attachments`, { token: pmToken })
    expect(listed.body.attachments[0].filename).toBe('SK-12 detail.pdf')

    const download = await raw('GET', `/attachments/${listed.body.attachments[0].id}`, { token: pmToken })
    expect(download.status).toBe(200)
    expect(download.headers['content-type']).toBe('application/pdf')
    // Always an attachment, never inline: an HTML or SVG rendered inline
    // would run in this origin and every party on the job can upload.
    expect(download.headers['content-disposition']).toContain('attachment;')
    expect(download.headers['x-content-type-options']).toBe('nosniff')
    expect(download.bytes.equals(pdf)).toBe(true)
  })
})

describe('the accounting export', () => {
  it('hands back a CSV as a download, for the person who cannot see it to be refused', async () => {
    const download = await raw('GET', `/projects/${projectId}/erp-export`, { token: pmToken })
    expect(download.status).toBe(200)
    expect(download.headers['content-type']).toBe('text/csv')
    expect(download.headers['content-disposition']).toContain('attachment;')
    expect(download.bytes.toString('utf8')).toContain('cost_code,cost_type')

    // Same permission as looking at the budget on screen. A download route
    // with its own check is a second place for that decision to drift.
    const refused = await raw('GET', `/projects/${projectId}/erp-export`, { token: tradeToken })
    expect(refused.status).toBe(403)
  })
})

describe('drawings, over HTTP', () => {
  it('issues a set, publishes it, and pins a record to the sheet', async () => {
    const set = await call('POST', `/projects/${projectId}/drawing-sets`, {
      token: pmToken,
      body: { name: 'API set', issuedOn: '2026-05-04' },
    })
    expect(set.status).toBe(200)

    const sheet = Buffer.from('%PDF-1.7 api sheet')
    const upload = await raw('POST', `/drawing-sets/${set.body.id}/sheets`, {
      token: pmToken,
      contentType: 'application/pdf',
      headers: {
        'x-sheet-number': 'S-401',
        'x-sheet-title': encodeURIComponent('Typical details'),
        'x-revision': '0',
      },
      body: sheet,
    })
    expect(upload.status).toBe(200)

    // Nothing is current until the set is published, because a crew building
    // from a check set is the accident the tool exists to prevent.
    const beforePublish = await call('GET', `/projects/${projectId}/drawings`, { token: pmToken })
    expect(beforePublish.body.sheets).toHaveLength(0)

    const published = await call('POST', `/drawing-sets/${set.body.id}/publish`, { token: pmToken, body: {} })
    expect(published.status).toBe(200)

    const current = await call('GET', `/projects/${projectId}/drawings`, { token: pmToken })
    expect(current.body.sheets[0].number).toBe('S-401')
    expect(current.body.sheets[0].revisionLabel).toBe('0')

    const record = await call('POST', `/projects/${projectId}/records`, {
      token: pmToken,
      body: {
        typeKey: 'rfi',
        title: 'Pinned to the sheet',
        body: { question: 'Which detail governs?', discipline: 'Structural' },
      },
    })
    const pin = await call('POST', `/drawing-revisions/${current.body.sheets[0].revisionId}/pins`, {
      token: pmToken,
      body: { recordId: record.body.record.id, x: 0.25, y: 0.5 },
    })
    expect(pin.status).toBe(200)

    const pins = await call('GET', `/drawings/${current.body.sheets[0].drawingId}/pins`, { token: pmToken })
    expect(pins.body.pins[0].recordId).toBe(record.body.record.id)
    expect(pins.body.pins[0].onCurrentRevision).toBe(true)

    const file = await raw('GET', `/drawing-revisions/${current.body.sheets[0].revisionId}/file`, { token: pmToken })
    expect(file.headers['content-type']).toBe('application/pdf')
    expect(file.bytes.equals(sheet)).toBe(true)
  })
})

describe('the MCP surface over the wire', () => {
  it('will not describe its tools to an anonymous caller', async () => {
    // Tool discovery reads like public metadata and is not: the list names
    // record types, and the record types are the customer's operation.
    expect((await call('GET', '/mcp/tools')).status).toBe(401)
    expect((await call('POST', '/mcp/call', { body: { name: 'list_record_types' } })).status).toBe(401)
  })

  it('lists tools, and marks which ones write', async () => {
    const res = await call('GET', '/mcp/tools', { token: pmToken })
    expect(res.status).toBe(200)

    const names = res.body.tools.map((t: { name: string }) => t.name)
    expect(names).toContain('ball_in_court')
    expect(names).toContain('transition_record')

    const writes = res.body.tools.filter((t: { mutating: boolean }) => t.mutating).map((t: { name: string }) => t.name)
    // A client shows this before it approves a call, so it has to be right.
    expect(writes).toEqual(['create_record', 'transition_record', 'comment_on_record'])
  })

  it('drives the workflow end to end as the signed-in person', async () => {
    const created = await call('POST', '/mcp/call', {
      token: pmToken,
      body: {
        name: 'create_record',
        arguments: {
          projectId,
          typeKey: 'rfi',
          title: 'Raised by an agent',
          body: { question: 'Which detail governs at the canopy?', discipline: 'Architectural' },
          assigneeUserId: architectUserId,
        },
      },
    })
    expect(created.status).toBe(200)
    const recordId = created.body.result.record.id

    const read = await call('POST', '/mcp/call', {
      token: pmToken,
      body: { name: 'get_record', arguments: { recordId } },
    })
    expect(read.body.result.record.id).toBe(recordId)
    expect(read.body.result.availableTransitions.length).toBeGreaterThan(0)

    const moved = await call('POST', '/mcp/call', {
      token: pmToken,
      body: {
        name: 'transition_record',
        arguments: { recordId, transitionKey: read.body.result.availableTransitions[0].key },
      },
    })
    expect(moved.status).toBe(200)
    expect(moved.body.result.assignment.holderUserId).toBe(architectUserId)
  })

  it('returns a refusal as a refusal, not a 500', async () => {
    const bogus = await call('POST', '/mcp/call', { token: pmToken, body: { name: 'drop_everything' } })
    expect(bogus.status).toBe(400)
    expect(bogus.body.error).toBe('unknown_tool')

    const missing = await call('POST', '/mcp/call', {
      token: pmToken,
      body: { name: 'get_record', arguments: {} },
    })
    expect(missing.status).toBe(400)
  })
})
