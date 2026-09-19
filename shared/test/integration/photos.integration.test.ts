import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createPool, withTenant } from '../../src/db.js'
import { RecordKernel, type Actor } from '../../src/kernel.js'
import { PhotoService } from '../../src/photos/service.js'
import {
  addProjectMember,
  createOrganization,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
} from '../../src/provisioning.js'
import { clearRecordTypeCache } from '../../src/repositories/record-types.js'
import { FilesystemBlobStore } from '../../src/storage/filesystem.js'

/**
 * Photographs, against a real store.
 *
 * Every construction product has a photos tab and almost none is worth
 * anything, because they re-encode on upload and throw the EXIF away. What is
 * left is a picture with an upload date, which proves nothing about when the
 * work was in that condition.
 *
 * So the properties here are: the bytes come back identical, the camera's own
 * timestamp survives, and the same photograph uploaded twice is one
 * photograph.
 */

/** A minimal JPEG carrying one EXIF date, built rather than committed. */
function photoTakenAt(stamp: string, salt = 0): Buffer {
  const date = [...stamp].map((c) => c.charCodeAt(0)).concat(0)
  const little = [0x49, 0x49]
  const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff]
  const u32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]

  const ifd0At = 8
  const ifd0Size = 2 + 1 * 12 + 4
  const exifAt = ifd0At + ifd0Size
  const exifSize = 2 + 1 * 12 + 4
  const dateAt = exifAt + exifSize

  const tiff = [
    ...little,
    ...u16(42),
    ...u32(8),
    ...u16(1),
    ...u16(0x8769),
    ...u16(4),
    ...u32(1),
    ...u32(exifAt),
    ...u32(0),
    ...u16(1),
    ...u16(0x9003),
    ...u16(2),
    ...u32(date.length),
    ...u32(dateAt),
    ...u32(0),
    ...date,
  ]
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]
  // A comment segment carrying the salt, so two photographs with the same
  // EXIF are still different files.
  const comment = [0xff, 0xfe, 0x00, 0x04, salt & 0xff, (salt >> 8) & 0xff]
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe1,
    (payload.length + 2) >> 8,
    (payload.length + 2) & 0xff,
    ...payload,
    ...comment,
    0xff,
    0xda,
    0x00,
    0x02,
  ])
}

let pool: Pool
let kernel: RecordKernel
let photos: PhotoService
let tenantId: string
let projectId: string
let otherProjectId: string
let pm: Actor
let sub: Actor
let recordId: string

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  kernel = new RecordKernel(pool)
  photos = new PhotoService(pool, new FilesystemBlobStore(`/tmp/plumbline-photos-${Date.now()}`))

  const tenant = await provisionTenant(pool, {
    tenantName: 'Shutter Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@shutter.test', name: 'Sam Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const trades = await createOrganization(tx, tenantId, {
      name: 'Vega Steel',
      kind: 'specialty_contractor',
      trade: 'Structural Steel',
    })
    const pmId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@shutter.test',
      name: 'Pat Moreno',
      companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Employee'),
    })
    const subId = await createUser(tx, tenantId, {
      organizationId: trades,
      email: 'pm@vega.test',
      name: 'Sasha Vega',
      companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Collaborator'),
    })
    projectId = await createProject(tx, tenantId, { number: '26-071', name: 'Shutter Yard' })
    otherProjectId = await createProject(tx, tenantId, { number: '26-072', name: 'Second Job' })
    await addProjectMember(tx, tenantId, { projectId, userId: pmId, permissionTemplateName: 'Project Manager' })
    await addProjectMember(tx, tenantId, {
      projectId: otherProjectId,
      userId: pmId,
      permissionTemplateName: 'Project Manager',
    })
    await addProjectMember(tx, tenantId, { projectId, userId: subId, permissionTemplateName: 'Trade Partner' })
    pm = { tenantId, userId: pmId }
    sub = { tenantId, userId: subId }
  })

  const rfi = await kernel.create(pm, {
    projectId,
    typeKey: 'rfi',
    title: 'Weld at grid C4',
    body: { question: 'Is this weld acceptable?' },
  })
  recordId = rfi.record.id
})

afterAll(async () => {
  await pool.end()
  clearRecordTypeCache()
})

describe('what the camera recorded', () => {
  it('keeps the moment the shutter opened, not the moment of upload', async () => {
    const result = await photos.upload(pm, {
      projectId,
      filename: 'IMG_4021.jpg',
      contentType: 'image/jpeg',
      bytes: photoTakenAt('2026:03:02 07:14:22'),
      caption: 'Weld at grid C4 before grinding',
    })

    // A phone in a basement uploads six hours later. The photograph belongs
    // to the day the work happened.
    expect(result.photo.takenAtLocal).toBe('2026-03-02T07:14:22')
    expect(result.photo.metadataRead).toBe(true)
    expect(new Date(result.photo.uploadedAt).getUTCFullYear()).toBeGreaterThan(2025)
  })

  it('returns the original bytes, byte for byte', async () => {
    const bytes = photoTakenAt('2026:03:03 09:00:00', 7)
    const { photo } = await photos.upload(pm, {
      projectId,
      filename: 'IMG_4022.jpg',
      contentType: 'image/jpeg',
      bytes,
    })

    const downloaded = await photos.download(pm, photo.id)
    // Re-encoding is what destroys the evidence in every other product.
    expect(downloaded.bytes.equals(bytes)).toBe(true)
    expect(downloaded.contentType).toBe('image/jpeg')
  })

  it('says plainly when a file carried no metadata at all', async () => {
    const { photo } = await photos.upload(pm, {
      projectId,
      filename: 'scan.png',
      contentType: 'image/png',
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
    })
    // "The camera did not say" and "nobody has looked" are different, and only
    // one is worth chasing somebody about.
    expect(photo.metadataRead).toBe(false)
    expect(photo.takenAtLocal).toBeNull()
  })

  it('takes the phone’s word only when the file has nothing to say', async () => {
    const withExif = await photos.upload(pm, {
      projectId,
      filename: 'IMG_4023.jpg',
      contentType: 'image/jpeg',
      bytes: photoTakenAt('2026:03:04 06:45:00', 11),
      fallback: { takenAt: '2026-03-04T14:00:00', latitude: 0, longitude: 0 },
    })
    // The camera's own record wins. A phone app's idea of "now" is when the
    // upload started.
    expect(withExif.photo.takenAtLocal).toBe('2026-03-04T06:45:00')

    const without = await photos.upload(pm, {
      projectId,
      filename: 'plain.png',
      contentType: 'image/png',
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]),
      fallback: { takenAt: '2026-03-05T11:30:00' },
    })
    expect(without.photo.takenAtLocal).toBe('2026-03-05T11:30:00')
    expect(without.photo.metadataRead).toBe(false)
  })
})

