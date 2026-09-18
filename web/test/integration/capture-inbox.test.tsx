import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { CaptureService, createPool, provisionTenant, withTenant } from '@plumbline/shared'
import { CaptureInbox } from '../../src/screens/CaptureInbox.tsx'
import {
  renderAsUser,
  seedProject,
  startHarness,
  tokenFor,
  type Harness,
  type SeededProject,
} from '../support/harness.tsx'

/**
 * The approval gate as a screen.
 *
 * The two things worth proving in a browser, because they are the product:
 * accepting really creates the record through the ordinary kernel path, and a
 * person who may not create that record type is refused in the UI exactly as
 * they would be at the API.
 */

let harness: Harness
let project: SeededProject
let pmToken: string
let tradeToken: string

const OBSERVATION_DRAFT = {
  typeKey: 'observation',
  title: 'Guardrail missing at level 5 north',
  fields: [
    { key: 'description', value: 'Guardrail missing on the north side of level 5 at the stair opening.' },
    { key: 'observation_type', value: 'Safety' },
  ],
  participants: [],
  confidence: 0.91,
  rationale: 'The note describes an unsafe condition seen on site.',
}

/** Puts a pending proposal in the inbox, the way the field would. */
async function seedProposal(draft: unknown, text: string, asUserId: string): Promise<string> {
  const pool = createPool({ connectionString: inject('databaseUrl') })
  try {
    harness.provider.push(draft)
    const capture = new CaptureService(pool, harness.provider)
    const actor = { tenantId: project.tenantId, userId: asUserId }
    const signal = await capture.record(actor, { projectId: project.projectId, kind: 'voice', text })
    const proposal = await capture.interpret(actor, signal.id)
    return proposal.id
  } finally {
    await pool.end()
  }
}


/**
 * Several proposals sit in this project's inbox at once, which is the honest
 * shape of the screen: "the Review button" is ambiguous, so every interaction
 * is scoped to the card carrying that proposal's title.
 */
async function reviewCard(title: string): Promise<HTMLElement> {
  const heading = await screen.findByText(title)
  const card = heading.closest('section')
  if (!card) throw new Error(`no card found around "${title}"`)
  await userEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Review' }))
  return screen.findByRole('dialog')
}

beforeAll(async () => {
  harness = await startHarness(inject('databaseUrl'))
  const tenant = await provisionTenant(harness.superPool, {
    tenantName: 'Inbox Builders',
    admin: { email: 'admin@inbox.test', name: 'Ina Admin', password: 'a-long-enough-password' },
  })
  project = await seedProject(harness.superPool, tenant.tenantId, 'inbox')
  pmToken = await tokenFor(harness.superPool, project.users.pm.email)
  tradeToken = await tokenFor(harness.superPool, project.users.trade.email)
})

afterEach(() => cleanup())
afterAll(async () => {
  await harness.close()
})

