import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { CaptureService } from '../../src/capture/service.js'
import { exportCasesFromProduction, runEval, type EvalCase } from '../../src/capture/eval.js'
import { createPool, withTenant } from '../../src/db.js'
import type { InterpretationProvider, ProviderRequest, ProviderResponse } from '../../src/capture/interpreter.js'
import { loadRecordTypes } from '../../src/repositories/record-types.js'
import {
  addProjectMember,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
} from '../../src/provisioning.js'

/**
 * Two jobs here.
 *
 * First, audit the case file itself against the live type registry: a suite
 * whose gold answers name fields that no longer exist scores a model against a
 * product that shipped two migrations ago, and nothing else in CI would notice.
 *
 * Second, run the harness end to end against a real database so the prompt it
 * grades is the prompt the product builds.
 */

const CASES_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../eval/cases/capture-v1.jsonl',
)

const NIL_TENANT = '00000000-0000-0000-0000-000000000000'

let pool: Pool
let cases: EvalCase[]

/** Returns whatever was queued for each case id, by position. */
class QueuedProvider implements InterpretationProvider {
  readonly name = 'queued'
  readonly requests: ProviderRequest[] = []
  constructor(private readonly outputs: (unknown | Error)[]) {}

  async interpret(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request)
    const next = this.outputs.shift()
    if (next instanceof Error) throw next
    return {
      output: next,
      model: 'claude-opus-5',
      usage: { inputTokens: 1_000, outputTokens: 150, cacheReadTokens: 800, cacheWriteTokens: 0 },
    }
  }
}

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  const text = await readFile(CASES_FILE, 'utf8')
  cases = text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EvalCase)
})

afterAll(async () => {
  await pool?.end()
})

describe('the case file', () => {
  it('has enough cases, stratified, with a held-out slice', () => {
    expect(cases.length).toBeGreaterThanOrEqual(15)
    const splits = new Set(cases.map((c) => c.split))
    expect(splits).toContain('train')
    expect(splits).toContain('test')

    const ids = cases.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of cases) expect(c.tags[0]).toBeTruthy()
  })

  it('names only fields and options that the live registry actually declares', async () => {
    const types = await withTenant(pool, NIL_TENANT, (tx) => loadRecordTypes(tx))
    const problems: string[] = []

    for (const testCase of cases) {
      // '*' means the capture does not determine a type, so there is nothing
      // to check it against.
      if (testCase.expected.typeKey === '*') continue
      const type = types.get(testCase.expected.typeKey)
      if (!type) {
        problems.push(`${testCase.id}: unknown record type "${testCase.expected.typeKey}"`)
        continue
      }
      const declared = new Map(type.definition.fields.map((f) => [f.key, f]))

      for (const key of [
        ...Object.keys(testCase.expected.fields ?? {}),
        ...(testCase.expected.absentFields ?? []),
      ]) {
        const field = declared.get(key)
        if (!field) {
          problems.push(`${testCase.id}: ${type.key} has no field "${key}"`)
          continue
        }
        const want = testCase.expected.fields?.[key]
        // A gold answer outside a select's options can never be reached, which
        // silently caps the achievable score.
        if (field.options && typeof want === 'string' && !field.options.includes(want)) {
          problems.push(`${testCase.id}: "${want}" is not an option of ${key} (${field.options.join(', ')})`)
        }
      }

      const roster = new Set(testCase.roster.map((m) => m.userId))
      for (const participant of testCase.expected.participants ?? []) {
        if (!roster.has(participant.userId)) {
          problems.push(`${testCase.id}: expects ${participant.userId}, who is not on the case roster`)
        }
      }
    }

    expect(problems).toEqual([])
  })

  it('covers every record type the product ships, and the adversarial cases', async () => {
    const types = await withTenant(pool, NIL_TENANT, (tx) => loadRecordTypes(tx))
    const covered = new Set(cases.map((c) => c.expected.typeKey).filter((key) => key !== '*'))
    for (const key of types.keys()) expect(covered).toContain(key)

    const tags = new Set(cases.flatMap((c) => c.tags))
    // The cases that catch the failures worth catching.
    expect(tags).toContain('hallucination-probe')
    expect(tags).toContain('adversarial')
    expect(tags).toContain('hard')
    expect(cases.some((c) => c.expected.complete === false)).toBe(true)
    // At least one case where forcing a label would measure the labeller.
    expect(cases.some((c) => c.expected.typeKey === '*')).toBe(true)
    expect(cases.some((c) => (c.expected.absentFields ?? []).length > 0)).toBe(true)
  })
})

