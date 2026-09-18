import { describe, expect, it } from 'vitest'
import { InvalidTransitionError, ValidationError } from '../src/errors.js'
import { parseRecordTypeDefinition, type RecordTypeDefinition } from '../src/record-type.js'
import { availableTransitions, planCreation, planTransition, resolveBallInCourt } from '../src/workflow.js'

/**
 * The state machine is the part of the product that decides who is holding up
 * the job, so it is tested without a database: definitions in, decisions out.
 */

const RFI: RecordTypeDefinition = parseRecordTypeDefinition({
  fields: [
    { key: 'question', label: 'Question', type: 'multiline', required: true },
    { key: 'answer', label: 'Official Response', type: 'multiline' },
  ],
  workflow: {
    initial: 'draft',
    states: [
      { key: 'draft', label: 'Draft', ballInCourt: 'creator' },
      { key: 'open', label: 'Open', ballInCourt: 'assignee' },
      { key: 'answered', label: 'Answered', ballInCourt: 'creator' },
      { key: 'closed', label: 'Closed', terminal: true, ballInCourt: 'none' },
    ],
    transitions: [
      {
        key: 'submit',
        label: 'Submit',
        from: ['draft'],
        to: 'open',
        expectedAction: 'Answer this RFI',
        dueInDays: 7,
        requires: { level: 'standard' },
      },
      {
        key: 'answer',
        label: 'Answer',
        from: ['open'],
        to: 'answered',
        requiresFields: ['answer'],
        requires: { level: 'standard', privilege: 'respond' },
      },
      { key: 'close', label: 'Close', from: ['answered'], to: 'closed', requires: { level: 'standard' } },
    ],
  },
})

const PARTICIPANTS = [
  { userId: 'pm', role: 'creator' as const, position: 0 },
  { userId: 'architect', role: 'assignee' as const, position: 0 },
]

describe('planCreation', () => {
  it('opens in the initial state with the ball in the creator’s court', () => {
    const plan = planCreation(RFI, PARTICIPANTS)
    expect(plan.status).toBe('draft')
    expect(plan.ballInCourtUserId).toBe('pm')
  })
})

describe('planTransition', () => {
  it('hands the ball to the assignee and sets the due date', () => {
    const now = new Date('2026-03-02T00:00:00Z')
    const plan = planTransition({
      definition: RFI,
      transitionKey: 'submit',
      currentStatus: 'draft',
      body: { question: 'Which anchor detail governs at grid C4?' },
      participants: PARTICIPANTS,
      now,
    })

    expect(plan.toStatus).toBe('open')
    expect(plan.ballInCourtUserId).toBe('architect')
    expect(plan.expectedAction).toBe('Answer this RFI')
    expect(plan.dueAt?.toISOString()).toBe('2026-03-09T00:00:00.000Z')
    expect(plan.terminal).toBe(false)
  })

  it('refuses a move that is not legal from the current state', () => {
    expect(() =>
      planTransition({
        definition: RFI,
        transitionKey: 'close',
        currentStatus: 'draft',
        body: {},
        participants: PARTICIPANTS,
      }),
    ).toThrow(InvalidTransitionError)
  })

  it('refuses to answer an RFI with no answer written', () => {
    try {
      planTransition({
        definition: RFI,
        transitionKey: 'answer',
        currentStatus: 'open',
        body: { question: 'q', answer: '   ' },
        participants: PARTICIPANTS,
      })
      expect.unreachable('blank answer should not pass the required-field check')
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError)
      expect((err as ValidationError).issues[0]?.field).toBe('answer')
    }
  })

  it('returns the ball to the creator when the answer lands', () => {
    const plan = planTransition({
      definition: RFI,
      transitionKey: 'answer',
      currentStatus: 'open',
      body: { question: 'q', answer: 'Detail 5/S-401 governs.' },
      participants: PARTICIPANTS,
    })
    expect(plan.ballInCourtUserId).toBe('pm')
    // No dueInDays on this transition, so no clock is started.
    expect(plan.dueAt).toBeNull()
  })

  it('drops the ball entirely on a terminal state', () => {
    const plan = planTransition({
      definition: RFI,
      transitionKey: 'close',
      currentStatus: 'answered',
      body: {},
      participants: PARTICIPANTS,
    })
    expect(plan.terminal).toBe(true)
    expect(plan.ballInCourtUserId).toBeNull()
    expect(plan.expectedAction).toBeNull()
  })

  it('refuses to send a record to a role nobody fills', () => {
    // No assignee: submitting would strand the RFI in 'open' with nobody
    // holding it, which is exactly the silent stall this design exists to
    // prevent.
    expect(() =>
      planTransition({
        definition: RFI,
        transitionKey: 'submit',
        currentStatus: 'draft',
        body: { question: 'q' },
        participants: [{ userId: 'pm', role: 'creator', position: 0 }],
      }),
    ).toThrow(ValidationError)
  })
})

describe('resolveBallInCourt', () => {
  it('picks the lowest position within the role, for sequential approvals', () => {
    const state = { key: 'open', label: 'Open', ballInCourt: 'reviewer' as const }
    const holder = resolveBallInCourt(state, [
      { userId: 'second', role: 'reviewer', position: 2 },
      { userId: 'first', role: 'reviewer', position: 1 },
    ])
    expect(holder).toBe('first')
  })
})

describe('availableTransitions', () => {
  it('lists only what is legal from here', () => {
    expect(availableTransitions(RFI, 'open').map((t) => t.key)).toEqual(['answer'])
    expect(availableTransitions(RFI, 'closed')).toEqual([])
  })
})