describe('the capture inbox', () => {
  it('shows the draft, its confidence and why the agent read it that way', async () => {
    await seedProposal(OBSERVATION_DRAFT, 'No guardrail on the north side of five.', project.users.pm.id)

    renderAsUser(
      harness,
      pmToken,
      <CaptureInbox projectId={project.projectId} projectName={project.projectName} />,
    )

    expect(await screen.findByText('Guardrail missing at level 5 north')).toBeInTheDocument()
    expect(screen.getByText('91% sure')).toBeInTheDocument()
    // A draft you cannot interrogate is one you should not accept.
    expect(screen.getByText(/unsafe condition seen on site/)).toBeInTheDocument()
  })

  it('accepting creates the record, as the person accepting', async () => {
    const proposalId = await seedProposal(
      { ...OBSERVATION_DRAFT, title: 'Loose handrail on the east stair' },
      'Handrail loose on the east stair.',
      project.users.pm.id,
    )

    renderAsUser(
      harness,
      pmToken,
      <CaptureInbox projectId={project.projectId} projectName={project.projectName} />,
    )

    const dialog = await reviewCard('Loose handrail on the east stair')
    expect(within(dialog).getByText(/nothing exists until you accept/)).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Accept and create' }))

    expect(await screen.findByText(/OBS-\d{3} created/)).toBeInTheDocument()

    const { rows } = await withTenant(harness.superPool, project.tenantId, (tx) =>
      tx.query<{ status: string; record_id: string; created_by: string; edited: boolean }>(
        `SELECT p.status, p.record_id, p.edited, r.created_by
           FROM capture_proposals p JOIN records r ON r.id = p.record_id
          WHERE p.id = $1`,
        [proposalId],
      ),
    )
    expect(rows[0]?.status).toBe('accepted')
    // Created by the approver, not by an agent or a service account.
    expect(rows[0]?.created_by).toBe(project.users.pm.id)
    expect(rows[0]?.edited).toBe(false)
  })

  it('records an edit when the human fixes the draft first', async () => {
    const proposalId = await seedProposal(
      { ...OBSERVATION_DRAFT, title: 'Vague note' },
      'Something on the west elevation.',
      project.users.pm.id,
    )

    renderAsUser(
      harness,
      pmToken,
      <CaptureInbox projectId={project.projectId} projectName={project.projectName} />,
    )

    const dialog = await reviewCard('Vague note')
    const titleField = within(dialog).getByLabelText(/Title/)
    await userEvent.clear(titleField)
    await userEvent.type(titleField, 'Efflorescence on west elevation CMU')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Accept and create' }))

    expect(await screen.findByText(/created with your edits/)).toBeInTheDocument()

    // The edited flag is the pipeline's quality metric, so the UI must set it
    // honestly rather than treating an edit as an ordinary accept.
    const { rows } = await withTenant(harness.superPool, project.tenantId, (tx) =>
      tx.query<{ edited: boolean; title: string }>(
        'SELECT edited, title FROM capture_proposals WHERE id = $1',
        [proposalId],
      ),
    )
    expect(rows[0]?.edited).toBe(true)
    expect(rows[0]?.title).toBe('Efflorescence on west elevation CMU')
  })

  it('refuses in the UI what the API would refuse, and says why', async () => {
    // A daily log proposal: the Trade Partner template grants 'none' on that
    // tool, so accepting must fail for them however good the draft is.
    await seedProposal(
      {
        typeKey: 'daily_log',
        title: 'Daily log for the gate test',
        fields: [
          { key: 'log_date', value: '2026-03-04' },
          { key: 'work_performed', value: 'Slab pour on the east half.' },
        ],
        participants: [],
        confidence: 0.95,
        rationale: 'A summary of the day’s work.',
      },
      'Poured the east slab today, fourteen guys.',
      project.users.trade.id,
    )

    renderAsUser(
      harness,
      tradeToken,
      <CaptureInbox projectId={project.projectId} projectName={project.projectName} />,
    )

    // Their own capture, drafted as a daily log: a tool their template grants
    // 'none' on. The inbox is not empty for them — they can read observations —
    // but this proposal must not be in it, because the inbox must never become
    // a side channel onto a tool somebody has no access to.
    await screen.findByText('Guardrail missing at level 5 north')
    expect(screen.queryByText('Daily log for the gate test')).not.toBeInTheDocument()
  })

  it('hides the reject action from someone who may not decide', async () => {
    await seedProposal(
      { ...OBSERVATION_DRAFT, title: 'Trip hazard at the south entry' },
      'Trip hazard at the south entry.',
      project.users.pm.id,
    )

    renderAsUser(
      harness,
      tradeToken,
      <CaptureInbox projectId={project.projectId} projectName={project.projectName} />,
    )

    const dialog = await reviewCard('Trip hazard at the south entry')
    // Read-only on capture: they see the draft, they do not decide it.
    expect(within(dialog).getByRole('button', { name: 'Reject' })).toBeDisabled()
  })
})
