import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createPool, withTenant } from '../../src/db.js'
import { EscalationService } from '../../src/escalation.js'
import { ValidationError } from '../../src/errors.js'
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
 * Chasing, against a real queue.
 *
 * The job a project engineer does with a spreadsheet on a Friday afternoon,
 * badly, everywhere, because it is tedious and the cost of missing one is
 * invisible until it is enormous.
 */

let pool: Pool
let kernel: RecordKernel
let escalations: EscalationService
let tenantId: string
let projectId: string
let pm: Actor
let architect: Actor

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  kernel = new RecordKernel(pool)
  escalations = new EscalationService(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Jarrow Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@jarrow.test', name: 'Jo Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const design = await createOrganization(tx, tenantId, { name: 'Lowry Architects', kind: 'architect' })
    const pmId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@jarrow.test',
      name: 'Jean Poole',
      companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Employee'),
    })
    const architectId = await createUser(tx, tenantId, {
      organizationId: design,
      email: 'aor@lowry.test',
      name: 'Lou Lowry',
      companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Collaborator'),
    })
    projectId = await createProject(tx, tenantId, { number: '28-400', name: 'Jarrow Quay' })
    await addProjectMember(tx, tenantId, { projectId, userId: pmId, permissionTemplateName: 'Project Manager' })
    await addProjectMember(tx, tenantId, { projectId, userId: architectId, permissionTemplateName: 'Design Team' })
    pm = { tenantId, userId: pmId }
    architect = { tenantId, userId: architectId }
  })
})

afterAll(async () => {
  await pool.end()
})

/** An RFI sitting with the architect, due however many days ago. */
async function waiting(title: string, dueDaysAgo: number) {
  const created = await kernel.create(pm, {
    projectId,
    typeKey: 'rfi',
    title,
    body: { question: 'Which detail governs?', discipline: 'Structural' },
    participants: [{ userId: architect.userId, role: 'assignee' }],
  })
  await kernel.transition(pm, created.record.id, { transitionKey: 'submit' })
  await pool.query(
    `UPDATE record_assignments
        SET due_at = now() - ($2 || ' days')::interval,
            assigned_at = now() - (($2::int + 2) || ' days')::interval
      WHERE record_id = $1 AND released_at IS NULL`,
    [created.record.id, String(dueDaysAgo)],
  )
  return created.record.id
}

describe('working the queue', () => {
  it('drafts a chase for what is late and leaves alone what is not', async () => {
    const late = await waiting('Eleven days with the architect', 11)
    await waiting('Plenty of time left', -9)

    const result = await escalations.sweep(pm, projectId)
    expect(result.drafted).toBe(1)

    const pending = await escalations.pending(pm, projectId)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.recordId).toBe(late)
    expect(pending[0]?.level).toBe('escalated')
  })

  it('says what is actually wrong, not that something is overdue', async () => {
    const pending = await escalations.pending(pm, projectId)
    const chase = pending[0]!

    // The value is in the reason, not the alert. "RFI-014 is overdue" is
    // something a filter already knows.
    expect(chase.reason).toContain('Lou Lowry')
    expect(chase.reason).toMatch(/\d+ days? past due/)
    expect(chase.message).toContain('Answer this RFI')
    // Written to be sent by a person to a person on a job. A chase that reads
    // as machinery is one the recipient learns to ignore and one the sender is
    // embarrassed to have their name on.
    expect(chase.message).not.toMatch(/automated|do not reply/i)
  })

  it('tells whoever raised it once it is genuinely late, not the holder', async () => {
    const chase = (await escalations.pending(pm, projectId))[0]!
    expect(chase.notifiedId).toBe(pm.userId)
  })

  it('does not chase the same thing twice at the same level', async () => {
    // A daily nag is a filter rule inside a week, and after that nothing the
    // system sends is read again.
    const second = await escalations.sweep(pm, projectId)
    expect(second.drafted).toBe(0)
    expect(await escalations.pending(pm, projectId)).toHaveLength(1)
  })

  it('climbs a rung when the same thing gets worse', async () => {
    const pending = await escalations.pending(pm, projectId)
    await pool.query(
      `UPDATE record_assignments SET due_at = now() - INTERVAL '20 days'
        WHERE record_id = $1 AND released_at IS NULL`,
      [pending[0]?.recordId],
    )
    const result = await escalations.sweep(pm, projectId)
    expect(result.drafted).toBe(1)

    const levels = (await escalations.pending(pm, projectId)).map((e) => e.level)
    expect(levels).toContain('critical')
  })

  it('sends nothing on its own', async () => {
    // Same gate as every other agent here. One that emails a client's
    // architect unsupervised is one incident away from being switched off.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM escalations WHERE tenant_id = $1 AND approved_at IS NOT NULL`,
      [tenantId],
    )
    expect(Number(rows[0]?.n)).toBe(0)
  })
})

describe('deciding a chase', () => {
  it('records an approval and will not decide it twice', async () => {
    const chase = (await escalations.pending(pm, projectId))[0]!
    await escalations.approve(pm, chase.id)
    await expect(escalations.approve(pm, chase.id)).rejects.toBeInstanceOf(ValidationError)
  })

  it('keeps a dismissed chase rather than deleting it', async () => {
    const chase = (await escalations.pending(pm, projectId))[0]!
    await escalations.dismiss(pm, chase.id)

    // "We decided not to chase this" is the answer to a question somebody
    // asks in a delay claim, and a deleted row cannot give it.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM escalations WHERE id = $1 AND dismissed_at IS NOT NULL`,
      [chase.id],
    )
    expect(Number(rows[0]?.n)).toBe(1)
    expect((await escalations.pending(pm, projectId)).some((e) => e.id === chase.id)).toBe(false)
  })
})
