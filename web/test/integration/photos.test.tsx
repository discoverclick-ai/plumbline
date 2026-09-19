import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { PhotoService, createPool, provisionTenant } from '@plumbline/shared'
import { FilesystemBlobStore } from '@plumbline/shared'
import { Photos, dayLabel, groupByDay, orientationTransform, timeLabel } from '../../src/screens/Photos.tsx'
import { renderAsUser, seedProject, startHarness, tokenFor, type Harness, type SeededProject } from '../support/harness.tsx'

/**
 * The photographs, in a browser.
 *
 * Organised by the day the shutter opened, because "show me the week we
 * poured" is the question and nobody has ever asked to see the photographs
 * somebody uploaded on a Tuesday.
 */

/** A minimal JPEG carrying one EXIF date. */
function photoTakenAt(stamp: string, salt = 0): Buffer {
  const date = [...stamp].map((c) => c.charCodeAt(0)).concat(0)
  const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff]
  const u32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
  const exifAt = 8 + 2 + 12 + 4
  const dateAt = exifAt + 2 + 12 + 4
  const tiff = [
    0x49, 0x49, ...u16(42), ...u32(8),
    ...u16(1), ...u16(0x8769), ...u16(4), ...u32(1), ...u32(exifAt), ...u32(0),
    ...u16(1), ...u16(0x9003), ...u16(2), ...u32(date.length), ...u32(dateAt), ...u32(0),
    ...date,
  ]
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload,
    0xff, 0xfe, 0x00, 0x04, salt & 0xff, (salt >> 8) & 0xff, 0xff, 0xda, 0x00, 0x02,
  ])
}

let harness: Harness
let project: SeededProject
let pmToken: string
const blobRoot = `/tmp/plumbline-photoweb-${Date.now()}`

beforeAll(async () => {
  // The same store the seeding uses, so the gallery serves the bytes that
  // were uploaded rather than a directory that has never been written to.
  harness = await startHarness(inject('databaseUrl'), { blobRoot })
  const tenant = await provisionTenant(harness.superPool, {
    tenantName: 'Photo Web',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@photoweb.test', name: 'Pip Admin', password: 'a-long-enough-password' },
  })
  project = await seedProject(harness.superPool, tenant.tenantId, 'photoweb')
  pmToken = await tokenFor(harness.superPool, project.users.pm.email)

  const pool = createPool({ connectionString: inject('databaseUrl') })
  try {
    const photos = new PhotoService(pool, new FilesystemBlobStore(blobRoot))
    const pm = { tenantId: project.tenantId, userId: project.users.pm.id }

    await photos.upload(pm, {
      projectId: project.projectId,
      filename: 'pour-am.jpg',
      contentType: 'image/jpeg',
      bytes: photoTakenAt('2026:03:02 07:14:22', 1),
      caption: 'North footings before the pour',
    })
    await photos.upload(pm, {
      projectId: project.projectId,
      filename: 'pour-pm.jpg',
      contentType: 'image/jpeg',
      bytes: photoTakenAt('2026:03:02 15:40:00', 2),
    })
    await photos.upload(pm, {
      projectId: project.projectId,
      filename: 'next-day.jpg',
      contentType: 'image/jpeg',
      bytes: photoTakenAt('2026:03:03 08:05:00', 3),
    })
    // No EXIF at all: the gap the screen has to surface.
    await photos.upload(pm, {
      projectId: project.projectId,
      filename: 'scanned.png',
      contentType: 'image/png',
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
    })
  } finally {
    await pool.end()
  }
})

afterEach(() => cleanup())
afterAll(async () => {
  await harness.close()
})

