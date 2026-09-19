import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createPool, withTenant } from '../../src/db.js'
import { PermissionDeniedError, ValidationError } from '../../src/errors.js'
import { RecordKernel, type Actor } from '../../src/kernel.js'
import { loadRecordTypes } from '../../src/repositories/record-types.js'
import {
  addProjectMember,
  createOrganization,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
} from '../../src/provisioning.js'

/**
 * Correspondence, meetings and tasks: three tools that arrived as three rows
 * of JSON in a migration, with no engine code behind them.
 *
 * That is the architectural claim under test here, more than any individual
 * workflow. If adding a tool needs a code change, the whole premise of this
 * product is wrong and it is just Procore with fewer features.
 */

let pool: Pool
let kernel: RecordKernel
let tenantId: string
let projectId: string
let pm: Actor
let trade: Actor

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  kernel = new RecordKernel(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Ashgrove Construction',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@ashgrove.test', name: 'Ada Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const subOrg = await createOrganization(tx, tenantId, {
      name: 'Pike Mechanical',
      kind: 'specialty_contractor',
      trade: 'Mechanical',
    })
    const pmId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@ashgrove.test',
      name: 'Ari Shaw',
      companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Employee'),
    })
    const tradeId = await createUser(tx, tenantId, {
      organizationId: subOrg,
      email: 'foreman@pike.test',
      name: 'Pat Ives',
      companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Collaborator'),
    })

    projectId = await createProject(tx, tenantId, { number: '26-415', name: 'Ashgrove Commons' })
    await addProjectMember(tx, tenantId, { projectId, userId: pmId, permissionTemplateName: 'Project Manager' })
    await addProjectMember(tx, tenantId, { projectId, userId: tradeId, permissionTemplateName: 'Trade Partner' })

    pm = { tenantId, userId: pmId }
    trade = { tenantId, userId: tradeId }
  })
})

afterAll(async () => {
  await pool.end()
})

