import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createPool, withTenant } from '../../src/db.js'
import { parseCsv, ProcoreImporter } from '../../src/import/procore.js'
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
 * Bringing a job across.
 *
 * The thing that decides whether anybody can leave the incumbent. A migration
 * that loses rows, or that produces records the product's own rules would have
 * refused, is one the customer abandons quietly, back to where they came from.
 */

const EXPORT = [
  'RFI #,Subject,Question,Status,Discipline,Ball In Court,Assignee Email,Responsible Company,Official Response',
  '1,Anchor bolt embedment,"The detail shows nine inch embedment on S-401.\nShop drawings say seven.\nWhich governs?",Closed,Structural,"Bishop, Ali",ali@bishop.test,Bishop Architects,"Nine inch governs. Revise and resubmit."',
  '2,"Duct routing, corridor 2",The 24in duct does not clear the structure as drawn.,Open,Mechanical,"Bishop, Ali",ali@bishop.test,Bishop Architects,',
  '3,Curtain wall anchor spacing,Confirm the spacing at the south elevation.,Pending Owner Review,Architectural,"Vance, Ola",ola@vance.test,Vance Consulting,',
  '4,,,Open,,,,,',
  '5,Parapet flashing,Which flashing detail governs?,Answered,Architectural,"Bishop, Ali",ali@bishop.test,Bishop Architects,"Detail 5 on A-501."',
].join('\n')

let pool: Pool
let kernel: RecordKernel
let importer: ProcoreImporter
let tenantId: string
let projectId: string
let pm: Actor
let existingArchitectId: string

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  kernel = new RecordKernel(pool)
  importer = new ProcoreImporter(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Kelso Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@kelso.test', name: 'Kay Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const design = await createOrganization(tx, tenantId, { name: 'Bishop Architects', kind: 'architect' })
    const pmId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@kelso.test',
      name: 'Kim Poole',
      companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Employee'),
    })
    // Already here, with the same email the export names. An import that
    // created a second Ali Bishop would be the most common migration failure
    // there is.
    existingArchitectId = await createUser(tx, tenantId, {
      organizationId: design,
      email: 'ali@bishop.test',
      name: 'Ali Bishop',
      companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Collaborator'),
    })
    projectId = await createProject(tx, tenantId, { number: '28-500', name: 'Kelso Wharf' })
    await addProjectMember(tx, tenantId, { projectId, userId: pmId, permissionTemplateName: 'Project Manager' })
    await addProjectMember(tx, tenantId, {
      projectId,
      userId: existingArchitectId,
      permissionTemplateName: 'Design Team',
    })
    pm = { tenantId, userId: pmId }
  })
})

afterAll(async () => {
  await pool.end()
})

describe('importing a job', () => {
  it('brings the records across through the ordinary kernel', async () => {
    const result = await importer.importRfis(pm, { projectId, rows: parseCsv(EXPORT) })

    // Four real rows; the fifth has neither subject nor question.
    expect(result.created).toBe(4)
    expect(result.skipped.some((s) => s.reason.includes('no subject or question'))).toBe(true)

    const records = await kernel.list(pm, { projectId, typeKey: 'rfi' })
    expect(records).toHaveLength(4)
    // Numbered by us, not by them: an imported record is a record, and it gets
    // the same designation any other would.
    expect(records.every((r) => /^RFI-\d{3}$/.test(r.designation))).toBe(true)
  })

  it('keeps a multi-line question intact', async () => {
    const records = await kernel.list(pm, { projectId, typeKey: 'rfi' })
    const anchor = records.find((r) => r.title === 'Anchor bolt embedment')!
    expect(String(anchor.body['question']).split('\n')).toHaveLength(3)
    expect(anchor.body['discipline']).toBe('Structural')
  })

  it('walks a closed RFI through its real workflow rather than setting the status', async () => {
    const records = await kernel.list(pm, { projectId, typeKey: 'rfi' })
    const closed = records.find((r) => r.title === 'Anchor bolt embedment')!

    expect(closed.status).toBe('closed')
    // And it got there legally, so the history is real and the record can
    // still be moved. Writing the status directly produces records in a state
    // their own workflow says is unreachable.
    const history = await kernel.history(pm, closed.id)
    expect(history.states.map((s) => s.transitionKey)).toEqual(['create', 'submit', 'answer', 'close'])
    expect(closed.body['answer']).toContain('Nine inch governs')
  })

  it('does not create a second account for somebody already here', async () => {
    const records = await kernel.list(pm, { projectId, typeKey: 'rfi' })
    const anchor = records.find((r) => r.title === 'Anchor bolt embedment')!
    const view = await kernel.get(pm, anchor.id)

    expect(view.participants.some((p) => p.userId === existingArchitectId && p.role === 'assignee')).toBe(true)

    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM users WHERE tenant_id = $1 AND lower(email) = 'ali@bishop.test'`,
      [tenantId],
    )
    expect(Number(rows[0]?.n)).toBe(1)
  })

  it('reports every person and company it had to invent', async () => {
    // Unavoidable on a ten year old job, and also how a directory quietly
    // fills with duplicates, so every one is surfaced for review.
    const { rows } = await pool.query<{ name: string; email: string }>(
      `SELECT name, email FROM users WHERE tenant_id = $1 AND email = 'ola@vance.test'`,
      [tenantId],
    )
    expect(rows[0]?.name).toBe('Ola Vance')

    const { rows: template } = await pool.query<{ name: string }>(
      `SELECT pt.name FROM project_memberships m
         JOIN permission_templates pt ON pt.id = m.permission_template_id
         JOIN users u ON u.id = m.user_id
        WHERE m.project_id = $1 AND u.email = 'ola@vance.test'`,
      [projectId],
    )
    // Least privilege for an imported account. Somebody who left in 2019
    // should not come back with standing access to a live job.
    expect(template[0]?.name).toBe('Read Only')
  })

  it('lands an unrecognised status open and says so rather than guessing closed', async () => {
    const records = await kernel.list(pm, { projectId, typeKey: 'rfi' })
    const pending = records.find((r) => r.title === 'Curtain wall anchor spacing')!
    expect(pending.status).toBe('open')
  })
})
