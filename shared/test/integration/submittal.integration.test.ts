import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createPool, withTenant } from '../../src/db.js'
import { InvalidTransitionError, PermissionDeniedError, ValidationError } from '../../src/errors.js'
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
 * The submittal, run the way a job runs it.
 *
 * This is the workflow a project engineer will check first, because it is the
 * most intricate one in construction and the one every tool gets wrong. The
 * tell is whether the general contractor is in it. A submittal that goes
 * straight from the sub to the architect describes no project anybody has
 * worked on: the GC reviews first, forwards, and then has to physically get
 * the stamped copy back to the sub before anybody can order material.
 */

let pool: Pool
let kernel: RecordKernel
let tenantId: string
let projectId: string

let sub: Actor
let gc: Actor
let architect: Actor

const BASE = {
  spec_section: '05 12 00',
  submittal_type: 'Shop Drawing',
  description: 'Structural steel shop drawings, sequence 4.',
  lead_time_days: 42,
  required_on_site: '2026-11-02',
}

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  kernel = new RecordKernel(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Marlow Construction',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@marlow.test', name: 'Mo Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const design = await createOrganization(tx, tenantId, { name: 'Ward Architects', kind: 'architect' })
    const steel = await createOrganization(tx, tenantId, {
      name: 'Delta Steel',
      kind: 'specialty_contractor',
      trade: 'Structural Steel',
    })
    const employee = await findTemplateByName(tx, tenantId, 'company', 'Employee')
    const collaborator = await findTemplateByName(tx, tenantId, 'company', 'Collaborator')

    const gcId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@marlow.test',
      name: 'Morgan Pike',
      companyPermissionTemplateId: employee,
    })
    const architectId = await createUser(tx, tenantId, {
      organizationId: design,
      email: 'aor@ward.test',
      name: 'Wren Ward',
      companyPermissionTemplateId: collaborator,
    })
    const subId = await createUser(tx, tenantId, {
      organizationId: steel,
      email: 'pm@delta.test',
      name: 'Dev Ruiz',
      companyPermissionTemplateId: collaborator,
    })

    projectId = await createProject(tx, tenantId, { number: '26-201', name: 'Marlow Yard' })
    await addProjectMember(tx, tenantId, { projectId, userId: gcId, permissionTemplateName: 'Project Manager' })
    await addProjectMember(tx, tenantId, { projectId, userId: architectId, permissionTemplateName: 'Design Team' })
    await addProjectMember(tx, tenantId, { projectId, userId: subId, permissionTemplateName: 'Trade Partner' })

    gc = { tenantId, userId: gcId }
    architect = { tenantId, userId: architectId }
    sub = { tenantId, userId: subId }
  })
})

afterAll(async () => {
  await pool.end()
})

/** A submittal raised by the sub, coordinated by the GC, reviewed by the design team. */
async function raise(title: string) {
  return kernel.create(sub, {
    projectId,
    typeKey: 'submittal',
    title,
    body: BASE,
    participants: [
      { userId: gc.userId, role: 'assignee' },
      { userId: architect.userId, role: 'reviewer' },
    ],
  })
}

