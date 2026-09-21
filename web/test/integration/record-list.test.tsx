import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { createPool, provisionTenant, RecordKernel } from '@plumbline/shared'
import { toCsv, visibleKeys } from '../../src/screens/RecordList.tsx'
import { ToolLanding } from '../../src/screens/ToolLanding.tsx'
import { renderAsUser, seedProject, startHarness, tokenFor, type Harness, type SeededProject } from '../support/harness.tsx'

/**
 * The record list, which is where a project manager actually lives.
 *
 * The four-column table this replaced meant somebody looking at eighty RFIs
 * exported to Excel and worked there, which is how a construction platform
 * loses the job it was bought for. So the assertions that earn their place
 * are about density and about filtering: the columns a type declares turning
 * up without anybody writing a screen, and a filter actually narrowing the
 * rows rather than decorating the top of the table.
 */

let harness: Harness
let project: SeededProject
let pmToken: string

beforeAll(async () => {
  harness = await startHarness(inject('databaseUrl'))
  const tenant = await provisionTenant(harness.superPool, {
    tenantName: 'List Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@list.test', name: 'Lou Admin', password: 'a-long-enough-password' },
  })
  project = await seedProject(harness.superPool, tenant.tenantId, 'list')
  pmToken = await tokenFor(harness.superPool, project.users.pm.email)

  const pool = createPool({ connectionString: inject('databaseUrl') })
  try {
    const kernel = new RecordKernel(pool)
    const pm = { tenantId: project.tenantId, userId: project.users.pm.id }
    const structural = await kernel.create(pm, {
      projectId: project.projectId,
      typeKey: 'rfi',
      title: 'Anchor bolt embedment at grid C4',
      body: { question: 'Which embedment governs?', discipline: 'Structural', drawing_number: 'S-401' },
      participants: [{ userId: project.users.architect.id, role: 'assignee' }],
    })
    await kernel.transition(pm, structural.record.id, { transitionKey: 'submit' })

    await kernel.create(pm, {
      projectId: project.projectId,
      typeKey: 'rfi',
      title: 'Duct routing conflict above corridor 2',
      body: { question: 'Does the duct clear?', discipline: 'Mechanical' },
      participants: [{ userId: project.users.architect.id, role: 'assignee' }],
    })
  } finally {
    await pool.end()
  }
})

afterEach(() => cleanup())
afterAll(async () => {
  await harness.close()
})

describe('columns that nobody wrote', () => {
  it('shows the fields the record type declares, not a fixed four', async () => {
    // The payoff of the kernel reaching the interface. Discipline and Drawing
    // Number are RFI fields defined in a migration; no file in the client
    // mentions either of them, and a tool added next month arrives with its
    // own columns the same way.
    renderAsUser(harness, pmToken, <ToolLanding projectId={project.projectId} projectName={project.projectName} onOpenRecord={() => {}} />)

    expect(await screen.findByText('Anchor bolt embedment at grid C4')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /Discipline/ })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /Drawing Number/ })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /Ball in Court/ })).toBeInTheDocument()
    expect(screen.getByText('S-401')).toBeInTheDocument()
  })

  it('keeps a paragraph field out of the default columns', async () => {
    // An RFI question runs to three sentences, and a paragraph in a table
    // cell pushes every other column off the screen. It stays available in
    // the picker, because somebody scanning for a phrase wants it.
    renderAsUser(harness, pmToken, <ToolLanding projectId={project.projectId} projectName={project.projectName} onOpenRecord={() => {}} />)
    await screen.findByText('Anchor bolt embedment at grid C4')
    expect(screen.queryByRole('columnheader', { name: /Question/ })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Columns' }))
    expect(await screen.findByLabelText('Question')).toBeInTheDocument()
  })
})

