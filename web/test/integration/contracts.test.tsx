import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import {
  ClockEngine,
  ContractService,
  ObligationService,
  RecordKernel,
  createPool,
  provisionTenant,
} from '@plumbline/shared'
import { Contracts, clockTone, dueText, highlight, windowText } from '../../src/screens/Contracts.tsx'
import { renderAsUser, seedProject, startHarness, tokenFor, type Harness, type SeededProject } from '../support/harness.tsx'

/**
 * The contract profile, in a browser.
 *
 * The one screen where being wrong is worse than being empty. A highlight on
 * the wrong words is a fabricated citation with a user interface around it,
 * and a deadline shown without its arithmetic is a number nobody will stake a
 * claim on.
 */

const CLAUSE_TEXT = `4.7.1 If the Subcontractor encounters conditions at the site which are
subsurface or otherwise concealed physical conditions which differ materially
from those indicated in the Subcontract Documents, the Subcontractor shall
give written notice to the Contractor within five days after the first
observance of the conditions.`

const CONTRACT = `ARTICLE 4  CLAIMS AND NOTICE\n\n${CLAUSE_TEXT}\n\n4.7.2 Failure to give notice shall constitute a waiver of any claim.\n`

let harness: Harness
let project: SeededProject
let pmToken: string
let tradeToken: string

beforeAll(async () => {
  harness = await startHarness(inject('databaseUrl'))
  const tenant = await provisionTenant(harness.superPool, {
    tenantName: 'Notice Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@noticeweb.test', name: 'Nora Admin', password: 'a-long-enough-password' },
  })
  project = await seedProject(harness.superPool, tenant.tenantId, 'noticeweb')
  pmToken = await tokenFor(harness.superPool, project.users.pm.email)
  tradeToken = await tokenFor(harness.superPool, project.users.trade.email)

  const pool = createPool({ connectionString: inject('databaseUrl') })
  try {
    const contracts = new ContractService(pool)
    const obligations = new ObligationService(pool)
    const engine = new ClockEngine(pool)
    const kernel = new RecordKernel(pool)
    const pm = { tenantId: project.tenantId, userId: project.users.pm.id }

    const doc = await contracts.createDocument(pm, {
      projectId: project.projectId,
      kind: 'subcontract',
      title: 'Earthwork Subcontract',
      executedAt: '2026-02-01',
    })
    await contracts.segmentDocument(pm, doc.id, CONTRACT)
    const clauses = await contracts.clauses(pm, doc.id)
    const clause = clauses.find((c) => c.clauseNumber === '4.7.1')!

    await contracts.setCalendar(pm, project.projectId, {
      workDays: [1, 2, 3, 4, 5],
      timeZone: 'America/Denver',
    })

    await obligations.propose(pm, doc.id, [
      {
        clauseId: clause.id,
        quote: 'give written notice to the Contractor within five days after the first observance',
        obligationType: 'differing_site_conditions',
        obligorParty: 'counterparty',
        obligeeParty: 'our_org',
        triggerMatch: { type_key: 'observation', event: 'record.created' },
        triggerDescription: 'A concealed condition differing from the documents was observed',
        durationValue: 5,
        durationUnit: 'days',
        deadlineBasis: 'from_occurrence',
        consequence: 'waiver_of_claim',
        confidence: 0.92,
        rationale: 'Express notice window with an express waiver at 4.7.2.',
      },
      {
        clauseId: clause.id,
        quote: 'the Subcontractor shall give written notice to the Contractor',
        obligationType: 'notice_of_claim',
        obligorParty: 'counterparty',
        obligeeParty: 'our_org',
        triggerDescription: 'A claim arises',
        durationValue: 21,
        durationUnit: 'business_days',
        deadlineBasis: 'from_awareness',
      },
    ])

    const [first] = await obligations.list(pm, { documentId: doc.id })
    await obligations.accept(pm, first!.id)

    await kernel.create(pm, {
      projectId: project.projectId,
      typeKey: 'observation',
      title: 'Soft subgrade at the east footings',
      body: { description: 'Standing water. Not what the geotech report shows.' },
    })
    await engine.fire()
  } finally {
    await pool.end()
  }
})

afterEach(() => cleanup())
afterAll(async () => {
  await harness.close()
})

describe('the quote highlight', () => {
  it('finds the quote across the line breaks a PDF leaves behind', () => {
    const parts = highlight(CLAUSE_TEXT, 'give written notice to the Contractor within five days')
    expect(parts).not.toBeNull()
    // The highlighted run is the ORIGINAL characters, line breaks included:
    // what is on screen has to be the contract as printed.
    expect(parts![1]).toContain('give written notice to the Contractor within five days')
    expect(parts![0] + parts![1] + parts![2]).toBe(CLAUSE_TEXT)
  })

  it('returns nothing rather than guessing when the quote is not there', () => {
    // A highlight on the wrong words is a fabricated citation with a user
    // interface around it.
    expect(highlight(CLAUSE_TEXT, 'within fourteen days after the first observance')).toBeNull()
    expect(highlight(CLAUSE_TEXT, 'notice')).toBeNull()
  })
})

