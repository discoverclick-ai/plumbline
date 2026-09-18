import type { Db } from '../db.js'
import { VersionConflictError } from '../errors.js'
import type { RecordBody } from '../record-type.js'
import type {
  BallInCourtEntry,
  ConstructionRecord,
  ParticipantRole,
  RecordAssignment,
  RecordComment,
  RecordParticipant,
  RecordStateChange,
} from '../types.js'

/**
 * SQL for the record kernel. Everything here is deliberately dumb: no
 * authorization, no workflow reasoning, no events raised on its own. The
 * kernel service composes these inside one transaction so that a transition,
 * its state history, its ball-in-court handoff and its event either all land
 * or none of them do.
 */

function iso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : value
}

function isoRequired(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

interface RecordRow {
  id: string
  tenant_id: string
  project_id: string
  type_key: string
  type_version: number
  number: number
  designation: string
  title: string
  body: RecordBody
  status: string
  ball_in_court_user_id: string | null
  due_at: Date | null
  created_by: string
  updated_by: string
  version: number
  closed_at: Date | null
  created_at: Date
  updated_at: Date
}

const RECORD_COLUMNS = `id, tenant_id, project_id, type_key, type_version, number, designation, title, body,
                        status, ball_in_court_user_id, due_at, created_by, updated_by, version,
                        closed_at, created_at, updated_at`

function toRecord(row: RecordRow): ConstructionRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    typeKey: row.type_key,
    typeVersion: row.type_version,
    number: row.number,
    designation: row.designation,
    title: row.title,
    body: row.body,
    status: row.status,
    ballInCourtUserId: row.ball_in_court_user_id,
    dueAt: iso(row.due_at),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    version: row.version,
    closedAt: iso(row.closed_at),
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
  }
}

/**
 * Allocate the next number for this project and type.
 *
 * Gapless, because RFI-014 gets cited in correspondence and, eventually, in a
 * claim. A sequence would be faster and would skip numbers on rollback, so
 * this takes a row lock instead: one UPSERT, returning the number it just
 * consumed. Concurrent creates serialize on that row and nobody sees a hole.
 */
export async function allocateNumber(
  db: Db,
  input: { tenantId: string; projectId: string; typeKey: string },
): Promise<number> {
  const { rows } = await db.query<{ number: number }>(
    `INSERT INTO record_number_sequences (tenant_id, project_id, type_key, next_number)
          VALUES ($1, $2, $3, 2)
     ON CONFLICT (project_id, type_key)
       DO UPDATE SET next_number = record_number_sequences.next_number + 1
       RETURNING next_number - 1 AS number`,
    [input.tenantId, input.projectId, input.typeKey],
  )
  const row = rows[0]
  if (!row) throw new Error('number allocation returned no row')
  return row.number
}

export interface InsertRecordInput {
  tenantId: string
  projectId: string
  typeKey: string
  typeVersion: number
  number: number
  designation: string
  title: string
  body: RecordBody
  status: string
  ballInCourtUserId: string | null
  dueAt: Date | null
  actorUserId: string
}

export async function insertRecord(db: Db, input: InsertRecordInput): Promise<ConstructionRecord> {
  const { rows } = await db.query<RecordRow>(
    `INSERT INTO records (tenant_id, project_id, type_key, type_version, number, designation, title, body,
                          status, ball_in_court_user_id, due_at, created_by, updated_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $12)
       RETURNING ${RECORD_COLUMNS}`,
    [
      input.tenantId,
      input.projectId,
      input.typeKey,
      input.typeVersion,
      input.number,
      input.designation,
      input.title,
      JSON.stringify(input.body),
      input.status,
      input.ballInCourtUserId,
      input.dueAt,
      input.actorUserId,
    ],
  )
  const row = rows[0]
  if (!row) throw new Error('record insert returned no row')
  return toRecord(row)
}

export async function findRecord(db: Db, recordId: string): Promise<ConstructionRecord | null> {
  const { rows } = await db.query<RecordRow>(`SELECT ${RECORD_COLUMNS} FROM records WHERE id = $1`, [recordId])
  const row = rows[0]
  return row ? toRecord(row) : null
}

/** Locks the row for the duration of the surrounding transaction. */
export async function findRecordForUpdate(db: Db, recordId: string): Promise<ConstructionRecord | null> {
  const { rows } = await db.query<RecordRow>(`SELECT ${RECORD_COLUMNS} FROM records WHERE id = $1 FOR UPDATE`, [
    recordId,
  ])
  const row = rows[0]
  return row ? toRecord(row) : null
}