describe('grouping by the day the shutter opened', () => {
  const photo = (takenAtLocal: string | null, id: string): never =>
    ({ id, takenAtLocal, latitude: null, orientation: null } as never)

  it('puts the newest day first and orders within a day forwards', () => {
    const { days } = groupByDay([
      photo('2026-03-02T15:40:00', 'b'),
      photo('2026-03-03T08:05:00', 'c'),
      photo('2026-03-02T07:14:22', 'a'),
    ])

    expect(days.map((d) => d.day)).toEqual(['2026-03-03', '2026-03-02'])
    // Within a day the work runs forwards, because that is the order it
    // happened in and the order somebody scrolls it.
    expect(days[1]!.photos.map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('pulls the undated ones out rather than sorting them to the bottom', () => {
    const { undated, days } = groupByDay([photo(null, 'x'), photo('2026-03-02T07:14:22', 'a')])
    // A gap somebody can see is worth more than one buried at the end of a
    // list ordered by a date it does not have.
    expect(undated.map((p) => p.id)).toEqual(['x'])
    expect(days.flatMap((d) => d.photos).map((p) => p.id)).toEqual(['a'])
  })

  it('labels a day the way it gets said on a job', () => {
    expect(dayLabel('2026-03-02')).toMatch(/Monday/)
    expect(dayLabel('2026-03-02')).toMatch(/March/)
    expect(timeLabel('2026-03-02T07:14:22')).toBe('07:14')
  })

  it('turns a sideways phone the right way up', () => {
    // 6 and 8 are a phone held sideways, which is most site photographs.
    expect(orientationTransform(6)).toBe('rotate(90deg)')
    expect(orientationTransform(8)).toBe('rotate(270deg)')
    expect(orientationTransform(1)).toBeUndefined()
    expect(orientationTransform(null)).toBeUndefined()
  })
})

describe('the screen', () => {
  it('groups the job by day, newest first', async () => {
    renderAsUser(harness, pmToken, <Photos projectId={project.projectId} projectName={project.projectName} />)

    const headings = await screen.findAllByRole('heading', { level: 3 })
    const text = headings.map((h) => h.textContent ?? '')
    // Undated first, then the newest day.
    expect(text[0]).toMatch(/No date from the camera/)
    // Locale-agnostic: the runner's locale decides whether it reads "3
    // March" or "March 3", and asserting one of those tests the environment.
    expect(text[1]).toMatch(/March 3|3 March/)
    expect(text[2]).toMatch(/March 2|2 March/)
  })

  it('says out loud that a photograph has no date', async () => {
    renderAsUser(harness, pmToken, <Photos projectId={project.projectId} projectName={project.projectName} />)

    // The spinner also carries role=status, so wait for the content first
    // rather than grabbing whichever status node is on screen at tick zero.
    await screen.findByText(/4 photographs/)

    // `status`, not `alert`: a missing timestamp is worth announcing and is
    // not worth interrupting a screen reader mid-sentence for.
    const banners = screen.getAllByRole('status').map((node) => node.textContent ?? '')
    const warning = banners.find((text) => /no date from the camera/i.test(text))
    // A photograph with no timestamp proves very little, and somebody
    // attaching it to a notice needs to know that before they do.
    expect(warning, banners.join(' | ')).toBeTruthy()
    expect(warning).toMatch(/proves very little/)
  })

  it('counts what it has, and how much of it is located', async () => {
    renderAsUser(harness, pmToken, <Photos projectId={project.projectId} projectName={project.projectName} />)
    expect(await screen.findByText(/4 photographs/)).toBeInTheDocument()
  })

  it('opens one and shows what the camera said, not just the picture', async () => {
    renderAsUser(harness, pmToken, <Photos projectId={project.projectId} projectName={project.projectName} />)

    await userEvent.click(await screen.findByTitle('North footings before the pour'))

    const panel = (await screen.findByText('North footings before the pour')).closest('section, div') as HTMLElement
    expect(within(panel).getByText('2026-03-02 07:14:22')).toBeInTheDocument()
    expect(within(panel).getByText(/Pat Moreno/)).toBeInTheDocument()
  })

  it('tells somebody choosing evidence that the camera never said when', async () => {
    renderAsUser(harness, pmToken, <Photos projectId={project.projectId} projectName={project.projectName} />)

    await userEvent.click(await screen.findByTitle('scanned.png'))
    expect(await screen.findByText('No timestamp from the camera')).toBeInTheDocument()
  })
})
