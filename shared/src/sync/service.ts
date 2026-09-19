import { withTenant, type Db } from '../db.js'
import { NotFoundError, ValidationError } from '../errors.js'
import type { Actor } from '../kernel.js'
import { getRecordType } from '../repositories/record-types.js'
import * as repo from '../repositories/records.js'
import { canApplyTo, mergeBody } from './merge.js'

/**
 * Offline that is not a lie.
 *
 * Caching what somebody already opened is caching the past, and the past is
 * not what they need in a basement. This pulls what they will need on this job
 * before they lose signal, takes back what they did while they were dark, and
 * keeps a log of anything it could not apply.
 */

export interface SyncBundle {
  deviceId: string
  /** Where the device is up to. Passed back on the next pull. */
  cursor: number
  records: {
    id: string
    projectId: string
    typeKey: string
    designation: string
    title: string
    status: string
    body: Record<string, unknown>
    version: number
    ballInCourtUserId: string | null
  }[]
  sheets: { drawingId: string; number: string; title: string; revisionId: string; revisionLabel: string }[]
  /** Everything the client needs to render and validate a type offline. */
  recordTypes: unknown[]
}

export interface PushedOperation {
  clientOpId: string
  recordId: string
  /** The version the device was working from. Without it there is no merge, only a guess. */
  baseVersion: number
  body: Record<string, unknown>
  occurredAt: string
}

export interface PushResult {
  clientOpId: string
  outcome: 'applied' | 'merged' | 'conflicted' | 'rejected' | 'duplicate'
  applied: string[]
  dropped: string[]
  detail?: string
}

export interface SyncConflict {
  clientOpId: string
  recordId: string | null
  designation: string | null
  title: string | null
  typeKey: string | null
  outcome: 'conflicted' | 'rejected'
  detail: string | null
  /** When the phone says it happened, which is the true one. */
  occurredAt: string
  /** When it reached the server, which on a job can be eight hours later. */
  receivedAt: string
  deviceLabel: string | null
  deviceOwner: string | null
  applied: string[]
  dropped: { field: string; value: string }[]
}

export class SyncService {
  constructor(private readonly db: Db) {}

