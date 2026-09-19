import { createHash } from 'node:crypto'
import { withTenant, type Db } from '../db.js'
import { NotFoundError, PermissionDeniedError, ValidationError } from '../errors.js'
import type { Actor } from '../kernel.js'
import { hasLevel, hasPrivilege } from '../permissions.js'
import { loadAccess } from '../repositories/permissions.js'
import { MAX_UPLOAD_BYTES, type BlobStore } from '../storage/index.js'
import { readExif, type PhotoMetadata } from './exif.js'

/**
 * Photographs.
 *
 * Every construction product has a photos tab and almost none is worth
 * anything, for one reason: they re-encode on upload and throw away the EXIF.
 * What is left is a picture with an upload date, which proves nothing about
 * when the work was in that condition.
 *
 * So the original bytes go to the store untouched, and what the camera
 * recorded travels with them. That is the entire difference between an
 * illustration and evidence, and it is why this is a table rather than a use
 * of `record_attachments`.
 */

const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'])

export interface PhotoView {
  id: string
  projectId: string
  filename: string | null
  contentType: string
  byteSize: number
  takenAtLocal: string | null
  uploadedAt: string
  latitude: string | null
  longitude: string | null
  orientation: number | null
  cameraMake: string | null
  cameraModel: string | null
  width: number | null
  height: number | null
  metadataRead: boolean
  caption: string | null
  uploadedByName: string | null
  albums: string[]
  recordIds: string[]
}

export interface PhotoUpload {
  projectId: string
  filename: string
  contentType: string
  bytes: Buffer
  caption?: string
  /** Where the phone said it was, when the file carries no EXIF of its own. */
  fallback?: { takenAt?: string; latitude?: number; longitude?: number }
}

export interface UploadResult {
  photo: PhotoView
  /** True when this exact image was already on the job. */
  duplicate: boolean
  metadata: PhotoMetadata
}

export class PhotoService {
  constructor(
    private readonly db: Db,
    private readonly store: BlobStore,
  ) {}

  async upload(actor: Actor, input: PhotoUpload): Promise<UploadResult> {
    if (input.bytes.byteLength === 0) {
      throw new ValidationError('That file is empty', [{ field: 'file', message: 'The file has no content' }])
    }
    if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new ValidationError('That photograph is too large', [
        { field: 'file', message: `Photographs are limited to ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB` },
      ])
    }
    if (!ACCEPTED.has(input.contentType)) {
      throw new ValidationError('That file is not a photograph', [
        { field: 'contentType', message: `${input.contentType} is not an image type this accepts` },
      ])
    }

    const metadata = readExif(input.bytes)
    const sha256 = createHash('sha256').update(input.bytes).digest('hex')

    // Hashed before it is stored, so the second crew photographing the same
    // crack does not put a second copy on the job. Returning the existing row
    // rather than refusing, because from the field's point of view the upload
    // worked and the photograph is there.
    const existing = await withTenant(this.db, actor.tenantId, async (tx) => {
      await this.assertPrivilege(tx, actor, input.projectId, 'upload')
      const { rows } = await tx.query<{ id: string }>(
        'SELECT id FROM photos WHERE tenant_id = $1 AND project_id = $2 AND sha256 = $3',
        [actor.tenantId, input.projectId, sha256],
      )
      return rows[0]?.id ?? null
    })

    if (existing) {
      return { photo: (await this.get(actor, existing))!, duplicate: true, metadata }
    }

    const stored = await this.store.put({
      tenantId: actor.tenantId,
      bytes: input.bytes,
      contentType: input.contentType,
    })

    // The camera's own record wins over anything the client says. A phone
    // app's idea of "now" is when the upload started, which on a photograph
    // taken in a basement at seven is six hours wrong.
    const takenAt = metadata.takenAt ?? input.fallback?.takenAt ?? null
    const latitude = metadata.latitude ?? input.fallback?.latitude ?? null
    const longitude = metadata.longitude ?? input.fallback?.longitude ?? null

