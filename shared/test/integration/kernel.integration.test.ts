import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createPool, withTenant } from '../../src/db.js'
import { PermissionDeniedError, ValidationError, VersionConflictError } from '../../src/errors.js'
import { RecordKernel, type Actor } from '../../src/kernel.js'
import {
  addProjectMember,
  createOrganization,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
} from '../../src/provisioning.js'

/**
 * The kernel against a real database, running the workflow a general
 * contractor actually runs: a PM raises an RFI, the architect answers it, the
 * PM closes it, and at every step the ball sits in exactly one person's court.
 *
 * The cast is deliberately mixed. The trade partner and the architect are on
 * the same project with different templates, because the moment that stops
 * working the product is single-company software.
 */

let pool: Pool
let kernel: RecordKernel

let tenantId: string
let projectId: string
let pm: Actor
let architect: Actor
let trade: Actor
let super_: Actor

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  kernel = new RecordKernel(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Ridgeline Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@ridgeline.test', name: 'Dana Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const designOrg = await createOrganization(tx, tenantId, { name: 'Bishop Architects', kind: 'architect' })
    const steelOrg = await createOrganization(tx, tenantId, {
      name: 'Vega Steel',
      kind: 'specialty_contractor',
      trade: 'Structural Steel',
    })

    const employee = await findTemplateByName(tx, tenantId, 'company', 'Employee')
    const collaborator = await findTemplateByName(tx, tenantId, 'company', 'Collaborator')

    const pmId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@ridgeline.test',
      name: 'Priya Mehta',
      jobTitle: 'Project Manager',
      companyPermissionTemplateId: employee,
    })
    const superId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'super@ridgeline.test',
      name: 'Sam Ruiz',
      jobTitle: 'Superintendent',
      companyPermissionTemplateId: employee,
    })
    const architectId = await createUser(tx, tenantId, {
      organizationId: designOrg,
      email: 'aor@bishop.test',
      name: 'Ali Bishop',
      companyPermissionTemplateId: collaborator,
    })
    const tradeId = await createUser(tx, tenantId, {
      organizationId: steelOrg,
      email: 'foreman@vega.test',
      name: 'Tomas Vega',
      companyPermissionTemplateId: collaborator,
    })

    projectId = await createProject(tx, tenantId, {
      number: '24-118',
      name: 'Harbor Point Phase II',
      stage: 'course_of_construction',
      contractValue: '48500000.00',
    })

    for (const [userId, templateName] of [
      [pmId, 'Project Manager'],
      [superId, 'Superintendent'],
      [architectId, 'Design Team'],
      [tradeId, 'Trade Partner'],
    ] as const) {
      await addProjectMember(tx, tenantId, {
        projectId,
        userId,
        permissionTemplateName: templateName,
      })
    }

    pm = { tenantId, userId: pmId }
    super_ = { tenantId, userId: superId }
    architect = { tenantId, userId: architectId }
    trade = { tenantId, userId: tradeId }
  })
})

afterAll(async () => {
  await pool?.end()
})

async function newRfi(title = 'Anchor bolt embedment at grid C4') {
  return kernel.create(pm, {
    projectId,
    typeKey: 'rfi',
    title,
    body: { question: 'Which anchor detail governs at grid C4?', discipline: 'Structural' },
    participants: [{ userId: architect.userId, role: 'assignee' }],
  })
}

