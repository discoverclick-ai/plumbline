import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { clearRecordTypeCache, provisionTenant, withTenant } from '@plumbline/shared'
import { ToolLanding } from '../../src/screens/ToolLanding.tsx'
import { RecordDetail } from '../../src/screens/RecordDetail.tsx'
import {
  renderAsUser,
  seedProject,
  startHarness,
  tokenFor,
  type Harness,
  type SeededProject,
} from '../support/harness.tsx'

/**
 * The claim this file exists to defend: there is no per-tool screen in this
 * codebase, so a record type added by a migration works in the UI with no
 * client release.
 *
 * The last test proves it the only way that means anything — by inserting a
 * record type the client has never heard of and driving it through the same
 * screens.
 */

let harness: Harness
let project: SeededProject
let pmToken: string
let architectToken: string
let tradeToken: string

beforeAll(async () => {
  harness = await startHarness(inject('databaseUrl'))
  const tenant = await provisionTenant(harness.superPool, {
    tenantName: 'Registry Builders',
    admin: { email: 'admin@registry.test', name: 'Reg Admin', password: 'a-long-enough-password' },
  })
  project = await seedProject(harness.superPool, tenant.tenantId, 'registry')
  pmToken = await tokenFor(harness.superPool, project.users.pm.email)
  architectToken = await tokenFor(harness.superPool, project.users.architect.email)
  tradeToken = await tokenFor(harness.superPool, project.users.trade.email)
})

afterEach(() => cleanup())
afterAll(async () => {
  await harness.close()
})

