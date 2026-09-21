import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { createPool, provisionTenant, RecordKernel } from '@plumbline/shared'
import { RecordDetail } from '../../src/screens/RecordDetail.tsx'
import { renderAsUser, seedProject, startHarness, tokenFor, type Harness, type SeededProject } from '../support/harness.tsx'

/**
 * What is attached to a record.
 *
 * These routes shipped with no client calling any of them: a record could
 * hold the sketch that answers the RFI, and no screen in the product could
 * put one there or get one back. That is the same failure as a service with
 * no route, one layer further out, and it is why this suite exists at the
 * screen rather than at the service.
 */

let harness: Harness
let project: SeededProject
let pmToken: string
let tradeToken: string
let recordId: string

beforeAll(async () => {
  harness = await startHarness(inject('databaseUrl'))
  const tenant = await provisionTenant(harness.superPool, {
    tenantName: 'Attach Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@attach.test', name: 'Ari Admin', password: 'a-long-enough-password' },
  })
  project = await seedProject(harness.superPool, tenant.tenantId, 'attach')
  pmToken = await tokenFor(harness.superPool, project.users.pm.email)
  tradeToken = await tokenFor(harness.superPool, project.users.trade.email)

  const pool = createPool({ connectionString: inject('databaseUrl') })
  try {
    const kernel = new RecordKernel(pool)
    const created = await kernel.create(
      { tenantId: project.tenantId, userId: project.users.pm.id },
      {
        projectId: project.projectId,
        typeKey: 'rfi',
        title: 'Anchor bolt embedment at grid C4',
        body: { question: 'Which embedment governs?', discipline: 'Structural' },
        participants: [{ userId: project.users.architect.id, role: 'assignee' }],
      },
    )
    recordId = created.record.id
  } finally {
    await pool.end()
  }
})

afterEach(() => cleanup())
afterAll(async () => {
  await harness.close()
})

describe('putting a file on a record', () => {
  it('uploads it and names who put it there', async () => {
    renderAsUser(harness, pmToken, <RecordDetail recordId={recordId} />)
    await userEvent.click(await screen.findByRole('tab', { name: /Attachments/ }))

    expect(await screen.findByText(/Nothing attached to this record yet/)).toBeInTheDocument()

    const file = new File(['%PDF-1.4 sketch'], 'SK-12 duct reroute.pdf', { type: 'application/pdf' })
    await userEvent.upload(screen.getByLabelText('Attach a file'), file)

    // Provenance is the column that matters. An attachment on a job is
    // evidence — who put this revision here and when — and a list of
    // filenames without either is the folder this is meant to replace.
    const row = (await screen.findByText('SK-12 duct reroute.pdf')).closest('tr') as HTMLElement
    expect(within(row).getByText('Pat Moreno')).toBeInTheDocument()
  })

  it('keeps a name with a space and a dash intact', async () => {
    // The filename travels in an HTTP HEADER, where a space is not legal, so
    // it is URI-encoded on the way out and decoded on the way in. Jobsite
    // files are named things like "RFI 14 — sketch.pdf" and a name that
    // arrives as RFI%2014 is a name nobody recognises.
    renderAsUser(harness, pmToken, <RecordDetail recordId={recordId} />)
    await userEvent.click(await screen.findByRole('tab', { name: /Attachments/ }))
    await screen.findByLabelText('Attach a file')

    const file = new File(['x'], 'RFI 14 — marked up.pdf', { type: 'application/pdf' })
    await userEvent.upload(screen.getByLabelText('Attach a file'), file)
    expect(await screen.findByText('RFI 14 — marked up.pdf')).toBeInTheDocument()
  })

  it('counts them on the tab', async () => {
    renderAsUser(harness, pmToken, <RecordDetail recordId={recordId} />)
    // Two from the tests above. A tab with no count makes somebody click it
    // to find out there is nothing there.
    await waitFor(() => expect(screen.getByRole('tab', { name: /Attachments/ }).textContent).toMatch(/2/))
  })

  it('does not offer the upload to somebody who may only read the record', async () => {
    // A trade partner on this job can see the RFI and has no business
    // putting a revision on it.
    renderAsUser(harness, tradeToken, <RecordDetail recordId={recordId} />)
    const tab = await screen.findByRole('tab', { name: /Attachments/ }).catch(() => null)
    if (!tab) return
    await userEvent.click(tab)
    await waitFor(() => expect(screen.queryByLabelText('Attach a file')).not.toBeInTheDocument())
  })
})