describe('the RFI lifecycle', () => {
  it('runs from draft to closed, moving the ball exactly once per step', async () => {
    const created = await newRfi()
    expect(created.record.designation).toMatch(/^RFI-\d{3}$/)
    expect(created.record.status).toBe('draft')
    expect(created.record.ballInCourtUserId).toBe(pm.userId)
    expect(created.availableTransitions.map((t) => t.key)).toContain('submit')

    const submitted = await kernel.transition(pm, created.record.id, { transitionKey: 'submit' })
    expect(submitted.record.status).toBe('open')
    expect(submitted.record.ballInCourtUserId).toBe(architect.userId)
    expect(submitted.assignment?.expectedAction).toBe('Answer this RFI')
    // dueInDays: 7 on the submit transition.
    const due = new Date(submitted.record.dueAt ?? '')
    expect(due.getTime()).toBeGreaterThan(Date.now())

    const answered = await kernel.transition(architect, created.record.id, {
      transitionKey: 'answer',
      body: { answer: 'Detail 5/S-401 governs. Embedment is 9 inches.' },
    })
    expect(answered.record.status).toBe('answered')
    expect(answered.record.ballInCourtUserId).toBe(pm.userId)
    expect(answered.record.body['answer']).toContain('9 inches')

    const closed = await kernel.transition(pm, created.record.id, { transitionKey: 'close' })
    expect(closed.record.status).toBe('closed')
    expect(closed.record.closedAt).not.toBeNull()
    expect(closed.record.ballInCourtUserId).toBeNull()
    expect(closed.assignment).toBeNull()
    expect(closed.availableTransitions.map((t) => t.key)).toEqual(['reopen'])

    const { states } = await kernel.history(pm, created.record.id)
    expect(states.map((s) => s.transitionKey)).toEqual(['create', 'submit', 'answer', 'close'])
    expect(states.at(-1)?.actorUserId).toBe(pm.userId)
  })

  it('numbers records per project and per type, without gaps', async () => {
    const first = await newRfi('First')
    const second = await newRfi('Second')
    expect(second.record.number).toBe(first.record.number + 1)

    const punch = await kernel.create(super_, {
      projectId,
      typeKey: 'punch_item',
      title: 'Touch up drywall at level 3 corridor',
      body: { description: 'Scuffed drywall, east corridor', location: 'L3 corridor' },
      participants: [{ userId: trade.userId, role: 'assignee' }],
    })
    // Separate sequence per type: the punch list does not inherit RFI numbers.
    expect(punch.record.designation).toBe('PI-001')
  })

  it('writes an event for every state change, for agents and for disputes', async () => {
    const created = await newRfi('Evented')
    await kernel.transition(pm, created.record.id, { transitionKey: 'submit' })

    const { rows } = await withTenant(pool, tenantId, (tx) =>
      tx.query<{ event: string; payload: Record<string, unknown> }>(
        'SELECT event, payload FROM record_events WHERE record_id = $1 ORDER BY id',
        [created.record.id],
      ),
    )
    expect(rows.map((r) => r.event)).toEqual(['record.created', 'record.transitioned'])
    expect(rows[1]?.payload['to']).toBe('open')
    expect(rows[1]?.payload['ballInCourt']).toBe(architect.userId)
  })
})

