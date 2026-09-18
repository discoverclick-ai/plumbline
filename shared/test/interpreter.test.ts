import { describe, expect, it } from 'vitest'
import { ValidationError } from '../src/errors.js'
import {
  buildSystemPrompt,
  buildUserContent,
  parseProposal,
  type RosterMember,
} from '../src/capture/interpreter.js'
import { estimateCostMicros } from '../src/capture/pricing.js'
import { parseRecordTypeDefinition, type RecordType } from '../src/record-type.js'

/**
 * Model output is input, and this is where that is enforced. Everything here
 * runs without a database or a network: the prompt is a pure function of the
 * type registry and the roster, and parsing is a pure function of the output.
 */

function type(key: string, fields: unknown[], toolKey: string): RecordType {
  return {
    key,
    toolKey,
    displayName: key.toUpperCase(),
    displayNamePlural: `${key}s`,
    numberPrefix: key.slice(0, 3).toUpperCase(),
    version: 1,
    definition: parseRecordTypeDefinition({
      fields,
      workflow: {
        initial: 'draft',
        states: [
          { key: 'draft', label: 'Draft', ballInCourt: 'creator' },
          { key: 'open', label: 'Open', ballInCourt: 'assignee' },
        ],
        transitions: [{ key: 'submit', label: 'Submit', from: ['draft'], to: 'open', requires: { level: 'standard' } }],
      },
    }),
  }
}

const TYPES = new Map<string, RecordType>([
  [
    'rfi',
    type(
      'rfi',
      [
        { key: 'question', label: 'Question', type: 'multiline', required: true },
        { key: 'discipline', label: 'Discipline', type: 'select', options: ['Structural', 'Mechanical'] },
      ],
      'rfis',
    ),
  ],
  [
    'observation',
    type('observation', [{ key: 'description', label: 'Description', type: 'multiline', required: true }], 'observations'),
  ],
])

const ROSTER: RosterMember[] = [
  { userId: 'u-architect', name: 'Ali Bishop', organization: 'Bishop Architects', jobTitle: 'Architect of Record' },
  { userId: 'u-pm', name: 'Priya Mehta', organization: 'Ridgeline Builders', jobTitle: 'Project Manager' },
]

describe('buildSystemPrompt', () => {
  it('renders the grounding from the registry, so a new tool needs no new agent', () => {
    const prompt = buildSystemPrompt([...TYPES.values()], ROSTER, 'Harbor Point')
    expect(prompt).toContain('Harbor Point')
    expect(prompt).toContain('rfi —')
    expect(prompt).toContain('question (multiline, required)')
    expect(prompt).toContain('one of: Structural | Mechanical')
    // A type added by a migration appears here with no code change.
    expect(prompt).toContain('observation —')
  })

  it('lists the real people with their real ids and nobody else', () => {
    const prompt = buildSystemPrompt([...TYPES.values()], ROSTER, 'Harbor Point')
    expect(prompt).toContain('u-architect  Ali Bishop, Architect of Record (Bishop Architects)')
    expect(prompt).toContain('Never invent one')
  })
})

describe('buildUserContent', () => {
  it('carries the field context the model needs to date and place the record', () => {
    const content = buildUserContent({
      kind: 'voice',
      text: 'Guardrail missing on level five, north side.',
      capturedAt: '2026-03-02T14:05:00.000Z',
      latitude: 47.61,
      longitude: -122.33,
      capturedByName: 'Sam Ruiz',
    })
    expect(content).toContain('Capture kind: voice')
    expect(content).toContain('Captured by: Sam Ruiz')
    expect(content).toContain('47.61, -122.33')
    expect(content).toContain('Guardrail missing')
  })
})

