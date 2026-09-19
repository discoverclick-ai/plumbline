import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { DrawingService, FilesystemBlobStore, RecordKernel, createPool, provisionTenant } from '@plumbline/shared'
import { Drawings, byDiscipline, pinFraction } from '../../src/screens/Drawings.tsx'
import { renderAsUser, seedProject, startHarness, tokenFor, type Harness, type SeededProject } from '../support/harness.tsx'

/**
 * Drawings, in a browser.
 *
 * The canvas itself is NOT exercised here: jsdom has no 2D context, so
 * pdf.js cannot render into one. What is exercised is everything a wrong
 * answer would come from — which revision the index offers, how a click
 * becomes a fraction of the page, and whether a pin from an older revision is
 * distinguishable from one on the current sheet.
 */

const blobRoot = `/tmp/plumbline-drawings-${Date.now()}`

/** A one-page PDF. Real enough for the store and the download path. */
function sheetPdf(label: string): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n` +
      `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n% ${label}\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  )
}

let harness: Harness
let project: SeededProject
let pmToken: string

beforeAll(async () => {
  harness = await startHarness(inject('databaseUrl'), { blobRoot })
  const tenant = await provisionTenant(harness.superPool, {
    tenantName: 'Sheet Web',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@sheetweb.test', name: 'Dee Admin', password: 'a-long-enough-password' },
  })
  project = await seedProject(harness.superPool, tenant.tenantId, 'sheetweb')
  pmToken = await tokenFor(harness.superPool, project.users.pm.email)

  const pool = createPool({ connectionString: inject('databaseUrl') })
  try {
    const drawings = new DrawingService(pool, new FilesystemBlobStore(blobRoot))
    const kernel = new RecordKernel(pool)
    const pm = { tenantId: project.tenantId, userId: project.users.pm.id }

    const set = await drawings.createSet(pm, { projectId: project.projectId, name: 'Permit Set', issuedOn: '2026-02-01' })
    await drawings.addRevision(pm, {
      setId: set.id,
      number: 'S-401',
      title: 'Typical Connections',
      discipline: 'Structural',
      revisionLabel: '0',
      filename: 'S-401.pdf',
      contentType: 'application/pdf',
      bytes: sheetPdf('S-401'),
    })
    await drawings.addRevision(pm, {
      setId: set.id,
      number: 'A-101',
      title: 'Level 1 Plan',
      discipline: 'Architectural',
      revisionLabel: '0',
      filename: 'A-101.pdf',
      contentType: 'application/pdf',
      bytes: sheetPdf('A-101'),
    })
    await drawings.publishSet(pm, set.id)

    const rfi = await kernel.create(pm, {
      projectId: project.projectId,
      typeKey: 'rfi',
      title: 'Embedment at grid C4',
      body: { question: 'Which governs?' },
    })
    const current = await drawings.currentSheets(pm, project.projectId)
    const structural = current.find((s) => s.number === 'S-401')!
    await drawings.pin(pm, { revisionId: structural.revisionId, recordId: rfi.record.id, x: 0.25, y: 0.5 })

    // A second revision, issued after the pin was placed. The pin stays where
    // it was put and is marked as belonging to the older sheet.
    const revised = await drawings.createSet(pm, {
      projectId: project.projectId,
      name: 'Revision 1',
      issuedOn: '2026-03-15',
    })
    await drawings.addRevision(pm, {
      setId: revised.id,
      number: 'S-401',
      title: 'Typical Connections',
      discipline: 'Structural',
      revisionLabel: '1',
      filename: 'S-401-r1.pdf',
      contentType: 'application/pdf',
      bytes: sheetPdf('S-401 rev 1'),
    })
    await drawings.publishSet(pm, revised.id)
  } finally {
    await pool.end()
  }
})

afterEach(() => cleanup())
afterAll(async () => {
  await harness.close()
})

describe('turning a click into a pin', () => {
  const rect = { left: 100, top: 50, width: 800, height: 600 }

  it('stores a fraction of the page, not a pixel', () => {
    // Pixels would move the pin on every other screen and at every zoom.
    expect(pinFraction(rect, 300, 350)).toEqual({ x: 0.25, y: 0.5 })
    expect(pinFraction(rect, 100, 50)).toEqual({ x: 0, y: 0 })
    expect(pinFraction(rect, 900, 650)).toEqual({ x: 1, y: 1 })
  })

  it('clamps a click that lands outside the sheet', () => {
    // A drag that ends off the canvas must not write a coordinate the
    // database's own check constraint would refuse.
    expect(pinFraction(rect, 50, 20)).toEqual({ x: 0, y: 0 })
    expect(pinFraction(rect, 2000, 2000)).toEqual({ x: 1, y: 1 })
  })

  it('keeps enough precision to hit a detail bubble', () => {
    const { x } = pinFraction({ left: 0, top: 0, width: 10000, height: 10000 }, 1234, 0)
    expect(x).toBeCloseTo(0.1234, 4)
  })
})