describe('narrowing eighty rows to the ones that matter', () => {
  it('filters by a field the type declared', async () => {
    // Discipline is an RFI field defined in a migration. Nothing in the
    // client names it, and the filter exists because the field is a select
    // with options — which is true of a tool added next month too.
    renderAsUser(harness, pmToken, <ToolLanding projectId={project.projectId} projectName={project.projectName} onOpenRecord={() => {}} />)
    await screen.findByText('Anchor bolt embedment at grid C4')

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Discipline' }), 'Mechanical')
    await waitFor(() => expect(screen.getByText('1 of 2 shown')).toBeInTheDocument())
    expect(screen.getByText('Duct routing conflict above corridor 2')).toBeInTheDocument()
    expect(screen.queryByText('Anchor bolt embedment at grid C4')).not.toBeInTheDocument()
  })

  it('drops the filters when you move to another tool', async () => {
    // Carrying "discipline: Mechanical" from RFIs onto Punch List shows an
    // empty table and reads as a tool with nothing in it.
    renderAsUser(harness, pmToken, <ToolLanding projectId={project.projectId} projectName={project.projectName} onOpenRecord={() => {}} />)
    await screen.findByText('Anchor bolt embedment at grid C4')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Discipline' }), 'Mechanical')
    await waitFor(() => expect(screen.getByText('1 of 2 shown')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('tab', { name: 'Punch List' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue(''))
  })

  it('says how many rows the filter is hiding', async () => {
    // A filtered table that looks like the whole table is how somebody
    // reports "we only have four open RFIs".
    renderAsUser(harness, pmToken, <ToolLanding projectId={project.projectId} projectName={project.projectName} onOpenRecord={() => {}} />)
    await screen.findByText('Anchor bolt embedment at grid C4')
    expect(screen.getByText('2 records')).toBeInTheDocument()

    await userEvent.type(screen.getByPlaceholderText(/Search RFIs/), 'anchor')
    await waitFor(() => expect(screen.getByText('1 of 2 shown')).toBeInTheDocument())
    expect(screen.queryByText('Duct routing conflict above corridor 2')).not.toBeInTheDocument()
  })

  it('searches the body, not just the title', async () => {
    renderAsUser(harness, pmToken, <ToolLanding projectId={project.projectId} projectName={project.projectName} onOpenRecord={() => {}} />)
    await screen.findByText('Anchor bolt embedment at grid C4')
    // "S-401" appears nowhere in either title. Somebody looking for every RFI
    // against a drawing is the single most common search on a job.
    await userEvent.type(screen.getByPlaceholderText(/Search RFIs/), 'S-401')
    await waitFor(() => expect(screen.getByText('1 of 2 shown')).toBeInTheDocument())
    expect(screen.getByText('Anchor bolt embedment at grid C4')).toBeInTheDocument()
  })

  it('sorts from the column header', async () => {
    renderAsUser(harness, pmToken, <ToolLanding projectId={project.projectId} projectName={project.projectName} onOpenRecord={() => {}} />)
    await screen.findByText('Anchor bolt embedment at grid C4')

    const first = () => (document.querySelectorAll('tbody tr td')[0] as HTMLElement).textContent
    expect(first()).toBe('RFI-002')
    await userEvent.click(screen.getByRole('columnheader', { name: 'Number' }))
    await waitFor(() => expect(first()).toBe('RFI-001'))
  })
})

describe('the export', () => {
  it('quotes a value containing a comma rather than splitting the row', () => {
    // A record title is free text and routinely contains a comma. An export
    // that turns one row into two is worse than no export, because it is
    // wrong in a file somebody then works from.
    const csv = toCsv(
      ['Number', 'Title'],
      [['RFI-001', 'Embedment at C4, and the shop drawings']],
    )
    expect(csv).toBe('Number,Title\r\nRFI-001,"Embedment at C4, and the shop drawings"')
  })

  it('doubles a quote inside a value', () => {
    expect(toCsv(['Note'], [['He said "no"']])).toBe('Note\r\n"He said ""no"""')
  })

  it('quotes a value containing a newline', () => {
    expect(toCsv(['Note'], [['line one\nline two']])).toBe('Note\r\n"line one\nline two"')
  })
})

describe('the column picker', () => {
  const columns = [
    { key: 'designation', byDefault: true },
    { key: 'created', byDefault: false },
  ]

  it('starts from the defaults', () => {
    expect([...visibleKeys(columns, new Set())]).toEqual(['designation'])
  })

  it('turns one off and another on', () => {
    expect([...visibleKeys(columns, new Set(['designation', '+created']))]).toEqual(['created'])
  })

  it('shows a column the product adds to the defaults later', () => {
    // The marks record CHANGES rather than the visible set. Storing the
    // visible set would silently exclude every column added after somebody
    // last touched the picker.
    const withNewDefault = [...columns, { key: 'ballInCourt', byDefault: true }]
    expect(visibleKeys(withNewDefault, new Set(['+created'])).has('ballInCourt')).toBe(true)
  })
})