describe('the record list', () => {
  it('builds its tabs and its create form from the registry', async () => {
    renderAsUser(
      harness,
      pmToken,
      <ToolLanding projectId={project.projectId} projectName={project.projectName} onOpenRecord={() => {}} />,
    )

    // Tabs are record types, not routes.
    expect(await screen.findByRole('tab', { name: 'RFIs' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Submittals' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Punch List' })).toBeInTheDocument()

    await userEvent.click(await screen.findByRole('button', { name: /New RFI/ }))

    // The form is the RFI type's own fields, including its select options.
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Question')).toBeInTheDocument()
    expect(within(dialog).getByText('Drawing Number')).toBeInTheDocument()
    expect(within(dialog).getByRole('option', { name: 'Structural' })).toBeInTheDocument()
  })

  it('creates a record through the real API', async () => {
    const opened: string[] = []
    renderAsUser(
      harness,
      pmToken,
      <ToolLanding
        projectId={project.projectId}
        projectName={project.projectName}
        onOpenRecord={(id) => opened.push(id)}
      />,
    )

    await userEvent.click(await screen.findByRole('button', { name: /New RFI/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText(/Title/), 'Anchor bolt embedment at C4')
    await userEvent.type(within(dialog).getByLabelText(/Question/), 'Which detail governs at grid C4?')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(opened).toHaveLength(1))

    // It really exists, in Postgres, with a designation the kernel allocated.
    const { rows } = await withTenant(harness.superPool, project.tenantId, (tx) =>
      tx.query<{ designation: string; title: string }>('SELECT designation, title FROM records WHERE id = $1', [
        opened[0],
      ]),
    )
    expect(rows[0]?.designation).toMatch(/^RFI-\d{3}$/)
    expect(rows[0]?.title).toBe('Anchor bolt embedment at C4')
  })

  it('surfaces the server’s per-field validation next to the field', async () => {
    renderAsUser(
      harness,
      pmToken,
      <ToolLanding projectId={project.projectId} projectName={project.projectName} onOpenRecord={() => {}} />,
    )

    await userEvent.click(await screen.findByRole('button', { name: /New RFI/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText(/Title/), 'Missing the question')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    // The client does not re-implement the rules; it shows what the kernel said.
    expect(await within(dialog).findByText('Question is required')).toBeInTheDocument()
  })

  it('says why a record cannot move when nobody was assigned', async () => {
    const opened: string[] = []
    const list = renderAsUser(
      harness,
      pmToken,
      <ToolLanding
        projectId={project.projectId}
        projectName={project.projectName}
        onOpenRecord={(id) => opened.push(id)}
      />,
    )
    await userEvent.click(await screen.findByRole('button', { name: /New RFI/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText(/Title/), 'Nobody to answer this')
    await userEvent.type(within(dialog).getByLabelText(/Question/), 'Who owns this detail?')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(opened).toHaveLength(1))
    list.unmount()

    renderAsUser(harness, pmToken, <RecordDetail recordId={opened[0] as string} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Submit' }))

    // Submit needs no fields, so there is no slide-over to show issues in.
    // Swallowing the refusal here would make the button look broken.
    expect(await screen.findByRole('alert')).toHaveTextContent(/no assignee/i)
  })

  it('shows a trade partner only the tools their template grants', async () => {
    renderAsUser(
      harness,
      tradeToken,
      <ToolLanding projectId={project.projectId} projectName={project.projectName} onOpenRecord={() => {}} />,
    )

    expect(await screen.findByRole('tab', { name: 'RFIs' })).toBeInTheDocument()
    // The Trade Partner template grants 'none' on the daily log, so the tab is
    // absent rather than present and broken.
    expect(screen.queryByRole('tab', { name: 'Daily Logs' })).not.toBeInTheDocument()
  })
})

describe('the record detail', () => {
  async function createRfi(): Promise<string> {
    const opened: string[] = []
    const view = renderAsUser(
      harness,
      pmToken,
      <ToolLanding
        projectId={project.projectId}
        projectName={project.projectName}
        onOpenRecord={(id) => opened.push(id)}
      />,
    )
    await userEvent.click(await screen.findByRole('button', { name: /New RFI/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText(/Title/), 'Duct routing above corridor 2')
    await userEvent.type(within(dialog).getByLabelText(/Question/), 'Confirm the intended routing.')
    // An RFI whose next state hands the ball to an assignee cannot be
    // submitted without one, so the form asks for a person.
    await userEvent.selectOptions(
      within(dialog).getByLabelText(/Assign to/),
      within(dialog).getByRole('option', { name: /Ali Ward/ }),
    )
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(opened).toHaveLength(1))
    view.unmount()
    return opened[0] as string
  }

  it('offers only the transitions the server says this actor may run', async () => {
    const recordId = await createRfi()

    const pmView = renderAsUser(harness, pmToken, <RecordDetail recordId={recordId} />)
    expect(await screen.findByRole('button', { name: 'Submit' })).toBeInTheDocument()
    // The author may submit and close; answering is the design team's move.
    expect(screen.queryByRole('button', { name: 'Answer' })).not.toBeInTheDocument()
    pmView.unmount()

    renderAsUser(harness, architectToken, <RecordDetail recordId={recordId} />)
    // In draft there is nothing for the architect to do, and the screen says so
    // rather than showing buttons that would 403.
    expect(await screen.findByText(/Nothing for you to do/)).toBeInTheDocument()
  })

  it('runs a transition, collecting exactly the fields that transition requires', async () => {
    const recordId = await createRfi()

    const pmView = renderAsUser(harness, pmToken, <RecordDetail recordId={recordId} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Submit' }))
    // Submit requires no fields, so it runs without a form.
    expect(await screen.findByText('Open')).toBeInTheDocument()
    pmView.unmount()

    renderAsUser(harness, architectToken, <RecordDetail recordId={recordId} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Answer' }))

    // Answer declares requiresFields: ['answer'], so the slide-over asks for
    // that and not for the whole record.
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Official Response')).toBeInTheDocument()
    expect(within(dialog).queryByText('Drawing Number')).not.toBeInTheDocument()

    await userEvent.type(within(dialog).getByLabelText(/Official Response/), 'Detail 5/S-401 governs.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Answer' }))

    expect(await screen.findByText('Answered')).toBeInTheDocument()

    const { rows } = await withTenant(harness.superPool, project.tenantId, (tx) =>
      tx.query<{ status: string; body: Record<string, unknown> }>(
        'SELECT status, body FROM records WHERE id = $1',
        [recordId],
      ),
    )
    expect(rows[0]?.status).toBe('answered')
    expect(String(rows[0]?.body['answer'])).toContain('S-401')
  })
})

describe('a record type the client has never seen', () => {
  it('renders and creates without a client release', async () => {
    // Added the way a migration would add it: a row in the registry. No
    // screen, no route, no component, no deploy.
    await harness.superPool.query(
      `INSERT INTO record_types (key, tool_key, display_name, display_name_plural, number_prefix, definition)
            VALUES ('site_instruction', 'rfis', 'Site Instruction', 'Site Instructions', 'SI', $1::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [
        JSON.stringify({
          fields: [
            { key: 'instruction', label: 'Instruction', type: 'multiline', required: true },
            { key: 'urgency', label: 'Urgency', type: 'select', options: ['Routine', 'Immediate'] },
          ],
          workflow: {
            initial: 'draft',
            states: [
              { key: 'draft', label: 'Draft', ballInCourt: 'creator' },
              { key: 'issued', label: 'Issued', terminal: true, ballInCourt: 'none' },
            ],
            transitions: [
              {
                key: 'issue',
                label: 'Issue',
                from: ['draft'],
                to: 'issued',
                requires: { level: 'standard', participantRoles: ['creator'] },
              },
            ],
          },
        }),
      ],
    )

    // The API caches the registry per process, exactly as it does in
    // production; a deployment picks a new type up on restart.
    clearRecordTypeCache()

    const opened: string[] = []
    renderAsUser(
      harness,
      pmToken,
      <ToolLanding
        projectId={project.projectId}
        projectName={project.projectName}
        onOpenRecord={(id) => opened.push(id)}
      />,
    )

    const tab = await screen.findByRole('tab', { name: 'Site Instructions' })
    await userEvent.click(tab)
    await userEvent.click(await screen.findByRole('button', { name: /New Site Instruction/ }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Instruction')).toBeInTheDocument()
    expect(within(dialog).getByRole('option', { name: 'Immediate' })).toBeInTheDocument()

    await userEvent.type(within(dialog).getByLabelText(/Title/), 'Stop work at the north stair')
    await userEvent.type(within(dialog).getByLabelText(/Instruction/), 'Stop work until the guardrail is in.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(opened).toHaveLength(1))
    const { rows } = await withTenant(harness.superPool, project.tenantId, (tx) =>
      tx.query<{ designation: string }>('SELECT designation FROM records WHERE id = $1', [opened[0]]),
    )
    expect(rows[0]?.designation).toBe('SI-001')
  })
})
