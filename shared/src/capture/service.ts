import { withTenant, type Db } from '../db.js'
import { KernelError, NotFoundError, PermissionDeniedError, ValidationError, type FieldIssue } from '../errors.js'
import { RecordKernel, type Actor, type RecordView } from '../kernel.js'
import { assertLevel, hasLevel, hasPrivilege, type AccessSnapshot } from '../permissions.js'
import { normalizeBody, type RecordBody, type RecordType } from '../record-type.js'
import { loadAccess } from '../repositories/permissions.js'
import { loadRecordTypes } from '../repositories/record-types.js'
import type { ParticipantRole } from '../types.js'
import {
  buildSystemPrompt,
  buildUserContent,
  parseProposal,
  PROPOSAL_SCHEMA,
  type InterpretationProvider,
  type RosterMember,
} from './interpreter.js'
import { estimateCostMicros } from './pricing.js'
import type { TranscriptionProvider } from './transcription.js'
import type { BlobStore } from '../storage/index.js'

/**
 * The capture pipeline: signal in, proposed record out, human at the gate.
 *
 * The whole design fits in one sentence, and the sentence is a constraint
 * rather than a feature: an agent may propose anything, and may create
 * nothing. Acceptance calls the ordinary `RecordKernel.create` AS THE
 * APPROVING HUMAN, so every permission, every required field and every
 * workflow rule applies exactly as it would if they had typed the record by
 * hand. There is no privileged path from a proposal to a record, and adding
 * one later would mean deleting this class rather than adding a flag to it.
 */

export const CAPTURE_TOOL = 'capture'

export interface Capture {
  id: string
  projectId: string
  capturedBy: string
  kind: 'photo' | 'voice' | 'document' | 'text' | 'email'
  storageKey: string | null
  contentType: string | null
  byteSize: number | null
  /** What a person typed. Never a machine's reading of anything. */
  text: string | null
  /**
   * A machine's best reading of the recording or the image.
   *
   * Kept apart from `text` because they are not the same kind of fact and
   * merging them loses the distinction exactly where it matters: what a
   * reviewer is asked to approve would look like something they wrote.
   * "No rebar" and "know rebar" sound identical.
   */
  transcript: string | null
  transcriptModel: string | null
  transcribedAt: string | null
  capturedAt: string
  latitude: number | null
  longitude: number | null
  status: 'received' | 'interpreting' | 'interpreted' | 'failed' | 'dismissed'
  failureReason: string | null
  createdAt: string
}

export interface Proposal {
  id: string
  captureId: string
  projectId: string
  typeKey: string
  title: string
  body: RecordBody
  participants: { userId: string; role: ParticipantRole }[]
  confidence: number | null
  rationale: string | null
  model: string | null
  issues: FieldIssue[]
  status: 'pending' | 'accepted' | 'rejected' | 'superseded'
  edited: boolean
  decidedBy: string | null
  decidedAt: string | null
  decisionNote: string | null
  recordId: string | null
  createdAt: string
}

export interface RecordCaptureInput {
  projectId: string
  kind: Capture['kind']
  text?: string
  storageKey?: string
  contentType?: string
  byteSize?: number
  capturedAt?: Date
  latitude?: number
  longitude?: number
  device?: Record<string, unknown>
}

export interface AcceptEdits {
  title?: string
  body?: Record<string, unknown>
  participants?: { userId: string; role: ParticipantRole }[]
}

interface CaptureRow {
  id: string
  project_id: string
  captured_by: string
  kind: Capture['kind']
  storage_key: string | null
  content_type: string | null
  byte_size: number | null
  text: string | null
  transcript: string | null
  transcript_model: string | null
  transcribed_at: Date | null
  captured_at: Date
  latitude: string | null
  longitude: string | null
  status: Capture['status']
  failure_reason: string | null
  created_at: Date
}

const CAPTURE_COLUMNS = `id, project_id, captured_by, kind, storage_key, content_type, byte_size, text,
                         transcript, transcript_model, transcribed_at,
                         captured_at, latitude, longitude, status, failure_reason, created_at`