    const id = await withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO photos
           (tenant_id, project_id, storage_key, content_type, byte_size, sha256, filename,
            taken_at_local, latitude, longitude, altitude_m, orientation, camera_make, camera_model,
            width, height, metadata_read, caption, taken_by, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamp, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
         RETURNING id`,
        [
          actor.tenantId,
          input.projectId,
          stored.key,
          input.contentType,
          input.bytes.byteLength,
          sha256,
          input.filename,
          takenAt,
          latitude,
          longitude,
          metadata.altitude,
          metadata.orientation,
          metadata.make,
          metadata.model,
          metadata.width,
          metadata.height,
          // "The camera did not say" and "nobody has looked" are different,
          // and only one of them is worth chasing somebody about.
          metadata.takenAt !== null || metadata.latitude !== null,
          input.caption ?? null,
          actor.userId,
          actor.userId,
        ],
      )
      return rows[0]!.id
    })

    return { photo: (await this.get(actor, id))!, duplicate: false, metadata }
  }

  async get(actor: Actor, photoId: string): Promise<PhotoView | null> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT p.*, u.name AS uploaded_by_name,
                coalesce(
                  (SELECT array_agg(a.name ORDER BY a.name)
                     FROM photo_album_members m JOIN photo_albums a ON a.id = m.album_id
                    WHERE m.photo_id = p.id),
                  '{}'
                ) AS albums,
                coalesce(
                  (SELECT array_agg(l.record_id::text) FROM photo_record_links l WHERE l.photo_id = p.id),
                  '{}'
                ) AS record_ids
           FROM photos p
      LEFT JOIN users u ON u.id = p.uploaded_by AND u.tenant_id = p.tenant_id
          WHERE p.tenant_id = $1 AND p.id = $2`,
        [actor.tenantId, photoId],
      )
      const row = rows[0]
      if (!row) return null
      await this.assertReadable(tx, actor, row['project_id'] as string)
      return toView(row)
    })
  }

  /** The bytes, exactly as they were uploaded. */
  async download(actor: Actor, photoId: string): Promise<{ bytes: Buffer; contentType: string; filename: string }> {
    const row = await withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        'SELECT project_id, storage_key, content_type, filename FROM photos WHERE tenant_id = $1 AND id = $2',
        [actor.tenantId, photoId],
      )
      const found = rows[0]
      if (!found) throw new NotFoundError('photo', photoId)
      await this.assertReadable(tx, actor, found['project_id'] as string)
      return found
    })

    return {
      bytes: await this.store.get(row['storage_key'] as string),
      contentType: row['content_type'] as string,
      filename: (row['filename'] as string | null) ?? `${photoId}.jpg`,
    }
  }

  /**
   * The library, filtered the three ways people actually look.
   *
   * By date, because "show me the week we poured", by album, because somebody
   * curated it, and by record, because the question is usually "what did this
   * RFI look like". Not by folder: every product that built a folder tree
   * ended up with photographs filed in three places and findable in none.
   */
  async list(
    actor: Actor,
    projectId: string,
    filter: { from?: string; to?: string; albumId?: string; recordId?: string; undatedOnly?: boolean; limit?: number } = {},
  ): Promise<PhotoView[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await this.assertReadable(tx, actor, projectId)

      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT p.*, u.name AS uploaded_by_name,
                coalesce(
                  (SELECT array_agg(a.name ORDER BY a.name)
                     FROM photo_album_members m JOIN photo_albums a ON a.id = m.album_id
                    WHERE m.photo_id = p.id),
                  '{}'
                ) AS albums,
                coalesce(
                  (SELECT array_agg(l.record_id::text) FROM photo_record_links l WHERE l.photo_id = p.id),
                  '{}'
                ) AS record_ids
           FROM photos p
      LEFT JOIN users u ON u.id = p.uploaded_by AND u.tenant_id = p.tenant_id
          WHERE p.tenant_id = $1 AND p.project_id = $2
            AND ($3::date IS NULL OR p.taken_at_local >= $3::date)
            AND ($4::date IS NULL OR p.taken_at_local < ($4::date + 1))
            AND ($5::uuid IS NULL OR EXISTS (
                  SELECT 1 FROM photo_album_members m WHERE m.photo_id = p.id AND m.album_id = $5::uuid))
            AND ($6::uuid IS NULL OR EXISTS (
                  SELECT 1 FROM photo_record_links l WHERE l.photo_id = p.id AND l.record_id = $6::uuid))
            AND ($7::boolean IS NOT TRUE OR p.taken_at_local IS NULL)
          ORDER BY p.taken_at_local DESC NULLS LAST, p.uploaded_at DESC
          LIMIT $8`,
        [
          actor.tenantId,
          projectId,
          filter.from ?? null,
          filter.to ?? null,
          filter.albumId ?? null,
          filter.recordId ?? null,
          filter.undatedOnly === true,
          Math.min(filter.limit ?? 200, 500),
        ],
      )
      return rows.map(toView)
    })
  }

  async createAlbum(actor: Actor, projectId: string, name: string, description?: string): Promise<{ id: string }> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await this.assertPrivilege(tx, actor, projectId, 'organise')
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO photo_albums (tenant_id, project_id, name, description, created_by)
              VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (project_id, name) DO UPDATE SET description = EXCLUDED.description
           RETURNING id`,
        [actor.tenantId, projectId, name, description ?? null, actor.userId],
      )
      return { id: rows[0]!.id }
    })
  }

  async addToAlbum(actor: Actor, albumId: string, photoIds: string[]): Promise<{ added: number }> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<{ project_id: string }>(
        'SELECT project_id FROM photo_albums WHERE tenant_id = $1 AND id = $2',
        [actor.tenantId, albumId],
      )
      const album = rows[0]
      if (!album) throw new NotFoundError('album', albumId)
      await this.assertPrivilege(tx, actor, album.project_id, 'organise')

      // Only photographs from the SAME project. An album spanning two jobs is
      // how a photograph of one client's site ends up in another's report.
      const { rowCount } = await tx.query(
        `INSERT INTO photo_album_members (album_id, photo_id, tenant_id)
         SELECT $2, p.id, $1 FROM photos p
          WHERE p.tenant_id = $1 AND p.id = ANY($3::uuid[]) AND p.project_id = $4
         ON CONFLICT DO NOTHING`,
        [actor.tenantId, albumId, photoIds, album.project_id],
      )
      return { added: rowCount ?? 0 }
    })
  }

  async linkToRecord(actor: Actor, photoId: string, recordId: string): Promise<void> {
    await withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<{ photo_project: string; record_project: string }>(
        `SELECT p.project_id AS photo_project, r.project_id AS record_project
           FROM photos p, records r
          WHERE p.tenant_id = $1 AND p.id = $2 AND r.tenant_id = $1 AND r.id = $3`,
        [actor.tenantId, photoId, recordId],
      )
      const pair = rows[0]
      if (!pair) throw new NotFoundError('photo or record', `${photoId}/${recordId}`)
      if (pair.photo_project !== pair.record_project) {
        throw new ValidationError('That photograph is on a different project', [
          { field: 'photoId', message: 'A photograph can only be linked to a record on its own job' },
        ])
      }
      await this.assertPrivilege(tx, actor, pair.record_project, 'organise')

      await tx.query(
        `INSERT INTO photo_record_links (photo_id, record_id, tenant_id, linked_by)
              VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [photoId, recordId, actor.tenantId, actor.userId],
      )
    })
  }

  private async assertReadable(tx: Db, actor: Actor, projectId: string): Promise<void> {
    const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
    if (!hasLevel(access, 'photos', 'read_only') && !access.isCompanyAdmin) {
      throw new PermissionDeniedError('You cannot see the photographs on this project', { tool: 'photos' })
    }
  }

  private async assertPrivilege(tx: Db, actor: Actor, projectId: string, privilege: string): Promise<void> {
    const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
    if (!hasPrivilege(access, 'photos', privilege) && !access.isCompanyAdmin) {
      throw new PermissionDeniedError(`You cannot ${privilege} photographs on this project`, {
        tool: 'photos',
        privilege,
      })
    }
  }
}

function toView(row: Record<string, unknown>): PhotoView {
  return {
    id: row['id'] as string,
    projectId: row['project_id'] as string,
    filename: (row['filename'] as string | null) ?? null,
    contentType: row['content_type'] as string,
    byteSize: Number(row['byte_size']),
    // Kept as written, with no zone attached. Turning it into an instant here
    // would pick the server's zone, which is nobody's.
    takenAtLocal: row['taken_at_local'] ? localStamp(row['taken_at_local']) : null,
    uploadedAt: (row['uploaded_at'] as Date).toISOString(),
    latitude: row['latitude'] === null ? null : String(row['latitude']),
    longitude: row['longitude'] === null ? null : String(row['longitude']),
    orientation: row['orientation'] === null ? null : Number(row['orientation']),
    cameraMake: (row['camera_make'] as string | null) ?? null,
    cameraModel: (row['camera_model'] as string | null) ?? null,
    width: row['width'] === null ? null : Number(row['width']),
    height: row['height'] === null ? null : Number(row['height']),
    metadataRead: row['metadata_read'] === true,
    caption: (row['caption'] as string | null) ?? null,
    uploadedByName: (row['uploaded_by_name'] as string | null) ?? null,
    albums: (row['albums'] as string[] | null) ?? [],
    recordIds: (row['record_ids'] as string[] | null) ?? [],
  }
}

function localStamp(value: unknown): string {
  if (value instanceof Date) {
    // A `timestamp without time zone` comes back as a Date that node-pg built
    // in the SERVER's zone. Reading the UTC parts back out recovers exactly
    // the characters that were stored, which is what a camera wrote.
    const pad = (n: number): string => String(n).padStart(2, '0')
    return (
      `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}` +
      `T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`
    )
  }
  return String(value).replace(' ', 'T').slice(0, 19)
}
