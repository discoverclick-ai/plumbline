import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { CaptureService } from '../../src/capture/service.js'
import { createPool, withTenant } from '../../src/db.js'
import { KernelError, PermissionDeniedError, ValidationError } from '../../src/errors.js'
import { RecordKernel, type Actor } from '../../src/kernel.js'
import {
  addProjectMember,
  createOrganization,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
} from '../../src/provisioning.js'
import { ScriptedProvider } from '../support/scripted-provider.js'

/**
 * The capture pipeline end to end: a superintendent dictates a note walking
 * the deck, an agent drafts the observation, a human accepts it, and a record
 * exists with the signal attached and the provenance written down.
 *
 * The assertions that matter most are the ones about what the pipeline REFUSES
 * to do. An agent may propose anything and create nothing; that is the whole
 * design, and it is only true if the gate cannot be walked around.
 */

let pool: Pool
let provider: ScriptedProvider
let capture: CaptureService
let kernel: RecordKernel

let tenantId: string
let projectId: string
let otherProjectId: string
let superintendent: Actor
let pm: Actor
let trade: Actor
let architectUserId: string

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  provider = new ScriptedProvider()
  capture = new CaptureService(pool, provider)
  kernel = new RecordKernel(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Longview Builders',
    admin: { email: 'admin@longview.test', name: 'Del Admin', password: 'a-long-enough-password' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const design = await createOrganization(tx, tenantId, { name: 'Ward Architects', kind: 'architect' })
    const steel = await createOrganization(tx, tenantId, { name: 'Ironside Steel', kind: 'specialty_contractor' })
    const employee = await findTemplateByName(tx, tenantId, 'company', 'Employee')
    const collaborator = await findTemplateByName(tx, tenantId, 'company', 'Collaborator')

    const superId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'super@longview.test',
      name: 'Sam Ruiz',
      jobTitle: 'Superintendent',
      companyPermissionTemplateId: employee,
    })
    const pmId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@longview.test',
      name: 'Priya Mehta',
      jobTitle: 'Project Manager',
      companyPermissionTemplateId: employee,
    })
    architectUserId = await createUser(tx, tenantId, {
      organizationId: design,
      email: 'aor@ward.test',
      name: 'Ali Ward',
      companyPermissionTemplateId: collaborator,
    })
    const tradeId = await createUser(tx, tenantId, {
      organizationId: steel,
      email: 'foreman@ironside.test',
      name: 'Tomas Vega',
      companyPermissionTemplateId: collaborator,
    })

    projectId = await createProject(tx, tenantId, { number: '26-101', name: 'Longview Deck' })
    otherProjectId = await createProject(tx, tenantId, { number: '26-102', name: 'Unrelated Job' })

    for (const [userId, template] of [
      [superId, 'Superintendent'],
      [pmId, 'Project Manager'],
      [architectUserId, 'Design Team'],
      [tradeId, 'Trade Partner'],
    ] as const) {
      await addProjectMember(tx, tenantId, {
        projectId,
        userId,
        permissionTemplateId: await findTemplateByName(tx, tenantId, 'project', template),
      })
    }

    superintendent = { tenantId, userId: superId }
    pm = { tenantId, userId: pmId }
    trade = { tenantId, userId: tradeId }
  })
})

afterAll(async () => {
  await pool?.end()
})

const OBSERVATION_DRAFT = {
  typeKey: 'observation',
  title: 'Guardrail missing at level 5 north',
  fields: [
    { key: 'description', value: 'Guardrail missing on the north side of level 5 at the stair opening.' },
    { key: 'observation_type', value: 'Safety' },
    { key: 'priority', value: 'High' },
  ],
  participants: [],
  confidence: 0.88,
  rationale: 'The note describes an unsafe condition seen on site, which is an observation.',
}

async function voiceNote(text = 'No guardrail on the north side of five, by the stair opening.') {
  return capture.record(superintendent, {
    projectId,
    kind: 'voice',
    text,
    capturedAt: new Date('2026-03-02T14:05:00Z'),
    latitude: 47.61,
    longitude: -122.33,
  })
}

