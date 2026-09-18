import { withTenant, type Db } from './db.js'
import { NotFoundError, PermissionDeniedError, ValidationError } from './errors.js'
import {
  assertLevel,
  assertTransitionAllowed,
  hasLevel,
  hasPrivilege,
  type AccessSnapshot,
} from './permissions.js'
import { normalizeBody, type RecordBody, type RecordType, type TransitionSpec } from './record-type.js'
import { loadAccess } from './repositories/permissions.js'
import { getRecordType } from './repositories/record-types.js'
import * as repo from './repositories/records.js'
import type {
  BallInCourtEntry,
  ConstructionRecord,
  ParticipantRole,
  RecordAssignment,
  RecordComment,
  RecordParticipant,
  RecordStateChange,
} from './types.js'
import { availableTransitions, findTransition, planCreation, planTransition } from './workflow.js'

/**
 * The record kernel.
 *
 * Every tool in the product is this class with a different type key. An RFI
 * and a punch item take the same code path; they differ only in the definition
 * loaded from the database. That is the bet: one kernel, config-driven tools,
 * and therefore one interface for agents to work the entire business through.
 *
 * Invariants this class is responsible for, and the reason everything runs in
 * one transaction:
 *
 *   * A record's status, its ball-in-court assignment, its state history and
 *     its event all move together or not at all.
 *   * Exactly one open assignment exists per record (the database enforces it
 *     too, with a partial unique index).
 *   * No write happens without an authorization decision taken from a freshly
 *     loaded access snapshot.
 */

export interface Actor {
  tenantId: string
  userId: string
}

export interface RecordView {
  record: ConstructionRecord
  type: { key: string; displayName: string; toolKey: string }
  statusLabel: string
  participants: RecordParticipant[]
  assignment: RecordAssignment | null
  /** Only the transitions THIS actor may run right now. Drives the button bar. */
  availableTransitions: { key: string; label: string }[]
}

export interface CreateRecordInput {
  projectId: string
  typeKey: string
  title: string
  body?: Record<string, unknown>
  participants?: { userId: string; role: ParticipantRole; position?: number }[]
}

export interface TransitionInput {
  transitionKey: string
  /** Fields supplied alongside the move, e.g. the answer on an RFI. */
  body?: Record<string, unknown>
  note?: string
  /** The version the caller read. Omit to skip the concurrency check. */
  expectedVersion?: number
}

export class RecordKernel {
  constructor(private readonly db: Db) {}

  async create(actor: Actor, input: CreateRecordInput): Promise<RecordView> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const type = await getRecordType(tx, input.typeKey)
      await assertProjectExists(tx, input.projectId)
      const access = await loadAccess(tx, {
        userId: actor.userId,
        tenantId: actor.tenantId,
        projectId: input.projectId,
      })
      assertCanCreate(access, type)

      const title = input.title?.trim()
      if (!title) throw new ValidationError('A title is required', [{ field: 'title', message: 'Title is required' }])

      const body = normalizeBody(type.definition.fields, input.body ?? {})

      // The creator is always a participant. Without that the workflow has
      // nobody to hand a returned record back to.
      const participants = dedupeParticipants([
        { userId: actor.userId, role: 'creator' as ParticipantRole, position: 0 },
        ...(input.participants ?? []),
      ])
      await assertParticipantsAreOnProject(tx, input.projectId, participants)

      const plan = planCreation(type.definition, participants)
      const number = await repo.allocateNumber(tx, {
        tenantId: actor.tenantId,
        projectId: input.projectId,
        typeKey: type.key,
      })

      const record = await repo.insertRecord(tx, {
        tenantId: actor.tenantId,
        projectId: input.projectId,
        typeKey: type.key,
        typeVersion: type.version,
        number,
        designation: `${type.numberPrefix}-${String(number).padStart(3, '0')}`,
        title,
        body,
        status: plan.status,
        ballInCourtUserId: plan.ballInCourtUserId,
        dueAt: null,
        actorUserId: actor.userId,
      })

      await repo.addParticipants(tx, {
        tenantId: actor.tenantId,
        recordId: record.id,
        participants,
      })

      if (plan.ballInCourtUserId) {
        await repo.openAssignment(tx, {
          tenantId: actor.tenantId,
          recordId: record.id,
          holderUserId: plan.ballInCourtUserId,
          expectedAction: `Complete and submit this ${type.displayName}`,
          dueAt: null,
          assignedBy: actor.userId,
        })
      }

      await repo.appendStateChange(tx, {
        tenantId: actor.tenantId,
        recordId: record.id,
        fromStatus: null,
        toStatus: record.status,
        transitionKey: 'create',
        actorUserId: actor.userId,
        note: null,
      })