describe('the submittal, end to end', () => {
  it('goes sub, contractor, design team, and back to the sub before it is closed', async () => {
    const created = await raise('Structural steel shop drawings, sequence 4')
    expect(created.record.status).toBe('draft')

    // The sub submits to the CONTRACTOR, not to the architect.
    const submitted = await kernel.transition(sub, created.record.id, { transitionKey: 'submit' })
    expect(submitted.record.status).toBe('contractor_review')
    expect(submitted.assignment?.holderUserId).toBe(gc.userId)

    // The design team cannot review something the GC has not forwarded, which
    // is the whole point of the contractor review step. The refusal comes from
    // the state machine rather than the permission model, which is the right
    // answer: this architect may well be allowed to approve, just not yet.
    await expect(
      kernel.transition(architect, created.record.id, { transitionKey: 'approve' }),
    ).rejects.toBeInstanceOf(InvalidTransitionError)

    const forwarded = await kernel.transition(gc, created.record.id, { transitionKey: 'forward' })
    expect(forwarded.record.status).toBe('design_review')
    expect(forwarded.assignment?.holderUserId).toBe(architect.userId)
    expect(forwarded.assignment?.dueAt).toBeTruthy()

    // Approved as noted needs the notes, or it is not "as noted".
    await expect(
      kernel.transition(architect, created.record.id, { transitionKey: 'approve_as_noted' }),
    ).rejects.toBeInstanceOf(ValidationError)

    const reviewed = await kernel.transition(architect, created.record.id, {
      transitionKey: 'approve_as_noted',
      body: { review_comments: 'Approved as noted. Confirm the bolt grade at the moment connections.' },
    })
    // Approved does NOT mean finished: the ball goes back to the GC, who has
    // to get the stamped copy to the sub before anybody can order steel.
    expect(reviewed.record.status).toBe('approved_as_noted')
    expect(reviewed.assignment?.holderUserId).toBe(gc.userId)

    const closed = await kernel.transition(gc, created.record.id, { transitionKey: 'distribute' })
    expect(closed.record.status).toBe('closed')
    expect(closed.assignment).toBeNull()
  })

  it('lets the contractor return a submittal without ever troubling the design team', async () => {
    const created = await raise('Anchor bolt layout, incomplete')
    await kernel.transition(sub, created.record.id, { transitionKey: 'submit' })

    // Plenty of submittals die here, and that is the GC doing their job.
    await expect(
      kernel.transition(gc, created.record.id, { transitionKey: 'return_to_sub' }),
    ).rejects.toBeInstanceOf(ValidationError)

    const returned = await kernel.transition(gc, created.record.id, {
      transitionKey: 'return_to_sub',
      body: { gc_comments: 'Missing the embed schedule and the welder certifications.' },
    })
    expect(returned.record.status).toBe('revise_and_resubmit')
    expect(returned.assignment?.holderUserId).toBe(sub.userId)
  })

  it('cycles a rejected submittal back around as a new revision', async () => {
    const created = await raise('Curtain wall shop drawings')
    await kernel.transition(sub, created.record.id, { transitionKey: 'submit' })
    await kernel.transition(gc, created.record.id, { transitionKey: 'forward' })

    const rejected = await kernel.transition(architect, created.record.id, {
      transitionKey: 'revise',
      body: { review_comments: 'Head detail does not match the approved mock-up.' },
    })
    // The architect's disposition lands with the GC, who owns telling the sub.
    expect(rejected.record.status).toBe('rejected')
    expect(rejected.assignment?.holderUserId).toBe(gc.userId)

    const backToSub = await kernel.transition(gc, created.record.id, { transitionKey: 'send_back' })
    expect(backToSub.record.status).toBe('revise_and_resubmit')
    expect(backToSub.assignment?.holderUserId).toBe(sub.userId)

    // A resubmittal has to say which revision it is. "Here is another one" is
    // how a project ends up with three drawings all called the same thing.
    await expect(
      kernel.transition(sub, created.record.id, { transitionKey: 'resubmit' }),
    ).rejects.toBeInstanceOf(ValidationError)

    const revised = await kernel.transition(sub, created.record.id, {
      transitionKey: 'resubmit',
      body: { ...BASE, revision: 1, description: 'Curtain wall shop drawings, revision 1. Head detail corrected.' },
    })
    expect(revised.record.status).toBe('contractor_review')
    expect(revised.record.body.revision).toBe(1)
    expect(revised.assignment?.holderUserId).toBe(gc.userId)
  })

  it('does not let the subcontractor forward or distribute their own submittal', async () => {
    const created = await raise('Self-forwarded submittal')
    await kernel.transition(sub, created.record.id, { transitionKey: 'submit' })

    await expect(
      kernel.transition(sub, created.record.id, { transitionKey: 'forward' }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })
})
