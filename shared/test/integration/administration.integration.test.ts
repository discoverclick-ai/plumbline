import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { AdministrationService } from '../../src/administration.js'
import { createPool, withTenant } from '../../src/db.js'
import type { Actor } from '../../src/kernel.js'
import {
  addProjectMember,
  createOrganization,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
} from '../../src/provisioning.js'
import { clearRecordTypeCache } from '../../src/repositories/record-types.js'

/**
 * Starting a job, which nothing could do.
 *
 * There was no route to create a project, a company, a person or a
 * membership. Every one of those existed as a provisioning primitive called
 * by tests and a seed script, so the product could run a job beautifully and
 * had no way to start one.
 *
 * Those primitives have no permission checks in them, because provisioning a
 * tenant happens before there is anybody to check against. This is the layer
 * that decides who may call them, and that is what these tests are about.
 */

let pool: Pool
let admin: AdministrationService
let tenantId: string
let owner: Actor
let employee: Actor
let outsider: Actor
let otherTenant: { tenantId: string; adminUserId: string; templateId: string }

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  admin = new AdministrationService(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Onboard Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@onboard.test', name: 'Olive Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId
  owner = { tenantId, userId: tenant.adminUserId }

  await withTenant(pool, tenantId, async (tx) => {
    const employeeId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@onboard.test',
      name: 'Pat Moreno',
      companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Employee'),
    })
    const subOrg = await createOrganization(tx, tenantId, { name: 'Vega Steel', kind: 'specialty_contractor' })
    const outsiderId = await createUser(tx, tenantId, {
      organizationId: subOrg,
      email: 'pm@vega.test',
      name: 'Sasha Vega',
      companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Collaborator'),
    })
    employee = { tenantId, userId: employeeId }
    outsider = { tenantId, userId: outsiderId }
  })

  const other = await provisionTenant(pool, {
    tenantName: 'Unrelated Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@unrelated-admin.test', name: 'Una', password: 'correct horse battery staple' },
  })
  const templateId = await withTenant(pool, other.tenantId, (tx) =>
    findTemplateByName(tx, other.tenantId, 'company', 'Company Administrator'),
  )
  otherTenant = { tenantId: other.tenantId, adminUserId: other.adminUserId, templateId: templateId as string }
})

afterAll(async () => {
  await pool.end()
  clearRecordTypeCache()
})

describe('starting a job', () => {
  it('puts the person who started it on it', async () => {
    const project = await admin.projectStart(employee, { number: '26-101', name: 'Riverside Depot' })

    // Without this they would create a project and immediately be unable to
    // open it, which is the first thing anybody would do and the first bug
    // they would report.
    const { rows } = await pool.query(
      'SELECT 1 FROM project_memberships WHERE project_id = $1 AND user_id = $2',
      [project.id, employee.userId],
    )
    expect(rows).toHaveLength(1)
  })

  it('refuses somebody whose template does not let them', async () => {
    // The Collaborator template grants no `create_projects`, which is the
    // point of it: a subcontractor on your account does not start jobs.
    await expect(admin.projectStart(outsider, { number: '26-102', name: 'Theirs' })).rejects.toThrow(
      /cannot start projects/,
    )
  })

  it('insists on a number and a name', async () => {
    await expect(admin.projectStart(employee, { number: '', name: 'No number' })).rejects.toThrow(/number and a name/)
  })
})

