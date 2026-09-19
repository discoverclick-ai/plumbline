import { withTenant, type Db } from './db.js'
import { NotFoundError, PermissionDeniedError, ValidationError } from './errors.js'
import type { Actor } from './kernel.js'
import { hasLevel, hasPrivilege } from './permissions.js'
import { loadAccess } from './repositories/permissions.js'
import { ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES, type BlobStore } from './storage/index.js'

/**
 * Drawings.
 *
 * The question the tool exists to answer is "which revision is current for
 * S-401, and was the crew building from it?" Getting that wrong is rework, and
 * rework is the most expensive word on a jobsite.
 *
 * The hard part is pins. A pin belongs to the revision it was placed on, and
 * that revision stops being current the moment a new one arrives. An RFI
 * pinned to revision 2 of S-401 has to still be findable on revision 3, AND
 * still be honest about which drawing the person was looking at when they
 * raised it. Most products pick one: either the pin follows the sheet and
 * quietly lies about what was asked, or it stays put and silently disappears.
 * Both are true here, and the caller is told which pins came from where.
 */

export interface CurrentSheet {
  drawingId: string
  number: string
  title: string
  discipline: string | null
  revisionId: string
  revisionLabel: string
  sequence: number
  setName: string
  issuedOn: string
  revisionCount: number
}

export interface SheetPin {
  pinId: string
  recordId: string
  page: number
  x: string
  y: string
  revisionId: string
  revisionLabel: string
  /** False when the pin was placed on an earlier revision of this sheet. */
  onCurrentRevision: boolean
}

export class DrawingService {
  constructor(
    private readonly db: Db,
    private readonly store: BlobStore,
  ) {}

