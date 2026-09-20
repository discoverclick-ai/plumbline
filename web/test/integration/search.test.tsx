import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { AdministrationService, RecordKernel, createPool, provisionTenant } from '@plumbline/shared'
import { SearchBox } from '../../src/screens/Search.tsx'
import { renderAsUser, seedProject, startHarness, tokenFor, type Harness, type SeededProject } from '../support/harness.tsx'

/**
 * Finding a record again.
 *
 * The most-used affordance in any construction product, and it had no client
 * at all: the route existed, the tsvector column existed, and nothing asked.
 *
 * The two properties worth holding are both about scope. It searches every
 * job this person is on, because half of all searches are "which job was
 * that weld RFI on". And it matches designations, because "RFI-014" is what
 * somebody reads off a drawing and types.
 */

let harness: Harness
let first: SeededProject
let secondProjectId: string
let pmToken: string
let tradeToken: string

beforeAll(async () => {
  harness = await startHarness(inject('databaseUrl'))
  const tenant = await provisionTenant(harness.superPool, {
    tenantName: 'Search Web',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@searchweb.test', name: 'Sid Admin', password: 'a-long-enough-password' },
  })
  first = await seedProject(harness.superPool, tenant.tenantId, 'searchweb')
  pmToken = await tokenFor(harness.superPool, first.users.pm.email)
  tradeToken = await tokenFor(harness.superPool, first.users.trade.email)

  const pool = createPool({ connectionString: inject('databaseUrl') })
  try {
    const kernel = new RecordKernel(pool)
    const pm = { tenantId: first.tenantId, userId: first.users.pm.id }

    await kernel.create(pm, {
      projectId: first.projectId,
      typeKey: 'rfi',
      title: 'Anchor bolt embedment at grid C4',
      body: { question: 'Nine inch on S-401, seven on the shops.' },
    })

    // A second job the SAME person is on, which is what makes cross-project
    // search worth having. Created through the administration service rather
    // than raw SQL: an earlier version picked a template with
    // `name = 'Project Manager' LIMIT 1` and got the OWNER's, which grants
    // read_only on RFIs. That is precisely the ambiguity the product warns
    // about, reproduced in a test fixture.
    const admin = new AdministrationService(pool)
    const created = await admin.projectStart(pm, { number: '26-902', name: 'Second Yard' })
    secondProjectId = created.id
    await kernel.create(pm, {
      projectId: secondProjectId,
      typeKey: 'rfi',
      title: 'Curtain wall anchor spacing at the south elevation',
      body: { question: 'Confirm the spacing.' },
    })
  } finally {
    await pool.end()
  }
})

afterEach(() => cleanup())
afterAll(async () => {
  await harness.close()
})

describe('the search box', () => {
  it('looks across every job this person is on, and says which', async () => {
    renderAsUser(harness, pmToken, <SearchBox onOpenRecord={() => {}} />)

    await userEvent.type(screen.getByPlaceholderText(/Search RFI-014/), 'anchor')

    // Half of all searches are "which job was that weld RFI on", and a box
    // scoped to the current project cannot answer the question people
    // actually have.
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(2), { timeout: 3000 })
    const text = screen.getAllByRole('option').map((o) => o.textContent ?? '')
    expect(text.some((t) => t.includes('Search Web') || t.includes('searchweb'))).toBe(true)
    expect(text.some((t) => t.includes('Second Yard'))).toBe(true)
  })

  it('matches a designation, which is what people actually type', async () => {
    renderAsUser(harness, pmToken, <SearchBox onOpenRecord={() => {}} />)
    await userEvent.type(screen.getByPlaceholderText(/Search RFI-014/), 'RFI-1')

    // "RFI-014" is read off a drawing and typed in. A search that only
    // matched prose would miss the commonest query in the product.
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0), { timeout: 3000 })
  })

  it('opens the record it was asked for', async () => {
    const opened = vi.fn()
    renderAsUser(harness, pmToken, <SearchBox onOpenRecord={opened} />)
    await userEvent.type(screen.getByPlaceholderText(/Search RFI-014/), 'embedment')

    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(1), { timeout: 3000 })
    await userEvent.click(screen.getAllByRole('option')[0]!)

    expect(opened).toHaveBeenCalledTimes(1)
    expect(opened.mock.calls[0]![1]).toBe(first.projectId)
  })

  it('says nothing was found rather than showing an empty box', async () => {
    renderAsUser(harness, pmToken, <SearchBox onOpenRecord={() => {}} />)
    await userEvent.type(screen.getByPlaceholderText(/Search RFI-014/), 'zzzznothing')

    const empty = await screen.findByText(/Nothing matching/, {}, { timeout: 3000 })
    // Named, because "no results" with the query missing leaves somebody
    // wondering whether it searched at all.
    expect(empty.textContent).toMatch(/zzzznothing/)
    expect(empty.textContent).toMatch(/any job you are on/)
  })

  it('does not search on a single character', async () => {
    renderAsUser(harness, pmToken, <SearchBox onOpenRecord={() => {}} />)
    await userEvent.type(screen.getByPlaceholderText(/Search RFI-014/), 'a')

    // Every keystroke is a tsvector scan across a tenant's whole record
    // table. One letter would match most of it.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('shows a trade partner only the job they are on', async () => {
    renderAsUser(harness, tradeToken, <SearchBox onOpenRecord={() => {}} />)
    await userEvent.type(screen.getByPlaceholderText(/Search RFI-014/), 'anchor')

    // Scope is the server's decision. The client sends the words and nothing
    // else, so a client bug cannot widen what somebody may find.
    await waitFor(
      () => expect(screen.getAllByRole('option').length + screen.queryAllByText(/Nothing matching/).length).toBeGreaterThan(0),
      { timeout: 3000 },
    )
    expect(screen.queryAllByRole('option').map((o) => o.textContent ?? '').some((t) => t.includes('Second Yard'))).toBe(
      false,
    )
  })
})