describe('the directory', () => {
  it('adds a company, and refuses somebody who is not an administrator', async () => {
    const company = await admin.addCompany(owner, { name: 'Bishop Architects', kind: 'architect' })
    expect((await admin.companies(owner)).map((c) => c.id)).toContain(company.id)

    await expect(admin.addCompany(employee, { name: 'Nope', kind: 'supplier' })).rejects.toThrow(/directory/)
  })

  it('will not let a second company claim to be the account itself', async () => {
    // Exactly one organization per tenant is the company itself. A second
    // would make every "which side of the contract are you on" decision in
    // the permission model ambiguous, so the flag is not accepted at all.
    const company = await admin.addCompany(owner, { name: 'Impostor Builders', kind: 'general_contractor' })
    const { rows } = await pool.query('SELECT is_self FROM organizations WHERE id = $1', [company.id])
    expect(rows[0]!.is_self).toBe(false)
    expect((await admin.companies(owner)).filter((c) => c.isSelf)).toHaveLength(1)
  })

  it('adds a person to a company', async () => {
    const [bishop] = (await admin.companies(owner)).filter((c) => c.name === 'Bishop Architects')
    const person = await admin.addPerson(owner, {
      organizationId: bishop!.id,
      email: 'Ali@Bishop.test',
      name: 'Ali Bishop',
      jobTitle: 'Architect of Record',
    })

    const listed = (await admin.people(owner)).find((p) => p.id === person.id)!
    // Lowercased on the way in: people are identified by email across
    // companies, and two rows differing only by capitals are two people.
    expect(listed.email).toBe('ali@bishop.test')
    expect(listed.organizationName).toBe('Bishop Architects')
  })

  it('refuses an email that is not one', async () => {
    const [self] = (await admin.companies(owner)).filter((c) => c.isSelf)
    await expect(
      admin.addPerson(owner, { organizationId: self!.id, email: 'not-an-email', name: 'Nobody' }),
    ).rejects.toThrow(/not an email/)
  })

  it('refuses a permission template from another account', async () => {
    // The id comes from a form. Without the check a company administrator
    // could hand somebody another tenant's template and nothing would fail.
    const [self] = (await admin.companies(owner)).filter((c) => c.isSelf)
    await expect(
      admin.addPerson(owner, {
        organizationId: self!.id,
        email: 'sneaky@onboard.test',
        name: 'Sneaky',
        companyPermissionTemplateId: otherTenant.templateId,
      }),
    ).rejects.toThrow(/not a permission template on this company/)
  })

  it('refuses a company from another account', async () => {
    const { rows } = await pool.query('SELECT id FROM organizations WHERE tenant_id = $1 LIMIT 1', [
      otherTenant.tenantId,
    ])
    await expect(
      admin.addPerson(owner, { organizationId: rows[0]!.id, email: 'x@onboard.test', name: 'X' }),
    ).rejects.toThrow(/not on this account/)
  })
})

describe('putting somebody on a job', () => {
  it('adds a member with the template written for their company', async () => {
    const project = await admin.projectStart(employee, { number: '26-103', name: 'Depot Phase 2' })
    const architect = (await admin.people(owner)).find((p) => p.email === 'ali@bishop.test')!

    await admin.addMember(owner, {
      projectId: project.id,
      userId: architect.id,
      permissionTemplateName: 'Design Team',
    })

    const { rows } = await pool.query(
      `SELECT t.name FROM project_memberships m
         JOIN permission_templates t ON t.id = m.permission_template_id
        WHERE m.project_id = $1 AND m.user_id = $2`,
      [project.id, architect.id],
    )
    expect(rows[0]!.name).toBe('Design Team')
  })

  it('refuses somebody who does not manage that project’s team', async () => {
    const project = await admin.projectStart(employee, { number: '26-104', name: 'Depot Phase 3' })
    await expect(
      admin.addMember(outsider, { projectId: project.id, userId: employee.userId }),
    ).rejects.toThrow(/manage who is on this project/)
  })

  it('refuses a person from another account', async () => {
    const project = await admin.projectStart(employee, { number: '26-105', name: 'Depot Phase 4' })
    await expect(
      admin.addMember(owner, { projectId: project.id, userId: otherTenant.adminUserId }),
    ).rejects.toThrow(/not on this account/)
  })
})

describe('the templates on offer', () => {
  it('says which company kinds a project template was written for', async () => {
    const templates = await admin.templates(owner, 'project')
    const managers = templates.filter((t) => t.name === 'Project Manager')

    // "Project Manager" names three templates that differ only by which side
    // of the contract the person sits on, and picking the wrong one is
    // silent. The list has to say which is which.
    expect(managers.length).toBeGreaterThan(1)
    expect(managers.every((t) => (t.appliesToOrgKinds ?? []).length > 0)).toBe(true)
  })
})
