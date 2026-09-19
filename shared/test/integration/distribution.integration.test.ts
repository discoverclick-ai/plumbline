import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createPool, withTenant } from '../../src/db.js'
import { ValidationError } from '../../src/errors.js'
import { RecordKernel, type Actor } from '../../src/kernel.js'
import {
  addProjectMember,
  clearDistributionDefault,
  createOrganization,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
  setDistributionDefault,
} from '../../src/provisioning.js'

/**
 * Who needs to know, as distinct from who owes something.
 *
 * Conflating those two is how construction software ends up either notifying
 * nobody or notifying everybody. The project executive owes nothing on an RFI
 * and still wants the structural ones. The owner's rep is never in anybody's
 * court and reads the whole job.
 */

let pool: Pool
let kernel: RecordKernel
let tenantId: string
let projectId: string
let pm: Actor
let exec: string
let ownerRep: string
let architect: string

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  kernel = new RecordKernel(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Fenwick Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@fenwick.test', name: 'Fay Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const design = await createOrganization(tx, tenantId, { name: 'Holt Architects', kind: 'architect' })
    const ownerOrg = await createOrganization(tx, tenantId, { name: 'Fen Holdings', kind: 'owner' })
    const employee = await findTemplateByName(tx, tenantId, 'company', 'Employee')
    const collaborator = await findTemplateByName(tx, tenantId, 'company', 'Collaborator')

    const pmId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@fenwick.test',
      name: 'Faye Ong',
      companyPermissionTemplateId: employee,
    })
    exec = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'px@fenwick.test',
      name: 'Eli Poe',
      companyPermissionTemplateId: employee,
    })
    ownerRep = await createUser(tx, tenantId, {
      organizationId: ownerOrg,
      email: 'rep@fen.test',
      name: 'Orla Reed',
      companyPermissionTemplateId: collaborator,
    })
    architect = await createUser(tx, tenantId, {
      organizationId: design,
      email: 'aor@holt.test',
      name: 'Hal Holt',
      companyPermissionTemplateId: collaborator,
    })

    projectId = await createProject(tx, tenantId, { number: '26-520', name: 'Fenwick Court' })
    await addProjectMember(tx, tenantId, { projectId, userId: pmId, permissionTemplateName: 'Project Manager' })
    await addProjectMember(tx, tenantId, { projectId, userId: exec, permissionTemplateName: 'Project Manager' })
    await addProjectMember(tx, tenantId, { projectId, userId: ownerRep, permissionTemplateName: 'Project Manager' })
    await addProjectMember(tx, tenantId, { projectId, userId: architect, permissionTemplateName: 'Design Team' })

    // The executive wants RFIs. The owner's rep reads everything.
    await setDistributionDefault(tx, tenantId, { projectId, userId: exec, typeKey: 'rfi' })
    await setDistributionDefault(tx, tenantId, { projectId, userId: ownerRep, role: 'watcher' })

    pm = { tenantId, userId: pmId }
  })
})

afterAll(async () => {
  await pool.end()
})

async function rfi(title: string) {
  return kernel.create(pm, {
    projectId,
    typeKey: 'rfi',
    title,
    body: { question: 'Which detail governs at the parapet?', discipline: 'Architectural' },
    participants: [{ userId: architect, role: 'assignee' }],
  })
}

function roleOf(view: { participants: { userId: string; role: string }[] }, userId: string) {
  return view.participants.find((p) => p.userId === userId)?.role
}

describe('standing distribution', () => {
  it('copies the standing list in without anybody remembering it', async () => {
    const created = await rfi('Parapet detail conflict')
    expect(roleOf(created, exec)).toBe('distribution')
    expect(roleOf(created, ownerRep)).toBe('watcher')
    // A new RFI sits in draft with its author, so the ball is the PM's until
    // they submit it. Being copied never puts anybody in the court.
    expect(created.assignment?.holderUserId).toBe(pm.userId)

    const submitted = await kernel.transition(pm, created.record.id, { transitionKey: 'submit' })
    expect(submitted.assignment?.holderUserId).toBe(architect)
  })

  it('applies an all-types default to a type it was never named for', async () => {
    const created = await kernel.create(pm, {
      projectId,
      typeKey: 'observation',
      title: 'Standing water at the loading dock',
      body: { description: 'Standing water at the dock after Tuesday rain.', observation_type: 'Quality' },
    })
    expect(roleOf(created, ownerRep)).toBe('watcher')
    // The executive asked for RFIs, so they are not on this one.
    expect(roleOf(created, exec)).toBeUndefined()
  })

  it('does not let a standing list demote somebody named on the record', async () => {
    await withTenant(pool, tenantId, (tx) =>
      setDistributionDefault(tx, tenantId, { projectId, userId: architect, typeKey: 'rfi' }),
    )
    const created = await kernel.create(pm, {
      projectId,
      typeKey: 'rfi',
      title: 'Explicit assignee beats the copy list',
      body: { question: 'Who governs?', discipline: 'Architectural' },
      participants: [{ userId: architect, role: 'assignee' }],
    })
    expect(roleOf(created, architect)).toBe('assignee')
    const submitted = await kernel.transition(pm, created.record.id, { transitionKey: 'submit' })
    expect(submitted.assignment?.holderUserId).toBe(architect)

    await withTenant(pool, tenantId, (tx) =>
      clearDistributionDefault(tx, tenantId, { projectId, userId: architect, typeKey: 'rfi' }),
    )
  })
})

describe('changing who is on a record afterwards', () => {
  it('adds and removes people, because they join and leave jobs', async () => {
    const created = await rfi('Distribution edited later')

    const added = await kernel.setParticipants(pm, created.record.id, {
      add: [{ userId: ownerRep, role: 'distribution' }],
    })
    expect(added.participants.filter((p) => p.userId === ownerRep)).toHaveLength(2)

    const removed = await kernel.setParticipants(pm, created.record.id, {
      remove: [{ userId: ownerRep, role: 'distribution' }],
    })
    expect(roleOf(removed, ownerRep)).toBe('watcher')
  })

  it('refuses to remove the person holding the ball', async () => {
    const created = await rfi('Cannot orphan the ball')
    // Submit it so the architect actually holds the ball rather than merely
    // being named as the assignee.
    await kernel.transition(pm, created.record.id, { transitionKey: 'submit' })
    await expect(
      kernel.setParticipants(pm, created.record.id, { remove: [{ userId: architect, role: 'assignee' }] }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses to remove the creator', async () => {
    const created = await rfi('Records keep their creator')
    await expect(
      kernel.setParticipants(pm, created.record.id, { remove: [{ userId: pm.userId, role: 'creator' }] }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})