describe('authorization', () => {
  it('stops a trade partner answering the architect’s RFI', async () => {
    const created = await newRfi('Not yours to answer')
    await kernel.transition(pm, created.record.id, { transitionKey: 'submit' })

    await expect(
      kernel.transition(trade, created.record.id, {
        transitionKey: 'answer',
        body: { answer: 'Whatever is cheapest' },
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it('stops the author submitting an RFI they are not the creator of', async () => {
    const created = await newRfi('Creator-gated')
    // The superintendent has standard on RFIs but is not on this record.
    await expect(kernel.transition(super_, created.record.id, { transitionKey: 'submit' })).rejects.toBeInstanceOf(
      PermissionDeniedError,
    )
  })

  it('lets a read-only trade partner raise an RFI, because the template grants create', async () => {
    const created = await kernel.create(trade, {
      projectId,
      typeKey: 'rfi',
      title: 'Bolt pattern clarification',
      body: { question: 'Confirm bolt pattern at HSS column base.' },
      participants: [{ userId: architect.userId, role: 'assignee' }],
    })
    expect(created.record.status).toBe('draft')
    // Creating is granted; closing is not.
    expect(created.availableTransitions.map((t) => t.key)).not.toContain('close')
  })

  it('refuses to put someone on a record who is not on the project', async () => {
    const outsiderId = await withTenant(pool, tenantId, async (tx) => {
      const org = await createOrganization(tx, tenantId, { name: 'Unrelated Co', kind: 'other' })
      return createUser(tx, tenantId, { organizationId: org, email: 'nobody@unrelated.test', name: 'Nora Outside' })
    })

    await expect(
      kernel.create(pm, {
        projectId,
        typeKey: 'rfi',
        title: 'Misrouted',
        body: { question: 'q' },
        participants: [{ userId: outsiderId, role: 'assignee' }],
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('hides records from a tool the actor cannot read', async () => {
    await kernel.create(super_, {
      projectId,
      typeKey: 'daily_log',
      title: 'Daily log 2026-03-02',
      body: { log_date: '2026-03-02', work_performed: 'Steel erection, level 4.' },
    })

    // The Trade Partner template grants 'none' on the daily log.
    const visible = await kernel.list(trade, { projectId })
    expect(visible.some((r) => r.typeKey === 'daily_log')).toBe(false)
    const superintendentView = await kernel.list(super_, { projectId })
    expect(superintendentView.some((r) => r.typeKey === 'daily_log')).toBe(true)
  })
})

describe('data integrity', () => {
  it('refuses to answer an RFI with no answer written', async () => {
    const created = await newRfi('Needs an answer')
    await kernel.transition(pm, created.record.id, { transitionKey: 'submit' })
    await expect(
      kernel.transition(architect, created.record.id, { transitionKey: 'answer' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses a transition that is not legal from the current state', async () => {
    const created = await newRfi('Out of order')
    await expect(kernel.transition(pm, created.record.id, { transitionKey: 'close' })).rejects.toThrow(
      /Cannot Close from draft/,
    )
  })

  it('refuses a stale write instead of clobbering the other person’s edit', async () => {
    const created = await newRfi('Two trailers, one RFI')
    const staleVersion = created.record.version

    await kernel.update(pm, created.record.id, { title: 'Edited first' })
    await expect(
      kernel.update(pm, created.record.id, { title: 'Edited second', expectedVersion: staleVersion }),
    ).rejects.toBeInstanceOf(VersionConflictError)
  })

  it('keeps exactly one open assignment per record through a full round trip', async () => {
    const created = await newRfi('One ball only')
    await kernel.transition(pm, created.record.id, { transitionKey: 'submit' })
    await kernel.transition(architect, created.record.id, {
      transitionKey: 'answer',
      body: { answer: 'See detail 5/S-401.' },
    })

    const { rows } = await withTenant(pool, tenantId, (tx) =>
      tx.query<{ open_count: string; total: string }>(
        `SELECT COUNT(*) FILTER (WHERE released_at IS NULL) AS open_count, COUNT(*) AS total
           FROM record_assignments WHERE record_id = $1`,
        [created.record.id],
      ),
    )
    expect(Number(rows[0]?.open_count)).toBe(1)
    expect(Number(rows[0]?.total)).toBe(3)
  })
})

describe('ball in court', () => {
  it('answers who is holding what, and for how long', async () => {
    const created = await newRfi('Waiting on the architect')
    await kernel.transition(pm, created.record.id, { transitionKey: 'submit' })

    const theirs = await kernel.ballInCourt(architect, { projectId })
    const entry = theirs.find((e) => e.recordId === created.record.id)
    expect(entry).toBeDefined()
    expect(entry?.holderUserId).toBe(architect.userId)
    expect(entry?.holderName).toBe('Ali Bishop')
    expect(entry?.expectedAction).toBe('Answer this RFI')
    expect(entry?.ageDays).toBe(0)
    expect(entry?.overdue).toBe(false)
    expect(entry?.projectName).toBe('Harbor Point Phase II')
  })

  it('defaults to your own workload when no project is named', async () => {
    const mine = await kernel.ballInCourt(architect)
    expect(mine.length).toBeGreaterThan(0)
    for (const entry of mine) expect(entry.holderUserId).toBe(architect.userId)
  })

  it('does not let the view become a side channel onto tools you cannot read', async () => {
    const created = await kernel.create(super_, {
      projectId,
      typeKey: 'daily_log',
      title: 'Daily log 2026-03-03',
      body: { log_date: '2026-03-03', work_performed: 'Decking.' },
    })
    // The log sits in the superintendent's own court, and the trade partner
    // has no access to the daily log tool at all.
    const tradeView = await kernel.ballInCourt(trade, { projectId })
    expect(tradeView.some((e) => e.recordId === created.record.id)).toBe(false)
  })
})