describe('parseProposal', () => {
  const context = { types: TYPES, roster: ROSTER }

  it('coerces a well-formed proposal into something the kernel could accept', () => {
    const parsed = parseProposal(
      {
        typeKey: 'rfi',
        title: 'Anchor detail at grid C4',
        fields: [
          { key: 'question', value: 'Which anchor detail governs at grid C4?' },
          { key: 'discipline', value: 'Structural' },
        ],
        participants: [{ userId: 'u-architect', role: 'assignee' }],
        confidence: 0.82,
        rationale: 'The note asks the design team a question about a detail.',
      },
      context,
    )

    expect(parsed.typeKey).toBe('rfi')
    expect(parsed.body['question']).toContain('grid C4')
    expect(parsed.participants).toEqual([{ userId: 'u-architect', role: 'assignee' }])
    expect(parsed.confidence).toBe(0.82)
    expect(parsed.issues).toEqual([])
  })

  it('refuses a record type that does not exist', () => {
    expect(() =>
      parseProposal({ typeKey: 'change_order', title: 'x', fields: [], participants: [] }, context),
    ).toThrow(ValidationError)
  })

  it('drops a person who is not on the project and says so', () => {
    const parsed = parseProposal(
      {
        typeKey: 'rfi',
        title: 'Routed to a stranger',
        fields: [{ key: 'question', value: 'q' }],
        participants: [
          { userId: 'u-architect', role: 'assignee' },
          { userId: 'u-invented', role: 'reviewer' },
        ],
        confidence: 0.5,
        rationale: '',
      },
      context,
    )
    expect(parsed.participants).toEqual([{ userId: 'u-architect', role: 'assignee' }])
    expect(parsed.issues.map((i) => i.message)).toContain('u-invented is not on this project')
  })

  it('never lets a proposal name its own creator', () => {
    const parsed = parseProposal(
      {
        typeKey: 'rfi',
        title: 'Self-dealing',
        fields: [{ key: 'question', value: 'q' }],
        // 'creator' is decided at the gate by whoever accepts, never proposed.
        participants: [{ userId: 'u-pm', role: 'creator' }],
        confidence: 0.5,
        rationale: '',
      },
      context,
    )
    expect(parsed.participants).toEqual([])
    expect(parsed.issues.some((i) => i.message.includes('creator'))).toBe(true)
  })

  it('keeps a partial draft and reports what is missing, rather than throwing it away', () => {
    const parsed = parseProposal(
      {
        typeKey: 'rfi',
        title: 'Incomplete',
        fields: [{ key: 'discipline', value: 'Structural' }],
        participants: [],
        confidence: 0.3,
        rationale: 'Not enough detail in the note.',
      },
      context,
    )
    // The approver sees a draft with the discipline filled in and one clear
    // gap, instead of an empty inbox.
    expect(parsed.body['discipline']).toBe('Structural')
    expect(parsed.issues.map((i) => i.field)).toContain('question')
  })

  it('drops a field the type does not declare', () => {
    const parsed = parseProposal(
      {
        typeKey: 'observation',
        title: 'Guardrail',
        fields: [
          { key: 'description', value: 'Guardrail missing at level 5.' },
          { key: 'estimated_cost', value: '4000' },
        ],
        participants: [],
        confidence: 0.9,
        rationale: '',
      },
      context,
    )
    expect(Object.keys(parsed.body)).not.toContain('estimated_cost')
    expect(parsed.issues.map((i) => i.message)).toContain('OBSERVATION has no field "estimated_cost"')
  })

  it('rejects a select value outside the declared options', () => {
    const parsed = parseProposal(
      {
        typeKey: 'rfi',
        title: 'Bad discipline',
        fields: [
          { key: 'question', value: 'q' },
          { key: 'discipline', value: 'Telepathy' },
        ],
        participants: [],
        confidence: 0.4,
        rationale: '',
      },
      context,
    )
    expect(parsed.issues.map((i) => i.field)).toContain('discipline')
  })

  it('clamps a confidence outside 0..1 instead of trusting it', () => {
    const parsed = parseProposal(
      { typeKey: 'rfi', title: 't', fields: [{ key: 'question', value: 'q' }], participants: [], confidence: 4.2 },
      context,
    )
    expect(parsed.confidence).toBe(1)
  })
})

describe('estimateCostMicros', () => {
  it('prices a call in millionths of a dollar', () => {
    const cost = estimateCostMicros('claude-opus-5', {
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 0,
    })
    // 1k input at $5/MTok = 5000 micros, 500 output at $25/MTok = 12500,
    // 10k cache reads at a tenth of input = 5000.
    expect(cost.costMicros).toBe(22_500)
    expect(cost.priced).toBe(true)
  })

  it('flags an unpriced model rather than silently reporting zero', () => {
    const cost = estimateCostMicros('some-model-shipped-next-year', {
      inputTokens: 100,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(cost.priced).toBe(false)
  })
})
