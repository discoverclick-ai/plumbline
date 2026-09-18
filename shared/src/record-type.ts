import { ValidationError, type FieldIssue } from './errors.js'
import type { ParticipantRole, PermissionLevel } from './types.js'
import type { OrganizationKind } from './types.js'

/**
 * A record type is a whole tool expressed as data: the fields a user fills in,
 * the states work moves through, who owes the next action in each state, and
 * what a transition demands of the actor.
 *
 * Definitions arrive from the database (see migration 0004), which means they
 * are input, not code. `parseRecordTypeDefinition` validates one completely and
 * fails loudly. A malformed definition is a deployment bug, and the place to
 * find out is startup, not the first time a foreman taps Submit.
 */

export type FieldType = 'text' | 'multiline' | 'number' | 'date' | 'select' | 'boolean'

export interface FieldSpec {
  key: string
  label: string
  type: FieldType
  required?: boolean
  /** Required when type is 'select'. */
  options?: string[]
  default?: string | number | boolean
}

/**
 * Whose court the ball lands in when a record enters this state, resolved
 * against the record's participants at transition time.
 */
export type BallInCourtRole = Extract<ParticipantRole, 'creator' | 'assignee' | 'reviewer' | 'approver'> | 'none'

export interface StateSpec {
  key: string
  label: string
  terminal?: boolean
  ballInCourt: BallInCourtRole
}

export interface TransitionRequirement {
  /** Minimum permission level on the type's tool. */
  level: PermissionLevel
  /** Granular privilege that must also be held. */
  privilege?: string
  /** Roles the actor must hold on THIS record (any one of them suffices). */
  participantRoles?: ParticipantRole[]
}

export interface TransitionSpec {
  key: string
  label: string
  from: string[]
  to: string
  /** What the next ball-in-court holder is being asked to do. */
  expectedAction?: string
  /** Sets the new holder's due date this many days out. */
  dueInDays?: number
  /** Fields that must be non-empty for this transition to be legal. */
  requiresFields?: string[]
  requires: TransitionRequirement
}

export interface WorkflowSpec {
  initial: string
  states: StateSpec[]
  transitions: TransitionSpec[]
}

export interface RecordTypeDefinition {
  fields: FieldSpec[]
  workflow: WorkflowSpec
}

export interface RecordType {
  key: string
  toolKey: string
  displayName: string
  displayNamePlural: string
  numberPrefix: string
  version: number
  /**
   * Organization kinds whose users may CREATE this type. Empty means every
   * kind, which is the case for all five built-ins. A sub bills time and
   * materials and a general contractor does not, so a T&M ticket is raisable
   * by one and merely readable by the other.
   */
  creatableByOrgKinds: OrganizationKind[]
  definition: RecordTypeDefinition
}

const FIELD_TYPES: ReadonlySet<string> = new Set(['text', 'multiline', 'number', 'date', 'select', 'boolean'])
const PERMISSION_LEVELS: ReadonlySet<string> = new Set(['none', 'read_only', 'standard', 'admin'])
const PARTICIPANT_ROLES: ReadonlySet<string> = new Set([
  'creator',
  'assignee',
  'reviewer',
  'approver',
  'distribution',
  'watcher',
])
const BALL_IN_COURT_ROLES: ReadonlySet<string> = new Set(['creator', 'assignee', 'reviewer', 'approver', 'none'])

class DefinitionError extends Error {}

function fail(path: string, message: string): never {
  throw new DefinitionError(`record type definition ${path}: ${message}`)
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'expected an object')
  return value as Record<string, unknown>
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'expected a non-empty string')
  return value
}

function asStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, 'expected an array')
  return value.map((item, i) => asString(item, `${path}[${i}]`))
}

/**
 * Validate a raw definition and return it typed. Throws on anything
 * structurally wrong, including dangling state references in transitions — a
 * transition pointing at a state that does not exist would otherwise strand a
 * record in a status nothing can act on.
 */
