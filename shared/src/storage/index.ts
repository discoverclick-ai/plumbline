import { randomUUID } from 'node:crypto'

/**
 * Where bytes live.
 *
 * Same seam as the model provider: one interface, one implementation per
 * backend, and nothing above this line knows whether a file is on a disk or in
 * a bucket. The filesystem store is not a stub for tests, it is what a
 * single-server install should run, because plenty of contractors will never
 * want their drawings leaving their own building.
 *
 * Two rules the interface exists to enforce.
 *
 * A key is opaque and unguessable. Construction documents are the most
 * sensitive thing on a job: bid numbers before a bid is due, an incident
 * report before the lawyers see it. A key derived from the filename and the
 * project, which is what most systems do, is a directory listing waiting to
 * be enumerated.
 *
 * A read is never public. There is no signed URL in this interface on purpose.
 * Every byte leaves through a route that has already loaded the reader's
 * access snapshot, because a link that works for anybody holding it is not a
 * permission model, it is a rumour.
 */

export interface StoredBlob {
  key: string
  byteSize: number
  contentType: string
}

export interface BlobStore {
  readonly name: string
  put(input: { tenantId: string; bytes: Buffer; contentType: string }): Promise<StoredBlob>
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
}

/**
 * Tenant-prefixed so a misdirected read cannot cross a company boundary even
 * if something above goes wrong, and random within it so the key carries no
 * information about what the file is or who uploaded it.
 */
export function newStorageKey(tenantId: string): string {
  const now = new Date()
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  return `${tenantId}/${month}/${randomUUID()}`
}

/** Refuses anything that could escape the store's root. */
export function assertSafeKey(key: string): void {
  if (!/^[0-9a-f-]{36}\/\d{4}-\d{2}\/[0-9a-f-]{36}$/.test(key)) {
    throw new Error(`Refusing a storage key that is not one of ours: ${key}`)
  }
}

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

/**
 * What a construction platform actually receives. Deliberately a list rather
 * than a wildcard: an upload surface that accepts anything is how a project
 * directory becomes a malware share, and every party on the job has an
 * account here.
 */
export const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
  'image/tiff',
  'video/mp4',
  'video/quicktime',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/webm',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/zip',
  'application/acad',
  'image/vnd.dwg',
  'application/dxf',
  'model/ifc',
])
