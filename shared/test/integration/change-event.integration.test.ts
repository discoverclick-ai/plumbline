import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createPool, withTenant } from '../../src/db.js'
import { PermissionDeniedError, ValidationError } from '../../src/errors.js'
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
 * The change event, which is the workflow that carries the money.
 *
 * Worth proving in full because it is the first one where all four kinds of
 * company have a different job: the super raises it, the sub prices their
 * scope, the GC assembles and submits, and the OWNER approves. The owner's
 * template is read-only across the entire project except for this one
 * privilege, which is the whole argument for cutting templates by company
 * kind rather than by job title.
 */

let pool: Pool
let kernel: RecordKernel
let tenantId: string
let projectId: string

let gcPm: Actor
let superintendent: Actor
let owner: Actor
let sub: Actor

const EVENT = {
  description: 'Rock encountered at the north footing, below the elevation shown on C-201.',
  cause: 'Unforeseen Condition',
  origin_reference: 'OBS-014',
}

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  kernel = new RecordKernel(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Coleman Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@coleman.test', name: 'Cam Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const ownerOrg = await createOrganization(tx, tenantId, { name: 'Northgate Holdings', kind: 'owner' })
    const subOrg = await createOrganization(tx, tenantId, {
      name: 'Basin Excavation',
      kind: 'specialty_contractor',
      trade: 'Earthwork',
    })
    const employee = await findTemplateByName(tx, tenantId, 'company', 'Employee')
    const collaborator = await findTemplateByName(tx, tenantId, 'company', 'Collaborator')

    const gcId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@coleman.test',
      name: 'Casey Poole',
      companyPermissionTemplateId: employee,
    })
    const superId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'super@coleman.test',
      name: 'Sam Ruiz',
      companyPermissionTemplateId: employee,
    })
    const ownerId = await createUser(tx, tenantId, {
      organizationId: ownerOrg,
      email: 'pm@northgate.test',
      name: 'Nadia Gray',
      companyPermissionTemplateId: collaborator,
    })
    const subId = await createUser(tx, tenantId, {
      organizationId: subOrg,
      email: 'pm@basin.test',
      name: 'Bo Ives',
      companyPermissionTemplateId: collaborator,
    })

    projectId = await createProject(tx, tenantId, { number: '26-310', name: 'Northgate Yard' })
    await addProjectMember(tx, tenantId, { projectId, userId: gcId, permissionTemplateName: 'Project Manager' })
    await addProjectMember(tx, tenantId, { projectId, userId: superId, permissionTemplateName: 'Superintendent' })
    await addProjectMember(tx, tenantId, { projectId, userId: ownerId, permissionTemplateName: 'Project Manager' })
    await addProjectMember(tx, tenantId, { projectId, userId: subId, permissionTemplateName: 'Trade Partner' })

    gcPm = { tenantId, userId: gcId }
    superintendent = { tenantId, userId: superId }
    owner = { tenantId, userId: ownerId }
    sub = { tenantId, userId: subId }
  })
})

afterAll(async () => {
  await pool.end()
})

async function raise(title: string) {
  return kernel.create(superintendent, {
    projectId,
    typeKey: 'change_event',
    title,
    body: EVENT,
    participants: [
      { userId: gcPm.userId, role: 'assignee' },
      { userId: owner.userId, role: 'approver' },
    ],
  })
}

describe('a change event, raised in the field and signed by the owner', () => {
  it('runs field to contractor to owner and back', async () => {
    const created = await raise('Rock at the north footing')
    expect(created.record.status).toBe('open')
    expect(created.assignment?.holderUserId).toBe(gcPm.userId)

    const pricing = await kernel.transition(gcPm, created.record.id, { transitionKey: 'request_pricing' })
    expect(pricing.record.status).toBe('pricing')

    // A change with no number is not priced. Nothing here defaults, because a
    // change priced at a silent zero is worse than one not priced at all.
    await expect(
      kernel.transition(gcPm, created.record.id, { transitionKey: 'record_pricing' }),
    ).rejects.toBeInstanceOf(ValidationError)

    const priced = await kernel.transition(gcPm, created.record.id, {
      transitionKey: 'record_pricing',
      body: {
        ...EVENT,
        scope_of_work: 'Over-excavate and replace with structural fill to the design bearing elevation.',
        cost_impact: 84200,
        schedule_impact_days: 6,
      },
    })
    expect(priced.record.status).toBe('priced')

    // The GC cannot approve their own change. This is the entire point.
    await expect(
      kernel.transition(gcPm, created.record.id, { transitionKey: 'submit_to_owner' }).then(() =>
        kernel.transition(gcPm, created.record.id, { transitionKey: 'approve' }),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError)

    const withOwner = await kernel.get(owner, created.record.id)
    expect(withOwner.record.status).toBe('submitted')
    expect(withOwner.assignment?.holderUserId).toBe(owner.userId)
    expect(withOwner.assignment?.dueAt).toBeTruthy()

    const approved = await kernel.transition(owner, created.record.id, { transitionKey: 'approve' })
    expect(approved.record.status).toBe('approved')
    // Approved is not finished: somebody still has to execute the paperwork.
    expect(approved.assignment?.holderUserId).toBe(gcPm.userId)

    // And executing needs the owner's reference, because a change order
    // without one cannot be billed.
    await expect(
      kernel.transition(gcPm, created.record.id, { transitionKey: 'execute' }),
    ).rejects.toBeInstanceOf(ValidationError)

    const executed = await kernel.transition(gcPm, created.record.id, {
      transitionKey: 'execute',
      body: { ...EVENT, cost_impact: 84200, schedule_impact_days: 6, owner_reference: 'OCO-004' },
    })
    expect(executed.record.status).toBe('executed')
    expect(executed.assignment).toBeNull()
  })

  it('sends a rejected change back to be repriced rather than killing it', async () => {
    const created = await raise('Added roof screen framing')
    await kernel.transition(gcPm, created.record.id, {
      transitionKey: 'record_pricing',
      body: { ...EVENT, scope_of_work: 'Frame and brace the screen.', cost_impact: 21000, schedule_impact_days: 2 },
    })
    await kernel.transition(gcPm, created.record.id, { transitionKey: 'submit_to_owner' })

    await expect(
      kernel.transition(owner, created.record.id, { transitionKey: 'reject' }),
    ).rejects.toBeInstanceOf(ValidationError)

    const rejected = await kernel.transition(owner, created.record.id, {
      transitionKey: 'reject',
      body: { ...EVENT, rejection_reason: 'General conditions are already carried in the base contract.' },
    })
    expect(rejected.record.status).toBe('priced')
    expect(rejected.assignment?.holderUserId).toBe(gcPm.userId)
  })

  it('will not let a subcontractor submit a change to the owner', async () => {
    const created = await raise('Sub-initiated change')
    await kernel.transition(gcPm, created.record.id, {
      transitionKey: 'record_pricing',
      body: { ...EVENT, scope_of_work: 'Extra haul-off.', cost_impact: 4000, schedule_impact_days: 0 },
    })

    // The sub may price and may read. Talking to the owner is the GC's job,
    // and on most jobs the sub has no contract with the owner at all.
    await expect(
      kernel.transition(sub, created.record.id, { transitionKey: 'submit_to_owner' }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it('will not let the owner approve something nobody has priced', async () => {
    const created = await raise('Unpriced change')
    await expect(
      kernel.transition(owner, created.record.id, { transitionKey: 'approve' }),
    ).rejects.toThrow()
  })
})
