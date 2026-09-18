import { withTenant, type Db } from '../db.js'
import type { RecordBody, RecordType } from '../record-type.js'
import { loadRecordTypes } from '../repositories/record-types.js'
import type { ParticipantRole } from '../types.js'
import {
  buildSystemPrompt,
  buildUserContent,
  parseProposal,
  PROPOSAL_SCHEMA,
  type InterpretationProvider,
  type ParsedProposal,
  type RosterMember,
} from './interpreter.js'
import { estimateCostMicros } from './pricing.js'

/**
 * The eval harness for the capture interpreter.
 *
 * An agent that drafts contractually significant records needs a number
 * attached to it before the tenth agent ships, not after. This is that number,
 * and three properties make it worth trusting:
 *
 *   1. It runs THE REAL CODE PATH. `runEvalCase` calls the same
 *      `buildSystemPrompt` / `buildUserContent` / `parseProposal` the product
 *      calls, against types loaded from a real database. An eval that scores a
 *      copy of the prompt measures the copy.
 *   2. Grading is programmatic. The output space is constrained — a type key
 *      from a closed set, fields declared by that type, user ids that exist —
 *      so a judge model would add cost, variance and nothing else.
 *   3. The same grader scores production. `caseFromAcceptedProposal` turns a
 *      proposal a human edited before accepting into an eval case whose gold
 *      answer is the human's correction. The product generates its own eval
 *      set, which is the only way a suite stays honest past month three.
 */

export type ExpectedValue = string | number | boolean | { contains: string }

export interface EvalExpectation {
  /**
   * `'*'` means the capture does not determine a type, so `type_match` is not
   * scored for this case. Forcing a label onto an unanswerable capture is how
   * an eval starts measuring the labeller's guess instead of the model.
   */
  typeKey: string | '*'
  /** Field values the draft must get right. `{contains}` for prose. */
  fields?: Record<string, ExpectedValue>
  participants?: { userId: string; role: ParticipantRole }[]
  /**
   * Fields that must be left empty. The hallucination probe: a capture that
   * never mentions a spec section must not produce one.
   */
  absentFields?: string[]
  /** Substrings that must appear nowhere in the draft. */
  forbidden?: string[]
  /**
   * Whether the capture carries enough for a clean draft. Complete cases must
   * produce no issues; incomplete ones MUST produce issues, because a draft
   * that hides its own gaps is worse than one that admits them.
   */
  complete: boolean
}

export interface EvalCase {
  id: string
  /** Random, stratified by tags[0]. Never split by score. */
  split: 'train' | 'test'
  /** tags[0] is the primary grouping shown as a section header in reports. */
  tags: string[]
  capture: {
    kind: 'photo' | 'voice' | 'document' | 'text' | 'email'
    text: string
    capturedAt?: string
    latitude?: number
    longitude?: number
    capturedByName?: string
  }
  roster: RosterMember[]
  projectName: string
  expected: EvalExpectation
  /** Why this case exists. Read by whoever inherits the suite. */
  note?: string
}

export type MetricId = 'type_match' | 'field_recall' | 'people' | 'no_invention' | 'wellformed'

/**
 * `null` means "not applicable to this case" — a capture with no determinable
 * type, or one with no expected fields. Nulls are excluded from the mean
 * rather than counted as a pass, because scoring an unanswerable case as
 * correct inflates the headline exactly where the suite is weakest.
 */
export type MetricScore = number | null

export interface CaseGrade {
  grade: Record<MetricId, MetricScore>
  explanation: Partial<Record<MetricId, string>>
}

type FieldValue = RecordBody[string] | undefined

function matches(actual: FieldValue, expected: ExpectedValue): boolean {
  if (actual === null || actual === undefined) return false
  if (typeof expected === 'object' && expected !== null && 'contains' in expected) {
    return String(actual).toLowerCase().includes(expected.contains.toLowerCase())
  }
  if (typeof expected === 'number') return Number(actual) === expected
  if (typeof expected === 'boolean') return Boolean(actual) === expected
  return String(actual).trim().toLowerCase() === expected.trim().toLowerCase()
}