      await repo.appendEvent(tx, {
        tenantId: actor.tenantId,
        projectId: record.projectId,
        recordId: record.id,
        typeKey: type.key,
        event: 'record.created',
        payload: { designation: record.designation, status: record.status, title: record.title },
        actorUserId: actor.userId,
      })

      await appendAudit(tx, actor, 'record.create', 'record', record.id, { designation: record.designation })

      return this.view(tx, access, type, record)
    })
  }

  async get(actor: Actor, recordId: string): Promise<RecordView> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const record = await repo.findRecord(tx, recordId)
      if (!record) throw new NotFoundError('record', recordId)
      const type = await getRecordType(tx, record.typeKey)
      const access = await loadAccess(tx, {
        userId: actor.userId,
        tenantId: actor.tenantId,
        projectId: record.projectId,
      })
      assertLevel(access, type.toolKey, 'read_only')
      return this.view(tx, access, type, record)
    })
  }

  async list(actor: Actor, filter: repo.ListRecordsFilter): Promise<ConstructionRecord[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await assertProjectExists(tx, filter.projectId)
      const access = await loadAccess(tx, {
        userId: actor.userId,
        tenantId: actor.tenantId,
        projectId: filter.projectId,
      })

      if (filter.typeKey) {
        const type = await getRecordType(tx, filter.typeKey)
        assertLevel(access, type.toolKey, 'read_only')
        return repo.listRecords(tx, filter)
      }

      // No type filter: return only the types this actor may read, rather
      // than refusing the whole request or leaking the ones they may not.
      const records = await repo.listRecords(tx, filter)
      const readable = new Map<string, boolean>()
      const out: ConstructionRecord[] = []
      for (const record of records) {
        let allowed = readable.get(record.typeKey)
        if (allowed === undefined) {
          const type = await getRecordType(tx, record.typeKey)
          allowed = hasLevel(access, type.toolKey, 'read_only')
          readable.set(record.typeKey, allowed)
        }
        if (allowed) out.push(record)
      }
      return out
    })
  }

  async update(
    actor: Actor,
    recordId: string,
    input: { title?: string; body?: Record<string, unknown>; expectedVersion?: number },
  ): Promise<RecordView> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const record = await repo.findRecordForUpdate(tx, recordId)
      if (!record) throw new NotFoundError('record', recordId)
      if (record.closedAt) throw new ValidationError('This record is closed and cannot be edited')

      const type = await getRecordType(tx, record.typeKey)
      const access = await loadAccess(tx, {
        userId: actor.userId,
        tenantId: actor.tenantId,
        projectId: record.projectId,
      })
      assertLevel(access, type.toolKey, 'standard')

      const patch: repo.UpdateRecordPatch = {}
      if (input.title !== undefined) {
        const title = input.title.trim()
        if (!title) throw new ValidationError('A title is required', [{ field: 'title', message: 'Title is required' }])
        patch.title = title
      }
      if (input.body !== undefined) {
        patch.body = { ...record.body, ...normalizeBody(type.definition.fields, input.body, { partial: true }) }
      }

      const updated = await repo.updateRecord(tx, {
        recordId,
        expectedVersion: input.expectedVersion ?? record.version,
        actorUserId: actor.userId,
        patch,
      })

      await repo.appendEvent(tx, {
        tenantId: actor.tenantId,
        projectId: record.projectId,
        recordId,
        typeKey: type.key,
        event: 'record.updated',
        payload: { fields: Object.keys(input.body ?? {}), titleChanged: input.title !== undefined },
        actorUserId: actor.userId,
      })

      return this.view(tx, access, type, updated)
    })
  }

  /**
   * Move a record through its workflow.
   *
   * Authorization is decided BEFORE the record's data requirements are
   * checked: someone who may not answer an RFI should be told that, not handed
   * a list of the fields they would need to fill in if they could.
   */
  async transition(actor: Actor, recordId: string, input: TransitionInput): Promise<RecordView> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const record = await repo.findRecordForUpdate(tx, recordId)
      if (!record) throw new NotFoundError('record', recordId)

      const type = await getRecordType(tx, record.typeKey)
      const access = await loadAccess(tx, {
        userId: actor.userId,
        tenantId: actor.tenantId,
        projectId: record.projectId,
      })

      const participants = await repo.listParticipants(tx, recordId)
      const actorRoles = rolesOf(participants, actor.userId)
      const transition = findTransition(type.definition, input.transitionKey)
      assertTransitionAllowed(access, type.toolKey, transition, actorRoles)

      const body = input.body
        ? { ...record.body, ...normalizeBody(type.definition.fields, input.body, { partial: true }) }
        : record.body

      const plan = planTransition({
        definition: type.definition,
        transitionKey: input.transitionKey,
        currentStatus: record.status,
        body,
        participants,
      })

      const patch: repo.UpdateRecordPatch = {
        status: plan.toStatus,
        ballInCourtUserId: plan.ballInCourtUserId,
        dueAt: plan.dueAt,
        closedAt: plan.terminal ? new Date() : null,
      }
      if (input.body) patch.body = body

      const updated = await repo.updateRecord(tx, {
        recordId,
        expectedVersion: input.expectedVersion ?? record.version,
        actorUserId: actor.userId,
        patch,
      })

      // The handoff. Releasing first keeps the one-open-assignment invariant
      // true at every point, not just at the end of the transaction.
      await repo.releaseOpenAssignment(tx, recordId, plan.transition.key)
      if (plan.ballInCourtUserId && plan.expectedAction) {
        await repo.openAssignment(tx, {
          tenantId: actor.tenantId,
          recordId,
          holderUserId: plan.ballInCourtUserId,
          expectedAction: plan.expectedAction,
          dueAt: plan.dueAt,
          assignedBy: actor.userId,
        })
      }

      await repo.appendStateChange(tx, {
        tenantId: actor.tenantId,
        recordId,
        fromStatus: plan.fromStatus,
        toStatus: plan.toStatus,
        transitionKey: plan.transition.key,
        actorUserId: actor.userId,
        note: input.note ?? null,
      })

      await repo.appendEvent(tx, {
        tenantId: actor.tenantId,
        projectId: record.projectId,
        recordId,
        typeKey: type.key,
        event: 'record.transitioned',
        payload: {
          transition: plan.transition.key,
          from: plan.fromStatus,
          to: plan.toStatus,
          ballInCourt: plan.ballInCourtUserId,
          designation: record.designation,
        },
        actorUserId: actor.userId,
      })

      await appendAudit(tx, actor, `record.${plan.transition.key}`, 'record', recordId, {
        from: plan.fromStatus,
        to: plan.toStatus,
      })

      return this.view(tx, access, type, updated)
    })
  }

  async comment(actor: Actor, recordId: string, body: string): Promise<RecordComment> {
    const text = body?.trim()
    if (!text) throw new ValidationError('A comment cannot be empty', [{ field: 'body', message: 'Comment is empty' }])

    return withTenant(this.db, actor.tenantId, async (tx) => {
      const record = await repo.findRecord(tx, recordId)
      if (!record) throw new NotFoundError('record', recordId)
      const type = await getRecordType(tx, record.typeKey)
      const access = await loadAccess(tx, {
        userId: actor.userId,
        tenantId: actor.tenantId,
        projectId: record.projectId,
      })
      assertLevel(access, type.toolKey, 'read_only')

      const comment = await repo.addComment(tx, {
        tenantId: actor.tenantId,
        recordId,
        authorUserId: actor.userId,
        body: text,
      })

      await repo.appendEvent(tx, {
        tenantId: actor.tenantId,
        projectId: record.projectId,
        recordId,
        typeKey: record.typeKey,
        event: 'record.commented',
        payload: { commentId: comment.id },
        actorUserId: actor.userId,
      })

      return comment
    })
  }

  async history(actor: Actor, recordId: string): Promise<{ states: RecordStateChange[]; comments: RecordComment[] }> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const record = await repo.findRecord(tx, recordId)
      if (!record) throw new NotFoundError('record', recordId)
      const type = await getRecordType(tx, record.typeKey)
      const access = await loadAccess(tx, {
        userId: actor.userId,
        tenantId: actor.tenantId,
        projectId: record.projectId,
      })
      assertLevel(access, type.toolKey, 'read_only')
      const [states, comments] = await Promise.all([
        repo.listStateHistory(tx, recordId),
        repo.listComments(tx, recordId),
      ])
      return { states, comments }
    })
  }

  /**
   * Who owes what, across a project or across a person's whole workload.
   *
   * Asking about yourself needs no permission beyond being signed in. Asking
   * about a project needs read access to it; asking about somebody else
   * without naming a project is a company-level view and needs the directory.
   */
  async ballInCourt(
    actor: Actor,
    filter: { projectId?: string; holderUserId?: string; overdueOnly?: boolean; limit?: number } = {},
  ): Promise<BallInCourtEntry[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const askingAboutSelf = !filter.holderUserId || filter.holderUserId === actor.userId
      const access = await loadAccess(tx, {
        userId: actor.userId,
        tenantId: actor.tenantId,
        projectId: filter.projectId ?? null,
      })

      if (filter.projectId) {
        await assertProjectExists(tx, filter.projectId)
        if (!access.isProjectMember && !access.isCompanyAdmin) {
          throw new PermissionDeniedError('You are not on this project')
        }
      } else if (!askingAboutSelf) {
        assertLevel(access, 'directory', 'read_only')
      }

      const entries = await repo.ballInCourt(tx, {
        ...filter,
        holderUserId: filter.holderUserId ?? (filter.projectId ? undefined : actor.userId),
      })

      if (access.isCompanyAdmin) return entries

      // Filter to the types this actor may actually read. Without this the
      // ball-in-court view becomes a side channel onto tools someone has no
      // access to.
      const allowed = new Map<string, boolean>()
      const visible: BallInCourtEntry[] = []
      for (const entry of entries) {
        let ok = allowed.get(`${entry.projectId}:${entry.typeKey}`)
        if (ok === undefined) {
          const type = await getRecordType(tx, entry.typeKey)
          const scoped = filter.projectId
            ? access
            : await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId: entry.projectId })
          ok = hasLevel(scoped, type.toolKey, 'read_only')
          allowed.set(`${entry.projectId}:${entry.typeKey}`, ok)
        }
        if (ok) visible.push(entry)
      }
      return visible
    })
  }

  private async view(
    tx: Db,
    access: AccessSnapshot,
    type: RecordType,
    record: ConstructionRecord,
  ): Promise<RecordView> {
    const [participants, assignment] = await Promise.all([
      repo.listParticipants(tx, record.id),
      repo.findOpenAssignment(tx, record.id),
    ])
    const actorRoles = rolesOf(participants, access.userId)
    const state = type.definition.workflow.states.find((s) => s.key === record.status)

    return {
      record,
      type: { key: type.key, displayName: type.displayName, toolKey: type.toolKey },
      statusLabel: state?.label ?? record.status,
      participants,
      assignment,
      availableTransitions: availableTransitions(type.definition, record.status)
        .filter((t) => permits(access, type.toolKey, t, actorRoles))
        .map((t) => ({ key: t.key, label: t.label })),
    }
  }
}