export interface UpdateRecordPatch {
  title?: string
  body?: RecordBody
  status?: string
  ballInCourtUserId?: string | null
  dueAt?: Date | null
  closedAt?: Date | null
}

/**
 * Apply a patch under optimistic concurrency. `expectedVersion` is the version
 * the caller read; if the row moved on, the write is refused rather than
 * silently clobbering whatever the other person wrote. Two PMs editing the
 * same RFI from two trailers is the normal case on a live job.
 */
export async function updateRecord(
  db: Db,
  input: { recordId: string; expectedVersion: number; actorUserId: string; patch: UpdateRecordPatch },
): Promise<ConstructionRecord> {
  const sets: string[] = ['version = records.version + 1', 'updated_at = now()', 'updated_by = $3']
  const params: unknown[] = [input.recordId, input.expectedVersion, input.actorUserId]

  const push = (fragment: string, value: unknown): void => {
    params.push(value)
    sets.push(`${fragment} = $${params.length}`)
  }

  const { patch } = input
  if (patch.title !== undefined) push('title', patch.title)
  if (patch.body !== undefined) {
    params.push(JSON.stringify(patch.body))
    sets.push(`body = $${params.length}::jsonb`)
  }
  if (patch.status !== undefined) push('status', patch.status)
  if (patch.ballInCourtUserId !== undefined) push('ball_in_court_user_id', patch.ballInCourtUserId)
  if (patch.dueAt !== undefined) push('due_at', patch.dueAt)
  if (patch.closedAt !== undefined) push('closed_at', patch.closedAt)

  const { rows } = await db.query<RecordRow>(
    `UPDATE records SET ${sets.join(', ')}
      WHERE id = $1 AND version = $2
      RETURNING ${RECORD_COLUMNS}`,
    params,
  )

  const row = rows[0]
  if (row) return toRecord(row)

  const current = await findRecord(db, input.recordId)
  if (!current) throw new Error(`record ${input.recordId} disappeared mid-update`)
  throw new VersionConflictError(input.expectedVersion, current.version)
}

export async function listParticipants(db: Db, recordId: string): Promise<RecordParticipant[]> {
  const { rows } = await db.query<{
    id: string
    record_id: string
    user_id: string
    role: ParticipantRole
    position: number
  }>(
    `SELECT id, record_id, user_id, role, position
       FROM record_participants
      WHERE record_id = $1
      ORDER BY role, position, user_id`,
    [recordId],
  )
  return rows.map((r) => ({ id: r.id, recordId: r.record_id, userId: r.user_id, role: r.role, position: r.position }))
}

export interface ParticipantInput {
  userId: string
  role: ParticipantRole
  position?: number
}

export async function addParticipants(
  db: Db,
  input: { tenantId: string; recordId: string; participants: ParticipantInput[] },
): Promise<void> {
  for (const participant of input.participants) {
    await db.query(
      `INSERT INTO record_participants (tenant_id, record_id, user_id, role, position)
            VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (record_id, user_id, role) DO UPDATE SET position = EXCLUDED.position`,
      [input.tenantId, input.recordId, participant.userId, participant.role, participant.position ?? 0],
    )
  }
}

export async function removeParticipant(
  db: Db,
  input: { recordId: string; userId: string; role: ParticipantRole },
): Promise<void> {
  await db.query('DELETE FROM record_participants WHERE record_id = $1 AND user_id = $2 AND role = $3', [
    input.recordId,
    input.userId,
    input.role,
  ])
}

interface AssignmentRow {
  id: string
  record_id: string
  holder_user_id: string
  expected_action: string
  due_at: Date | null
  assigned_by: string
  assigned_at: Date
  released_at: Date | null
  released_reason: string | null
}

function toAssignment(row: AssignmentRow): RecordAssignment {
  return {
    id: row.id,
    recordId: row.record_id,
    holderUserId: row.holder_user_id,
    expectedAction: row.expected_action,
    dueAt: iso(row.due_at),
    assignedBy: row.assigned_by,
    assignedAt: isoRequired(row.assigned_at),
    releasedAt: iso(row.released_at),
    releasedReason: row.released_reason,
  }
}

