import { InvalidTransitionError, ValidationError } from './errors.js'
import { hasValue, type RecordBody, type RecordTypeDefinition, type StateSpec, type TransitionSpec } from './record-type.js'
import type { ParticipantRole } from './types.js'

/**
 * The state machine, as pure functions. No database, no clock of its own, no
 * permissions. Everything here is decidable from a definition, a current
 * status, a body and a participant list, which is what makes the rules
 * testable without a Postgres instance and reusable by an agent that wants to
 * know what it is allowed to propose.
 */

export interface ParticipantLike {
  userId: string
  role: ParticipantRole
  position: number
}

export interface TransitionPlan {
  transition: TransitionSpec
  fromStatus: string
  toStatus: string
  terminal: boolean
  /** Who owes the next action once this transition lands. */
  ballInCourtUserId: string | null
  expectedAction: string | null
  dueAt: Date | null
}

export function findState(definition: RecordTypeDefinition, key: string): StateSpec {
  const state = definition.workflow.states.find((s) => s.key === key)
  if (!state) throw new ValidationError(`Unknown state "${key}"`)
  return state
}

export function findTransition(definition: RecordTypeDefinition, key: string): TransitionSpec {
  const transition = definition.workflow.transitions.find((t) => t.key === key)
  if (!transition) throw new ValidationError(`Unknown transition "${key}"`)
  return transition
}

/** Every transition legal from `status`, ignoring permissions. */
export function availableTransitions(definition: RecordTypeDefinition, status: string): TransitionSpec[] {
  return definition.workflow.transitions.filter((t) => t.from.includes(status))
}

/**
 * Who holds the ball in the given state.
 *
 * A state that hands the ball to a role nobody fills is a record that stalls
 * silently, so this refuses rather than returning null. You cannot send an RFI
 * to nobody.
 */
export function resolveBallInCourt(state: StateSpec, participants: readonly ParticipantLike[]): string | null {
  if (state.ballInCourt === 'none') return null

  const candidates = participants
    .filter((p) => p.role === state.ballInCourt)
    .sort((a, b) => a.position - b.position || a.userId.localeCompare(b.userId))

  const holder = candidates[0]
  if (!holder) {
    throw new ValidationError(`This record has no ${state.ballInCourt} to hand the ball to`, [
      { field: 'participants', message: `Add a ${state.ballInCourt} before moving to ${state.label}` },
    ])
  }
  return holder.userId
}

export interface PlanTransitionInput {
  definition: RecordTypeDefinition
  transitionKey: string
  currentStatus: string
  /** The body as it will be AFTER any edits submitted alongside the transition. */
  body: RecordBody
  participants: readonly ParticipantLike[]
  now?: Date
}

/**
 * Decide what a transition does, or refuse it. Ordering is deliberate:
 * legality of the move first, then the data it requires, then the handoff.
 * A user who cannot make the move at all should not be told which fields are
 * missing.
 */
export function planTransition(input: PlanTransitionInput): TransitionPlan {
  const { definition, currentStatus, body, participants } = input
  const now = input.now ?? new Date()
  const transition = findTransition(definition, input.transitionKey)

  if (!transition.from.includes(currentStatus)) {
    throw new InvalidTransitionError(transition.label, currentStatus)
  }

  const missing = (transition.requiresFields ?? []).filter((key) => !hasValue(body, key))
  if (missing.length > 0) {
    const fields = definition.fields
    throw new ValidationError(
      `${transition.label} needs more information`,
      missing.map((key) => ({
        field: key,
        message: `${fields.find((f) => f.key === key)?.label ?? key} is required to ${transition.label.toLowerCase()}`,
      })),
    )
  }

  const nextState = findState(definition, transition.to)
  const ballInCourtUserId = resolveBallInCourt(nextState, participants)

  const dueAt =
    transition.dueInDays !== undefined && ballInCourtUserId
      ? new Date(now.getTime() + transition.dueInDays * 24 * 60 * 60 * 1000)
      : null

  return {
    transition,
    fromStatus: currentStatus,
    toStatus: nextState.key,
    terminal: nextState.terminal === true,
    ballInCourtUserId,
    expectedAction: ballInCourtUserId ? (transition.expectedAction ?? `Act on this ${nextState.label}`) : null,
    dueAt,
  }
}

/** The opening state and its ball-in-court holder, for a record being created. */
export function planCreation(
  definition: RecordTypeDefinition,
  participants: readonly ParticipantLike[],
): { status: string; ballInCourtUserId: string | null; state: StateSpec } {
  const state = findState(definition, definition.workflow.initial)
  return { status: state.key, ballInCourtUserId: resolveBallInCourt(state, participants), state }
}