function permits(
  access: AccessSnapshot,
  toolKey: string,
  transition: TransitionSpec,
  actorRoles: ReadonlySet<ParticipantRole>,
): boolean {
  try {
    assertTransitionAllowed(access, toolKey, transition, actorRoles)
    return true
  } catch {
    return false
  }
}

function rolesOf(participants: RecordParticipant[], userId: string): ReadonlySet<ParticipantRole> {
  return new Set(participants.filter((p) => p.userId === userId).map((p) => p.role))
}

function dedupeParticipants(
  entries: { userId: string; role: ParticipantRole; position?: number }[],
): { userId: string; role: ParticipantRole; position: number }[] {
  const seen = new Map<string, { userId: string; role: ParticipantRole; position: number }>()
  for (const entry of entries) {
    seen.set(`${entry.userId}:${entry.role}`, {
      userId: entry.userId,
      role: entry.role,
      position: entry.position ?? 0,
    })
  }
  return [...seen.values()]
}

/**
 * Creation rule: `standard` on the tool creates, and a `read_only` user who
 * has been granted the tool's `create` privilege creates too. That second half
 * is the whole point of granular privileges — the superintendent who may read
 * everything and raise observations, but change nothing else.
 */
function assertCanCreate(access: AccessSnapshot, type: RecordType): void {
  if (hasLevel(access, type.toolKey, 'standard')) return
  if (hasLevel(access, type.toolKey, 'read_only') && hasPrivilege(access, type.toolKey, 'create')) return
  throw new PermissionDeniedError(`You cannot create ${type.displayName} records`, { tool: type.toolKey })
}

