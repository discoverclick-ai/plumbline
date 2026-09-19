import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import {
  BudgetService,
  CommitmentService,
  InvoicingService,
  createBudgetCode,
  createOrganization,
  createPool,
  provisionTenant,
  withTenant,
} from '@plumbline/shared'
import { Budget, formatMoney, trimZeros } from '../../src/screens/Budget.tsx'
import { renderAsUser, seedProject, startHarness, tokenFor, type Harness, type SeededProject } from '../support/harness.tsx'

/**
 * The money, in a browser.
 *
 * Two things worth proving here that a unit test cannot. The screen does no
 * arithmetic, so what it shows is exactly what the database view computed. And
 * somebody who may not see cost figures gets told so, rather than an empty
 * table that looks like a job with no budget on it.
 */

let harness: Harness
let project: SeededProject
let pmToken: string
let tradeToken: string
let superToken: string

beforeAll(async () => {
  harness = await startHarness(inject('databaseUrl'))
  const tenant = await provisionTenant(harness.superPool, {
    tenantName: 'Budget Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@budgetweb.test', name: 'Bud Admin', password: 'a-long-enough-password' },
  })
  project = await seedProject(harness.superPool, tenant.tenantId, 'budgetweb')
  pmToken = await tokenFor(harness.superPool, project.users.pm.email)
  tradeToken = await tokenFor(harness.superPool, project.users.trade.email)
  superToken = await tokenFor(harness.superPool, project.users.superintendent.email)

  const pool = createPool({ connectionString: inject('databaseUrl') })
  try {
    const budget = new BudgetService(pool)
    const commitments = new CommitmentService(pool)
    const pm = { tenantId: project.tenantId, userId: project.users.pm.id }

    const code = await createBudgetCode(pool, project.tenantId, {
      projectId: project.projectId,
      values: { cost_code: '26 00 00', cost_type: 'S' },
    })
    await budget.addLine(pm, {
      projectId: project.projectId,
      budgetCodeId: code.id,
      description: 'Electrical',
      originalAmount: '1250000.00',
    })

    const vendorOrgId = await withTenant(pool, project.tenantId, (tx) =>
      createOrganization(tx, project.tenantId, { name: 'Web Electric', kind: 'specialty_contractor' }),
    )
    const commitment = await commitments.create(pm, {
      projectId: project.projectId,
      kind: 'subcontract',
      number: 'SC-WEB-1',
      title: 'Electrical',
      vendorOrgId,
      lines: [{ budgetCodeId: code.id, description: 'Base building', amount: '1180000.00' }],
    })
    await commitments.execute(pm, commitment.id)
  } finally {
    await pool.end()
  }
})

afterEach(() => cleanup())
afterAll(async () => {
  await harness.close()
})

describe('formatting money without parsing it', () => {
  it('groups thousands and keeps the cents exactly as given', () => {
    expect(formatMoney('1250000.00')).toBe('$1,250,000.00')
    expect(formatMoney('0.10')).toBe('$0.10')
    expect(formatMoney('-40000.00')).toBe('-$40,000.00')
    // The value that would round wrong through a float, kept verbatim.
    expect(formatMoney('0.1')).toBe('$0.10')
    expect(formatMoney('999999999999.99')).toBe('$999,999,999,999.99')
  })
})

describe('the budget screen', () => {
  it('shows what the view computed, without adding anything up itself', async () => {
    renderAsUser(harness, pmToken, <Budget projectId={project.projectId} projectName={project.projectName} />)

    const row = (await screen.findByText('26 00 00.S')).closest('tr') as HTMLElement
    const cells = [...row.querySelectorAll('td')].map((cell) => cell.textContent?.trim())

    // Read positionally, because several of these figures are legitimately
    // equal: original and current budget both 1.25M until somebody revises,
    // and committed and projected both 1.18M until something is billed.
    // Asserting by value alone would pass on a screen that rendered the same
    // number in every column.
    expect(cells).toEqual([
      '26 00 00.SElectrical',
      '$1,250,000.00',
      '—',
      '$1,250,000.00',
      '$1,180,000.00',
      '$0.00',
      '$1,180,000.00',
      '$70,000.00',
    ])
  })

  it('lists the commitment and says plainly that it is signed', async () => {
    renderAsUser(harness, pmToken, <Budget projectId={project.projectId} projectName={project.projectName} />)
    await userEvent.click(await screen.findByRole('tab', { name: /Commitments/ }))

    const row = (await screen.findByText('SC-WEB-1')).closest('tr') as HTMLElement
    expect(within(row).getByText('executed')).toBeInTheDocument()
    // Original and current value, with no executed changes between them.
    expect(within(row).getAllByText('$1,180,000.00')).toHaveLength(2)
  })

  it('tells a trade partner, who may not see the budget at all, why it is empty', async () => {
    renderAsUser(harness, tradeToken, <Budget projectId={project.projectId} projectName={project.projectName} />)

    // An empty table would read as a job with no budget on it, which is a
    // different and much more alarming thing than not being allowed to look.
    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toMatch(/cannot see/i)
    expect(screen.queryByText('26 00 00.S')).not.toBeInTheDocument()
  })

  it('shows a superintendent the scopes and quantities with no dollars anywhere', async () => {
    renderAsUser(harness, superToken, <Budget projectId={project.projectId} projectName={project.projectName} />)

    // The scope is theirs to manage; the margin is not. The screen says so
    // rather than rendering a row of dashes, which reads as a job with no
    // numbers on it.
    expect(await screen.findByText('26 00 00.S')).toBeInTheDocument()
    // A note, not an alert: nothing is wrong, they simply are not cleared for
    // the dollars.
    expect(screen.getByRole('status').textContent).toMatch(/quantities/i)
    expect(screen.queryByText(/\$1,250,000/)).not.toBeInTheDocument()
    expect(screen.queryByText('Over / Under')).not.toBeInTheDocument()
  })
})