describe('the same photograph twice', () => {
  it('is one photograph', async () => {
    const bytes = photoTakenAt('2026:03:06 08:00:00', 21)
    const first = await photos.upload(pm, {
      projectId,
      filename: 'crack.jpg',
      contentType: 'image/jpeg',
      bytes,
    })
    const second = await photos.upload(pm, {
      projectId,
      filename: 'crack-copy.jpg',
      contentType: 'image/jpeg',
      bytes,
    })

    // Two crews photograph the same crack. From the field's point of view the
    // upload worked and the photograph is there, so this returns the existing
    // one rather than refusing.
    expect(second.duplicate).toBe(true)
    expect(second.photo.id).toBe(first.photo.id)
  })

  it('is two photographs on two different jobs', async () => {
    const bytes = photoTakenAt('2026:03:07 08:00:00', 31)
    const here = await photos.upload(pm, { projectId, filename: 'a.jpg', contentType: 'image/jpeg', bytes })
    const there = await photos.upload(pm, {
      projectId: otherProjectId,
      filename: 'a.jpg',
      contentType: 'image/jpeg',
      bytes,
    })
    expect(there.duplicate).toBe(false)
    expect(there.photo.id).not.toBe(here.photo.id)
  })
})

describe('finding one again', () => {
  it('filters by the date it was taken, not the date it arrived', async () => {
    const window = await photos.list(pm, projectId, { from: '2026-03-02', to: '2026-03-02' })
    expect(window.map((p) => p.filename)).toEqual(['IMG_4021.jpg'])
  })

  it('surfaces the photographs with no date on them', async () => {
    const undated = await photos.list(pm, projectId, { undatedOnly: true })
    // A gap somebody can see is worth more than a gap buried at the end of a
    // list sorted by a date that does not exist.
    expect(undated.every((p) => p.takenAtLocal === null)).toBe(true)
    expect(undated.length).toBeGreaterThan(0)
  })

  it('groups into albums without inventing a folder tree', async () => {
    const album = await photos.createAlbum(pm, projectId, 'Steel erection', 'Week of 2 March')
    const all = await photos.list(pm, projectId, {})
    const added = await photos.addToAlbum(pm, album.id, all.slice(0, 2).map((p) => p.id))

    expect(added.added).toBe(2)
    expect(await photos.list(pm, projectId, { albumId: album.id })).toHaveLength(2)
    expect((await photos.get(pm, all[0]!.id))!.albums).toContain('Steel erection')
  })

  it('will not put another job’s photograph in this job’s album', async () => {
    const album = await photos.createAlbum(pm, projectId, 'Mixed')
    const elsewhere = await photos.list(pm, otherProjectId, {})
    // An album spanning two jobs is how a photograph of one client's site
    // ends up in another client's report.
    expect((await photos.addToAlbum(pm, album.id, elsewhere.map((p) => p.id))).added).toBe(0)
  })

  it('links to a record, and finds them again from it', async () => {
    const [photo] = await photos.list(pm, projectId, {})
    await photos.linkToRecord(pm, photo!.id, recordId)

    const onRecord = await photos.list(pm, projectId, { recordId })
    expect(onRecord.map((p) => p.id)).toEqual([photo!.id])
    expect((await photos.get(pm, photo!.id))!.recordIds).toContain(recordId)
  })

  it('refuses to link across jobs', async () => {
    const [elsewhere] = await photos.list(pm, otherProjectId, {})
    await expect(photos.linkToRecord(pm, elsewhere!.id, recordId)).rejects.toThrow(/different project/)
  })
})

describe('who may do what', () => {
  it('lets a subcontractor photograph their own work', async () => {
    // A sub who cannot put a photograph on their own T&M ticket will text it
    // instead, and then it is on a phone nobody can subpoena.
    const result = await photos.upload(sub, {
      projectId,
      filename: 'vega-weld.jpg',
      contentType: 'image/jpeg',
      bytes: photoTakenAt('2026:03:08 10:00:00', 41),
    })
    expect(result.photo.uploadedByName).toBe('Sasha Vega')
  })

  it('refuses a file that is not an image', async () => {
    await expect(
      photos.upload(pm, {
        projectId,
        filename: 'contract.pdf',
        contentType: 'application/pdf',
        bytes: Buffer.from('%PDF-1.7'),
      }),
    ).rejects.toThrow(/not a photograph/)
  })

  it('refuses an empty file', async () => {
    await expect(
      photos.upload(pm, { projectId, filename: 'x.jpg', contentType: 'image/jpeg', bytes: Buffer.alloc(0) }),
    ).rejects.toThrow(/empty/)
  })
})
