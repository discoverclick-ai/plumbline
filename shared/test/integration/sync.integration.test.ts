import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createPool, withTenant } from '../../src/db.js'
import { DrawingService } from '../../src/drawings.js'
import { RecordKernel, type Actor } from '../../src/kernel.js'
import { InMemoryBlobStore } from '../../src/storage/filesystem.js'
import { SyncService } from '../../src/sync/service.js'
import {
  addProjectMember,
  createOrganization,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
} from '../../src/provisioning.js'

/**
 * Offline, end to end.
 *
 * The two claims being tested are the ones Procore's offline cannot make. The
 * device gets what it will need rather than what it already opened. And two
 * people editing one record while one of them is in a basement both keep their
 * work, unless they genuinely touched the same field, in which case a human is
 * told which version was dropped.
 */

let pool: Pool
let kernel: RecordKernel
let sync: SyncService
let drawings: DrawingService
let tenantId: string
let projectId: string
let pm: Actor
let superintendent: Actor
let trade: Actor
let phone: string

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  kernel = new RecordKernel(pool)
  sync = new SyncService(pool)
  drawings = new DrawingService(pool, new InMemoryBlobStore())

  const tenant = await provisionTenant(pool, {
    tenantName: 'Ivens Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@ivens.test', name: 'Iva Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const steel = await createOrganization(tx, tenantId, {
      name: 'Kade Steel',
      kind: 'specialty_contractor',
      trade: 'Structural Steel',
    })
    const employee = await findTemplateByName(tx, tenantId, 'company', 'Employee')
    const collaborator = await findTemplateByName(tx, tenantId, 'company', 'Collaborator')

    const pmId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@ivens.test',
      name: 'Ivy Poole',
      companyPermissionTemplateId: employee,
    })
    const superId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'super@ivens.test',
      name: 'Sam Ruiz',
      companyPermissionTemplateId: employee,
    })
    const tradeId = await createUser(tx, tenantId, {
      organizationId: steel,
      email: 'foreman@kade.test',
      name: 'Kit Kade',
      companyPermissionTemplateId: collaborator,
    })

    projectId = await createProject(tx, tenantId, { number: '28-300', name: 'Ivens Yard' })
    await addProjectMember(tx, tenantId, { projectId, userId: pmId, permissionTemplateName: 'Project Manager' })
    await addProjectMember(tx, tenantId, { projectId, userId: superId, permissionTemplateName: 'Superintendent' })
    await addProjectMember(tx, tenantId, { projectId, userId: tradeId, permissionTemplateName: 'Trade Partner' })

    pm = { tenantId, userId: pmId }
    superintendent = { tenantId, userId: superId }
    trade = { tenantId, userId: tradeId }
  })

  phone = (await sync.registerDevice(superintendent, 'sam-phone', "Sam's phone")).deviceId
})

afterAll(async () => {
  await pool.end()
})

describe('what the device takes into the basement', () => {
  it('pulls what is owed, not what was opened', async () => {
    const owed = await kernel.create(pm, {
      projectId,
      typeKey: 'punch_item',
      title: 'Handrail loose at the level 4 stair',
      body: { description: 'Handrail loose at the wall bracket.', priority: 'High' },
      participants: [{ userId: superintendent.userId, role: 'assignee' }],
    })
    await kernel.transition(pm, owed.record.id, { transitionKey: 'issue' })

    // Somebody else's work, on the same job, which the device has no business
    // carrying.
    await kernel.create(pm, {
      projectId,
      typeKey: 'punch_item',
      title: 'Somebody else’s punch item',
      body: { description: 'Not Sam’s.', priority: 'Low' },
      participants: [{ userId: trade.userId, role: 'assignee' }],
    })

    const bundle = await sync.pull(superintendent, { deviceId: phone, projectId })
    const titles = bundle.records.map((r) => r.title)

    expect(titles).toContain('Handrail loose at the level 4 stair')
    expect(titles).not.toContain('Somebody else’s punch item')
  })

  it('carries the current sheets and the type definitions', async () => {
    const set = await drawings.createSet(pm, { projectId, name: 'CDs', issuedOn: '2026-05-04' })
    await drawings.addRevision(pm, {
      setId: set.id,
      number: 'S-401',
      title: 'Typical details',
      revisionLabel: '0',
      filename: 'S-401.pdf',
      contentType: 'application/pdf',
      bytes: Buffer.from('%PDF-1.7 sheet'),
    })
    await drawings.publishSet(pm, set.id)

    const bundle = await sync.pull(superintendent, { deviceId: phone, projectId })
    expect(bundle.sheets.map((s) => s.number)).toContain('S-401')
    // The definitions travel with the bundle so a device can render and
    // validate a type it has never seen, the same property the web client has.
    expect(bundle.recordTypes.length).toBeGreaterThan(5)
  })
})

