import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { RecordKernel, ScheduleService, createPool, provisionTenant } from '@plumbline/shared'
import { Lookahead, exposureTone, floatText, startsIn } from '../../src/screens/Lookahead.tsx'
import { RecordDetail } from '../../src/screens/RecordDetail.tsx'
import { renderAsUser, seedProject, startHarness, tokenFor, type Harness, type SeededProject } from '../support/harness.tsx'

/**
 * The morning meeting, in a browser.
 *
 * No Gantt chart, on purpose. Nobody standing in a trailer at seven needs a
 * picture of the plan; they need the list of things that will stop them and
 * the name of the person sitting on each one.
 */

const tab = (...cells: string[]): string => cells.join('\t')
const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

let harness: Harness
let project: SeededProject
let pmToken: string
let architectToken: string
let rfiId: string

beforeAll(async () => {
  harness = await startHarness(inject('databaseUrl'))
  const tenant = await provisionTenant(harness.superPool, {
    tenantName: 'Lookahead Web',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@lookaheadweb.test', name: 'Lou Admin', password: 'a-long-enough-password' },
  })
  project = await seedProject(harness.superPool, tenant.tenantId, 'lookaheadweb')
  pmToken = await tokenFor(harness.superPool, project.users.pm.email)
  architectToken = await tokenFor(harness.superPool, project.users.architect.email)

  const pool = createPool({ connectionString: inject('databaseUrl') })
  try {
    const schedule = new ScheduleService(pool)
    const kernel = new RecordKernel(pool)
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
        tab('%R', '2', 'A1020', 'Install curtain wall', 'TT_Task', `${inDays(19)} 08:00`, '240'),
        tab('%R', '3', 'A9000', 'Landscaping', 'TT_Task', `${inDays(200)} 08:00`, '800'),
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
    rfiId = rfi.record.id

    // Sitting longer than the activity has float. This is the row the screen
    // exists to make impossible to miss.
    await pool.query(
      `UPDATE record_assignments SET assigned_at = now() - interval '9 days'
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

describe('saying it the way a superintendent would', () => {
  it('never says zero point zero zero days of float', () => {
    expect(floatText('2.00')).toBe('2 days of float')
    expect(floatText('1.00')).toBe('1 day of float')
    expect(floatText('0.00')).toBe('critical path')
    expect(floatText('-3.00')).toBe('critical path')
    expect(floatText(null)).toBe('no float shown')
  })

  it('counts start dates in days, not in dates', () => {
    const now = new Date('2026-06-15T12:00:00Z')
    expect(startsIn('2026-06-15', now)).toBe('starts today')
    expect(startsIn('2026-06-16', now)).toBe('starts tomorrow')
    expect(startsIn('2026-06-22', now)).toBe('starts in 7d')
    expect(startsIn('2026-06-10', now)).toBe('started 5d ago')
    expect(startsIn(null, now)).toBe('unscheduled')
  })

  it('goes red once the waiting has eaten the float, not when the schedule says so', () => {
    // Twenty days of float and twenty-two days of waiting is already late. A
    // screen that showed that in grey because the schedule says twenty would
    // be actively misleading.
    const base = {
      activityCode: 'A',
      activityName: 'A',
      startAt: null,
      finishAt: null,
      isCritical: false,
      openRecords: 1,
      records: [],
    }
    expect(exposureTone({ ...base, totalFloatDays: '20.00', longestWaitDays: 22, floatRemainingDays: -2 })).toBe(
      'danger',
    )
    expect(exposureTone({ ...base, totalFloatDays: '20.00', longestWaitDays: 17, floatRemainingDays: 3 })).toBe('warn')
    expect(exposureTone({ ...base, totalFloatDays: '20.00', longestWaitDays: 1, floatRemainingDays: 19 })).toBe(
      'neutral',
    )
    // Nothing waiting yet: fall back to the schedule's own verdict.
    expect(
      exposureTone({ ...base, isCritical: true, totalFloatDays: '0.00', longestWaitDays: null, floatRemainingDays: null }),
    ).toBe('danger')
  })
})

describe('the screen', () => {
  it('leads with what is in the way, and names who is sitting on it', async () => {
    renderAsUser(harness, pmToken, <Lookahead projectId={project.projectId} projectName={project.projectName} />)

    const row = (await screen.findByText('Erect structural steel')).closest('tr') as HTMLElement
    expect(within(row).getByText('2 days of float')).toBeInTheDocument()
    expect(within(row).getByText(/waiting 9d/)).toBeInTheDocument()
    expect(within(row).getByText(/RFI-/)).toBeInTheDocument()
    // By name. "With the design team" is not something anybody can act on.
    expect(within(row).getByText(/with Ali Ward/)).toBeInTheDocument()
  })

  it('says out loud that the float is already gone', async () => {
    renderAsUser(harness, pmToken, <Lookahead projectId={project.projectId} projectName={project.projectName} />)
    await screen.findByText('Erect structural steel')

    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toMatch(/already happened/)
  })

  it('leaves out activities with nothing blocking them', async () => {
    renderAsUser(harness, pmToken, <Lookahead projectId={project.projectId} projectName={project.projectName} />)
    await screen.findByText('Erect structural steel')

    // An exposure list that includes everything is a schedule printout, and
    // there is already one of those on the wall.
    expect(screen.queryByText('Landscaping')).not.toBeInTheDocument()
    expect(screen.queryByText('Install curtain wall')).not.toBeInTheDocument()
  })

  it('shows the whole window on the lookahead tab, and widens on demand', async () => {
    renderAsUser(harness, pmToken, <Lookahead projectId={project.projectId} projectName={project.projectName} />)
    await userEvent.click(await screen.findByRole('tab', { name: /lookahead/ }))

    expect(await screen.findByText('Install curtain wall')).toBeInTheDocument()
    // Two hundred days out: a six week lookahead is a document, a three week
    // one is a conversation.
    expect(screen.queryByText('Landscaping')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '2w' }))
    expect(await screen.findByText('Erect structural steel')).toBeInTheDocument()
    expect(screen.queryByText('Install curtain wall')).not.toBeInTheDocument()
  })
})

describe('on the record itself', () => {
  it('tells the person holding it what their answer unblocks, before the question', async () => {
    renderAsUser(harness, architectToken, <RecordDetail recordId={rfiId} />)

    // Somebody deciding whether to answer today needs to know steel starts
    // this week before they read the question, not after.
    const card = (await screen.findByText('Holding up')).closest('section, div') as HTMLElement
    expect(within(card).getByText('Erect structural steel')).toBeInTheDocument()
    expect(within(card).getByText('2 days of float')).toBeInTheDocument()
  })

  it('shows nothing where nothing is linked, rather than an empty section', async () => {
    const pool = createPool({ connectionString: inject('databaseUrl') })
    let unlinkedId: string
    try {
      const kernel = new RecordKernel(pool)
      const created = await kernel.create(
        { tenantId: project.tenantId, userId: project.users.pm.id },
        {
          projectId: project.projectId,
          typeKey: 'rfi',
          title: 'Nothing depends on this one',
          body: { question: 'Just checking.' },
        },
      )
      unlinkedId = created.record.id
    } finally {
      await pool.end()
    }

    renderAsUser(harness, pmToken, <RecordDetail recordId={unlinkedId} />)
    await screen.findByText(/Nothing depends on this one/)

    // An empty "Holding up" card on most records would train people to skip
    // the section, and then to skip it on the one that mattered.
    expect(screen.queryByText('Holding up')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows a sub what their own RFI is holding up, because they hold the schedule too', async () => {
    // A trade partner reads the programme on purpose: it is how they plan
    // crews, and a sub who cannot see that steel starts Thursday cannot tell
    // anybody it is about to slip.
    const tradeToken = await tokenFor(harness.superPool, project.users.trade.email)
    renderAsUser(harness, tradeToken, <RecordDetail recordId={rfiId} />)
    expect(await screen.findByText('Erect structural steel')).toBeInTheDocument()
  })
})
