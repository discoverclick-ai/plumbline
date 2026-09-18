import { describe, expect, it } from 'vitest'
import {
  checkAgainstBaseline,
  gradeProposal,
  summarize,
  type CaseResult,
  type EvalExpectation,
} from '../src/capture/eval.js'
import type { ParsedProposal } from '../src/capture/interpreter.js'

/**
 * The graders decide whether a change to the prompt helped, so they get the
 * same scrutiny as product code. Each metric is tested for the failure it
 * exists to catch, not just for the happy path.
 */

function proposal(overrides: Partial<ParsedProposal> = {}): ParsedProposal {
  return {
    typeKey: 'observation',
    title: 'Guardrail missing at level 5',
    body: { description: 'Guardrail missing on the north side of level 5.', observation_type: 'Safety' },
    participants: [],
    confidence: 0.8,
    rationale: 'Unsafe condition seen on site.',
    issues: [],
    ...overrides,
  }
}

const EXPECTED: EvalExpectation = {
  typeKey: 'observation',
  fields: { description: { contains: 'guardrail' }, observation_type: 'Safety' },
  participants: [],
  complete: true,
}

describe('gradeProposal', () => {
  it('does not score the type when the capture cannot determine one', () => {
    // Labelling an unreadable capture 'observation' would measure the
    // labeller's guess, and scoring it as correct would inflate the headline
    // exactly where the suite is weakest.
    const { grade } = gradeProposal(proposal({ typeKey: 'rfi' }), {
      typeKey: '*',
      fields: {},
      complete: false,
    })
    expect(grade.type_match).toBeNull()
    expect(grade.field_recall).toBeNull()
  })

  it('scores a correct draft full marks', () => {
    const { grade } = gradeProposal(proposal(), EXPECTED)
    expect(grade).toEqual({ type_match: 1, field_recall: 1, people: 1, no_invention: 1, wellformed: 1 })
  })

  it('leaves field recall unscored when the case expects no fields', () => {
    const { grade } = gradeProposal(proposal(), { ...EXPECTED, fields: {} })
    expect(grade.field_recall).toBeNull()
  })

  it('catches the wrong record type and says what it proposed', () => {
    const { grade, explanation } = gradeProposal(proposal({ typeKey: 'punch_item' }), EXPECTED)
    expect(grade.type_match).toBe(0)
    expect(explanation.type_match).toContain('proposed punch_item')
  })

  it('scores field recall proportionally rather than all-or-nothing', () => {
    const { grade } = gradeProposal(
      proposal({ body: { description: 'Guardrail missing.', observation_type: 'Quality' } }),
      EXPECTED,
    )
    // One of two expected fields right.
    expect(grade.field_recall).toBe(0.5)
  })

  it('matches prose loosely and enums exactly', () => {
    const loose = gradeProposal(
      proposal({ body: { description: 'No GUARDRAIL at the level five stair.', observation_type: 'Safety' } }),
      EXPECTED,
    )
    expect(loose.grade.field_recall).toBe(1)

    const enumMiss = gradeProposal(
      proposal({ body: { description: 'Guardrail missing.', observation_type: 'safety issue' } }),
      EXPECTED,
    )
    expect(enumMiss.grade.field_recall).toBe(0.5)
  })

  it('catches an invented value in a field the capture never mentioned', () => {
    // The failure mode that matters most: a plausible spec section in an RFI
    // gets quoted back in a claim.
    const { grade, explanation } = gradeProposal(
      proposal({ body: { description: 'Guardrail missing.', observation_type: 'Safety', location: 'Level 5 north' } }),
      { ...EXPECTED, absentFields: ['location'] },
    )
    expect(grade.no_invention).toBe(0)
    expect(explanation.no_invention).toContain('location')
  })

  it('catches a forbidden phrase anywhere in the draft', () => {
    const { grade } = gradeProposal(proposal({ title: 'Per spec section 05 51 00' }), {
      ...EXPECTED,
      forbidden: ['05 51 00'],
    })
    expect(grade.no_invention).toBe(0)
  })

  it('requires an exact participant set, not a superset', () => {
    const extra = gradeProposal(proposal({ participants: [{ userId: 'u-arch', role: 'assignee' }] }), EXPECTED)
    expect(extra.grade.people).toBe(0)

    const right = gradeProposal(proposal({ participants: [{ userId: 'u-arch', role: 'assignee' }] }), {
      ...EXPECTED,
      participants: [{ userId: 'u-arch', role: 'assignee' }],
    })
    expect(right.grade.people).toBe(1)
  })

  it('rewards a draft that admits its gaps on an incomplete capture', () => {
    const honest = gradeProposal(
      proposal({ issues: [{ field: 'description', message: 'Description is required' }] }),
      { ...EXPECTED, fields: {}, complete: false },
    )
    expect(honest.grade.wellformed).toBe(1)

    // A confident draft off a capture with nothing in it is the failure.
    const silent = gradeProposal(proposal({ issues: [] }), { ...EXPECTED, fields: {}, complete: false })
    expect(silent.grade.wellformed).toBe(0)
    expect(silent.explanation.wellformed).toContain('no issues raised')
  })

  it('penalizes issues raised on a capture that had everything', () => {
    const { grade } = gradeProposal(
      proposal({ issues: [{ field: 'priority', message: 'Priority is required' }] }),
      EXPECTED,
    )
    expect(grade.wellformed).toBe(0)
  })
})

