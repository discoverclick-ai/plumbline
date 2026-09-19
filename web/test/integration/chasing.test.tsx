import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { RecordKernel, ScheduleService, createPool, provisionTenant } from '@plumbline/shared'
import { Chasing, audienceLine } from '../../src/screens/Chasing.tsx'
import { renderAsUser, seedProject, startHarness, tokenFor, type Harness, type SeededProject } from '../support/harness.tsx'

/**
 * The chase queue, in a browser.
 *
 * This is where the product's central promise becomes something a person can
 * see: an agent may propose anything and send nothing. Every row is a message
 * that was written and not sent.
 */

const tab = (...cells: string[]): string => cells.join('\t')
const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

let harness: Harness
let project: SeededProject
let pmToken: string

beforeAll(async () => {
  harness = await startHarness(inject('databaseUrl'))
  const tenant = await provisionTenant(harness.superPool, {
    tenantName: 'Chase Web',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@chaseweb.test', name: 'Cass Admin', password: 'a-long-enough-password' },
  })
  project = await seedProject(harness.superPool, tenant.tenantId, 'chaseweb')
  pmToken = await tokenFor(harness.superPool, project.users.pm.email)

  const pool = createPool({ connectionString: inject('databaseUrl') })
  try {
    const kernel = new RecordKernel(pool)
    const schedule = new ScheduleService(pool)
    const pm = { tenantId: project.tenantId, userId: project.users.pm.id }

    await schedule.importXer(pm, {
      projectId: project.projectId,
      name: 'Current',
      text: [
        tab('ERMHDR', '18.8.0', '2026-03-02', 'Project', 'admin', 'P6'),
        tab('%T', 'PROJECT'),
        tab('%F', 'proj_id', 'day_hr_cnt'),
        tab('%R', '100', '8'),
        tab('%T', 'TASK'),
        tab('%F', 'task_id', 'task_code', 'task_name', 'task_type', 'early_start_date', 'total_float_hr_cnt'),
        tab('%R', '1', 'A1010', 'Erect structural steel', 'TT_Task', `${inDays(4)} 08:00`, '16'),
        tab('%E'),
      ].join('\n'),
    })

    const rfi = await kernel.create(pm, {
      projectId: project.projectId,
      typeKey: 'rfi',
      title: 'Anchor bolt embedment at grid C4',
      body: { question: 'Nine inch on S-401, seven on the shop drawings.' },
      participants: [{ userId: project.users.architect.id, role: 'assignee' }],
    })
    await kernel.transition(pm, rfi.record.id, { transitionKey: 'submit' })
    await schedule.link(pm, { recordId: rfi.record.id, activityCode: 'A1010', kind: 'blocks' })

    await pool.query(
      `UPDATE record_assignments
          SET due_at = now() - interval '6 days', assigned_at = now() - interval '11 days'
        WHERE record_id = $1 AND released_at IS NULL`,
      [rfi.record.id],
    )
  } finally {
    await pool.end()
  }
})

afterEach(() => cleanup())
afterAll(async () => {
  await harness.close()
})

describe('saying who it lands on', () => {
  const base = { id: '1', recordId: 'r', designation: 'RFI-001', title: 't', typeKey: 'rfi',
    reason: '', message: '', notifiedId: 'n', daysWaiting: 4, dueAt: null, createdAt: '' }

  it('addresses a reminder to the person holding it', () => {
    expect(audienceLine({ ...base, level: 'reminder', notifiedName: 'Ali Ward', holderName: 'Ali Ward' })).toBe(
      'To Ali Ward, who is holding it',
    )
  })

  it('addresses an escalation to whoever raised it, about the holder', () => {
    // Nobody is escalated to their manager by surprise, and the screen says
    // who is about to be told what.
    expect(audienceLine({ ...base, level: 'escalated', notifiedName: 'Pat Moreno', holderName: 'Ali Ward' })).toBe(
      'To Pat Moreno, about Ali Ward',
    )
  })

  it('never shows a bare id where a name belongs', () => {
    expect(audienceLine({ ...base, level: 'reminder', notifiedName: null, holderName: null })).not.toMatch(/[0-9a-f]{8}/)
  })
})

describe('the queue', () => {
  it('starts empty and fills only when somebody asks it to', async () => {
    renderAsUser(harness, pmToken, <Chasing projectId={project.projectId} projectName={project.projectName} />)

    expect(await screen.findByText('Nothing waiting on you')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Work the queue' }))
    // The designation appears in the header and again inside the drafted
    // message, which is correct; the assertion is that a card arrived.
    expect(await screen.findAllByRole('article')).toHaveLength(1)
  })

  it('shows the whole drafted message, not a summary of it', async () => {
    renderAsUser(harness, pmToken, <Chasing projectId={project.projectId} projectName={project.projectName} />)
    const [card] = await screen.findAllByRole('article')

    // Anything a person is about to put their name on, they should have to
    // look at.
    const text = card!.textContent ?? ''
    expect(text).toMatch(/Answer this RFI/)
    // And the schedule consequence is in it, which is what turns a nag into
    // a phone call.
    expect(text).toMatch(/Erect structural steel/)
    expect(text).toMatch(/2 days of float/)
  })

  it('offers exactly two buttons, and no bulk approve', async () => {
    renderAsUser(harness, pmToken, <Chasing projectId={project.projectId} projectName={project.projectName} />)
    const [card] = await screen.findAllByRole('article')

    const buttons = within(card!).getAllByRole('button').map((b) => b.textContent)
    expect(buttons).toEqual(['Stand down', 'Send this'])
    // Approving forty chases with one click is the same as sending forty
    // unread, and the whole value of the gate is that somebody read them.
    expect(screen.queryByRole('button', { name: /approve all|send all/i })).not.toBeInTheDocument()
  })

  it('keeps a stand-down on the record rather than deleting it', async () => {
    renderAsUser(harness, pmToken, <Chasing projectId={project.projectId} projectName={project.projectName} />)
    const [card] = await screen.findAllByRole('article')

    await userEvent.click(within(card!).getByRole('button', { name: 'Stand down' }))

    // "Did we chase them, and when" is the question a delay claim turns on,
    // and "we decided not to" is an answer.
    await waitFor(() => expect(screen.getByText(/stood down/i)).toBeInTheDocument())
    expect(screen.getByText(/on the record/i)).toBeInTheDocument()
    expect(await screen.findByText('Nothing waiting on you')).toBeInTheDocument()
  })
})