describe('tools that arrived as configuration', () => {
  it('registers all three without a code change', async () => {
    const types = await loadRecordTypes(pool)
    for (const key of ['correspondence', 'meeting', 'task']) {
      expect(types.has(key), `${key} should be in the registry`).toBe(true)
    }
  })

  it('runs a task from assignment to close, with the ball in the right court at each step', async () => {
    const created = await kernel.create(pm, {
      projectId,
      typeKey: 'task',
      title: 'Send the updated mechanical coordination drawings',
      body: { detail: 'Latest coordinated set before Friday.', priority: 'Medium' },
      participants: [{ userId: trade.userId, role: 'assignee' }],
    })
    expect(created.record.status).toBe('open')
    expect(created.assignment?.holderUserId).toBe(trade.userId)

    // Only the person who owes it can say it is done.
    await expect(
      kernel.transition(pm, created.record.id, { transitionKey: 'complete' }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)

    const done = await kernel.transition(trade, created.record.id, { transitionKey: 'complete' })
    expect(done.record.status).toBe('done')
    // Back to whoever asked, because "done" is a claim and somebody accepts it.
    expect(done.assignment?.holderUserId).toBe(pm.userId)

    const reopened = await kernel.transition(pm, created.record.id, { transitionKey: 'reopen' })
    expect(reopened.record.status).toBe('open')
    expect(reopened.assignment?.holderUserId).toBe(trade.userId)

    await kernel.transition(trade, created.record.id, { transitionKey: 'complete' })
    const closed = await kernel.transition(pm, created.record.id, { transitionKey: 'close' })
    expect(closed.record.status).toBe('closed')
    expect(closed.assignment).toBeNull()

    // And the trade partner never gets to close their own task.
    const second = await kernel.create(pm, {
      projectId,
      typeKey: 'task',
      title: 'Second task',
      body: { detail: 'Anything.' },
      participants: [{ userId: trade.userId, role: 'assignee' }],
    })
    await kernel.transition(trade, second.record.id, { transitionKey: 'complete' })
    await expect(
      kernel.transition(trade, second.record.id, { transitionKey: 'close' }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it('will not issue a letter without saying how it was delivered', async () => {
    const created = await kernel.create(pm, {
      projectId,
      typeKey: 'correspondence',
      title: 'Notice of delayed erection sequence',
      body: { letter_type: 'Notice', body: 'You have been off site four working days.' },
      participants: [{ userId: trade.userId, role: 'assignee' }],
    })

    // A notice nobody can prove was served is not a notice.
    await expect(
      kernel.transition(pm, created.record.id, { transitionKey: 'issue' }),
    ).rejects.toBeInstanceOf(ValidationError)

    const issued = await kernel.transition(pm, created.record.id, {
      transitionKey: 'issue',
      body: {
        letter_type: 'Notice',
        body: 'You have been off site four working days.',
        delivery_method: 'Certified Mail',
      },
    })
    expect(issued.record.status).toBe('issued')
    expect(issued.assignment?.holderUserId).toBe(trade.userId)
    expect(issued.assignment?.dueAt).toBeTruthy()
  })

  it('carries a meeting through to minutes, and will not publish minutes that do not exist', async () => {
    const created = await kernel.create(pm, {
      projectId,
      typeKey: 'meeting',
      title: 'OAC 14',
      body: { meeting_type: 'Owner Architect Contractor', scheduled_for: '2026-03-16', location: 'Site trailer' },
      participants: [{ userId: trade.userId, role: 'assignee' }],
    })
    expect(created.record.status).toBe('scheduled')

    // A meeting with no attendance recorded did not happen in any useful sense.
    await expect(
      kernel.transition(pm, created.record.id, { transitionKey: 'hold' }),
    ).rejects.toBeInstanceOf(ValidationError)

    const held = await kernel.transition(pm, created.record.id, {
      transitionKey: 'hold',
      body: {
        meeting_type: 'Owner Architect Contractor',
        scheduled_for: '2026-03-16',
        attendance: 'Ari Shaw, Pat Ives',
      },
    })
    expect(held.record.status).toBe('held')

    const issued = await kernel.transition(pm, created.record.id, {
      transitionKey: 'issue_minutes',
      body: {
        meeting_type: 'Owner Architect Contractor',
        scheduled_for: '2026-03-16',
        attendance: 'Ari Shaw, Pat Ives',
        minutes: 'Steel sequence reviewed. Curtain wall mock-up date unresolved.',
        carried_forward: 'Curtain wall mock-up date.',
      },
    })
    // The minutes land with the attendees to correct, which is the only part
    // of a meeting anybody cares about a week later.
    expect(issued.record.status).toBe('minutes_issued')
    expect(issued.assignment?.holderUserId).toBe(trade.userId)
    expect(issued.record.body.carried_forward).toContain('mock-up')
  })
})

describe('the incident, which is a legal document from the moment it is written', () => {
  it('will not leave the investigation without a root cause and a corrective action', async () => {
    const created = await kernel.create(pm, {
      projectId,
      typeKey: 'incident',
      title: 'Laceration on level three',
      body: {
        occurred_at: '2026-03-20',
        incident_type: 'Injury',
        location: 'Level 3 east',
        description: 'Forearm caught on a sheared stud.',
        medical_treatment: 'First Aid',
      },
      // Nobody named as the investigator yet, which is the ordinary case: a
      // foreman reporting an injury from the field does not know who will
      // pick it up, and requiring one is how you lose the report.
      participants: [{ userId: trade.userId, role: 'approver' }],
    })
    expect(created.record.status).toBe('reported')
    expect(created.assignment?.holderUserId).toBe(pm.userId)

    // Somebody picks it up. Beginning an investigation without saying who is
    // investigating is exactly the move that leaves incidents open for months.
    await kernel.setParticipants(pm, created.record.id, {
      add: [{ userId: pm.userId, role: 'assignee' }],
    })

    await kernel.transition(pm, created.record.id, {
      transitionKey: 'investigate',
      body: {
        occurred_at: '2026-03-20',
        incident_type: 'Injury',
        location: 'Level 3 east',
        description: 'Forearm caught on a sheared stud.',
      },
    })

    // An incident closed without either is a filing exercise, and it is the
    // version a lawyer reads out loud.
    await expect(
      kernel.transition(pm, created.record.id, { transitionKey: 'submit_findings' }),
    ).rejects.toBeInstanceOf(ValidationError)

    const submitted = await kernel.transition(pm, created.record.id, {
      transitionKey: 'submit_findings',
      body: {
        occurred_at: '2026-03-20',
        incident_type: 'Injury',
        location: 'Level 3 east',
        description: 'Forearm caught on a sheared stud.',
        root_cause: 'Sheared studs left unprotected after demolition of the temporary partition.',
        corrective_action: 'Cap or grind sheared studs at the end of each shift; added to the daily walk.',
        recordable: 'No',
      },
    })
    expect(submitted.record.status).toBe('pending_signoff')
    // And sign-off is somebody else's, never the investigator's own.
    expect(submitted.assignment?.holderUserId).toBe(trade.userId)
  })

  it('has no way out except a named person signing it', async () => {
    const types = await loadRecordTypes(pool)
    const incident = types.get('incident')!.definition
    const terminals = incident.workflow.states.filter((s) => s.terminal).map((s) => s.key)
    // No void, no auto-close, no cancel. The only terminal state is reached by
    // the sign_off transition.
    expect(terminals).toEqual(['closed'])
    const intoClosed = incident.workflow.transitions.filter((t) => t.to === 'closed').map((t) => t.key)
    expect(intoClosed).toEqual(['sign_off'])
  })
})