describe('saying it the way a person would', () => {
  it('reads the window out loud', () => {
    expect(windowText({ durationValue: 5, durationUnit: 'days', deadlineBasis: 'from_occurrence' })).toBe(
      '5 days from the event',
    )
    expect(windowText({ durationValue: 1, durationUnit: 'days', deadlineBasis: 'from_awareness' })).toBe(
      '1 day from when we became aware',
    )
    expect(windowText({ durationValue: 21, durationUnit: 'business_days', deadlineBasis: 'from_receipt' })).toBe(
      '21 business days from receipt',
    )
  })

  it('counts down on the job\u2019s calendar, not the viewer\u2019s clock', () => {
    const now = new Date('2026-06-15T12:00:00Z')
    // Later the same day is today, not tomorrow. An earlier version diffed
    // raw timestamps and rounded a six-hour window up to a day.
    expect(dueText('2026-06-15T18:00:00Z', 'UTC', now)).toBe('Due today')
    expect(dueText('2026-06-16T18:00:00Z', 'UTC', now)).toBe('Due tomorrow')
    expect(dueText('2026-06-12T18:00:00Z', 'UTC', now)).toBe('3 days past due')

    // End of 15 June in Denver is 06:00Z on the 16th. Everybody on the job
    // sees the job's date, whatever zone they are reading from.
    expect(dueText('2026-06-16T05:59:59Z', 'America/Denver', now)).toBe('Due today')
    expect(dueText('2026-06-16T05:59:59Z', 'UTC', now)).toBe('Due tomorrow')
  })

  it('colours a deadline by how much room is left, not by its state alone', () => {
    const now = new Date('2026-06-15T12:00:00Z')
    const base = { id: 'c', obligationType: 'x', consequence: 'none_stated', clauseNumber: null,
      triggerDescription: '', startedAt: '', warnAt: '', noticeRecordId: null, noticeDesignation: null,
      noticeStatus: null, triggerDesignation: null, triggerTitle: null, computation: { timeZone: 'UTC' } }
    expect(clockTone({ ...base, state: 'watching', dueAt: '2026-06-30T00:00:00Z' }, now)).toBe('neutral')
    expect(clockTone({ ...base, state: 'watching', dueAt: '2026-06-17T00:00:00Z' }, now)).toBe('warn')
    expect(clockTone({ ...base, state: 'watching', dueAt: '2026-06-14T00:00:00Z' }, now)).toBe('danger')
    expect(clockTone({ ...base, state: 'expired', dueAt: '2026-06-30T00:00:00Z' }, now)).toBe('danger')
    expect(clockTone({ ...base, state: 'satisfied', dueAt: '2026-06-14T00:00:00Z' }, now)).toBe('ok')
  })
})

describe('the review screen', () => {
  it('shows each obligation with the clause it came from, quote highlighted', async () => {
    renderAsUser(harness, pmToken, <Contracts projectId={project.projectId} projectName={project.projectName} />)
    await userEvent.click(await screen.findByRole('tab', { name: /Contract Profile/ }))

    const heading = await screen.findByText('Differing site conditions')
    const card = heading.closest('div')!.parentElement!.parentElement as HTMLElement

    expect(within(card).getByText(/5 days from the event/)).toBeInTheDocument()
    // The consequence is on the card, because it is the reason anybody cares.
    expect(within(card).getByText('Claim is waived')).toBeInTheDocument()

    // The quote is highlighted inside the clause, not repeated above it: a
    // reviewer has to see the sentence in context to judge the reading.
    const mark = card.querySelector('mark')
    expect(mark?.textContent).toContain('give written notice to the Contractor within five days')
  })

  it('accepts one, and leaves the other waiting', async () => {
    renderAsUser(harness, pmToken, <Contracts projectId={project.projectId} projectName={project.projectName} />)
    await userEvent.click(await screen.findByRole('tab', { name: /Contract Profile/ }))

    await screen.findByText('Notice of claim')
    const accepted = await screen.findAllByText('Accepted')
    expect(accepted).toHaveLength(1)

    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    // waitFor, not findAllByText: find* resolves as soon as ONE node matches,
    // and one already did before the click. It would have passed on a screen
    // where nothing happened.
    await waitFor(() => expect(screen.getAllByText('Accepted')).toHaveLength(2))
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
  })

  it('will not let a trade partner accept an obligation against themselves', async () => {
    renderAsUser(harness, tradeToken, <Contracts projectId={project.projectId} projectName={project.projectName} />)
    await userEvent.click(await screen.findByRole('tab', { name: /Contract Profile/ }))

    // They can see the instrument they signed. They cannot decide what it
    // obliges them to do.
    const buttons = screen.queryAllByRole('button', { name: 'Accept' })
    if (buttons.length > 0) {
      await userEvent.click(buttons[0]!)
      const banner = await screen.findByRole('alert')
      expect(banner.textContent).toMatch(/cannot/i)
    }
  })
})

describe('the clocks', () => {
  it('lists a running deadline with the notice behind it', async () => {
    renderAsUser(harness, pmToken, <Contracts projectId={project.projectId} projectName={project.projectName} />)

    const row = (await screen.findByText('Differing site conditions')).closest('tr') as HTMLElement
    expect(within(row).getByText(/NOT-/)).toBeInTheDocument()
    expect(within(row).getByText('Soft subgrade at the east footings')).toBeInTheDocument()
    expect(within(row).getByText(/OBS-/)).toBeInTheDocument()
  })

  it('shows its arithmetic on demand, day by day', async () => {
    renderAsUser(harness, pmToken, <Contracts projectId={project.projectId} projectName={project.projectName} />)
    await screen.findByText('Differing site conditions')

    await userEvent.click(screen.getByRole('button', { name: 'Show work' }))

    // The clause it relies on, quoted, and then the count. A deadline a
    // project manager cannot check by hand is one they will not stake a claim
    // on, and this product is asking them to.
    expect(await screen.findByText(/give written notice to the Contractor/)).toBeInTheDocument()
    expect(screen.getByText(/America\/Denver/)).toBeInTheDocument()
    expect(screen.getByText(/plus 5 days/)).toBeInTheDocument()
  })
})