export async function findOpenAssignment(db: Db, recordId: string): Promise<RecordAssignment | null> {
  const { rows } = await db.query<AssignmentRow>(
    `SELECT id, record_id, holder_user_id, expected_action, due_at, assigned_by, assigned_at, released_at, released_reason
       FROM record_assignments
      WHERE record_id = $1 AND released_at IS NULL`,
    [recordId],
  )
  const row = rows[0]
  return row ? toAssignment(row) : null
}

export async function releaseOpenAssignment(db: Db, recordId: string, reason: string): Promise<void> {
  await db.query(
    `UPDATE record_assignments
        SET released_at = now(), released_reason = $2
      WHERE record_id = $1 AND released_at IS NULL`,
    [recordId, reason],
  )
}

export async function openAssignment(
  db: Db,
  input: {
    tenantId: string
    recordId: string
    holderUserId: string
    expectedAction: string
    dueAt: Date | null
    assignedBy: string
  },
): Promise<RecordAssignment> {
  const { rows } = await db.query<AssignmentRow>(
    `INSERT INTO record_assignments (tenant_id, record_id, holder_user_id, expected_action, due_at, assigned_by)
          VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, record_id, holder_user_id, expected_action, due_at, assigned_by, assigned_at, released_at, released_reason`,
    [input.tenantId, input.recordId, input.holderUserId, input.expectedAction, input.dueAt, input.assignedBy],
  )
  const row = rows[0]
  if (!row) throw new Error('assignment insert returned no row')
  return toAssignment(row)
}

export async function appendStateChange(
  db: Db,
  input: {
    tenantId: string
    recordId: string
    fromStatus: string | null
    toStatus: string
    transitionKey: string
    actorUserId: string
    note: string | null
  },
): Promise<void> {
  await db.query(
    `INSERT INTO record_state_history (tenant_id, record_id, from_status, to_status, transition_key, actor_user_id, note)
          VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.tenantId,
      input.recordId,
      input.fromStatus,
      input.toStatus,
      input.transitionKey,
      input.actorUserId,
      input.note,
    ],
  )
}

export async function listStateHistory(db: Db, recordId: string): Promise<RecordStateChange[]> {
  const { rows } = await db.query<{
    id: number
    record_id: string
    from_status: string | null
    to_status: string
    transition_key: string
    actor_user_id: string
    note: string | null
    occurred_at: Date
  }>(
    `SELECT id, record_id, from_status, to_status, transition_key, actor_user_id, note, occurred_at
       FROM record_state_history
      WHERE record_id = $1
      ORDER BY id`,
    [recordId],
  )
  return rows.map((r) => ({
    id: r.id,
    recordId: r.record_id,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    transitionKey: r.transition_key,
    actorUserId: r.actor_user_id,
    note: r.note,
    occurredAt: isoRequired(r.occurred_at),
  }))
}

export async function appendEvent(
  db: Db,
  input: {
    tenantId: string
    projectId: string
    recordId: string
    typeKey: string
    event: string
    payload: Record<string, unknown>
    actorUserId: string | null
  },
): Promise<void> {
  await db.query(
    `INSERT INTO record_events (tenant_id, project_id, record_id, type_key, event, payload, actor_user_id)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      input.tenantId,
      input.projectId,
      input.recordId,
      input.typeKey,
      input.event,
      JSON.stringify(input.payload),
      input.actorUserId,
    ],
  )
}

export async function addComment(
  db: Db,
  input: { tenantId: string; recordId: string; authorUserId: string; body: string },
): Promise<RecordComment> {
  const { rows } = await db.query<{
    id: string
    record_id: string
    author_user_id: string
    body: string
    created_at: Date
  }>(
    `INSERT INTO record_comments (tenant_id, record_id, author_user_id, body)
          VALUES ($1, $2, $3, $4)
       RETURNING id, record_id, author_user_id, body, created_at`,
    [input.tenantId, input.recordId, input.authorUserId, input.body],
  )
  const row = rows[0]
  if (!row) throw new Error('comment insert returned no row')
  return {
    id: row.id,
    recordId: row.record_id,
    authorUserId: row.author_user_id,
    body: row.body,
    createdAt: isoRequired(row.created_at),
  }
}