describe('capture to record', () => {
  it('turns a voice note into an accepted observation', async () => {
    const signal = await voiceNote()
    expect(signal.status).toBe('received')

    provider.push(OBSERVATION_DRAFT)
    const proposal = await capture.interpret(superintendent, signal.id)

    expect(proposal.status).toBe('pending')
    expect(proposal.typeKey).toBe('observation')
    expect(proposal.confidence).toBe(0.88)
    expect(proposal.issues).toEqual([])
    expect(proposal.recordId).toBeNull()

    // Nothing exists yet. This is the point of the whole design.
    const beforeAcceptance = await kernel.list(superintendent, { projectId, typeKey: 'observation' })
    expect(beforeAcceptance.some((r) => r.title === OBSERVATION_DRAFT.title)).toBe(false)

    const { record, proposal: decided } = await capture.accept(superintendent, proposal.id)
    expect(record.record.designation).toMatch(/^OBS-\d{3}$/)
    expect(record.record.body['description']).toContain('north side of level 5')
    expect(record.record.createdBy).toBe(superintendent.userId)
    expect(decided.status).toBe('accepted')
    expect(decided.edited).toBe(false)
    expect(decided.recordId).toBe(record.record.id)
  })

  it('writes provenance on the record: which capture, which model, who accepted', async () => {
    const signal = await voiceNote('Handrail loose on the east stair.')
    provider.push({ ...OBSERVATION_DRAFT, title: 'Loose handrail, east stair' })
    const proposal = await capture.interpret(superintendent, signal.id)
    const { record } = await capture.accept(pm, proposal.id)

    const { rows } = await withTenant(pool, tenantId, (tx) =>
      tx.query<{ event: string; payload: Record<string, unknown>; actor_user_id: string }>(
        'SELECT event, payload, actor_user_id FROM record_events WHERE record_id = $1 ORDER BY id',
        [record.record.id],
      ),
    )
    const provenance = rows.find((r) => r.event === 'record.accepted_from_capture')
    expect(provenance).toBeDefined()
    expect(provenance?.payload['captureId']).toBe(signal.id)
    expect(provenance?.payload['model']).toBe('claude-opus-5')
    expect(provenance?.payload['captureKind']).toBe('voice')
    // A year from now, in a claim, this is the answer to "who decided this".
    expect(provenance?.actor_user_id).toBe(pm.userId)
  })

  it('records what the interpretation cost, priced at the time it ran', async () => {
    const signal = await voiceNote('Debris blocking the egress path on two.')
    provider.push(OBSERVATION_DRAFT)
    await capture.interpret(superintendent, signal.id)

    const { rows } = await withTenant(pool, tenantId, (tx) =>
      tx.query<{ model: string; input_tokens: number; cost_micros: string; purpose: string }>(
        'SELECT model, input_tokens, cost_micros, purpose FROM ai_usage WHERE capture_id = $1',
        [signal.id],
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.purpose).toBe('capture.interpret')
    expect(rows[0]?.input_tokens).toBe(1_200)
    // Opus 5 rates: 1200 input at $5/MTok = 6000 micros, 180 output at
    // $25/MTok = 4500, 900 cache reads at a tenth of input = 450.
    expect(Number(rows[0]?.cost_micros)).toBe(10_950)
  })

  it('marks a proposal edited when the human changed it before accepting', async () => {
    const signal = await voiceNote('Something about the west elevation.')
    provider.push({ ...OBSERVATION_DRAFT, title: 'Vague note' })
    const proposal = await capture.interpret(superintendent, signal.id)

    const { proposal: decided, record } = await capture.accept(pm, proposal.id, {
      title: 'Efflorescence on west elevation CMU',
      body: { priority: 'Low' },
    })
    // This ratio is the quality metric for the pipeline, which is why it is a
    // column and not a log line.
    expect(decided.edited).toBe(true)
    expect(record.record.title).toBe('Efflorescence on west elevation CMU')
    expect(record.record.body['priority']).toBe('Low')
  })

  it('attaches the original signal to the record it became', async () => {
    const signal = await capture.record(superintendent, {
      projectId,
      kind: 'photo',
      text: 'Photo shows an unguarded floor opening near column C4.',
      storageKey: 'captures/2026/03/abc123.jpg',
      contentType: 'image/jpeg',
      byteSize: 2_400_000,
    })
    provider.push({ ...OBSERVATION_DRAFT, title: 'Unguarded floor opening at C4' })
    const proposal = await capture.interpret(superintendent, signal.id)
    const { record } = await capture.accept(superintendent, proposal.id)

    const { rows } = await withTenant(pool, tenantId, (tx) =>
      tx.query<{ storage_key: string; content_type: string }>(
        'SELECT storage_key, content_type FROM record_attachments WHERE record_id = $1',
        [record.record.id],
      ),
    )
    expect(rows[0]?.storage_key).toBe('captures/2026/03/abc123.jpg')
    expect(rows[0]?.content_type).toBe('image/jpeg')
  })
})

describe('the gate', () => {
  it('refuses to create a record the approver could not have created by hand', async () => {
    const signal = await capture.record(trade, {
      projectId,
      kind: 'text',
      text: 'Poured the east slab today, 14 guys, clear and cold.',
    })
    provider.push({
      typeKey: 'daily_log',
      title: 'Daily log 2026-03-02',
      fields: [
        { key: 'log_date', value: '2026-03-02' },
        { key: 'work_performed', value: 'Poured the east slab.' },
        { key: 'manpower_count', value: '14' },
      ],
      participants: [],
      confidence: 0.94,
      rationale: 'A summary of the day’s work.',
    })
    const proposal = await capture.interpret(trade, signal.id)
    expect(proposal.typeKey).toBe('daily_log')

    // The trade partner template grants 'none' on the daily log. A confident,
    // well-formed proposal changes nothing about that: acceptance runs as the
    // human, so it is refused exactly as hand entry would be.
    await expect(capture.accept(trade, proposal.id)).rejects.toBeInstanceOf(PermissionDeniedError)

    const { rows } = await withTenant(pool, tenantId, (tx) =>
      tx.query<{ status: string }>('SELECT status FROM capture_proposals WHERE id = $1', [proposal.id]),
    )
    expect(rows[0]?.status).toBe('pending')
  })

  it('refuses to accept a draft that is missing a required field', async () => {
    const signal = await voiceNote('Mumbled, inaudible.')
    provider.push({
      typeKey: 'observation',
      title: 'Unclear note',
      fields: [{ key: 'priority', value: 'Low' }],
      participants: [],
      confidence: 0.2,
      rationale: 'Could not make out the condition.',
    })
    const proposal = await capture.interpret(superintendent, signal.id)

    // The draft is kept with its gap named, rather than discarded.
    expect(proposal.issues.map((i) => i.field)).toContain('description')
    await expect(capture.accept(superintendent, proposal.id)).rejects.toBeInstanceOf(ValidationError)

    // And the approver can fix it at the gate, which is the normal path.
    const { record } = await capture.accept(superintendent, proposal.id, {
      body: { description: 'Could not determine the condition; re-walk required.' },
    })
    expect(record.record.status).toBe('draft')
  })

  it('decides a proposal exactly once', async () => {
    const signal = await voiceNote('Trip hazard at the south entry.')
    provider.push({ ...OBSERVATION_DRAFT, title: 'Trip hazard, south entry' })
    const proposal = await capture.interpret(superintendent, signal.id)

    await capture.accept(superintendent, proposal.id)
    await expect(capture.accept(superintendent, proposal.id)).rejects.toBeInstanceOf(KernelError)
    await expect(capture.reject(superintendent, proposal.id)).rejects.toBeInstanceOf(KernelError)
  })

  it('stops a trade partner deciding proposals', async () => {
    const signal = await voiceNote('Cracked pane on the second floor.')
    provider.push({ ...OBSERVATION_DRAFT, title: 'Cracked pane' })
    const proposal = await capture.interpret(superintendent, signal.id)
    // Trade Partner gets read_only on capture: they may send signal and see
    // their inbox, not decide what becomes a record.
    await expect(capture.reject(trade, proposal.id)).rejects.toBeInstanceOf(PermissionDeniedError)
  })
})

describe('grounding', () => {
  it('shows the model only the people on this project', async () => {
    const before = provider.requests.length
    const signal = await voiceNote('Check the roster grounding.')
    provider.push(OBSERVATION_DRAFT)
    await capture.interpret(superintendent, signal.id)

    const request = provider.requests[before]
    expect(request?.system).toContain('Longview Deck')
    expect(request?.system).toContain(architectUserId)
    expect(request?.system).toContain('Ward Architects')
    // Somebody on another job is not in this prompt.
    expect(request?.system).not.toContain('Unrelated Job')
  })

  it('offers every record type in the registry without naming one in code', async () => {
    const before = provider.requests.length
    const signal = await voiceNote('Check the type grounding.')
    provider.push(OBSERVATION_DRAFT)
    await capture.interpret(superintendent, signal.id)

    const system = provider.requests[before]?.system ?? ''
    for (const key of ['rfi', 'submittal', 'punch_item', 'observation', 'daily_log']) {
      expect(system).toContain(`${key} —`)
    }
  })
})

describe('failure and re-interpretation', () => {
  it('keeps the capture when the interpreter fails', async () => {
    const signal = await voiceNote('The model will fall over on this one.')
    provider.push(new Error('provider exploded'))
    await expect(capture.interpret(superintendent, signal.id)).rejects.toThrow('provider exploded')

    const failed = await capture.getCapture(superintendent, signal.id)
    expect(failed.status).toBe('failed')
    expect(failed.failureReason).toContain('provider exploded')
    // The signal is the asset; the draft can be retried.
    expect(failed.text).toContain('fall over')

    provider.push(OBSERVATION_DRAFT)
    const retried = await capture.interpret(superintendent, signal.id)
    expect(retried.status).toBe('pending')
    expect((await capture.getCapture(superintendent, signal.id)).status).toBe('interpreted')
  })

  it('supersedes the previous draft instead of showing two live ones', async () => {
    const signal = await voiceNote('Re-interpret me.')
    provider.push(OBSERVATION_DRAFT)
    const first = await capture.interpret(superintendent, signal.id)
    provider.push({ ...OBSERVATION_DRAFT, title: 'Second reading' })
    const second = await capture.interpret(superintendent, signal.id)

    expect(second.id).not.toBe(first.id)
    const inbox = await capture.inbox(superintendent, { projectId })
    const forCapture = inbox.filter((p) => p.captureId === signal.id)
    expect(forCapture).toHaveLength(1)
    expect(forCapture[0]?.id).toBe(second.id)
  })

  it('refuses to interpret a capture with nothing to read', async () => {
    const signal = await capture.record(superintendent, {
      projectId,
      kind: 'photo',
      storageKey: 'captures/pending-ocr.jpg',
      contentType: 'image/jpeg',
    })
    await expect(capture.interpret(superintendent, signal.id)).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('the inbox', () => {
  it('hides proposals for tools the reviewer cannot read', async () => {
    const signal = await capture.record(superintendent, {
      projectId,
      kind: 'text',
      text: 'Slab pour, 14 guys, cold and clear.',
    })
    provider.push({
      typeKey: 'daily_log',
      title: 'Daily log for the inbox test',
      fields: [
        { key: 'log_date', value: '2026-03-03' },
        { key: 'work_performed', value: 'Slab pour.' },
      ],
      participants: [],
      confidence: 0.9,
      rationale: 'Daily summary.',
    })
    const proposal = await capture.interpret(superintendent, signal.id)

    const superView = await capture.inbox(superintendent, { projectId })
    expect(superView.some((p) => p.id === proposal.id)).toBe(true)

    // The trade partner has no access to the daily log tool, so the inbox does
    // not become a side channel onto it.
    const tradeView = await capture.inbox(trade, { projectId })
    expect(tradeView.some((p) => p.id === proposal.id)).toBe(false)
  })

  it('reports what the pipeline cost and how often humans had to fix it', async () => {
    const stats = await capture.stats(pm, { projectId })
    expect(stats.captures).toBeGreaterThan(0)
    expect(stats.accepted).toBeGreaterThan(0)
    expect(stats.acceptedUnedited).toBeLessThanOrEqual(stats.accepted)
    expect(stats.costMicros).toBeGreaterThan(0)
  })
})