describe('coming back with work done', () => {
  it('keeps both edits when two people touched different fields', async () => {
    const created = await kernel.create(pm, {
      projectId,
      typeKey: 'punch_item',
      title: 'Two people, one record',
      body: { description: 'Loose handrail', priority: 'Medium', trade: 'Steel' },
      participants: [{ userId: superintendent.userId, role: 'assignee' }],
    })
    const bundle = await sync.pull(superintendent, { deviceId: phone, projectId })
    const asSeenOnPhone = bundle.records.find((r) => r.id === created.record.id)!

    // The PM raises the priority at a desk while Sam is underground.
    await kernel.update(pm, created.record.id, {
      body: { description: 'Loose handrail', priority: 'High', trade: 'Steel' },
    })

    const [result] = await sync.push(superintendent, phone, [
      {
        clientOpId: 'op-1',
        recordId: created.record.id,
        baseVersion: asSeenOnPhone.version,
        body: { description: 'Loose handrail at the level 4 stair', priority: 'Medium', trade: 'Steel' },
        occurredAt: '2026-05-05T09:12:00.000Z',
      },
    ])

    // Last-write-wins would have thrown one of these away with no trace.
    expect(result?.outcome).toBe('merged')
    expect(result?.applied).toEqual(['description'])
    expect(result?.dropped).toEqual([])

    const after = await kernel.get(pm, created.record.id)
    expect(after.record.body['description']).toBe('Loose handrail at the level 4 stair')
    expect(after.record.body['priority']).toBe('High')
  })

  it('conflicts when both touched the same field, and says which value was dropped', async () => {
    const created = await kernel.create(pm, {
      projectId,
      typeKey: 'punch_item',
      title: 'Same field, two answers',
      body: { description: 'Cracked tile', priority: 'Medium' },
      participants: [{ userId: superintendent.userId, role: 'assignee' }],
    })
    const bundle = await sync.pull(superintendent, { deviceId: phone, projectId })
    const asSeenOnPhone = bundle.records.find((r) => r.id === created.record.id)!

    await kernel.update(pm, created.record.id, { body: { description: 'Cracked tile', priority: 'High' } })

    const [result] = await sync.push(superintendent, phone, [
      {
        clientOpId: 'op-2',
        recordId: created.record.id,
        baseVersion: asSeenOnPhone.version,
        body: { description: 'Cracked tile', priority: 'Low' },
        occurredAt: '2026-05-05T09:20:00.000Z',
      },
    ])

    expect(result?.outcome).toBe('conflicted')
    expect(result?.dropped).toEqual(['priority'])
    // A human has to be able to read what was lost, or the log is decoration.
    expect(result?.detail).toContain('kept "High"')
    expect(result?.detail).toContain('dropped "Low"')

    const conflicts = await sync.conflicts(pm, projectId)
    expect(conflicts.some((c) => c.clientOpId === 'op-2')).toBe(true)
  })

  it('does not apply the same operation twice', async () => {
    const created = await kernel.create(pm, {
      projectId,
      typeKey: 'punch_item',
      title: 'Pushed twice',
      body: { description: 'Original', priority: 'Medium' },
      participants: [{ userId: superintendent.userId, role: 'assignee' }],
    })
    const bundle = await sync.pull(superintendent, { deviceId: phone, projectId })
    const seen = bundle.records.find((r) => r.id === created.record.id)!

    const operation = {
      clientOpId: 'op-3',
      recordId: created.record.id,
      baseVersion: seen.version,
      body: { description: 'Edited underground', priority: 'Medium' },
      occurredAt: '2026-05-05T09:30:00.000Z',
    }
    const first = await sync.push(superintendent, phone, [operation])
    // A phone that pushes, loses signal before the response, and pushes again.
    const second = await sync.push(superintendent, phone, [operation])

    expect(first[0]?.outcome).toBe('applied')
    expect(second[0]?.outcome).toBe('duplicate')

    const after = await kernel.get(pm, created.record.id)
    expect(after.record.body['description']).toBe('Edited underground')
    expect(after.record.version).toBe(seen.version + 1)
  })

  it('refuses an edit to a record that closed while the device was dark', async () => {
    const created = await kernel.create(pm, {
      projectId,
      typeKey: 'observation',
      title: 'Closed while underground',
      body: { description: 'Standing water.', observation_type: 'Quality' },
      participants: [{ userId: superintendent.userId, role: 'assignee' }],
    })
    const bundle = await sync.pull(superintendent, { deviceId: phone, projectId })
    const seen = bundle.records.find((r) => r.id === created.record.id)!

    await kernel.transition(pm, created.record.id, { transitionKey: 'issue' })
    await kernel.transition(superintendent, created.record.id, {
      transitionKey: 'resolve',
      body: { description: 'Standing water.', observation_type: 'Quality', resolution: 'Drain cleared.' },
    })
    await kernel.transition(pm, created.record.id, { transitionKey: 'close' })

    const [result] = await sync.push(superintendent, phone, [
      {
        clientOpId: 'op-4',
        recordId: created.record.id,
        baseVersion: seen.version,
        body: { description: 'Edited after it closed', observation_type: 'Quality' },
        occurredAt: '2026-05-05T09:40:00.000Z',
      },
    ])

    // Applying it would reopen the past. Kept as rejected with a reason
    // somebody can read out loud, because "my change did not save" with no
    // explanation is the most corrosive thing a field tool can do.
    expect(result?.outcome).toBe('rejected')
    expect(result?.detail).toContain('closed')
    expect((await sync.conflicts(pm, projectId)).some((c) => c.clientOpId === 'op-4')).toBe(true)
  })

  it('keeps a device’s own sync state separate from the same person’s other device', async () => {
    // A phone and a tablet are two sync states. Treating them as one is how a
    // change made on the tablet vanishes when the phone catches up.
    const tablet = (await sync.registerDevice(superintendent, 'sam-tablet', "Sam's tablet")).deviceId
    expect(tablet).not.toBe(phone)

    const created = await kernel.create(pm, {
      projectId,
      typeKey: 'punch_item',
      title: 'Two devices',
      body: { description: 'From the tablet', priority: 'Medium' },
      participants: [{ userId: superintendent.userId, role: 'assignee' }],
    })
    const seen = (await sync.pull(superintendent, { deviceId: tablet, projectId })).records.find(
      (r) => r.id === created.record.id,
    )!

    // The same client op id from a different device is a different operation.
    const result = await sync.push(superintendent, tablet, [
      {
        clientOpId: 'op-1',
        recordId: created.record.id,
        baseVersion: seen.version,
        body: { description: 'Edited on the tablet', priority: 'Medium' },
        occurredAt: '2026-05-05T10:00:00.000Z',
      },
    ])
    expect(result[0]?.outcome).toBe('applied')
  })
})