/**
 * Everything there is to read, labelled.
 *
 * The transcript is marked as one rather than run together with the typed
 * note, because the interpreter should weigh them differently: a name typed
 * by the person who was there beats the same name as a microphone heard it,
 * and a model given one undifferentiated blob has no way to know which is
 * which.
 */
export function readableText(capture: Pick<Capture, 'text' | 'transcript'>): string {
  const typed = capture.text?.trim() ?? ''
  const heard = capture.transcript?.trim() ?? ''
  if (typed && heard) return `${typed}\n\n[Transcribed from the attached file]\n${heard}`
  if (heard) return `[Transcribed from the attached file]\n${heard}`
  return typed
}

function toCapture(row: CaptureRow): Capture {
  return {
    id: row.id,
    projectId: row.project_id,
    capturedBy: row.captured_by,
    kind: row.kind,
    storageKey: row.storage_key,
    contentType: row.content_type,
    byteSize: row.byte_size,
    text: row.text,
    transcript: row.transcript,
    transcriptModel: row.transcript_model,
    transcribedAt: row.transcribed_at === null ? null : row.transcribed_at.toISOString(),
    capturedAt: row.captured_at.toISOString(),
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    status: row.status,
    failureReason: row.failure_reason,
    createdAt: row.created_at.toISOString(),
  }
}

interface ProposalRow {
  id: string
  capture_id: string
  project_id: string
  type_key: string
  title: string
  body: RecordBody
  participants: { userId: string; role: ParticipantRole }[]
  confidence: string | null
  rationale: string | null
  model: string | null
  issues: FieldIssue[]
  status: Proposal['status']
  edited: boolean
  decided_by: string | null
  decided_at: Date | null
  decision_note: string | null
  record_id: string | null
  created_at: Date
}

const PROPOSAL_COLUMNS = `id, capture_id, project_id, type_key, title, body, participants, confidence,
                          rationale, model, issues, status, edited, decided_by, decided_at,
                          decision_note, record_id, created_at`

function toProposal(row: ProposalRow): Proposal {
  return {
    id: row.id,
    captureId: row.capture_id,
    projectId: row.project_id,
    typeKey: row.type_key,
    title: row.title,
    body: row.body,
    participants: row.participants,
    confidence: row.confidence === null ? null : Number(row.confidence),
    rationale: row.rationale,
    model: row.model,
    issues: row.issues,
    status: row.status,
    edited: row.edited,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decisionNote: row.decision_note,
    recordId: row.record_id,
    createdAt: row.created_at.toISOString(),
  }
}

export class CaptureService {
  constructor(
    private readonly db: Db,
    private readonly provider: InterpretationProvider,
    private readonly options: {
      maxTokens?: number
      /**
       * Bytes to words, in front of the interpreter. Optional, and a
       * deployment without one still serves every route: a voice memo or a
       * photograph sits in the inbox with a plain message rather than taking
       * the product down.
       *
       * A thunk because constructing an SDK client can throw in some
       * runtimes, and the alternative — building it per request — took every
       * route with it once already.
       */
      transcriber?: TranscriptionProvider | (() => TranscriptionProvider)
      blobs?: BlobStore | (() => BlobStore)
    } = {},
  ) {}

  private transcriber(): TranscriptionProvider | null {
    const configured = this.options.transcriber
    if (!configured) return null
    return typeof configured === 'function' ? configured() : configured
  }

  private blobs(): BlobStore | null {
    const configured = this.options.blobs
    if (!configured) return null
    return typeof configured === 'function' ? configured() : configured
  }