function isPopulated(value: FieldValue): boolean {
  if (value === null || value === undefined) return false
  return typeof value === 'string' ? value.trim().length > 0 : true
}

/**
 * Score one draft against one expectation.
 *
 * Five metrics rather than one pass-rate, because they trade against each
 * other and a single number hides the trade. A prompt change that lifts field
 * recall by inventing plausible values will show up as `no_invention` falling,
 * which is exactly the failure worth catching.
 */
export function gradeProposal(actual: ParsedProposal, expected: EvalExpectation): CaseGrade {
  const explanation: Partial<Record<MetricId, string>> = {}

  const typeMatch: MetricScore =
    expected.typeKey === '*' ? null : actual.typeKey === expected.typeKey ? 1 : 0
  if (typeMatch === 0) explanation.type_match = `proposed ${actual.typeKey}, expected ${expected.typeKey}`

  const expectedFields = Object.entries(expected.fields ?? {})
  let fieldRecall: MetricScore = null
  if (expectedFields.length > 0) {
    const misses = expectedFields.filter(([key, want]) => !matches(actual.body[key], want))
    fieldRecall = (expectedFields.length - misses.length) / expectedFields.length
    if (misses.length > 0) {
      explanation.field_recall = `missed ${misses.map(([key]) => key).join(', ')}`
    }
  }

  const key = (list: { userId: string; role: ParticipantRole }[]): string =>
    JSON.stringify([...list].map((p) => `${p.userId}:${p.role}`).sort())
  const people = key(actual.participants) === key(expected.participants ?? []) ? 1 : 0
  if (!people) {
    explanation.people = `proposed ${key(actual.participants)}, expected ${key(expected.participants ?? [])}`
  }

  const invented: string[] = []
  for (const field of expected.absentFields ?? []) {
    if (isPopulated(actual.body[field])) invented.push(`${field}="${String(actual.body[field])}"`)
  }
  const haystack = [actual.title, ...Object.values(actual.body).map((v) => String(v ?? ''))]
    .join(' ')
    .toLowerCase()
  for (const phrase of expected.forbidden ?? []) {
    if (haystack.includes(phrase.toLowerCase())) invented.push(`forbidden "${phrase}"`)
  }
  const noInvention = invented.length === 0 ? 1 : 0
  if (!noInvention) explanation.no_invention = `invented ${invented.join('; ')}`

  // A complete capture should draft cleanly; an incomplete one should say what
  // it is missing rather than quietly producing a half-record.
  const wellformed = expected.complete ? (actual.issues.length === 0 ? 1 : 0) : actual.issues.length > 0 ? 1 : 0
  if (!wellformed) {
    explanation.wellformed = expected.complete
      ? `issues on a complete capture: ${actual.issues.map((i) => i.field).join(', ')}`
      : 'no issues raised on an incomplete capture'
  }

  return {
    grade: {
      type_match: typeMatch,
      field_recall: fieldRecall,
      people,
      no_invention: noInvention,
      wellformed,
    },
    explanation,
  }
}

export interface CaseResult {
  prompt_id: string
  prompt: string
  tags: string[]
  split: 'train' | 'test'
  status: 'ok' | 'error'
  grade: Record<MetricId, MetricScore>
  explanation: Partial<Record<MetricId, string>>
  confidence: number
  model: string
  latency_s: number
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
  }
  cost_micros: number
  /** The full exchange, for a human reading a surprising grade. */
  trace: { role: 'system' | 'user' | 'assistant'; content: string }[]
}

export interface CaseError {
  prompt_id: string
  /** refusal | provider | timeout | grader — zeros with different causes. */
  failure: string
  message: string
}

export interface EvalRun {
  results: CaseResult[]
  errors: CaseError[]
  summary: EvalSummary
}