  async registerDevice(actor: Actor, deviceKey: string, label?: string): Promise<{ deviceId: string }> {
    if (!deviceKey?.trim()) {
      throw new ValidationError('A device key is required', [
        { field: 'deviceKey', message: 'The client picks a stable key for this device' },
      ])
    }
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO sync_devices (tenant_id, user_id, device_key, label)
              VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, device_key) DO UPDATE SET last_seen_at = now(), label = COALESCE(EXCLUDED.label, sync_devices.label)
           RETURNING id`,
        [actor.tenantId, actor.userId, deviceKey.trim(), label ?? null],
      )
      return { deviceId: rows[0]?.id as string }
    })
  }

  /**
   * What this person will need on this job, before they lose signal.
   *
   * Not "everything on the project", which is gigabytes of drawings, and not
   * "what they opened", which is the past. What they owe, what is open and
   * assigned to them, what they touched recently, and the current sheets.
   */
  async pull(actor: Actor, input: { deviceId: string; projectId: string }): Promise<SyncBundle> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows: deviceRows } = await tx.query<{ id: string; last_event_id: string }>(
        `SELECT id, last_event_id FROM sync_devices
          WHERE tenant_id = $1 AND id = $2 AND user_id = $3`,
        [actor.tenantId, input.deviceId, actor.userId],
      )
      const device = deviceRows[0]
      if (!device) throw new NotFoundError('device', input.deviceId)

      const { rows: records } = await tx.query<Record<string, unknown>>(
        `SELECT r.id, r.project_id, r.type_key, r.designation, r.title, r.status, r.body, r.version,
                r.ball_in_court_user_id
           FROM records r
          WHERE r.tenant_id = $1 AND r.project_id = $2
            AND (
              -- Owed by this person right now.
              r.ball_in_court_user_id = $3
              -- Or open and they are on it, because the next thing they do is
              -- usually to something they are already party to.
              OR (r.closed_at IS NULL AND EXISTS (
                    SELECT 1 FROM record_participants p
                     WHERE p.record_id = r.id AND p.user_id = $3))
              -- Or they touched it this week, which is the only part of the
              -- past worth carrying.
              OR EXISTS (
                    SELECT 1 FROM record_state_history h
                     WHERE h.record_id = r.id AND h.actor_user_id = $3
                       AND h.occurred_at > now() - INTERVAL '7 days')
            )
          ORDER BY r.updated_at DESC
          LIMIT 500`,
        [actor.tenantId, input.projectId, actor.userId],
      )

      const { rows: sheets } = await tx.query<Record<string, string>>(
        `SELECT drawing_id, number, title, revision_id, revision_label
           FROM current_drawings
          WHERE tenant_id = $1 AND project_id = $2
          ORDER BY number
          LIMIT 500`,
        [actor.tenantId, input.projectId],
      )

      const { rows: types } = await tx.query<{ key: string; definition: unknown; version: number }>(
        `SELECT key, definition, version FROM record_types`,
      )

      const { rows: head } = await tx.query<{ id: string }>(
        `SELECT COALESCE(MAX(id), 0)::text AS id FROM record_events WHERE tenant_id = $1 AND project_id = $2`,
        [actor.tenantId, input.projectId],
      )
      const cursor = Number(head[0]?.id ?? 0)

      await tx.query(
        `UPDATE sync_devices SET last_event_id = $2, last_seen_at = now() WHERE id = $1`,
        [device.id, cursor],
      )

      return {
        deviceId: device.id,
        cursor,
        records: records.map((r) => ({
          id: r['id'] as string,
          projectId: r['project_id'] as string,
          typeKey: r['type_key'] as string,
          designation: r['designation'] as string,
          title: r['title'] as string,
          status: r['status'] as string,
          body: (r['body'] ?? {}) as Record<string, unknown>,
          version: Number(r['version']),
          ballInCourtUserId: (r['ball_in_court_user_id'] as string | null) ?? null,
        })),
        sheets: sheets.map((s) => ({
          drawingId: s['drawing_id'] as string,
          number: s['number'] as string,
          title: s['title'] as string,
          revisionId: s['revision_id'] as string,
          revisionLabel: s['revision_label'] as string,
        })),
        // The definitions travel with the bundle so a device can render and
        // validate a record type it has never seen, which is the same
        // property the web client has and for the same reason.
        recordTypes: types,
      }
    })
  }

  /**
   * Takes back what somebody did while they were dark.
   *
   * Every operation is recorded whatever happens to it, including the ones
   * that are refused. "My change did not save" is the most corrosive thing a
   * field tool can do, and the only answer that helps is showing the person
   * exactly what arrived and what became of it.
   */
  async push(actor: Actor, deviceId: string, operations: PushedOperation[]): Promise<PushResult[]> {
    const results: PushResult[] = []

    for (const operation of operations) {
      results.push(await this.applyOne(actor, deviceId, operation))
    }
    return results
  }

  private async applyOne(actor: Actor, deviceId: string, operation: PushedOperation): Promise<PushResult> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      // A phone that pushes, loses signal before the response, and pushes
      // again must not double.
      const { rows: seen } = await tx.query<{ outcome: string; applied_fields: string[]; dropped_fields: string[] }>(
        `SELECT outcome, applied_fields, dropped_fields FROM sync_operations
          WHERE tenant_id = $1 AND device_id = $2 AND client_op_id = $3`,
        [actor.tenantId, deviceId, operation.clientOpId],
      )
      if (seen[0]) {
        return {
          clientOpId: operation.clientOpId,
          outcome: 'duplicate' as const,
          applied: seen[0].applied_fields,
          dropped: seen[0].dropped_fields,
          detail: `Already received, and ${seen[0].outcome}`,
        }
      }

      const record = await repo.findRecord(tx, operation.recordId)
      const write = async (result: PushResult, recordId: string | null): Promise<PushResult> => {
        await tx.query(
          `INSERT INTO sync_operations
             (tenant_id, device_id, client_op_id, record_id, kind, payload, base_version,
              outcome, applied_fields, dropped_fields, detail, occurred_at)
           VALUES ($1, $2, $3, $4, 'record.update', $5, $6, $7::sync_outcome, $8, $9, $10, $11::timestamptz)`,
          [
            actor.tenantId,
            deviceId,
            operation.clientOpId,
            recordId,
            JSON.stringify(operation.body),
            operation.baseVersion,
            result.outcome,
            result.applied,
            result.dropped,
            result.detail ?? null,
            operation.occurredAt,
          ],
        )
        return result
      }

      if (!record) {
        return write(
          {
            clientOpId: operation.clientOpId,
            outcome: 'rejected',
            applied: [],
            dropped: Object.keys(operation.body),
            detail: 'That record no longer exists',
          },
          null,
        )
      }

      const type = await getRecordType(tx, record.typeKey)
      const terminal = type.definition.workflow.states.filter((s) => s.terminal).map((s) => s.key)
      if (!canApplyTo(record.status, terminal)) {
        return write(
          {
            clientOpId: operation.clientOpId,
            outcome: 'rejected',
            applied: [],
            dropped: Object.keys(operation.body),
            detail: `That record was ${record.status} before this arrived`,
          },
          record.id,
        )
      }

      // The base is reconstructed from the record as the device last saw it.
      // Without a stored base, a field the device did not touch cannot be
      // told from one it changed back, so the client sends the version it was
      // working from and anything newer is treated as the server's.
      const base =
        operation.baseVersion === record.version
          ? record.body
          : await this.bodyAtVersion(tx, record, operation.baseVersion)

      if (base === null) {
        // The history cannot reach back far enough to say what the device was
        // looking at. Refusing is the conservative direction: a human reads
        // the log and re-enters it, rather than the device silently
        // overwriting work it never saw.
        return write(
          {
            clientOpId: operation.clientOpId,
            outcome: 'rejected',
            applied: [],
            dropped: Object.keys(operation.body),
            detail: `Cannot tell what this device was working from (version ${operation.baseVersion})`,
          },
          record.id,
        )
      }

      const merge = mergeBody(base, record.body, operation.body)

      if (Object.keys(merge.merged).length > 0) {
        await tx.query(
          `UPDATE records SET body = body || $3::jsonb, version = version + 1, updated_at = now()
            WHERE tenant_id = $1 AND id = $2`,
          [actor.tenantId, record.id, JSON.stringify(merge.merged)],
        )
        await repo.appendEvent(tx, {
          tenantId: actor.tenantId,
          projectId: record.projectId,
          recordId: record.id,
          typeKey: record.typeKey,
          event: 'record.synced',
          payload: { applied: merge.applied, dropped: merge.dropped, device: deviceId },
          actorUserId: actor.userId,
        })
      }

      // `applied` means the edit went in as the person left it. `merged`
      // means somebody else had moved the record on and the result is a
      // blend. Counting applied fields against the fields the device sent
      // cannot tell those apart, because a client sending its whole body back
      // is normal and would make every successful push read as merged.
      const outcome =
        merge.conflicts.length > 0 ? 'conflicted' : merge.serverAlsoChanged ? 'merged' : 'applied'

      return write(
        {
          clientOpId: operation.clientOpId,
          outcome,
          applied: merge.applied,
          dropped: merge.dropped,
          ...(merge.conflicts.length > 0
            ? {
                detail: merge.conflicts
                  .map((c) => `${c.field}: kept "${String(c.server)}", dropped "${String(c.device)}"`)
                  .join('; '),
              }
            : {}),
        },
        record.id,
      )
    })
  }

  /**
   * The body as the device last saw it.
   *
   * Reconstructed from the record's own history rather than stored per device,
   * because storing a copy per device per record is a cache with a
   * multiplication in it. Where the history cannot reach back far enough the
   * server's current body is used, which degrades the merge to "the device
   * changed everything it sent" and is the conservative direction: it produces
   * conflicts a human reviews rather than silent overwrites.
   */
  private async bodyAtVersion(
    tx: Db,
    record: { id: string; body: Record<string, unknown> },
    baseVersion: number,
  ): Promise<Record<string, unknown> | null> {
    const { rows } = await tx.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM record_events
        WHERE record_id = $1 AND (payload ->> 'version')::int = $2 AND payload ? 'body'
        ORDER BY id DESC
        LIMIT 1`,
      [record.id, baseVersion],
    )
    const snapshot = rows[0]?.payload?.['body']
    // Null, not the server's body. Falling back to the current body makes base
    // equal server, which means every field the device sent looks changed and
    // wins silently — the exact failure the three-way merge exists to prevent.
    return (snapshot as Record<string, unknown>) ?? null
  }

  /**
   * What could not be applied, for somebody at a desk to look at.
   *
   * Joined out to the record and the device, because "whose phone was this
   * and which RFI" is the first question anybody asks, and a screen that
   * answers it with two UUIDs is one nobody uses twice. The dropped VALUES
   * come too: a conflict list that says a field was lost without saying what
   * was in it gives the person no way to put it back.
   */
  async conflicts(actor: Actor, projectId: string): Promise<SyncConflict[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT o.client_op_id, o.record_id, o.detail, o.occurred_at, o.received_at,
                o.outcome::text AS outcome, o.dropped_fields, o.applied_fields, o.payload,
                r.designation, r.title, r.type_key,
                d.label AS device_label, u.name AS device_owner
           FROM sync_operations o
           LEFT JOIN records r ON r.id = o.record_id
           JOIN sync_devices d ON d.id = o.device_id AND d.tenant_id = o.tenant_id
      LEFT JOIN users u ON u.id = d.user_id AND u.tenant_id = o.tenant_id
          WHERE o.tenant_id = $1 AND o.outcome IN ('conflicted', 'rejected')
            AND (r.project_id = $2 OR o.record_id IS NULL)
          ORDER BY o.received_at DESC
          LIMIT 200`,
        [actor.tenantId, projectId],
      )
      return rows.map((r) => {
        const dropped = (r['dropped_fields'] as string[] | null) ?? []
        // For a pushed update the payload IS the body. Version snapshots
        // written elsewhere in this file wrap it under `body`, so both shapes
        // are read rather than assuming the one this query mostly returns.
        const payload = (r['payload'] as Record<string, unknown> | null) ?? {}
        const body = ((payload['body'] as Record<string, unknown> | undefined) ?? payload) as Record<string, unknown>
        return {
          clientOpId: r['client_op_id'] as string,
          recordId: (r['record_id'] as string | null) ?? null,
          designation: (r['designation'] as string | null) ?? null,
          title: (r['title'] as string | null) ?? null,
          typeKey: (r['type_key'] as string | null) ?? null,
          outcome: r['outcome'] as 'conflicted' | 'rejected',
          detail: (r['detail'] as string | null) ?? null,
          occurredAt: (r['occurred_at'] as Date).toISOString(),
          receivedAt: (r['received_at'] as Date).toISOString(),
          deviceLabel: (r['device_label'] as string | null) ?? null,
          deviceOwner: (r['device_owner'] as string | null) ?? null,
          applied: (r['applied_fields'] as string[] | null) ?? [],
          // What the device actually typed, field by field, so it can be
          // re-entered. A conflict that says "notes was dropped" and not what
          // was in it is a conflict nobody can resolve.
          dropped: dropped.map((field) => ({ field, value: String(body[field] ?? '') })),
        }
      })
    })
  }
}