describe('what the screen refuses to imply', () => {
  it('does not offer a Commitments tab to somebody who may not see contracts', async () => {
    renderAsUser(harness, superToken, <Budget projectId={project.projectId} projectName={project.projectName} />)
    await screen.findByText('26 00 00.S')

    // "Nothing committed on this job yet" told to somebody who simply may not
    // see the contracts is a lie, and on a job with signed subcontracts on it
    // an alarming one.
    expect(screen.queryByRole('tab', { name: /Commitments/ })).not.toBeInTheDocument()
  })

  it('says a lump sum line is not tracked by unit rather than showing zero of nothing', async () => {
    renderAsUser(harness, superToken, <Budget projectId={project.projectId} projectName={project.projectName} />)
    const row = (await screen.findByText('26 00 00.S')).closest('tr') as HTMLElement
    expect(within(row).getByText('not tracked by unit')).toBeInTheDocument()
  })
})

describe('trimming quantities', () => {
  it('keeps a zero a zero', () => {
    // An earlier version stripped trailing zeros unconditionally, which turned
    // "0" into the empty string and put a blank where a quantity of nothing
    // belonged.
    expect(trimZeros('0')).toBe('0')
    expect(trimZeros('1000')).toBe('1000')
    expect(trimZeros('12.5000')).toBe('12.5')
    expect(trimZeros('12.0000')).toBe('12')
  })
})

describe('the pay application cycle', () => {
  it('walks an application from draft to paid, and refuses to pay before the waiver', async () => {
    const pool = createPool({ connectionString: inject('databaseUrl') })
    try {
      const invoicing = new InvoicingService(pool)
      const commitments = new CommitmentService(pool)
      const pm = { tenantId: project.tenantId, userId: project.users.pm.id }

      const [commitment] = await commitments.summary(pm, project.projectId)
      const { rows: lineRows } = await pool.query<{ id: string }>(
        'SELECT id FROM commitment_lines WHERE commitment_id = $1 ORDER BY sort_order LIMIT 1',
        [commitment!.commitmentId],
      )

      const created = await invoicing.createInvoice(pm, {
        commitmentId: commitment!.commitmentId,
        number: 'APP-001',
        periodStart: '2026-03-01',
        periodEnd: '2026-03-31',
        lines: [{ commitmentLineId: lineRows[0]!.id, amount: '100000.00' }],
      })

      // Submitted by the SUBCONTRACTOR, because a general contractor
      // submitting a sub's own pay application is not something the
      // permission model allows and should not be: the whole point of the
      // application is that the sub says what they did.
      await invoicing.submit({ tenantId: project.tenantId, userId: project.users.trade.id }, created.id)

      renderAsUser(harness, pmToken, <Budget projectId={project.projectId} projectName={project.projectName} />)
      await userEvent.click(await screen.findByRole('tab', { name: /Commitments/ }))
      await userEvent.click(await screen.findByRole('button', { name: 'Billing' }))

      const row = (await screen.findByText('APP-001')).closest('tr') as HTMLElement
      expect(within(row).getByText('submitted')).toBeInTheDocument()

      await userEvent.click(within(row).getByRole('button', { name: 'Approve' }))

      await waitFor(() => expect(screen.getByText('approved')).toBeInTheDocument())
      const approved = (await screen.findByText('APP-001')).closest('tr') as HTMLElement
      // Disabled with the reason beside it rather than hidden. A missing
      // button teaches nobody what to go and get.
      const pay = within(approved).getByRole('button', { name: 'Pay' })
      expect(pay).toBeDisabled()
      expect(pay.getAttribute('title')).toMatch(/lien waiver/i)

      await userEvent.click(within(approved).getByRole('button', { name: 'Record it' }))
      await waitFor(() => expect(screen.getByText('Received')).toBeInTheDocument())
      const waived = (await screen.findByText('APP-001')).closest('tr') as HTMLElement
      expect(within(waived).getByRole('button', { name: 'Pay' })).toBeEnabled()

      await userEvent.click(within(waived).getByRole('button', { name: 'Pay' }))
      await waitFor(() => expect(screen.getByText('paid')).toBeInTheDocument())
    } finally {
      await pool.end()
    }
  })
})