describe('runEval', () => {
  it('grades against the prompt the product actually builds', async () => {
    const subject = cases.find((c) => c.id === 'obs-safety')
    expect(subject).toBeDefined()

    const provider = new QueuedProvider([
      {
        typeKey: 'observation',
        title: 'Guardrail missing at level 5 north',
        fields: [
          { key: 'description', value: 'No guardrail on the north side of level 5 at the stair opening.' },
          { key: 'observation_type', value: 'Safety' },
          { key: 'priority', value: 'High' },
        ],
        participants: [],
        confidence: 0.9,
        rationale: 'Unsafe condition on site.',
      },
    ])

    const run = await runEval({ db: pool, provider, cases: [subject as EvalCase], tenantId: NIL_TENANT })

    expect(run.results).toHaveLength(1)
    expect(run.summary.headline).toBe(1)
    expect(run.summary.metrics.field_recall).toBe(1)
    expect(run.summary.costMicros).toBeGreaterThan(0)

    // The prompt came from the registry in the database, not a fixture: this
    // is what makes the eval sensitive to a migration that changes a type.
    const system = provider.requests[0]?.system ?? ''
    expect(system).toContain('observation —')
    expect(system).toContain('submittal —')
    expect(system).toContain('u-arch')
  })

  it('catches an invented field on the hallucination probe', async () => {
    const subject = cases.find((c) => c.id === 'rfi-no-spec-mentioned')
    expect(subject).toBeDefined()

    const provider = new QueuedProvider([
      {
        typeKey: 'rfi',
        title: 'Fire caulk at CMU head of wall',
        fields: [
          { key: 'question', value: 'Is fire caulk required at the top of the CMU wall in the electrical room?' },
          // Nothing in the capture mentions a spec section. This is the
          // failure the probe exists for.
          { key: 'spec_section', value: '07 84 13' },
        ],
        participants: [],
        confidence: 0.86,
        rationale: 'Firestopping question for the design team.',
      },
    ])

    const run = await runEval({ db: pool, provider, cases: [subject as EvalCase], tenantId: NIL_TENANT })
    const result = run.results[0]
    expect(result?.grade.type_match).toBe(1)
    expect(result?.grade.no_invention).toBe(0)
    expect(result?.explanation.no_invention).toContain('spec_section')
  })

  it('records a provider failure as an error rather than a zero', async () => {
    const subject = cases[0] as EvalCase
    const provider = new QueuedProvider([new Error('overloaded')])
    const run = await runEval({ db: pool, provider, cases: [subject], tenantId: NIL_TENANT })

    // Scoring plumbing as a model failure is how an eval quietly lies.
    expect(run.results).toHaveLength(0)
    expect(run.errors[0]?.failure).toBe('provider')
    expect(run.summary.errored).toBe(1)
  })

  it('scores an unparseable draft as a failure instead of dropping it', async () => {
    const subject = cases[0] as EvalCase
    const provider = new QueuedProvider([{ typeKey: 'change_order', title: 'x', fields: [], participants: [] }])
    const run = await runEval({ db: pool, provider, cases: [subject], tenantId: NIL_TENANT })
    expect(run.errors[0]?.failure).toBe('unparseable')
  })

  it('runs a whole suite concurrently and keeps results in a stable order', async () => {
    const subset = cases.slice(0, 6)
    const provider = new QueuedProvider(
      subset.map(() => ({
        typeKey: 'observation',
        title: 'Anything',
        fields: [{ key: 'description', value: 'Something seen on site.' }],
        participants: [],
        confidence: 0.5,
        rationale: '',
      })),
    )
    const run = await runEval({ db: pool, provider, cases: subset, tenantId: NIL_TENANT, concurrency: 3 })
    expect(run.results.length + run.errors.length).toBe(subset.length)
    const ids = run.results.map((r) => r.prompt_id)
    expect([...ids].sort()).toEqual(ids)
  })
})

describe('exportCasesFromProduction', () => {
  it('turns a proposal a human corrected into a case whose gold is the correction', async () => {
    const tenant = await provisionTenant(pool, {
      tenantName: 'Eval Export Co',
      admin: { email: 'admin@evalexport.test', name: 'Ada Admin', password: 'a-long-enough-password' },
    })

    const { projectId, userId } = await withTenant(pool, tenant.tenantId, async (tx) => {
      const project = await createProject(tx, tenant.tenantId, { number: 'EX-1', name: 'Export Tower' })
      const user = await createUser(tx, tenant.tenantId, {
        organizationId: tenant.organizationId,
        email: 'super@evalexport.test',
        name: 'Sid Super',
        companyPermissionTemplateId: await findTemplateByName(tx, tenant.tenantId, 'company', 'Employee'),
      })
      await addProjectMember(tx, tenant.tenantId, {
        projectId: project,
        userId: user,
        permissionTemplateId: await findTemplateByName(tx, tenant.tenantId, 'project', 'Superintendent'),
      })
      return { projectId: project, userId: user }
    })

    const actor = { tenantId: tenant.tenantId, userId }
    const provider = new QueuedProvider([
      {
        typeKey: 'observation',
        title: 'Something in the stair',
        fields: [{ key: 'description', value: 'Vague description the human will rewrite.' }],
        participants: [],
        confidence: 0.4,
        rationale: 'Unclear.',
      },
    ])
    const capture = new CaptureService(pool, provider)

    const signal = await capture.record(actor, {
      projectId,
      kind: 'voice',
      text: 'Something blocking the north stair landing, boxes and banding everywhere.',
    })
    const proposal = await capture.interpret(actor, signal.id)
    await capture.accept(actor, proposal.id, {
      body: { description: 'Boxes and banding blocking the north stair landing on level 3.' },
    })

    const exported = await exportCasesFromProduction(pool, { tenantId: tenant.tenantId, editedOnly: true })

    expect(exported).toHaveLength(1)
    const testCase = exported[0] as EvalCase
    expect(testCase.tags).toContain('edited-by-human')
    expect(testCase.tags).toContain('production')
    expect(testCase.capture.text).toContain('north stair landing')
    expect(testCase.expected.typeKey).toBe('observation')
    // The gold answer is what the human corrected it to, not what the model
    // said. That is the whole point of the loop.
    const goldDescription = testCase.expected.fields?.['description']
    expect(JSON.stringify(goldDescription)).toContain('Boxes and banding')
    expect(testCase.roster.some((m) => m.userId === userId)).toBe(true)
  })
})