function result(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    prompt_id: 'c1',
    prompt: 'text',
    tags: ['observation'],
    split: 'train',
    status: 'ok',
    grade: { type_match: 1, field_recall: 1, people: 1, no_invention: 1, wellformed: 1 },
    explanation: {},
    confidence: 0.9,
    model: 'claude-opus-5',
    latency_s: 1,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    cost_micros: 100,
    trace: [],
    ...overrides,
  }
}

describe('summarize', () => {
  it('excludes unscored metrics from the mean instead of counting them as passes', () => {
    const summary = summarize(
      [
        result(),
        result({
          prompt_id: 'c2',
          grade: { type_match: null, field_recall: null, people: 1, no_invention: 1, wellformed: 1 },
        }),
      ],
      [],
    )
    // One applicable case, scored 1 — not two cases averaging to 1.
    expect(summary.headline).toBe(1)
    expect(summary.metrics.people).toBe(1)
  })

  it('averages each metric independently so a trade between them is visible', () => {
    const summary = summarize(
      [
        result(),
        result({
          prompt_id: 'c2',
          grade: { type_match: 0, field_recall: 1, people: 1, no_invention: 0, wellformed: 1 },
        }),
      ],
      [],
    )
    expect(summary.headline).toBe(0.5)
    expect(summary.metrics.field_recall).toBe(1)
    expect(summary.metrics.no_invention).toBe(0.5)
  })

  it('reports a noise floor so a two-case move is not read as a result', () => {
    const summary = summarize(Array.from({ length: 25 }, (_, i) => result({ prompt_id: `c${i}` })), [])
    // 1/sqrt(25) = 20 points.
    expect(summary.noiseFloorPoints).toBe(20)
  })

  it('scores calibration, punishing confident mistakes hardest', () => {
    const confidentlyWrong = summarize(
      [result({ confidence: 0.95, grade: { ...result().grade, type_match: 0 } })],
      [],
    )
    const unsureAndWrong = summarize(
      [result({ confidence: 0.3, grade: { ...result().grade, type_match: 0 } })],
      [],
    )
    expect(confidentlyWrong.calibration).toBeGreaterThan(unsureAndWrong.calibration)
  })

  it('counts errors separately from failures, because the causes differ', () => {
    const summary = summarize([result()], [{ prompt_id: 'c9', failure: 'provider', message: 'overloaded' }])
    expect(summary.cases).toBe(1)
    expect(summary.errored).toBe(1)
    expect(summary.headline).toBe(1)
  })
})

describe('checkAgainstBaseline', () => {
  const baseline = summarize(
    Array.from({ length: 100 }, (_, i) => result({ prompt_id: `c${i}` })),
    [],
  )

  it('passes a run that holds the line', () => {
    expect(checkAgainstBaseline(baseline, baseline).passed).toBe(true)
  })

  it('does not fire inside the noise floor', () => {
    // A gate that fires on noise trains everyone to ignore it.
    const slightlyWorse = { ...baseline, metrics: { ...baseline.metrics, type_match: 0.96 } }
    expect(checkAgainstBaseline(slightlyWorse, baseline).passed).toBe(true)
  })

  it('fires on a real drop and names the metric', () => {
    const worse = { ...baseline, metrics: { ...baseline.metrics, no_invention: 0.6 } }
    const check = checkAgainstBaseline(worse, baseline)
    expect(check.passed).toBe(false)
    expect(check.failures[0]).toContain('no_invention')
  })

  it('fires when more cases error than before', () => {
    const check = checkAgainstBaseline({ ...baseline, errored: 3 }, baseline)
    expect(check.passed).toBe(false)
    expect(check.failures.some((f) => f.startsWith('errors'))).toBe(true)
  })
})
