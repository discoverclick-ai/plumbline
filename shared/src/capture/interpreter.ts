import { normalizeBody, type RecordBody, type RecordType } from '../record-type.js'
import { ValidationError, type FieldIssue } from '../errors.js'
import type { ParticipantRole } from '../types.js'

/**
 * Turning field signal into a proposed record.
 *
 * The important property of this file is that it knows nothing about
 * construction. The prompt is GENERATED from the record type registry, so a
 * tool added by a migration next month is interpretable the moment it exists,
 * with no change here and no new agent. That is the payoff of the kernel: one
 * interface, and the agent surface grows with the product for free.
 *
 * The provider seam is deliberate. Everything above `InterpretationProvider`
 * is vendor-agnostic and unit-testable with a scripted double; nothing outside
 * `providers/` imports a model SDK.
 */

export interface InterpretationProvider {
  readonly name: string
  interpret(request: ProviderRequest): Promise<ProviderResponse>
}

export interface ProviderRequest {
  /**
   * Stable across every call for a given project and type registry, and put
   * first so it can be cached by the provider. The volatile part (the capture
   * itself) goes in `userContent`.
   */
  system: string
  userContent: string
  /** JSON schema the model's output must satisfy. */
  schema: Record<string, unknown>
  maxTokens: number
}

export interface ProviderUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface ProviderResponse {
  /** Parsed JSON conforming to the request's schema. */
  output: unknown
  usage: ProviderUsage
  /** What actually served the request. */
  model: string
}

export interface RosterMember {
  userId: string
  name: string
  organization: string
  jobTitle: string | null
}

export interface CaptureSignal {
  kind: 'photo' | 'voice' | 'document' | 'text' | 'email'
  text: string
  capturedAt: string
  latitude?: number | null
  longitude?: number | null
  capturedByName?: string
}

/**
 * The output contract. Fields arrive as key/value pairs rather than a free
 * object because the shape is then stable across every record type, which
 * means one schema the provider can constrain against instead of one per tool.
 * Coercion into the type's real field types happens in `parseProposal`.
 */
export const PROPOSAL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['typeKey', 'title', 'fields', 'participants', 'confidence', 'rationale'],
  properties: {
    typeKey: { type: 'string', description: 'Key of the record type this capture should become' },
    title: { type: 'string', description: 'A short, specific title a project manager would recognize' },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'value'],
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
        },
      },
    },
    participants: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['userId', 'role'],
        properties: {
          userId: { type: 'string' },
          role: { type: 'string', enum: ['assignee', 'reviewer', 'approver', 'distribution', 'watcher'] },
        },
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string', description: 'One or two sentences on why this reading of the capture is right' },
  },
}

/**
 * The grounding. Everything the model is allowed to know about this project,
 * rendered from the registry and the project roster.
 *
 * Both inputs were read under the approving user's tenant context, so the
 * model is never grounded in data the humans involved could not see. That is
 * not a prompt instruction, it is a property of where this text comes from.
 */
export function buildSystemPrompt(types: RecordType[], roster: RosterMember[], projectName: string): string {
  const typeBlocks = types.map((type) => {
    const fields = type.definition.fields
      .map((field) => {
        const parts = [`      - ${field.key} (${field.type}${field.required ? ', required' : ''}): ${field.label}`]
        if (field.options) parts.push(`        one of: ${field.options.join(' | ')}`)
        return parts.join('\n')
      })
      .join('\n')
    return `  ${type.key} — ${type.displayName}\n${fields}`
  })

  const people = roster
    .map((m) => `  ${m.userId}  ${m.name}${m.jobTitle ? `, ${m.jobTitle}` : ''} (${m.organization})`)
    .join('\n')

  return [
    'You read raw signal captured on a construction site and draft the record it should become.',
    `The project is "${projectName}".`,
    '',
    'RECORD TYPES YOU MAY PROPOSE',
    typeBlocks.join('\n\n'),
    '',
    'PEOPLE ON THIS PROJECT',
    'Use these exact ids. Never invent one, and never name somebody who is not listed.',
    people || '  (nobody listed)',
    '',
    'HOW TO CHOOSE',
    '  A question for the design team that needs a formal answer is an rfi.',
    '  Product data, a shop drawing or a sample going for review is a submittal.',
    '  Defective or incomplete work that a trade must return to fix is a punch_item.',
    '  A safety or quality issue seen on site is an observation.',
    '  A summary of a day of work, weather or manpower is a daily_log.',
    '',
    'RULES',
    '  Fill only fields that the capture actually supports. Leave the rest out.',
    '  Never invent a dimension, a date, a spec section or a drawing number that is not in the capture.',
    '  Assign a participant only when the capture makes the right person clear.',
    '  Confidence is your honest probability that a project manager would accept this draft unedited.',
    '  A human reviews everything you produce before it becomes a record, so a careful partial',
    '  draft with low confidence is more useful than a confident invention.',
  ].join('\n')
}