  /**
   * Reads the bytes and writes down what they say.
   *
   * Idempotent, because it costs money and because a second run would
   * overwrite a transcript somebody may already have read and corrected
   * against. Re-running is a deliberate act, not a side effect of opening
   * the inbox twice.
   */
  async transcribe(actor: Actor, captureId: string, options: { force?: boolean } = {}): Promise<Capture> {
    const prepared = await withTenant(this.db, actor.tenantId, async (tx) => {
      const capture = await this.loadCapture(tx, actor.tenantId, captureId)
      const access = await this.accessFor(tx, actor, capture.projectId)
      assertLevel(access, CAPTURE_TOOL, 'read_only')
      return capture
    })

    if (prepared.transcript && !options.force) return prepared

    if (!prepared.storageKey || !prepared.contentType) {
      throw new ValidationError('There is no file on this capture to read', [
        { field: 'storageKey', message: 'A transcript needs the original recording or image' },
      ])
    }

    const transcriber = this.transcriber()
    const blobs = this.blobs()
    if (!transcriber || !blobs) {
      throw new KernelError(
        'transcription_unavailable',
        'Nothing is configured here that can read a file',
        503,
      )
    }
    if (!transcriber.handles(prepared.contentType)) {
      // Named rather than swallowed. A capture that silently stays blank is a
      // capture nobody comes back to, and a voice memo from a foreman about a
      // delay is exactly the one worth coming back to.
      throw new KernelError(
        'transcription_unsupported',
        `Nothing configured here can read ${prepared.contentType}`,
        422,
        { contentType: prepared.contentType },
      )
    }

    const bytes = await blobs.get(prepared.storageKey)
    const result = await transcriber.transcribe({
      kind: prepared.kind,
      contentType: prepared.contentType,
      bytes,
      ...(prepared.text?.trim() ? { hint: prepared.text.trim() } : {}),
    })

    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<CaptureRow>(
        `UPDATE captures
            SET transcript = $3, transcript_model = $4, transcribed_at = now()
          WHERE tenant_id = $1 AND id = $2
        RETURNING ${CAPTURE_COLUMNS}`,
        [actor.tenantId, captureId, result.text, result.model],
      )
      const cost = estimateCostMicros(result.model, result.usage)
      await tx.query(
        `INSERT INTO ai_usage (tenant_id, purpose, model, input_tokens, output_tokens,
                               cache_read_tokens, cache_write_tokens, cost_micros, capture_id)
              VALUES ($1, 'capture.transcribe', $2, $3, $4, $5, $6, $7, $8)`,
        [
          actor.tenantId,
          result.model,
          result.usage.inputTokens,
          result.usage.outputTokens,
          result.usage.cacheReadTokens,
          result.usage.cacheWriteTokens,
          cost.costMicros,
          captureId,
        ],
      )
      const row = rows[0]
      if (!row) throw new NotFoundError('capture', captureId)
      return toCapture(row)
    })
  }

  /**
   * Take a capture from the field.
   *
   * This must be the cheapest call in the system and it must almost never
   * fail, because the alternative for the person holding the phone is not
   * "try again later", it is "stop recording things". The only validation is
   * that there is something to interpret.
   */
  async record(actor: Actor, input: RecordCaptureInput): Promise<Capture> {
    if (!input.text?.trim() && !input.storageKey) {
      throw new ValidationError('A capture needs either text or a stored file', [
        { field: 'text', message: 'Nothing was captured' },
      ])
    }

    return withTenant(this.db, actor.tenantId, async (tx) => {
      const access = await this.accessFor(tx, actor, input.projectId)
      assertCanCapture(access)

      const { rows } = await tx.query<CaptureRow>(
        `INSERT INTO captures (tenant_id, project_id, captured_by, kind, storage_key, content_type,
                               byte_size, text, captured_at, latitude, longitude, device)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, now()), $10, $11, $12::jsonb)
           RETURNING ${CAPTURE_COLUMNS}`,
        [
          actor.tenantId,
          input.projectId,
          actor.userId,
          input.kind,
          input.storageKey ?? null,
          input.contentType ?? null,
          input.byteSize ?? null,
          input.text?.trim() ?? null,
          input.capturedAt ?? null,
          input.latitude ?? null,
          input.longitude ?? null,
          JSON.stringify(input.device ?? {}),
        ],
      )
      const row = rows[0]
      if (!row) throw new Error('capture insert returned no row')
      return toCapture(row)
    })
  }

  /**
   * Transcribes when there is something to transcribe and nothing yet read.
   *
   * Swallows its own failures on purpose. This runs on the way into
   * interpretation, and a deployment with no reader configured, or a capture
   * whose media nothing can read, must still be able to interpret whatever
   * text the person typed. The refusal that matters — "there is nothing here
   * to read at all" — is raised by `interpret` itself a moment later, once it
   * knows there is genuinely nothing.
   */
  private async transcribeIfNeeded(actor: Actor, captureId: string): Promise<void> {
    if (!this.options.transcriber || !this.options.blobs) return
    try {
      const capture = await withTenant(this.db, actor.tenantId, (tx) => this.loadCapture(tx, actor.tenantId, captureId))
      if (readableText(capture) || !capture.storageKey) return
      await this.transcribe(actor, captureId)
    } catch (err) {
      // A permission refusal is not this method's to swallow: it means the
      // caller had no business here, and interpret will refuse for the same
      // reason on its own.
      if (err instanceof PermissionDeniedError) throw err
    }
  }

  /**
   * Read a capture and draft the record it should become.
   *
   * Every piece of grounding handed to the model — the type registry, the
   * project roster, the capture itself — is read inside this tenant context,
   * under the same row-level security a human gets. The model cannot be
   * grounded in data the people involved could not see, and that is a property
   * of the transaction rather than an instruction in the prompt.
   */
  async interpret(actor: Actor, captureId: string): Promise<Proposal> {
    // Reading the file first, rather than telling somebody to press another
    // button. A voice memo and a photograph of a field ticket are the two
    // things a phone on a jobsite is good at producing, and until this ran
    // both of them reached the inbox and stopped there.
    await this.transcribeIfNeeded(actor, captureId)

    const prepared = await withTenant(this.db, actor.tenantId, async (tx) => {
      const capture = await this.loadCapture(tx, actor.tenantId, captureId)
      const access = await this.accessFor(tx, actor, capture.projectId)
      assertLevel(access, CAPTURE_TOOL, 'read_only')

      if (!readableText(capture)) {
        throw new ValidationError('This capture has nothing to read yet', [
          {
            field: 'text',
            message: capture.storageKey
              ? 'Nothing configured here could read the file on it'
              : 'Nothing was captured',
          },
        ])
      }

      const types = await loadRecordTypes(tx)
      const roster = await this.loadRoster(tx, actor.tenantId, capture.projectId)
      const { rows } = await tx.query<{ name: string }>(
        'SELECT name FROM projects WHERE tenant_id = $1 AND id = $2',
        [actor.tenantId, capture.projectId],
      )
      const projectName = rows[0]?.name ?? 'this project'

      const capturedBy = roster.find((m) => m.userId === capture.capturedBy)

      await tx.query(`UPDATE captures SET status = 'interpreting' WHERE tenant_id = $1 AND id = $2`, [
        actor.tenantId,
        captureId,
      ])

      return { capture, types, roster, projectName, capturedByName: capturedBy?.name }
    })

    // The model call happens OUTSIDE the transaction. A database transaction
    // held open across a multi-second network round trip is how connection
    // pools die under load, and nothing here needs the lock.
    let parsed
    let model: string
    try {
      const response = await this.provider.interpret({
        system: buildSystemPrompt([...prepared.types.values()], prepared.roster, prepared.projectName),
        userContent: buildUserContent({
          kind: prepared.capture.kind,
          // Both, when there are both. A voice memo with a typed note is
          // both, and the note is usually where the names and the submittal
          // numbers the transcript mangled are spelled correctly.
          text: readableText(prepared.capture),
          capturedAt: prepared.capture.capturedAt,
          latitude: prepared.capture.latitude,
          longitude: prepared.capture.longitude,
          ...(prepared.capturedByName ? { capturedByName: prepared.capturedByName } : {}),
        }),
        schema: PROPOSAL_SCHEMA,
        maxTokens: this.options.maxTokens ?? 4096,
      })

      model = response.model
      parsed = parseProposal(response.output, { types: prepared.types, roster: prepared.roster })

      const cost = estimateCostMicros(response.model, response.usage)
      await withTenant(this.db, actor.tenantId, (tx) =>
        tx.query(
          `INSERT INTO ai_usage (tenant_id, purpose, model, input_tokens, output_tokens,
                                 cache_read_tokens, cache_write_tokens, cost_micros, capture_id)
                VALUES ($1, 'capture.interpret', $2, $3, $4, $5, $6, $7, $8)`,
          [
            actor.tenantId,
            response.model,
            response.usage.inputTokens,
            response.usage.outputTokens,
            response.usage.cacheReadTokens,
            response.usage.cacheWriteTokens,
            cost.costMicros,
            captureId,
          ],
        ),
      )
      if (!cost.priced) {
        console.warn(`[capture] no rate table entry for ${response.model}; usage recorded with zero cost`)
      }
    } catch (err) {
      // A failed interpretation must never lose the capture. The signal is the
      // valuable part; the draft can be retried.
      await withTenant(this.db, actor.tenantId, (tx) =>
        tx.query(
          `UPDATE captures SET status = 'failed', failure_reason = $3
            WHERE tenant_id = $1 AND id = $2`,
          [
            actor.tenantId,
            captureId,
            err instanceof Error ? err.message.slice(0, 500) : 'interpretation failed',
          ],
        ),
      )
      throw err
    }

    return withTenant(this.db, actor.tenantId, async (tx) => {
      // Re-interpreting supersedes the previous draft rather than racing it,
      // which is also what the partial unique index enforces.
      await tx.query(
        `UPDATE capture_proposals SET status = 'superseded', decided_at = now()
          WHERE tenant_id = $1 AND capture_id = $2 AND status = 'pending'`,
        [actor.tenantId, captureId],
      )

      const { rows } = await tx.query<ProposalRow>(
        `INSERT INTO capture_proposals (tenant_id, capture_id, project_id, type_key, title, body,
                                        participants, confidence, rationale, model, issues)
              VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11::jsonb)
           RETURNING ${PROPOSAL_COLUMNS}`,
        [
          actor.tenantId,
          captureId,
          prepared.capture.projectId,
          parsed.typeKey,
          parsed.title,
          JSON.stringify(parsed.body),
          JSON.stringify(parsed.participants),
          parsed.confidence,
          parsed.rationale,
          model,
          JSON.stringify(parsed.issues),
        ],
      )
      await tx.query(
        `UPDATE captures SET status = 'interpreted', failure_reason = NULL WHERE tenant_id = $1 AND id = $2`,
        [actor.tenantId, captureId],
      )

      const row = rows[0]
      if (!row) throw new Error('proposal insert returned no row')
      return toProposal(row)
    })
  }

  /**
   * The approval inbox: what the field sent, what the agent made of it, and
   * what it is still missing. Filtered to the record types this person may
   * actually read, so the inbox never becomes a side channel onto a tool they
   * have no access to.
   */
  async inbox(
    actor: Actor,
    filter: { projectId: string; status?: Proposal['status']; limit?: number },
  ): Promise<Proposal[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const access = await this.accessFor(tx, actor, filter.projectId)
      assertLevel(access, CAPTURE_TOOL, 'read_only')

      const { rows } = await tx.query<ProposalRow>(
        `SELECT ${PROPOSAL_COLUMNS}
           FROM capture_proposals
          WHERE tenant_id = $1 AND project_id = $2 AND status = $3
          ORDER BY created_at DESC
          LIMIT $4`,
        [actor.tenantId, filter.projectId, filter.status ?? 'pending', Math.min(filter.limit ?? 50, 200)],
      )

      const types = await loadRecordTypes(tx)
      return rows
        .map(toProposal)
        .filter((proposal) => {
          const type = types.get(proposal.typeKey)
          return type ? hasLevel(access, type.toolKey, 'read_only') : false
        })
    })
  }

  async getCapture(actor: Actor, captureId: string): Promise<Capture> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const capture = await this.loadCapture(tx, actor.tenantId, captureId)
      const access = await this.accessFor(tx, actor, capture.projectId)
      assertLevel(access, CAPTURE_TOOL, 'read_only')
      return capture
    })
  }

  /**
   * The gate.
   *
   * Accepting is creating, by the person accepting. Note what is NOT here: no
   * elevated actor, no service identity, no "the agent already checked it"
   * shortcut. If the approver may not create this record type, or the draft is
   * missing a required field, this fails exactly as hand entry would — which
   * is the point, because a gate that can be satisfied by the thing it is
   * gating is not a gate.
   */
  async accept(actor: Actor, proposalId: string, edits: AcceptEdits = {}): Promise<{ proposal: Proposal; record: RecordView }> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const proposal = await this.loadProposalForUpdate(tx, actor.tenantId, proposalId)
      if (proposal.status !== 'pending') {
        throw new KernelError('proposal_decided', `This proposal was already ${proposal.status}`, 409, {
          status: proposal.status,
        })
      }

      const access = await this.accessFor(tx, actor, proposal.projectId)
      assertLevel(access, CAPTURE_TOOL, 'read_only')

      const types = await loadRecordTypes(tx)
      const type = types.get(proposal.typeKey)
      if (!type) throw new NotFoundError('record type', proposal.typeKey)

      const title = edits.title?.trim() ?? proposal.title
      const body = edits.body
        ? { ...proposal.body, ...normalizeBody(type.definition.fields, edits.body, { partial: true }) }
        : proposal.body
      const participants = edits.participants ?? proposal.participants
      const edited = wasEdited(proposal, { title, body, participants })

      // The ordinary path. Same permissions, same validation, same events as a
      // record typed by hand — bound to this transaction so the record and the
      // decision land together or not at all.
      const record = await new RecordKernel(tx).create(actor, {
        projectId: proposal.projectId,
        typeKey: proposal.typeKey,
        title,
        body,
        participants,
      })

      await tx.query(
        `UPDATE capture_proposals
            SET status = 'accepted', edited = $3, decided_by = $4, decided_at = now(), record_id = $5,
                title = $6, body = $7::jsonb, participants = $8::jsonb
          WHERE tenant_id = $1 AND id = $2`,
        [
          actor.tenantId,
          proposalId,
          edited,
          actor.userId,
          record.record.id,
          title,
          JSON.stringify(body),
          JSON.stringify(participants),
        ],
      )

      // Provenance, on the record itself: this came from signal, an agent read
      // it, a named human accepted it. A year from now, in a claim, that chain
      // is the answer to "who decided this".
      const capture = await this.loadCapture(tx, actor.tenantId, proposal.captureId)
      await tx.query(
        `INSERT INTO record_events (tenant_id, project_id, record_id, type_key, event, payload, actor_user_id)
              VALUES ($1, $2, $3, $4, 'record.accepted_from_capture', $5::jsonb, $6)`,
        [
          actor.tenantId,
          proposal.projectId,
          record.record.id,
          proposal.typeKey,
          JSON.stringify({
            captureId: proposal.captureId,
            captureKind: capture.kind,
            proposalId,
            model: proposal.model,
            confidence: proposal.confidence,
            edited,
          }),
          actor.userId,
        ],
      )

      // The original signal rides along with the record it became.
      if (capture.storageKey) {
        await tx.query(
          `INSERT INTO record_attachments (tenant_id, record_id, filename, content_type, byte_size, storage_key, uploaded_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            actor.tenantId,
            record.record.id,
            `capture-${capture.kind}-${capture.id.slice(0, 8)}`,
            capture.contentType ?? 'application/octet-stream',
            capture.byteSize ?? 0,
            capture.storageKey,
            capture.capturedBy,
          ],
        )
      }

      const updated = await this.loadProposal(tx, actor.tenantId, proposalId)
      return { proposal: updated, record }
    })
  }

  async reject(actor: Actor, proposalId: string, note?: string): Promise<Proposal> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const proposal = await this.loadProposalForUpdate(tx, actor.tenantId, proposalId)
      if (proposal.status !== 'pending') {
        throw new KernelError('proposal_decided', `This proposal was already ${proposal.status}`, 409, {
          status: proposal.status,
        })
      }

      const access = await this.accessFor(tx, actor, proposal.projectId)
      assertLevel(access, CAPTURE_TOOL, 'read_only')
      if (!hasLevel(access, CAPTURE_TOOL, 'standard') && !hasPrivilege(access, CAPTURE_TOOL, 'review')) {
        throw new PermissionDeniedError('You cannot decide proposals on this project', { tool: CAPTURE_TOOL })
      }

      await tx.query(
        `UPDATE capture_proposals
            SET status = 'rejected', decided_by = $3, decided_at = now(), decision_note = $4
          WHERE tenant_id = $1 AND id = $2`,
        [actor.tenantId, proposalId, actor.userId, note ?? null],
      )
      // The capture is dismissed with its draft: the signal stays, and it can
      // be re-interpreted later when the type registry or the prompt improves.
      await tx.query(`UPDATE captures SET status = 'dismissed' WHERE tenant_id = $1 AND id = $2`, [
        actor.tenantId,
        proposal.captureId,
      ])

      return this.loadProposal(tx, actor.tenantId, proposalId)
    })
  }

  /**
   * What the pipeline cost this tenant, and how well it is working.
   *
   * `acceptedUnedited` over `accepted` is the number that matters: an agent
   * whose drafts always need fixing is costing the field time, not saving it.
   */
  async stats(
    actor: Actor,
    filter: { projectId?: string } = {},
  ): Promise<{
    captures: number
    proposals: number
    accepted: number
    acceptedUnedited: number
    rejected: number
    costMicros: number
  }> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      if (filter.projectId) {
        const access = await this.accessFor(tx, actor, filter.projectId)
        assertLevel(access, CAPTURE_TOOL, 'read_only')
      } else {
        const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId: null })
        assertLevel(access, 'directory', 'read_only')
      }

      const { rows } = await tx.query<{
        captures: number
        proposals: number
        accepted: number
        accepted_unedited: number
        rejected: number
      }>(
        // The tenant filter is not belt and braces here. With no project
        // given this counts across the WHOLE table, so without it the company
        // statistics screen reports every capture in the database — which is
        // every customer's, and the row-level policy is the only thing that
        // was stopping it.
        `SELECT
           (SELECT COUNT(*) FROM captures c
             WHERE c.tenant_id = $1 AND ($2::uuid IS NULL OR c.project_id = $2))::int AS captures,
           (SELECT COUNT(*) FROM capture_proposals p
             WHERE p.tenant_id = $1 AND ($2::uuid IS NULL OR p.project_id = $2))::int AS proposals,
           (SELECT COUNT(*) FROM capture_proposals p
             WHERE p.tenant_id = $1 AND ($2::uuid IS NULL OR p.project_id = $2)
              AND p.status = 'accepted')::int AS accepted,
           (SELECT COUNT(*) FROM capture_proposals p
             WHERE p.tenant_id = $1 AND ($2::uuid IS NULL OR p.project_id = $2)
              AND p.status = 'accepted' AND NOT p.edited)::int AS accepted_unedited,
           (SELECT COUNT(*) FROM capture_proposals p
             WHERE p.tenant_id = $1 AND ($2::uuid IS NULL OR p.project_id = $2)
              AND p.status = 'rejected')::int AS rejected`,
        [actor.tenantId, filter.projectId ?? null],
      )

      const { rows: costRows } = await tx.query<{ cost: string | null }>(
        `SELECT SUM(cost_micros) AS cost FROM ai_usage
          WHERE tenant_id = $1
            AND ($2::uuid IS NULL
                 OR capture_id IN (SELECT id FROM captures WHERE tenant_id = $1 AND project_id = $2))`,
        [actor.tenantId, filter.projectId ?? null],
      )

      const counts = rows[0]
      return {
        captures: counts?.captures ?? 0,
        proposals: counts?.proposals ?? 0,
        accepted: counts?.accepted ?? 0,
        acceptedUnedited: counts?.accepted_unedited ?? 0,
        rejected: counts?.rejected ?? 0,
        costMicros: Number(costRows[0]?.cost ?? 0),
      }
    })
  }

  private async accessFor(tx: Db, actor: Actor, projectId: string): Promise<AccessSnapshot> {
    const { rows } = await tx.query('SELECT 1 FROM projects WHERE tenant_id = $1 AND id = $2', [
      actor.tenantId,
      projectId,
    ])
    if (rows.length === 0) throw new NotFoundError('project', projectId)
    return loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
  }

  private async loadCapture(tx: Db, tenantId: string, captureId: string): Promise<Capture> {
    const { rows } = await tx.query<CaptureRow>(
      `SELECT ${CAPTURE_COLUMNS} FROM captures WHERE tenant_id = $1 AND id = $2`,
      [tenantId, captureId],
    )
    const row = rows[0]
    if (!row) throw new NotFoundError('capture', captureId)
    return toCapture(row)
  }

  private async loadProposal(tx: Db, tenantId: string, proposalId: string): Promise<Proposal> {
    const { rows } = await tx.query<ProposalRow>(
      `SELECT ${PROPOSAL_COLUMNS} FROM capture_proposals WHERE tenant_id = $1 AND id = $2`,
      [tenantId, proposalId],
    )
    const row = rows[0]
    if (!row) throw new NotFoundError('proposal', proposalId)
    return toProposal(row)
  }

  private async loadProposalForUpdate(tx: Db, tenantId: string, proposalId: string): Promise<Proposal> {
    const { rows } = await tx.query<ProposalRow>(
      `SELECT ${PROPOSAL_COLUMNS} FROM capture_proposals WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, proposalId],
    )
    const row = rows[0]
    if (!row) throw new NotFoundError('proposal', proposalId)
    return toProposal(row)
  }

  private async loadRoster(tx: Db, tenantId: string, projectId: string): Promise<RosterMember[]> {
    const { rows } = await tx.query<{
      id: string
      name: string
      job_title: string | null
      organization: string
    }>(
      `SELECT u.id, u.name, u.job_title, o.name AS organization
         FROM project_memberships m
         JOIN users u ON u.id = m.user_id AND u.tenant_id = m.tenant_id
         JOIN organizations o ON o.id = u.organization_id AND o.tenant_id = u.tenant_id
        WHERE m.tenant_id = $1 AND m.project_id = $2 AND u.is_active
        ORDER BY o.name, u.name`,
      [tenantId, projectId],
    )
    return rows.map((r) => ({
      userId: r.id,
      name: r.name,
      jobTitle: r.job_title,
      organization: r.organization,
    }))
  }
}

/**
 * Capturing is not creating. A trade partner with read-only access to every
 * tool can still photograph a problem, because refusing the photo is how you
 * end up with a system nobody in the field uses.
 */
function assertCanCapture(access: AccessSnapshot): void {
  if (hasLevel(access, CAPTURE_TOOL, 'read_only')) return
  throw new PermissionDeniedError('You are not able to capture on this project', { tool: CAPTURE_TOOL })
}

function wasEdited(
  proposal: Proposal,
  applied: { title: string; body: RecordBody; participants: { userId: string; role: ParticipantRole }[] },
): boolean {
  if (applied.title !== proposal.title) return true
  if (JSON.stringify(applied.body) !== JSON.stringify(proposal.body)) return true
  const key = (list: { userId: string; role: ParticipantRole }[]): string =>
    JSON.stringify([...list].map((p) => `${p.userId}:${p.role}`).sort())
  return key(applied.participants) !== key(proposal.participants)
}

export type { RecordType }