export async function listComments(db: Db, recordId: string): Promise<RecordComment[]> {
  const { rows } = await db.query<{
    id: string
    record_id: string
    author_user_id: string
    body: string
    created_at: Date
  }>(
    `SELECT id, record_id, author_user_id, body, created_at
       FROM record_comments
      WHERE record_id = $1
      ORDER BY created_at, id`,
    [recordId],
  )
  return rows.map((r) => ({
    id: r.id,
    recordId: r.record_id,
    authorUserId: r.author_user_id,
    body: r.body,
    createdAt: isoRequired(r.created_at),
  }))
}

export interface ListRecordsFilter {
  projectId: string
  typeKey?: string
  status?: string
  ballInCourtUserId?: string
  openOnly?: boolean
  limit?: number
  offset?: number
}

export async function listRecords(db: Db, filter: ListRecordsFilter): Promise<ConstructionRecord[]> {
  const conditions: string[] = ['project_id = $1']
  const params: unknown[] = [filter.projectId]

  const add = (fragment: string, value: unknown): void => {
    params.push(value)
    conditions.push(fragment.replace('?', `$${params.length}`))
  }

  if (filter.typeKey) add('type_key = ?', filter.typeKey)
  if (filter.status) add('status = ?', filter.status)
  if (filter.ballInCourtUserId) add('ball_in_court_user_id = ?', filter.ballInCourtUserId)
  if (filter.openOnly) conditions.push('closed_at IS NULL')

  params.push(Math.min(filter.limit ?? 50, 200))
  const limitParam = `$${params.length}`
  params.push(filter.offset ?? 0)
  const offsetParam = `$${params.length}`

  const { rows } = await db.query<RecordRow>(
    `SELECT ${RECORD_COLUMNS}
       FROM records
      WHERE ${conditions.join(' AND ')}
      ORDER BY type_key, number DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params,
  )
  return rows.map(toRecord)
}

/**
 * The ball-in-court view: every open handoff, who is holding it, and how long
 * they have been holding it. Scoped to a project, a holder, or neither.
 *
 * This is the query the whole ball-in-court design exists for. In a status-
 * field product it is a nightly report; here it is a join.
 */
export async function ballInCourt(
  db: Db,
  filter: { projectId?: string; holderUserId?: string; overdueOnly?: boolean; limit?: number },
): Promise<BallInCourtEntry[]> {
  const conditions: string[] = ['a.released_at IS NULL', 'r.closed_at IS NULL']
  const params: unknown[] = []

  const add = (fragment: string, value: unknown): void => {
    params.push(value)
    conditions.push(fragment.replace('?', `$${params.length}`))
  }

  if (filter.projectId) add('r.project_id = ?', filter.projectId)
  if (filter.holderUserId) add('a.holder_user_id = ?', filter.holderUserId)
  if (filter.overdueOnly) conditions.push('a.due_at IS NOT NULL AND a.due_at < now()')

  params.push(Math.min(filter.limit ?? 100, 500))

  const { rows } = await db.query<{
    record_id: string
    project_id: string
    project_name: string
    type_key: string
    designation: string
    title: string
    status: string
    holder_user_id: string
    holder_name: string
    expected_action: string
    assigned_at: Date
    due_at: Date | null
    age_days: number
    overdue: boolean
  }>(
    `SELECT r.id AS record_id,
            r.project_id,
            p.name AS project_name,
            r.type_key,
            r.designation,
            r.title,
            r.status,
            a.holder_user_id,
            u.name AS holder_name,
            a.expected_action,
            a.assigned_at,
            a.due_at,
            FLOOR(EXTRACT(EPOCH FROM (now() - a.assigned_at)) / 86400)::int AS age_days,
            (a.due_at IS NOT NULL AND a.due_at < now()) AS overdue
       FROM record_assignments a
       JOIN records r ON r.id = a.record_id
       JOIN projects p ON p.id = r.project_id
       JOIN users u ON u.id = a.holder_user_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY (a.due_at IS NOT NULL AND a.due_at < now()) DESC, a.assigned_at ASC
      LIMIT $${params.length}`,
    params,
  )

  return rows.map((r) => ({
    recordId: r.record_id,
    projectId: r.project_id,
    projectName: r.project_name,
    typeKey: r.type_key,
    designation: r.designation,
    title: r.title,
    status: r.status,
    holderUserId: r.holder_user_id,
    holderName: r.holder_name,
    expectedAction: r.expected_action,
    assignedAt: isoRequired(r.assigned_at),
    dueAt: iso(r.due_at),
    ageDays: r.age_days,
    overdue: r.overdue,
  }))
}