async function assertProjectExists(tx: Db, projectId: string): Promise<void> {
  const { rows } = await tx.query('SELECT 1 FROM projects WHERE id = $1', [projectId])
  if (rows.length === 0) throw new NotFoundError('project', projectId)
}

/**
 * Everyone on a record must be on the project. Otherwise the ball can be
 * handed to somebody who cannot open the record they have been handed.
 */
async function assertParticipantsAreOnProject(
  tx: Db,
  projectId: string,
  participants: { userId: string }[],
): Promise<void> {
  const userIds = [...new Set(participants.map((p) => p.userId))]
  const { rows } = await tx.query<{ user_id: string }>(
    'SELECT user_id FROM project_memberships WHERE project_id = $1 AND user_id = ANY($2::uuid[])',
    [projectId, userIds],
  )
  const onProject = new Set(rows.map((r) => r.user_id))
  const strangers = userIds.filter((id) => !onProject.has(id))
  if (strangers.length > 0) {
    throw new ValidationError(
      'Everyone on a record must be on the project',
      strangers.map((id) => ({ field: 'participants', message: `User ${id} is not on this project` })),
    )
  }
}

async function appendAudit(
  tx: Db,
  actor: Actor,
  action: string,
  subjectType: string,
  subjectId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (tenant_id, actor_user_id, action, subject_type, subject_id, detail)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [actor.tenantId, actor.userId, action, subjectType, subjectId, JSON.stringify(detail)],
  )
}