  async createSet(
    actor: Actor,
    input: { projectId: string; name: string; issuedOn: string; receivedOn?: string },
  ): Promise<{ id: string }> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await this.assertPrivilege(tx, actor, input.projectId, 'upload')
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO drawing_sets (tenant_id, project_id, name, issued_on, received_on, created_by)
              VALUES ($1, $2, $3, $4::date, $5::date, $6)
         RETURNING id`,
        [actor.tenantId, input.projectId, input.name, input.issuedOn, input.receivedOn ?? null, actor.userId],
      )
      return { id: rows[0]?.id as string }
    })
  }

  /**
   * Adds a sheet to a set, creating the sheet if the job has never seen that
   * number before.
   *
   * The sequence is assigned here rather than parsed from the revision label.
   * Labels are whatever the architect's title block says, and "which of A and
   * 1 is newer" is not a question any code should be asked.
   */
  async addRevision(
    actor: Actor,
    input: {
      setId: string
      number: string
      title: string
      discipline?: string
      revisionLabel: string
      filename: string
      contentType: string
      bytes: Buffer
    },
  ): Promise<{ drawingId: string; revisionId: string; sequence: number }> {
    if (input.bytes.byteLength === 0) {
      throw new ValidationError('That sheet is empty', [{ field: 'file', message: 'The file has no content' }])
    }
    if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new ValidationError('That sheet is too large', [
        { field: 'file', message: `Sheets are limited to ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB` },
      ])
    }
    if (!ALLOWED_CONTENT_TYPES.has(input.contentType)) {
      throw new ValidationError('That file type is not accepted', [
        { field: 'contentType', message: `${input.contentType} is not an accepted file type` },
      ])
    }

    const { projectId, status } = await withTenant(this.db, actor.tenantId, async (tx) => {
      const set = await this.loadSet(tx, actor.tenantId, input.setId)
      await this.assertPrivilege(tx, actor, set.project_id, 'upload')
      return { projectId: set.project_id, status: set.status }
    })

    if (status !== 'draft') {
      // A published set is what a crew is building from. Adding a sheet to it
      // after the fact means somebody on site has a set that does not match
      // the one in the system, and neither of them knows.
      throw new ValidationError('That set is already published', [
        { field: 'setId', message: 'Issue a new set rather than adding to a published one' },
      ])
    }

    const stored = await this.store.put({
      tenantId: actor.tenantId,
      bytes: input.bytes,
      contentType: input.contentType,
    })

    try {
      return await withTenant(this.db, actor.tenantId, async (tx) => {
        const { rows: drawingRows } = await tx.query<{ id: string }>(
          `INSERT INTO drawings (tenant_id, project_id, number, title, discipline)
                VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (project_id, number) DO UPDATE SET title = EXCLUDED.title
             RETURNING id`,
          [actor.tenantId, projectId, input.number, input.title, input.discipline ?? null],
        )
        const drawingId = drawingRows[0]?.id as string

        const { rows } = await tx.query<{ id: string; sequence: number }>(
          `INSERT INTO drawing_revisions
             (tenant_id, drawing_id, set_id, revision_label, sequence, storage_key, content_type, byte_size, uploaded_by)
           VALUES ($1, $2, $3, $4,
                   (SELECT COALESCE(MAX(sequence), 0) + 1 FROM drawing_revisions WHERE drawing_id = $2),
                   $5, $6, $7, $8)
           RETURNING id, sequence`,
          [
            actor.tenantId,
            drawingId,
            input.setId,
            input.revisionLabel,
            stored.key,
            input.contentType,
            stored.byteSize,
            actor.userId,
          ],
        )
        const revision = rows[0]
        if (!revision) throw new Error('revision insert returned no row')
        return { drawingId, revisionId: revision.id, sequence: revision.sequence }
      })
    } catch (err) {
      await this.store.delete(stored.key).catch(() => undefined)
      throw err
    }
  }

  /**
   * Publishes the set, which is the moment its sheets become what the job is
   * built from. Everything issued earlier for the same sheets is superseded by
   * sequence, not by this call, because supersession is a fact about ordering
   * rather than a flag somebody has to remember to set.
   */
  async publishSet(actor: Actor, setId: string): Promise<void> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const set = await this.loadSet(tx, actor.tenantId, setId)
      await this.assertPrivilege(tx, actor, set.project_id, 'publish')
      if (set.status !== 'draft') {
        throw new ValidationError('That set is already published', [
          { field: 'setId', message: `The set is ${set.status}` },
        ])
      }
      const { rows } = await tx.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM drawing_revisions WHERE tenant_id = $1 AND set_id = $2`,
        [actor.tenantId, setId],
      )
      if (Number(rows[0]?.n ?? 0) === 0) {
        throw new ValidationError('That set has no sheets in it', [
          { field: 'setId', message: 'Add at least one sheet before publishing' },
        ])
      }
      await tx.query(
        `UPDATE drawing_sets SET status = 'published', published_at = now() WHERE tenant_id = $1 AND id = $2`,
        [actor.tenantId, setId],
      )
    })
  }

  /** What the job is currently built from. */
  async currentSheets(actor: Actor, projectId: string, discipline?: string): Promise<CurrentSheet[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await this.assertReadable(tx, actor, projectId)
      const { rows } = await tx.query<Record<string, string | number | null>>(
        `SELECT drawing_id, number, title, discipline, revision_id, revision_label, sequence,
                set_name, issued_on, revision_count
           FROM current_drawings
          WHERE tenant_id = $1 AND project_id = $2
            AND ($3::text IS NULL OR discipline = $3)
          ORDER BY discipline NULLS LAST, number`,
        [actor.tenantId, projectId, discipline ?? null],
      )
      return rows.map((r) => ({
        drawingId: r['drawing_id'] as string,
        number: r['number'] as string,
        title: r['title'] as string,
        discipline: (r['discipline'] as string | null) ?? null,
        revisionId: r['revision_id'] as string,
        revisionLabel: r['revision_label'] as string,
        sequence: Number(r['sequence']),
        setName: r['set_name'] as string,
        issuedOn: String(r['issued_on']),
        revisionCount: Number(r['revision_count']),
      }))
    })
  }

  /**
   * Pins a record to a spot on the sheet the person is looking at.
   *
   * Coordinates are fractions of the page, so a pin survives the sheet being
   * rescanned at a different resolution. Storing pixels would move every pin
   * on the job the first time somebody re-exported the PDF at 300dpi.
   */
  async pin(
    actor: Actor,
    input: { revisionId: string; recordId: string; page?: number; x: number; y: number },
  ): Promise<{ id: string }> {
    if (!(input.x >= 0 && input.x <= 1 && input.y >= 0 && input.y <= 1)) {
      throw new ValidationError('That pin is off the sheet', [
        { field: 'x', message: 'Coordinates are fractions of the page, between 0 and 1' },
      ])
    }
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<{ drawing_id: string; project_id: string }>(
        `SELECT r.drawing_id, d.project_id
           FROM drawing_revisions r JOIN drawings d ON d.id = r.drawing_id
          WHERE r.tenant_id = $1 AND r.id = $2`,
        [actor.tenantId, input.revisionId],
      )
      const revision = rows[0]
      if (!revision) throw new NotFoundError('drawing revision', input.revisionId)
      await this.assertPrivilege(tx, actor, revision.project_id, 'pin')

      // A record from another project pinned to this sheet would put one job's
      // RFI on another job's drawing, which is exactly as confusing as it
      // sounds and completely invisible afterwards.
      const { rows: recordRows } = await tx.query<{ project_id: string }>(
        `SELECT project_id FROM records WHERE tenant_id = $1 AND id = $2`,
        [actor.tenantId, input.recordId],
      )
      if (!recordRows[0]) throw new NotFoundError('record', input.recordId)
      if (recordRows[0].project_id !== revision.project_id) {
        throw new ValidationError('That record is on a different project', [
          { field: 'recordId', message: 'A record can only be pinned to its own project drawings' },
        ])
      }

      const { rows: pinRows } = await tx.query<{ id: string }>(
        `INSERT INTO drawing_pins (tenant_id, drawing_id, revision_id, record_id, page, x, y, placed_by)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (revision_id, record_id) DO UPDATE SET x = EXCLUDED.x, y = EXCLUDED.y, page = EXCLUDED.page
           RETURNING id`,
        [
          actor.tenantId,
          revision.drawing_id,
          input.revisionId,
          input.recordId,
          input.page ?? 1,
          input.x,
          input.y,
          actor.userId,
        ],
      )
      return { id: pinRows[0]?.id as string }
    })
  }

  /**
   * Every pin on a sheet, from every revision, each saying where it came from.
   *
   * Showing only the current revision's pins loses the RFI somebody raised
   * against revision 2, which is usually the one that mattered. Moving old
   * pins onto the current revision silently would claim the person had been
   * looking at a drawing that did not exist yet.
   */
  async pinsFor(actor: Actor, drawingId: string): Promise<SheetPin[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows: drawingRows } = await tx.query<{ project_id: string }>(
        `SELECT project_id FROM drawings WHERE tenant_id = $1 AND id = $2`,
        [actor.tenantId, drawingId],
      )
      const drawing = drawingRows[0]
      if (!drawing) throw new NotFoundError('drawing', drawingId)
      await this.assertReadable(tx, actor, drawing.project_id)

      const { rows } = await tx.query<Record<string, string | number | boolean>>(
        `SELECT p.id AS pin_id, p.record_id, p.page, p.x, p.y, p.revision_id, r.revision_label,
                (p.revision_id = cd.revision_id) AS on_current
           FROM drawing_pins p
           JOIN drawing_revisions r ON r.id = p.revision_id
           LEFT JOIN current_drawings cd ON cd.drawing_id = p.drawing_id
          WHERE p.tenant_id = $1 AND p.drawing_id = $2
          ORDER BY r.sequence DESC, p.created_at`,
        [actor.tenantId, drawingId],
      )
      return rows.map((r) => ({
        pinId: r['pin_id'] as string,
        recordId: r['record_id'] as string,
        page: Number(r['page']),
        x: String(r['x']),
        y: String(r['y']),
        revisionId: r['revision_id'] as string,
        revisionLabel: r['revision_label'] as string,
        onCurrentRevision: r['on_current'] === true,
      }))
    })
  }

  /** The sheet itself, after the reader's access has been loaded. */
  async sheetBytes(actor: Actor, revisionId: string): Promise<{ bytes: Buffer; contentType: string; number: string }> {
    const { storageKey, contentType, number } = await withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<{
        storage_key: string
        content_type: string
        number: string
        project_id: string
      }>(
        `SELECT r.storage_key, r.content_type, d.number, d.project_id
           FROM drawing_revisions r JOIN drawings d ON d.id = r.drawing_id
          WHERE r.tenant_id = $1 AND r.id = $2`,
        [actor.tenantId, revisionId],
      )
      const row = rows[0]
      if (!row) throw new NotFoundError('drawing revision', revisionId)
      await this.assertReadable(tx, actor, row.project_id)
      return { storageKey: row.storage_key, contentType: row.content_type, number: row.number }
    })
    return { bytes: await this.store.get(storageKey), contentType, number }
  }

  private async loadSet(
    tx: Db,
    tenantId: string,
    setId: string,
  ): Promise<{ project_id: string; status: string }> {
    const { rows } = await tx.query<{ project_id: string; status: string }>(
      `SELECT project_id, status FROM drawing_sets WHERE tenant_id = $1 AND id = $2`,
      [tenantId, setId],
    )
    const row = rows[0]
    if (!row) throw new NotFoundError('drawing set', setId)
    return row
  }

  private async assertReadable(tx: Db, actor: Actor, projectId: string): Promise<void> {
    const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
    if (!hasLevel(access, 'drawings', 'read_only')) {
      throw new PermissionDeniedError('You cannot see drawings on this project', { tool: 'drawings' })
    }
  }

  private async assertPrivilege(tx: Db, actor: Actor, projectId: string, privilege: string): Promise<void> {
    const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
    if (!hasPrivilege(access, 'drawings', privilege) && !access.isCompanyAdmin) {
      throw new PermissionDeniedError(`You cannot ${privilege} drawings on this project`, { tool: 'drawings' })
    }
  }
}