export function parseRecordTypeDefinition(raw: unknown): RecordTypeDefinition {
  const root = asRecord(raw, '')
  const fieldsRaw = root['fields']
  if (!Array.isArray(fieldsRaw)) fail('fields', 'expected an array')

  const fields: FieldSpec[] = fieldsRaw.map((entry, i) => {
    const f = asRecord(entry, `fields[${i}]`)
    const type = asString(f['type'], `fields[${i}].type`)
    if (!FIELD_TYPES.has(type)) fail(`fields[${i}].type`, `unknown field type "${type}"`)
    const options = f['options'] === undefined ? undefined : asStringArray(f['options'], `fields[${i}].options`)
    if (type === 'select' && (!options || options.length === 0)) {
      fail(`fields[${i}].options`, 'a select field needs options')
    }
    const spec: FieldSpec = {
      key: asString(f['key'], `fields[${i}].key`),
      label: asString(f['label'], `fields[${i}].label`),
      type: type as FieldType,
    }
    if (f['required'] === true) spec.required = true
    if (options) spec.options = options
    if (f['default'] !== undefined) spec.default = f['default'] as string | number | boolean
    return spec
  })

  const seenFields = new Set<string>()
  for (const field of fields) {
    if (seenFields.has(field.key)) fail('fields', `duplicate field key "${field.key}"`)
    seenFields.add(field.key)
  }

  const wf = asRecord(root['workflow'], 'workflow')
  const statesRaw = wf['states']
  if (!Array.isArray(statesRaw) || statesRaw.length === 0) fail('workflow.states', 'expected a non-empty array')

  const states: StateSpec[] = statesRaw.map((entry, i) => {
    const s = asRecord(entry, `workflow.states[${i}]`)
    const ballInCourt = asString(s['ballInCourt'], `workflow.states[${i}].ballInCourt`)
    if (!BALL_IN_COURT_ROLES.has(ballInCourt)) {
      fail(`workflow.states[${i}].ballInCourt`, `unknown role "${ballInCourt}"`)
    }
    const spec: StateSpec = {
      key: asString(s['key'], `workflow.states[${i}].key`),
      label: asString(s['label'], `workflow.states[${i}].label`),
      ballInCourt: ballInCourt as BallInCourtRole,
    }
    if (s['terminal'] === true) spec.terminal = true
    return spec
  })

  const stateKeys = new Set(states.map((s) => s.key))
  if (stateKeys.size !== states.length) fail('workflow.states', 'duplicate state keys')

  const initial = asString(wf['initial'], 'workflow.initial')
  if (!stateKeys.has(initial)) fail('workflow.initial', `"${initial}" is not one of the declared states`)

  const transitionsRaw = wf['transitions']
  if (!Array.isArray(transitionsRaw)) fail('workflow.transitions', 'expected an array')

  const transitions: TransitionSpec[] = transitionsRaw.map((entry, i) => {
    const t = asRecord(entry, `workflow.transitions[${i}]`)
    const path = `workflow.transitions[${i}]`
    const from = asStringArray(t['from'], `${path}.from`)
    const to = asString(t['to'], `${path}.to`)
    for (const state of [...from, to]) {
      if (!stateKeys.has(state)) fail(path, `references unknown state "${state}"`)
    }

    const requires = asRecord(t['requires'], `${path}.requires`)
    const level = asString(requires['level'], `${path}.requires.level`)
    if (!PERMISSION_LEVELS.has(level)) fail(`${path}.requires.level`, `unknown level "${level}"`)

    const requirement: TransitionRequirement = { level: level as PermissionLevel }
    if (requires['privilege'] !== undefined) {
      requirement.privilege = asString(requires['privilege'], `${path}.requires.privilege`)
    }
    if (requires['participantRoles'] !== undefined) {
      const roles = asStringArray(requires['participantRoles'], `${path}.requires.participantRoles`)
      for (const role of roles) {
        if (!PARTICIPANT_ROLES.has(role)) fail(`${path}.requires.participantRoles`, `unknown role "${role}"`)
      }
      requirement.participantRoles = roles as ParticipantRole[]
    }

    const spec: TransitionSpec = {
      key: asString(t['key'], `${path}.key`),
      label: asString(t['label'], `${path}.label`),
      from,
      to,
      requires: requirement,
    }
    if (t['expectedAction'] !== undefined) spec.expectedAction = asString(t['expectedAction'], `${path}.expectedAction`)
    if (t['dueInDays'] !== undefined) {
      const days = t['dueInDays']
      if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
        fail(`${path}.dueInDays`, 'expected a positive number')
      }
      spec.dueInDays = days
    }
    if (t['requiresFields'] !== undefined) {
      const required = asStringArray(t['requiresFields'], `${path}.requiresFields`)
      for (const key of required) {
        if (!seenFields.has(key)) fail(`${path}.requiresFields`, `references unknown field "${key}"`)
      }
      spec.requiresFields = required
    }
    return spec
  })

  const transitionKeys = new Set(transitions.map((t) => t.key))
  if (transitionKeys.size !== transitions.length) fail('workflow.transitions', 'duplicate transition keys')

  return { fields, workflow: { initial, states, transitions } }
}

export type RecordBody = Record<string, string | number | boolean | null>

/**
 * Validate a submitted body against the type's fields and return it
 * normalized: unknown keys dropped, defaults applied, numbers and booleans
 * coerced from the strings a form or an agent will inevitably send.
 *
 * `partial` is for edits, where absent means "leave alone" rather than
 * "clear"; required-field checks are skipped and only supplied keys returned.
 */
export function normalizeBody(
  fields: FieldSpec[],
  input: Record<string, unknown>,
  { partial = false }: { partial?: boolean } = {},
): RecordBody {
  const issues: FieldIssue[] = []
  const out: RecordBody = {}

  for (const field of fields) {
    const supplied = Object.prototype.hasOwnProperty.call(input, field.key)
    let value = supplied ? input[field.key] : undefined

    if (!supplied) {
      if (partial) continue
      if (field.default !== undefined) {
        out[field.key] = field.default
        continue
      }
      value = undefined
    }

    if (value === undefined || value === null || value === '') {
      if (field.required && !partial) issues.push({ field: field.key, message: `${field.label} is required` })
      out[field.key] = null
      continue
    }

    switch (field.type) {
      case 'number': {
        const num = typeof value === 'number' ? value : Number(value)
        if (!Number.isFinite(num)) {
          issues.push({ field: field.key, message: `${field.label} must be a number` })
          break
        }
        out[field.key] = num
        break
      }
      case 'boolean': {
        if (typeof value === 'boolean') out[field.key] = value
        else if (value === 'true' || value === 'false') out[field.key] = value === 'true'
        else issues.push({ field: field.key, message: `${field.label} must be true or false` })
        break
      }
      case 'date': {
        const text = String(value)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
          issues.push({ field: field.key, message: `${field.label} must be a date (YYYY-MM-DD)` })
          break
        }
        out[field.key] = text
        break
      }
      case 'select': {
        const text = String(value)
        if (field.options && !field.options.includes(text)) {
          issues.push({ field: field.key, message: `${field.label} must be one of: ${field.options.join(', ')}` })
          break
        }
        out[field.key] = text
        break
      }
      default:
        out[field.key] = String(value)
    }
  }

  if (issues.length > 0) throw new ValidationError('The record has invalid fields', issues)
  return out
}

/** True when the body has a usable value for `key`. */
export function hasValue(body: RecordBody, key: string): boolean {
  const value = body[key]
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  return true
}