export function buildUserContent(capture: CaptureSignal): string {
  const lines = [`Capture kind: ${capture.kind}`, `Captured at: ${capture.capturedAt}`]
  if (capture.capturedByName) lines.push(`Captured by: ${capture.capturedByName}`)
  if (capture.latitude != null && capture.longitude != null) {
    lines.push(`Location: ${capture.latitude}, ${capture.longitude}`)
  }
  lines.push('', 'Content:', capture.text)
  return lines.join('\n')
}

export interface ParsedProposal {
  typeKey: string
  title: string
  body: RecordBody
  participants: { userId: string; role: ParticipantRole }[]
  confidence: number
  rationale: string
  /**
   * What is wrong with this draft. Kept rather than thrown: the approver needs
   * to see that the RFI is missing its question, not get a blank inbox.
   */
  issues: FieldIssue[]
}

const ASSIGNABLE_ROLES: ReadonlySet<string> = new Set([
  'assignee',
  'reviewer',
  'approver',
  'distribution',
  'watcher',
])

/**
 * Validate and coerce a model's output into something the kernel could accept.
 *
 * Model output is input. It is checked exactly as hard as a form post: the
 * type must exist, fields must belong to that type and coerce to its declared
 * shapes, and every person named must actually be on the project. Anything
 * that fails becomes an issue on the proposal rather than a silently dropped
 * value or a 500.
 */
export function parseProposal(
  raw: unknown,
  context: { types: Map<string, RecordType>; roster: RosterMember[] },
): ParsedProposal {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError('The interpreter returned something that is not a proposal')
  }
  const output = raw as Record<string, unknown>

  const typeKey = String(output['typeKey'] ?? '')
  const type = context.types.get(typeKey)
  if (!type) {
    throw new ValidationError(`The interpreter proposed an unknown record type "${typeKey}"`)
  }

  const issues: FieldIssue[] = []

  const title = String(output['title'] ?? '').trim()
  if (!title) issues.push({ field: 'title', message: 'Title is required' })

  const supplied: Record<string, unknown> = {}
  const fieldKeys = new Set(type.definition.fields.map((f) => f.key))
  if (Array.isArray(output['fields'])) {
    for (const entry of output['fields'] as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue
      const pair = entry as Record<string, unknown>
      const key = String(pair['key'] ?? '')
      if (!fieldKeys.has(key)) {
        // Not an error worth blocking on: the model named a field this type
        // does not have, so it is dropped and noted.
        issues.push({ field: key, message: `${type.displayName} has no field "${key}"` })
        continue
      }
      supplied[key] = pair['value']
    }
  }

  // Two passes. The strict pass surfaces every problem as an issue; the second
  // pass drops the values that caused them and produces the best body we can
  // actually store, so the approver edits a mostly-complete draft rather than
  // an empty form.
  //
  // Dropping matters: a select field the model filled with a value outside the
  // declared options would otherwise fail the second pass too, and the whole
  // interpretation would be lost over one bad enum.
  let body: RecordBody
  try {
    body = normalizeBody(type.definition.fields, supplied)
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err
    issues.push(...err.issues)
    const clean: Record<string, unknown> = {}
    const rejected = new Set(err.issues.map((issue) => issue.field))
    for (const [key, value] of Object.entries(supplied)) {
      if (!rejected.has(key)) clean[key] = value
    }
    body = normalizeBody(type.definition.fields, clean, { partial: true })
  }

  const known = new Set(context.roster.map((m) => m.userId))
  const participants: { userId: string; role: ParticipantRole }[] = []
  if (Array.isArray(output['participants'])) {
    for (const entry of output['participants'] as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue
      const pair = entry as Record<string, unknown>
      const userId = String(pair['userId'] ?? '')
      const role = String(pair['role'] ?? '')
      if (!known.has(userId)) {
        issues.push({ field: 'participants', message: `${userId} is not on this project` })
        continue
      }
      if (!ASSIGNABLE_ROLES.has(role)) {
        issues.push({ field: 'participants', message: `"${role}" is not a role a proposal may assign` })
        continue
      }
      // The creator role is never proposed: whoever accepts the proposal is
      // the creator, and that is decided at the gate, not by the model.
      participants.push({ userId, role: role as ParticipantRole })
    }
  }

  const rawConfidence = Number(output['confidence'])
  const confidence = Number.isFinite(rawConfidence) ? Math.min(1, Math.max(0, rawConfidence)) : 0

  return {
    typeKey,
    title: title || `Untitled ${type.displayName}`,
    body,
    participants,
    confidence,
    rationale: String(output['rationale'] ?? '').trim(),
    issues,
  }
}
