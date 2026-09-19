import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createPool, withTenant } from '../../src/db.js'
import { RecordKernel, type Actor } from '../../src/kernel.js'
import { NotificationService, RecordingMailSender, stripQuotedReply } from '../../src/notifications.js'
import {
  addProjectMember,
  createOrganization,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
} from '../../src/provisioning.js'

/**
 * The message that makes ball in court real.
 *
 * A superintendent does not open your app. Your app reaches them or it does
 * not exist, and the reply they send from their phone at 6am is either a
 * comment on the record or it is lost.
 */

let pool: Pool
let kernel: RecordKernel
let mail: RecordingMailSender
let notifications: NotificationService
let tenantId: string
let projectId: string
let pm: Actor
let architect: Actor
let watcher: string

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  kernel = new RecordKernel(pool)
  mail = new RecordingMailSender()
  notifications = new NotificationService(pool, mail, { replyDomain: 'reply.plumbline.test' })

  const tenant = await provisionTenant(pool, {
    tenantName: 'Mercer Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@mercer.test', name: 'Mo Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const design = await createOrganization(tx, tenantId, { name: 'Reed Architects', kind: 'architect' })
    const employee = await findTemplateByName(tx, tenantId, 'company', 'Employee')
    const collaborator = await findTemplateByName(tx, tenantId, 'company', 'Collaborator')

    const pmId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@mercer.test',
      name: 'Mika Poole',
      companyPermissionTemplateId: employee,
    })
    const architectId = await createUser(tx, tenantId, {
      organizationId: design,
      email: 'aor@reed.test',
      name: 'Rae Reed',
      companyPermissionTemplateId: collaborator,
    })
    watcher = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'px@mercer.test',
      name: 'Wes Pike',
      companyPermissionTemplateId: employee,
    })

    projectId = await createProject(tx, tenantId, { number: '26-800', name: 'Mercer Wharf' })
    for (const userId of [pmId, watcher]) {
      await addProjectMember(tx, tenantId, { projectId, userId, permissionTemplateName: 'Project Manager' })
    }
    await addProjectMember(tx, tenantId, { projectId, userId: architectId, permissionTemplateName: 'Design Team' })

    // Wes reads everything on this job; everybody else hears about their own court.
    await tx.query(
      `INSERT INTO notification_preferences (tenant_id, user_id, project_id, scope) VALUES ($1, $2, $3, 'all')`,
      [tenantId, watcher, projectId],
    )

    pm = { tenantId, userId: pmId }
    architect = { tenantId, userId: architectId }
  })
})

afterAll(async () => {
  await pool.end()
})

async function queued(recordId: string): Promise<{ recipient_id: string; subject: string; state: string }[]> {
  const { rows } = await pool.query(
    `SELECT recipient_id, subject, state FROM notifications WHERE tenant_id = $1 AND record_id = $2`,
    [tenantId, recordId],
  )
  return rows as never
}

describe('telling the person who now owes something', () => {
  it('notifies the new holder and the person who asked for everything, never the actor', async () => {
    const created = await kernel.create(pm, {
      projectId,
      typeKey: 'rfi',
      title: 'Parapet flashing at the west elevation',
      body: { question: 'Which flashing detail governs?', discipline: 'Architectural' },
      participants: [
        { userId: architect.userId, role: 'assignee' },
        { userId: watcher, role: 'distribution' },
      ],
    })
    await kernel.transition(pm, created.record.id, { transitionKey: 'submit' })
    await notifications.generate()

    const rows = await queued(created.record.id)
    const recipients = rows.map((r) => r.recipient_id)

    // The architect now holds it.
    expect(recipients).toContain(architect.userId)
    // Wes asked for everything on this job.
    expect(recipients).toContain(watcher)
    // And the PM caused all of it. A notification about your own action is
    // how people learn to filter you into a folder.
    expect(recipients).not.toContain(pm.userId)
  })

  it('says what is owed in the subject line, because that is all anybody reads', async () => {
    const created = await kernel.create(pm, {
      projectId,
      typeKey: 'rfi',
      title: 'Slab depression at the elevator pit',
      body: { question: 'Confirm the depression depth.', discipline: 'Structural' },
      participants: [{ userId: architect.userId, role: 'assignee' }],
    })
    await kernel.transition(pm, created.record.id, { transitionKey: 'submit' })
    await notifications.generate()

    const subject = (await queued(created.record.id)).find((r) => r.recipient_id === architect.userId)?.subject
    expect(subject).toContain(created.record.designation)
    expect(subject).toContain('in your court')
    expect(subject).toContain('Slab depression')
  })

  it('does not send the same thing twice when the log is replayed', async () => {
    const created = await kernel.create(pm, {
      projectId,
      typeKey: 'rfi',
      title: 'Replay safety',
      body: { question: 'Anything.', discipline: 'Structural' },
      participants: [{ userId: architect.userId, role: 'assignee' }],
    })
    await kernel.transition(pm, created.record.id, { transitionKey: 'submit' })
    await notifications.generate()
    const first = (await queued(created.record.id)).length

    // Rewinding the cursor is what happens whenever a bug is fixed in the
    // generator, so it must be safe.
    await pool.query(`UPDATE notification_cursor SET last_event_id = 0 WHERE name = 'notifications'`)
    await notifications.generate()

    expect((await queued(created.record.id)).length).toBe(first)
  })
})

describe('the reply that never gets logged in', () => {
  it('turns an emailed reply into a comment on the right record', async () => {
    const created = await kernel.create(pm, {
      projectId,
      typeKey: 'rfi',
      title: 'Reply round trip',
      body: { question: 'Which detail governs at the parapet?', discipline: 'Architectural' },
      participants: [{ userId: architect.userId, role: 'assignee' }],
    })
    await kernel.transition(pm, created.record.id, { transitionKey: 'submit' })
    await notifications.generate()
    await notifications.deliver()

    const message = mail.sent.find((m) => m.to === 'aor@reed.test' && m.subject.includes('Reply round trip'))
    expect(message?.replyTo).toMatch(/^reply\+[A-Za-z0-9_-]+@reply\.plumbline\.test$/)

    const result = await notifications.receiveReply(
      message!.replyTo as string,
      ['Detail 5 on A-501 governs. Nine inches.', '', 'On Thu, Mika Poole wrote:', '> Which detail governs?'].join('\n'),
    )
    expect(result.recordId).toBe(created.record.id)

    const history = await kernel.history(pm, created.record.id)
    const comment = history.comments.at(-1)
    // Posted AS the architect, because the token is bound to one person, and
    // without the thread quoted back at us.
    expect(comment?.body).toBe('Detail 5 on A-501 governs. Nine inches.')
    expect(comment?.authorUserId).toBe(architect.userId)
  })

  it('refuses an address nobody was issued', async () => {
    await expect(
      notifications.receiveReply('reply+notarealtoken@reply.plumbline.test', 'hello'),
    ).rejects.toThrow()
  })
})

describe('stripping the thread', () => {
  it('keeps the new text and drops the history', () => {
    expect(
      stripQuotedReply(['Nine inch embedment governs.', '', 'On Tue, Sam Ruiz wrote:', '> Which one?'].join('\n')),
    ).toBe('Nine inch embedment governs.')

    expect(stripQuotedReply(['Approved.', '________________', 'From: someone'].join('\n'))).toBe('Approved.')
    expect(stripQuotedReply('> only a quote')).toBe('')
  })
})