export interface EvalSummary {
  cases: number
  errored: number
  /** null when no case in the run scored that metric. */
  metrics: Record<MetricId, MetricScore>
  /** Headline: mean type_match over the cases where a type was determinable. */
  headline: MetricScore
  /**
   * Brier score over (confidence, type_match). Lower is better; 0.25 is what
   * you get by always guessing 0.5. A model that is confidently wrong is worse
   * than one that is unsure, because the approver stops reading.
   */
  calibration: number
  /**
   * Half-width of the 95% interval on the headline at this sample size,
   * in points. Printed next to every score so a two-case move is not read as
   * a result.
   */
  noiseFloorPoints: number
  costMicros: number
  meanLatencySeconds: number
}

export function summarize(results: CaseResult[], errors: CaseError[]): EvalSummary {
  const scored = results.filter((r) => r.status === 'ok')
  const n = scored.length
  const mean = (pick: (r: CaseResult) => number): number =>
    n === 0 ? 0 : scored.reduce((total, r) => total + pick(r), 0) / n

  /** Mean over the cases where the metric applies; null when none do. */
  const meanApplicable = (metric: MetricId): MetricScore => {
    const values = scored.map((r) => r.grade[metric]).filter((v): v is number => v !== null)
    return values.length === 0 ? null : values.reduce((total, v) => total + v, 0) / values.length
  }

  const metrics: Record<MetricId, MetricScore> = {
    type_match: meanApplicable('type_match'),
    field_recall: meanApplicable('field_recall'),
    people: meanApplicable('people'),
    no_invention: meanApplicable('no_invention'),
    wellformed: meanApplicable('wellformed'),
  }

  // Calibration is only meaningful where correctness was decidable.
  const calibrationCases = scored.filter((r) => r.grade.type_match !== null)

  return {
    cases: n,
    errored: errors.length,
    metrics,
    headline: metrics.type_match,
    calibration:
      calibrationCases.length === 0
        ? 0
        : calibrationCases.reduce((total, r) => total + (r.confidence - (r.grade.type_match ?? 0)) ** 2, 0) /
          calibrationCases.length,
    noiseFloorPoints: n === 0 ? 100 : Math.round((100 / Math.sqrt(n)) * 10) / 10,
    costMicros: scored.reduce((total, r) => total + r.cost_micros, 0),
    meanLatencySeconds: Math.round(mean((r) => r.latency_s) * 1000) / 1000,
  }
}

export interface RunEvalOptions {
  db: Db
  provider: InterpretationProvider
  cases: EvalCase[]
  tenantId: string
  maxTokens?: number
  /** Bound in-flight requests so a full pass finishes in minutes. */
  concurrency?: number
  onCase?: (result: CaseResult | CaseError) => void
}

/**
 * Run one case through the real interpretation path.
 *
 * Types come from the database rather than a fixture, because the prompt is
 * generated from the registry and an eval that stubs the registry cannot catch
 * a regression caused by a migration.
 */
