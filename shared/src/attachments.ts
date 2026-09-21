import { withTenant, type Db } from './db.js'
import { NotFoundError, PermissionDeniedError, ValidationError } from './errors.js'
import type { Actor } from './kernel.js'
import { hasLevel } from './permissions.js'
import { loadAccess } from './repositories/permissions.js'
import * as repo from './repositories/records.js'
import { getRecordType } from './repositories/record-types.js'
import { ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES, type BlobStore } from './storage/index.js'

/**
 * Files on records.
 *
 * The schema for these has existed since the record kernel shipped and
 * nothing ever wrote to it, which made every attachment in the product a
 * promise. This is the half that was missing: a store, a permission check on
 * both ends, and a download path that loads the reader's access before it
 * reads a byte.
 *
 * Reading an attachment is checked against the RECORD's tool, not against a
 * separate documents permission. An attachment is part of the record it hangs
 * on: if you can read the RFI you can read the sketch attached to it, and if
 * you cannot, a second permission that says otherwise is a hole.
 */

export interface AttachmentView {
  id: string
  recordId: string
  filename: string
  contentType: string
  byteSize: number
  uploadedBy: string
  /** Null only where the account has since been removed. */
  uploadedByName: string | null
  createdAt: Date
}

export class AttachmentService {
  constructor(
    private readonly db: Db,
    private readonly store: BlobStore,
  ) {}

  async attach(
    actor: Actor,
    recordId: string,
    input: { filename: string; contentType: string; bytes: Buffer },
  ): Promise<AttachmentView> {
    const filename = input.filename?.trim()
    if (!filename) {
      throw new ValidationError('A filename is required', [{ field: 'filename', message: 'Filename is required' }])
    }
    if (input.bytes.byteLength === 0) {
      throw new ValidationError('That file is empty', [{ field: 'file', message: 'The file has no content' }])
    }
    if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new ValidationError('That file is too large', [
        { field: 'file', message: `Files are limited to ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB` },
      ])
    }
    if (!ALLOWED_CONTENT_TYPES.has(input.contentType)) {
      throw new ValidationError('That file type is not accepted', [
        { field: 'contentType', message: `${input.contentType} is not an accepted file type` },
      ])
    }

    // Authorize BEFORE anything is written, so a refused upload leaves no
    // orphan in the store.
    const { record, type } = await withTenant(this.db, actor.tenantId, async (tx) => {
      const found = await repo.findRecord(tx, recordId)
      if (!found) throw new NotFoundError('record', recordId)
      const recordType = await getRecordType(tx, found.typeKey)
      const access = await loadAccess(tx, {
        userId: actor.userId,
        tenantId: actor.tenantId,
        projectId: found.projectId,
      })
      if (!hasLevel(access, recordType.toolKey, 'standard')) {
        throw new PermissionDeniedError(`You cannot attach files to ${recordType.displayNamePlural}`, {
          tool: recordType.toolKey,
        })
      }
      return { record: found, type: recordType }
    })

    const stored = await this.store.put({
      tenantId: actor.tenantId,
      bytes: input.bytes,
      contentType: input.contentType,
    })

    try {
      return await withTenant(this.db, actor.tenantId, async (tx) => {
        const row = await repo.insertAttachment(tx, {
          tenantId: actor.tenantId,
          recordId,
          filename,
          contentType: input.contentType,
          byteSize: stored.byteSize,
          storageKey: stored.key,
          uploadedBy: actor.userId,
        })
        await repo.appendEvent(tx, {
          tenantId: actor.tenantId,
          projectId: record.projectId,
          recordId,
          typeKey: type.key,
          event: 'record.attachment_added',
          payload: { filename, contentType: input.contentType, byteSize: stored.byteSize },
          actorUserId: actor.userId,
        })
        return row
      })
    } catch (err) {
      // The row is the record of truth. A blob with no row is invisible and
      // billable forever, so take it back out rather than leaving litter.
      await this.store.delete(stored.key).catch(() => undefined)
      throw err
    }
  }

  async list(actor: Actor, recordId: string): Promise<AttachmentView[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await this.assertCanRead(tx, actor, recordId)
      return repo.listAttachments(tx, { tenantId: actor.tenantId, recordId })
    })
  }

  /** The bytes, and only after the reader's access has been loaded. */
  async read(actor: Actor, attachmentId: string): Promise<{ attachment: AttachmentView; bytes: Buffer }> {
    const { attachment, storageKey } = await withTenant(this.db, actor.tenantId, async (tx) => {
      const found = await repo.findAttachment(tx, { tenantId: actor.tenantId, attachmentId })
      if (!found) throw new NotFoundError('attachment', attachmentId)
      await this.assertCanRead(tx, actor, found.attachment.recordId)
      return found
    })
    return { attachment, bytes: await this.store.get(storageKey) }
  }

  private async assertCanRead(tx: Db, actor: Actor, recordId: string): Promise<void> {
    const record = await repo.findRecord(tx, recordId)
    if (!record) throw new NotFoundError('record', recordId)
    const type = await getRecordType(tx, record.typeKey)
    const access = await loadAccess(tx, {
      userId: actor.userId,
      tenantId: actor.tenantId,
      projectId: record.projectId,
    })
    if (!hasLevel(access, type.toolKey, 'read_only')) {
      throw new PermissionDeniedError(`You cannot read ${type.displayNamePlural}`, { tool: type.toolKey })
    }
  }
}