describe('the drawing index', () => {
  it('groups by discipline and sorts sheet numbers as a drawing index does', () => {
    const sheet = (number: string, discipline: string | null): never => ({ number, discipline, drawingId: number } as never)
    const groups = byDiscipline([
      sheet('A-1010', 'Architectural'),
      sheet('S-401', 'Structural'),
      sheet('A-101', 'Architectural'),
      sheet('X-1', null),
    ])

    expect(groups.map((g) => g.discipline)).toEqual(['Architectural', 'Structural', 'Unclassified'])
    // "A-101" before "A-1010": text order, which is what a printed index does.
    expect(groups[0]!.sheets.map((s) => s.number)).toEqual(['A-101', 'A-1010'])
  })
})

describe('the screen', () => {
  it('lists the current sheets by discipline', async () => {
    renderAsUser(harness, pmToken, <Drawings projectId={project.projectId} projectName={project.projectName} />)

    expect(await screen.findByText('A-101')).toBeInTheDocument()
    expect(screen.getByText('S-401')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Structural' })).toBeInTheDocument()
  })

  it('shows the revision on screen, never abbreviated away', async () => {
    renderAsUser(harness, pmToken, <Drawings projectId={project.projectId} projectName={project.projectName} />)
    await screen.findByText('A-101')
    await userEvent.click(screen.getByText('S-401'))

    // A superseded sheet shown without saying so is the accident this whole
    // tool exists to prevent, so the label is always visible.
    expect(await screen.findByText('Rev 1')).toBeInTheDocument()
    expect(screen.getByText(/issued 2026-03-15/)).toBeInTheDocument()
  })

  it('says when a pin belongs to an earlier revision', async () => {
    renderAsUser(harness, pmToken, <Drawings projectId={project.projectId} projectName={project.projectName} />)
    await screen.findByText('A-101')
    await userEvent.click(screen.getByText('S-401'))

    // The pin was placed on rev 0 and the current sheet is rev 1. What it
    // points at may have moved, and quietly relocating it would be a guess.
    // The spinner also carries role=status, so look for the one that says
    // what this test is about rather than whichever arrives first.
    const banner = await screen.findByText(/earlier revision/)
    expect(banner.textContent).toMatch(/may have moved/)
  })

  it('fails visibly when a sheet will not render', async () => {
    // jsdom has no 2D context, so this is the failure path, and it is the
    // one worth asserting: a blank white rectangle where a drawing should be
    // is indistinguishable from an empty sheet.
    renderAsUser(harness, pmToken, <Drawings projectId={project.projectId} projectName={project.projectName} />)
    await screen.findByText('A-101')

    const alert = await screen.findByRole('alert', {}, { timeout: 5000 })
    expect(alert.textContent).toMatch(/could not be rendered/)
    expect(alert.textContent).toMatch(/rather than working from a blank screen/)
  })
})

describe('placing a pin', () => {
  it('is a mode, not the default click', async () => {
    renderAsUser(harness, pmToken, <Drawings projectId={project.projectId} projectName={project.projectName} />)
    await screen.findByText('A-101')

    // A screen where every stray click drops a pin on a drawing is one people
    // stop panning.
    expect(await screen.findByRole('button', { name: 'Pin a record' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Pin a record' }))
    expect(await screen.findByRole('button', { name: 'Click the sheet…' })).toBeInTheDocument()
  })

  it('offers only the open records', async () => {
    renderAsUser(harness, pmToken, <Drawings projectId={project.projectId} projectName={project.projectName} />)
    await screen.findByText('A-101')
    await userEvent.click(screen.getByText('S-401'))
    await userEvent.click(await screen.findByRole('button', { name: 'Pin a record' }))

    // jsdom gives every element a zero-size rect, so the click lands at 0,0 —
    // which is a real coordinate and exactly what the clamp is for.
    const canvas = document.querySelector('canvas') as HTMLCanvasElement
    await userEvent.click(canvas)

    expect(await screen.findByText('Pin which record?')).toBeInTheDocument()
    // Pinning a closed RFI to a drawing is almost always somebody picking the
    // wrong row from a long list.
    expect(await screen.findByText(/Embedment at grid C4/)).toBeInTheDocument()
  })
})