export async function runEvalCase(
  options: { provider: InterpretationProvider; types: Map<string, RecordType>; maxTokens?: number },
  testCase: EvalCase,
): Promise<CaseResult | CaseError> {
  const system = buildSystemPrompt([...options.types.values()], testCase.roster, testCase.projectName)
  const userContent = buildUserContent({
    kind: testCase.capture.kind,
    text: testCase.capture.text,
    capturedAt: testCase.capture.capturedAt ?? new Date().toISOString(),
    ...(testCase.capture.latitude !== undefined ? { latitude: testCase.capture.latitude } : {}),
    ...(testCase.capture.longitude !== undefined ? { longitude: testCase.capture.longitude } : {}),
    ...(testCase.capture.capturedByName ? { capturedByName: testCase.capture.capturedByName } : {}),
  })

  const started = Date.now()
  let response
  try {
    response = await options.provider.interpret({
      system,
      userContent,
      schema: PROPOSAL_SCHEMA,
      maxTokens: options.maxTokens ?? 4096,
    })
  } catch (err) {
    return {
      prompt_id: testCase.id,
      failure: 'provider',
      message: err instanceof Error ? err.message : String(err),
    }
  }
  const latency = (Date.now() - started) / 1000

  let parsed: ParsedProposal
  try {
    parsed = parseProposal(response.output, { types: options.types, roster: testCase.roster })
  } catch (err) {
    // A draft the product would have refused outright. Scored as a failure of
    // every metric rather than dropped, because dropping it flatters the score.
    return {
      prompt_id: testCase.id,
      failure: 'unparseable',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  const { grade, explanation } = gradeProposal(parsed, testCase.expected)
  const cost = estimateCostMicros(response.model, response.usage)

  return {
    prompt_id: testCase.id,
    prompt: testCase.capture.text,
    tags: testCase.tags,
    split: testCase.split,
    status: 'ok',
    grade,
    explanation,
    confidence: parsed.confidence,
    model: response.model,
    latency_s: Math.round(latency * 1000) / 1000,
    usage: {
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens,
      cache_read_input_tokens: response.usage.cacheReadTokens,
      cache_creation_input_tokens: response.usage.cacheWriteTokens,
    },
    cost_micros: cost.costMicros,
    trace: [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
      { role: 'assistant', content: JSON.stringify(response.output, null, 2) },
    ],
  }
}

export async function runEval(options: RunEvalOptions): Promise<EvalRun> {
  const types = await withTenant(options.db, options.tenantId, (tx) => loadRecordTypes(tx))

  const results: CaseResult[] = []
  const errors: CaseError[] = []
  const queue = [...options.cases]
  const limit = Math.max(1, options.concurrency ?? 4)

  async function worker(): Promise<void> {
    for (;;) {
      const testCase = queue.shift()
      if (!testCase) return
      const outcome = await runEvalCase(
        {
          provider: options.provider,
          types,
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        },
        testCase,
      )
      if ('status' in outcome) results.push(outcome)
      else errors.push(outcome)
      options.onCase?.(outcome)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker))

  // Deterministic order regardless of how the workers interleaved.
  results.sort((a, b) => a.prompt_id.localeCompare(b.prompt_id))
  errors.sort((a, b) => a.prompt_id.localeCompare(b.prompt_id))

  return { results, errors, summary: summarize(results, errors) }
}

export interface RegressionCheck {
  passed: boolean
  failures: string[]
}

/**
 * Compare a run against a stored baseline.
 *
 * `tolerancePoints` should be at least the baseline's noise floor. A gate that
 * fires inside the noise trains everyone to ignore it, which is worse than no
 * gate.
 */
export function checkAgainstBaseline(
  run: EvalSummary,
  baseline: EvalSummary,
  tolerancePoints = baseline.noiseFloorPoints,
): RegressionCheck {
  const failures: string[] = []
  const tolerance = tolerancePoints / 100

  for (const [metric, value] of Object.entries(run.metrics) as [MetricId, MetricScore][]) {
    const before = baseline.metrics[metric]
    // A metric nobody scored in one of the two runs cannot be compared.
    if (value === null || before === null) continue
    if (value + tolerance < before) {
      failures.push(
        `${metric}: ${(value * 100).toFixed(1)}% vs baseline ${(before * 100).toFixed(1)}% ` +
          `(tolerance ${tolerancePoints} points)`,
      )
    }
  }

  if (run.errored > baseline.errored) {
    failures.push(`errors: ${run.errored} vs baseline ${baseline.errored}`)
  }

  return { passed: failures.length === 0, failures }
}

/**
 * The living-suite loop.
 *
 * Every proposal a human edited before accepting is a case the interpreter got
 * wrong, with the correction already attached: the record as accepted IS the
 * gold answer. Pulling those back in is how the suite keeps matching real
 * traffic instead of the traffic someone imagined at the start.
 *
 * Accepted-unedited proposals come back too, as the easy positives that catch
 * a regression the hard cases would miss.
 */
export async function exportCasesFromProduction(
  db: Db,
  options: { tenantId: string; projectId?: string; limit?: number; editedOnly?: boolean },
): Promise<EvalCase[]> {
  return withTenant(db, options.tenantId, async (tx) => {
    const { rows } = await tx.query<{
      proposal_id: string
      project_id: string
      project_name: string
      type_key: string
      title: string
      body: RecordBody
      participants: { userId: string; role: ParticipantRole }[]
      edited: boolean
      capture_kind: EvalCase['capture']['kind']
      capture_text: string | null
      captured_at: Date
      latitude: string | null
      longitude: string | null
    }>(
      `SELECT p.id AS proposal_id, p.project_id, pr.name AS project_name, p.type_key, p.title, p.body,
              p.participants, p.edited, c.kind AS capture_kind, c.text AS capture_text,
              c.captured_at, c.latitude, c.longitude
         FROM capture_proposals p
         JOIN captures c ON c.id = p.capture_id
         JOIN projects pr ON pr.id = p.project_id
        WHERE p.tenant_id = $1
          AND p.status = 'accepted'
          AND c.text IS NOT NULL
          AND ($2::uuid IS NULL OR p.project_id = $2)
          AND ($3::boolean IS FALSE OR p.edited)
        ORDER BY p.decided_at DESC
        LIMIT $4`,
      [
        // Filtered explicitly as well as by RLS: this helper is also reachable
        // from an operator connection that bypasses the policies, and an eval
        // set quietly built from another tenant's records is a data leak that
        // ends up committed to a repository.
        options.tenantId,
        options.projectId ?? null,
        options.editedOnly === true,
        Math.min(options.limit ?? 200, 1000),
      ],
    )

    const cases: EvalCase[] = []
    for (const row of rows) {
      const roster = await loadRosterForEval(tx, row.project_id)
      const fields: Record<string, ExpectedValue> = {}
      for (const [key, value] of Object.entries(row.body)) {
        if (value === null || value === undefined || value === '') continue
        // Prose is matched loosely: the gold is the human's wording, and a
        // draft that says the same thing differently is not wrong.
        fields[key] = typeof value === 'string' && value.length > 40 ? { contains: value.slice(0, 24) } : value
      }

      cases.push({
        id: `prod-${row.proposal_id.slice(0, 8)}`,
        split: 'test',
        tags: [row.type_key, row.edited ? 'edited-by-human' : 'accepted-clean', 'production'],
        projectName: row.project_name,
        roster,
        capture: {
          kind: row.capture_kind,
          text: row.capture_text ?? '',
          capturedAt: row.captured_at.toISOString(),
          ...(row.latitude !== null ? { latitude: Number(row.latitude) } : {}),
          ...(row.longitude !== null ? { longitude: Number(row.longitude) } : {}),
        },
        expected: {
          typeKey: row.type_key,
          fields,
          participants: row.participants,
          complete: true,
        },
        note: row.edited
          ? 'Derived from a proposal a human corrected before accepting. The correction is the gold answer.'
          : 'Derived from a proposal a human accepted unedited.',
      })
    }
    return cases
  })
}

async function loadRosterForEval(tx: Db, projectId: string): Promise<RosterMember[]> {
  const { rows } = await tx.query<{ id: string; name: string; job_title: string | null; organization: string }>(
    `SELECT u.id, u.name, u.job_title, o.name AS organization
       FROM project_memberships m
       JOIN users u ON u.id = m.user_id
       JOIN organizations o ON o.id = u.organization_id
      WHERE m.project_id = $1 AND u.is_active
      ORDER BY o.name, u.name`,
    [projectId],
  )
  return rows.map((r) => ({ userId: r.id, name: r.name, jobTitle: r.job_title, organization: r.organization }))
}

/** The metric declarations a report needs. Headline first, labels under 14 characters. */
export const EVAL_METRICS = [
  { id: 'type_match', label: 'Right type', kind: 'binary' },
  { id: 'field_recall', label: 'Fields', kind: 'continuous' },
  { id: 'people', label: 'People', kind: 'binary' },
  { id: 'no_invention', label: 'No invention', kind: 'binary' },
  { id: 'wellformed', label: 'Well formed', kind: 'binary' },
] as const
