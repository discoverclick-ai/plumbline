import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createPool, withTenant } from '../../src/db.js'
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
 * Finding a record again.
 *
 * Every construction platform has a search box and almost none of them work,
 * because they search titles. What people type is a fragment of something
 * somebody said eight weeks ago, and that text is in the body.
 *
 * The part that has to be right is not the ranking, it is that search cannot
 * become an efficient way to read somebody else's mail.
 */

let pool: Pool
let kernel: RecordKernel
let tenantId: string
let harbor: string
let eastyard: string
let pm: Actor
let trade: Actor
let outsider: Actor

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  kernel = new RecordKernel(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Sefton Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@sefton.test', name: 'Sam Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const subOrg = await createOrganization(tx, tenantId, {
      name: 'Orbit Steel',
      kind: 'specialty_contractor',
      trade: 'Structural Steel',
    })
    const employee = await findTemplateByName(tx, tenantId, 'company', 'Employee')
    const collaborator = await findTemplateByName(tx, tenantId, 'company', 'Collaborator')

    const pmId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@sefton.test',
      name: 'Sasha Pine',
      companyPermissionTemplateId: employee,
    })
    const tradeId = await createUser(tx, tenantId, {
      organizationId: subOrg,
      email: 'foreman@orbit.test',
      name: 'Ola Byrne',
      companyPermissionTemplateId: collaborator,
    })
    const outsiderId = await createUser(tx, tenantId, {
      organizationId: subOrg,
      email: 'other@orbit.test',
      name: 'Nia Frost',
      companyPermissionTemplateId: collaborator,
    })

    harbor = await createProject(tx, tenantId, { number: '26-700', name: 'Harbor Point' })
    eastyard = await createProject(tx, tenantId, { number: '26-701', name: 'Eastyard Transit' })

    for (const projectId of [harbor, eastyard]) {
      await addProjectMember(tx, tenantId, { projectId, userId: pmId, permissionTemplateName: 'Project Manager' })
    }
    // The trade partner is on Harbor Point only.
    await addProjectMember(tx, tenantId, { projectId: harbor, userId: tradeId, permissionTemplateName: 'Trade Partner' })
    await addProjectMember(tx, tenantId, {
      projectId: eastyard,
      userId: outsiderId,
      permissionTemplateName: 'Trade Partner',
    })

    pm = { tenantId, userId: pmId }
    trade = { tenantId, userId: tradeId }
    outsider = { tenantId, userId: outsiderId }
  })

  await kernel.create(pm, {
    projectId: harbor,
    typeKey: 'rfi',
    title: 'Anchor bolt embedment at grid C4',
    body: {
      question: 'The anchor detail shows nine inch embedment but the shop drawings came through at seven.',
      discipline: 'Structural',
    },
  })
  await kernel.create(pm, {
    projectId: harbor,
    typeKey: 'observation',
    title: 'Water staining on level 2 ceiling tiles',
    body: { description: 'Staining across several ceiling tiles in the northeast corner.', observation_type: 'Quality' },
  })
  await kernel.create(pm, {
    projectId: eastyard,
    typeKey: 'rfi',
    title: 'Platform edge detail',
    body: { question: 'Rock encountered below the platform footing.', discipline: 'Civil' },
  })
  await kernel.create(pm, {
    projectId: harbor,
    typeKey: 'daily_log',
    title: 'Daily log, Tuesday',
    body: {
      log_date: '2026-03-17',
      work_performed: 'Steel crew on the north bay. Rock hauled off from the footing excavation.',
    },
  })
})

afterAll(async () => {
  await pool.end()
})

const titles = (hits: { record: { title: string } }[]) => hits.map((h) => h.record.title)

describe('searching for something somebody said weeks ago', () => {
  it('finds a record by words that only exist in its body', async () => {
    const hits = await kernel.search(pm, { query: 'ceiling tiles northeast' })
    expect(titles(hits)).toContain('Water staining on level 2 ceiling tiles')
  })

  it('finds a record by its designation the way a person writes it', async () => {
    const all = await kernel.search(pm, { query: 'embedment' })
    const designation = all[0]?.record.designation as string
    const byNumber = await kernel.search(pm, { query: designation })
    expect(byNumber.map((h) => h.record.designation)).toContain(designation)
  })

  it('searches across every project the person is on, and says which one', async () => {
    const hits = await kernel.search(pm, { query: 'rock' })
    const projects = new Set(hits.map((h) => h.projectName))
    expect(projects.size).toBeGreaterThan(1)
    expect([...projects]).toContain('Eastyard Transit')
  })

  it('scopes to one project when asked', async () => {
    const hits = await kernel.search(pm, { query: 'rock', projectId: eastyard })
    expect(hits.every((h) => h.projectName === 'Eastyard Transit')).toBe(true)
  })

  it('returns nothing for an empty query rather than everything', async () => {
    expect(await kernel.search(pm, { query: '   ' })).toEqual([])
  })
})

describe('search is not a way to read somebody else’s mail', () => {
  it('hides projects the searcher is not on', async () => {
    // Nia is on Eastyard only, so Harbor Point's RFI is not hers to find.
    const hits = await kernel.search(outsider, { query: 'embedment' })
    expect(titles(hits)).not.toContain('Anchor bolt embedment at grid C4')
  })

  it('hides record types the searcher cannot read on a project they ARE on', async () => {
    // Ola is on Harbor Point, and a trade partner holds `none` on daily logs.
    const hits = await kernel.search(trade, { query: 'rock' })
    expect(titles(hits)).not.toContain('Daily log, Tuesday')

    // And the same search run by the PM does find it, so the absence above is
    // the permission model rather than a broken query.
    expect(titles(await kernel.search(pm, { query: 'rock' }))).toContain('Daily log, Tuesday')
  })
})
