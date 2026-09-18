import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createPool, withTenant } from '../../src/db.js'
import { NotFoundError, PermissionDeniedError } from '../../src/errors.js'
import { RecordKernel } from '../../src/kernel.js'
import {
  addProjectMember,
  createOrganization,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
} from '../../src/provisioning.js'
import { clearRecordTypeCache } from '../../src/repositories/record-types.js'
import { loadAccess } from '../../src/repositories/permissions.js'
import { toolAccess } from '../../src/permissions.js'

/**
 * Which side of the contract you sit on.
 *
 * Procore teaches "Project Manager" three separate times, once for an owner,
 * once for a general contractor and once for a specialty contractor, and the
 * only curriculum that covers T&M tickets is the sub's. Both of those facts
 * are permission model requirements, not curriculum trivia: a title is not
 * enough to decide what somebody may do, and some record types belong to one
 * kind of company outright.
 */

let pool: Pool
let tenantId: string
let projectId: string

let gcPm: string
let ownerPm: string
let subPm: string
let supplier: string

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })

  const tenant = await provisionTenant(pool, {
    tenantName: 'Keystone Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@keystone.test', name: 'Kay Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const ownerOrg = await createOrganization(tx, tenantId, { name: 'Harbor Holdings', kind: 'owner' })
    const subOrg = await createOrganization(tx, tenantId, {
      name: 'Vega Steel',
      kind: 'specialty_contractor',
      trade: 'Structural Steel',
    })
    const supplyOrg = await createOrganization(tx, tenantId, { name: 'Cascade Supply', kind: 'supplier' })

    const employee = await findTemplateByName(tx, tenantId, 'company', 'Employee')
    const collaborator = await findTemplateByName(tx, tenantId, 'company', 'Collaborator')

    gcPm = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@keystone.test',
      name: 'Gale Price',
      companyPermissionTemplateId: employee,
    })
    ownerPm = await createUser(tx, tenantId, {
      organizationId: ownerOrg,
      email: 'pm@harbor.test',
      name: 'Owen Reed',
      companyPermissionTemplateId: collaborator,
    })
    subPm = await createUser(tx, tenantId, {
      organizationId: subOrg,
      email: 'pm@vega.test',
      name: 'Sasha Vega',
      companyPermissionTemplateId: collaborator,
    })
    supplier = await createUser(tx, tenantId, {
      organizationId: supplyOrg,
      email: 'sales@cascade.test',
      name: 'Casey Lane',
      companyPermissionTemplateId: collaborator,
    })

    projectId = await createProject(tx, tenantId, { number: '26-004', name: 'Keystone Yard' })

    // Every one of these asks for the SAME template name.
    for (const userId of [gcPm, ownerPm, subPm]) {
      await addProjectMember(tx, tenantId, { projectId, userId, permissionTemplateName: 'Project Manager' })
    }
    // And this one asks for nothing, so it falls to a default.
    await addProjectMember(tx, tenantId, { projectId, userId: supplier })
  })
})

afterAll(async () => {
  await pool.end()
  clearRecordTypeCache()
})

async function accessFor(userId: string) {
  return withTenant(pool, tenantId, (tx) => loadAccess(tx, { userId, tenantId, projectId }))
}

