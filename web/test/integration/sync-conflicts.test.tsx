import { cleanup, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { RecordKernel, SyncService, createPool, provisionTenant } from '@plumbline/shared'
import { SyncConflicts, arrivalGap } from '../../src/screens/SyncConflicts.tsx'
import { renderAsUser, seedProject, startHarness, tokenFor, type Harness, type SeededProject } from '../support/harness.tsx'

/**
 * What the field typed and the server could not keep.
 *
 * Offline is not an edge case on a construction site: basements, lifts, rural
 * jobs, a phone out of signal since seven. The merge keeps every field the
 * office did not also change, which is most of them, and this screen is for
 * the rest.
 *
 * The property it exists to hold: never show that something was lost without
 * showing what it was.
 */

let harness: Harness
let project: SeededProject
let pmToken: string

beforeAll(async () => {
  harness = await startHarness(inject('databaseUrl'))
  const tenant = await provisionTenant(harness.superPool, {
    tenantName: 'Field Web',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@fieldweb.test', name: 'Fay Admin', password: 'a-long-enough-password' },
  })
  project = await seedProject(harness.superPool, tenant.tenantId, 'fieldweb')
  pmToken = await tokenFor(harness.superPool, project.users.pm.email)

  const pool = createPool({ connectionString: inject('databaseUrl') })
  try {
    const kernel = new RecordKernel(pool)
    const sync = new SyncService(pool)
    const pm = { tenantId: project.tenantId, userId: project.users.pm.id }
    const superintendent = { tenantId: project.tenantId, userId: project.users.superintendent.id }

    const observation = await kernel.create(superintendent, {
      projectId: project.projectId,
      typeKey: 'observation',
      title: 'Standing water at the east footings',
      body: { description: 'Subgrade will not compact.' },
    })

    const device = await sync.registerDevice(superintendent, 'phone-sam-01', "Sam's phone")

    // The office edits the same field while the phone is out of signal.
    await kernel.update(pm, observation.record.id, {
      body: { description: 'Subgrade soft at the east footings. Geotech notified.' },
    })

    // The phone pushes what it typed at 07:20, from the version it had.
    await sync.push(superintendent, device.deviceId, [
      {
        clientOpId: 'op-1',
        recordId: observation.record.id,
        baseVersion: observation.record.version,
        body: { description: 'Water is back this morning, worse on the north side. Pump running.' },
        occurredAt: new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString(),
      },
    ])
  } finally {
    await pool.end()
  }
})

afterEach(() => cleanup())
afterAll(async () => {
  await harness.close()
})

describe('saying how late it arrived', () => {
  it('names the gap that explains most conflicts', () => {
    // A phone out of signal since seven, pushing at four.
    expect(arrivalGap('2026-03-02T07:20:00Z', '2026-03-02T16:20:00Z')).toBe('reached us 9 hours later')
    expect(arrivalGap('2026-03-02T07:20:00Z', '2026-03-05T07:20:00Z')).toBe('reached us 3 days later')
  })

  it('says nothing when it arrived straight away', () => {
    // Noise on the ninety per cent of pushes that happen in real time.
    expect(arrivalGap('2026-03-02T07:20:00Z', '2026-03-02T07:20:30Z')).toBeNull()
    expect(arrivalGap('2026-03-02T07:20:00Z', '2026-03-02T07:50:00Z')).toBeNull()
  })
})

describe('the screen', () => {
  it('shows the words that were not kept, ready to paste back', async () => {
    renderAsUser(harness, pmToken, <SyncConflicts projectId={project.projectId} projectName={project.projectName} />)

    const card = (await screen.findByText(/Standing water at the east footings/)).closest('article') as HTMLElement

    // The rule the whole screen is built on. "description was dropped" is a
    // line nobody can act on; the sentence itself is one somebody pastes back
    // in thirty seconds.
    // More than one node can carry the text (the detail line and the value
    // block); what matters is that the words are on screen at all.
    expect(within(card).getAllByText(/Water is back this morning, worse on the north side/).length).toBeGreaterThan(0)
    expect(within(card).getByText(/Not kept · description/)).toBeInTheDocument()
  })

  it('names whose phone it was', async () => {
    renderAsUser(harness, pmToken, <SyncConflicts projectId={project.projectId} projectName={project.projectName} />)
    const card = (await screen.findByText(/Standing water at the east footings/)).closest('article') as HTMLElement

    // "Whose phone and which RFI" is the first question anybody asks, and a
    // screen that answers it with two UUIDs is one nobody uses twice.
    expect(within(card).getByText(/Sam Ruiz/)).toBeInTheDocument()
    expect(within(card).getByText(/Sam's phone|Sam’s phone/)).toBeInTheDocument()
  })

  it('offers no apply-anyway button', async () => {
    renderAsUser(harness, pmToken, <SyncConflicts projectId={project.projectId} projectName={project.projectName} />)
    await screen.findByText(/Standing water at the east footings/)

    // The device's value lost because somebody at a desk changed the same
    // field. Silently overwriting their work to fix the foreman's would just
    // move the problem.
    expect(screen.queryByRole('button', { name: /apply|overwrite|force/i })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Copy' }).length).toBeGreaterThan(0)
  })
})