describe('one template name, three different jobs', () => {
  it('gives the general contractor’s PM the run of the job', async () => {
    const access = await accessFor(gcPm)
    expect(access.organizationKind).toBe('general_contractor')
    expect(toolAccess(access, 'rfis').level).toBe('standard')
    expect(toolAccess(access, 'rfis').privileges.has('close')).toBe(true)
    expect(toolAccess(access, 'daily_log').level).toBe('standard')
  })

  it('gives the owner’s PM a watching brief, not a working one', async () => {
    const access = await accessFor(ownerPm)
    expect(access.organizationKind).toBe('owner')
    // The owner does not answer their own RFIs, and above all does not close
    // a contractor's punch item: accepting the work is the whole point of it.
    expect(toolAccess(access, 'rfis').level).toBe('read_only')
    expect(toolAccess(access, 'punch_list').privileges.has('verify')).toBe(false)
  })

  it('gives the subcontractor’s PM their own scope and nothing else', async () => {
    const access = await accessFor(subPm)
    expect(access.organizationKind).toBe('specialty_contractor')
    expect(toolAccess(access, 'rfis').privileges.has('create')).toBe(true)
    expect(toolAccess(access, 'rfis').privileges.has('close')).toBe(false)
    // The GC's daily log is not the sub's business.
    expect(toolAccess(access, 'daily_log').level).toBe('none')
  })

  it('refuses to guess when a name is ambiguous and nothing says which company', async () => {
    await expect(
      withTenant(pool, tenantId, (tx) => findTemplateByName(tx, tenantId, 'project', 'Project Manager')),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('still resolves a name that only exists once', async () => {
    const id = await withTenant(pool, tenantId, (tx) =>
      findTemplateByName(tx, tenantId, 'project', 'Superintendent'),
    )
    expect(id).toEqual(expect.any(String))
  })
})

describe('defaults', () => {
  it('hands a supplier the trade partner default', async () => {
    const access = await accessFor(supplier)
    expect(toolAccess(access, 'punch_list').level).toBe('standard')
  })

  it('falls back to the least privileged template for a company nobody wrote one for', async () => {
    const consultant = await withTenant(pool, tenantId, async (tx) => {
      const org = await createOrganization(tx, tenantId, { name: 'Quayside Advisors', kind: 'other' })
      const userId = await createUser(tx, tenantId, {
        organizationId: org,
        email: 'advisor@quayside.test',
        name: 'Quinn Ash',
        companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Collaborator'),
      })
      await addProjectMember(tx, tenantId, { projectId, userId })
      return userId
    })

    // Read Only, not Project Manager. A person from a company we have no
    // opinion about gets to look and nothing else.
    const access = await accessFor(consultant)
    expect(toolAccess(access, 'rfis').level).toBe('read_only')
    expect(toolAccess(access, 'punch_list').level).toBe('read_only')
  })
})

describe('record types that belong to one side of the contract', () => {
  const TYPE_KEY = 'test_tm_ticket'

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO record_types (key, tool_key, display_name, display_name_plural, number_prefix,
                                 definition, creatable_by_org_kinds)
            VALUES ($1, 'punch_list', 'T&M Ticket', 'T&M Tickets', 'TM', $2, ARRAY['specialty_contractor']::organization_kind[])
       ON CONFLICT (key) DO NOTHING`,
      [
        TYPE_KEY,
        JSON.stringify({
          fields: [{ key: 'hours', label: 'Hours', type: 'number', required: true }],
          workflow: {
            initial: 'open',
            states: [
              { key: 'open', label: 'Open', ballInCourt: 'creator' },
              { key: 'signed', label: 'Signed', terminal: true, ballInCourt: 'none' },
            ],
            transitions: [{ key: 'sign', label: 'Sign', from: ['open'], to: 'signed', requires: { level: 'standard' } }],
          },
        }),
      ],
    )
    clearRecordTypeCache()
  })

  it('lets the company it is about raise one', async () => {
    const kernel = new RecordKernel(pool)
    const created = await kernel.create(
      { tenantId, userId: subPm },
      { projectId, typeKey: TYPE_KEY, title: 'Extra hours, grid C4 rework', body: { hours: 6 } },
    )
    expect(created.record.designation).toMatch(/^TM-\d{3}$/)
  })

  it('refuses the general contractor, who reads these rather than writes them', async () => {
    const kernel = new RecordKernel(pool)
    await expect(
      kernel.create(
        { tenantId, userId: gcPm },
        { projectId, typeKey: TYPE_KEY, title: 'Hours on behalf of the sub', body: { hours: 6 } },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it('refuses a company administrator too, because this is not a privilege level', async () => {
    const adminId = await withTenant(pool, tenantId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT u.id FROM users u
           JOIN permission_templates pt ON pt.id = u.company_permission_template_id
          WHERE u.tenant_id = $1 AND pt.name = 'Company Administrator'
          LIMIT 1`,
        [tenantId],
      )
      const id = rows[0]?.id as string
      await addProjectMember(tx, tenantId, { projectId, userId: id, permissionTemplateName: 'Project Manager' })
      return id
    })

    // A GC admin filing a sub's T&M ticket would be forging a claim about
    // somebody else's crew. No level of access makes that correct.
    const kernel = new RecordKernel(pool)
    await expect(
      kernel.create(
        { tenantId, userId: adminId },
        { projectId, typeKey: TYPE_KEY, title: 'Admin override', body: { hours: 6 } },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })
})
