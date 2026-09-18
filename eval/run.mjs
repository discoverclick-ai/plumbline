#!/usr/bin/env node
/**
 * The capture interpreter eval runner.
 *
 *   node plumbline/eval/run.mjs                        # score with the real model
 *   node plumbline/eval/run.mjs --provider=selftest    # exercise the harness, no key, no spend
 *   node plumbline/eval/run.mjs --split=test           # held-out slice only
 *   node plumbline/eval/run.mjs --check                # fail on regression against the baseline
 *   node plumbline/eval/run.mjs --save-baseline        # record the current run as the baseline
 *   node plumbline/eval/run.mjs --export > cases.jsonl # pull new cases out of production
 *
 * DATABASE_URL is required: the record type registry is loaded from the
 * database, exactly as the product loads it, so a migration that changes a
 * type's fields changes the eval too. An eval that stubs the registry cannot
 * catch that class of regression at all.
 *
 * Output goes to plumbline/eval/runs/<name>/ as results.jsonl, errors.jsonl,
 * traces/<id>_rep0.json and _state.json — the layout the bundled hillclimb
 * report builder consumes, so `report.html` is one command away.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AnthropicInterpretationProvider,
  checkAgainstBaseline,
  createPool,
  EVAL_METRICS,
  exportCasesFromProduction,
  runEval,
} from '@plumbline/shared'
import { SelfTestProvider } from './selftest-provider.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * `record_types` is a global catalogue with no row-level security, so any
 * tenant context loads it. The nil UUID makes it obvious that the eval is not
 * reading anybody's data.
 */
const NIL_TENANT = '00000000-0000-0000-0000-000000000000'

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  const [, value] = hit.split('=')
  return value ?? true
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

async function loadCases(file, split) {
  const text = await readFile(file, 'utf8')
  const cases = text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line)
      } catch (err) {
        throw new Error(`${file}:${i + 1} is not valid JSON: ${err.message}`)
      }
    })
  return split && split !== 'all' ? cases.filter((c) => c.split === split) : cases
}

function pct(value) {
  return value === null ? '  n/a' : `${(value * 100).toFixed(1)}%`
}

function table(results) {
  const width = Math.max(12, ...results.map((r) => r.prompt_id.length))
  const lines = [
    `${'case'.padEnd(width)}  type  field  ppl  noinv  form  conf  why`,
    `${'-'.repeat(width)}  ----  -----  ---  -----  ----  ----  ---`,
  ]
  for (const r of results) {
    const g = r.grade
    const why = Object.entries(r.explanation)
      .map(([metric, text]) => `${metric}: ${text}`)
      .join(' | ')
    lines.push(
      [
        r.prompt_id.padEnd(width),
        g.type_match === null ? ' -- ' : g.type_match ? ' ok ' : 'MISS',
        g.field_recall === null ? '   --' : g.field_recall.toFixed(2).padStart(5),
        g.people ? ' ok' : ' no',
        g.no_invention ? '  ok ' : ' INV ',
        g.wellformed ? ' ok ' : 'FLAG',
        r.confidence.toFixed(2),
        why,
      ].join('  '),
    )
  }
  return lines.join('\n')
}

async function main() {
  if (!process.env.DATABASE_URL) {
    fail('DATABASE_URL is required — the type registry is loaded from the database, like the product does.')
  }

  const pool = createPool()
  try {
    if (arg('export')) {
      const tenantId = arg('tenant')
      if (!tenantId) fail('--export needs --tenant=<uuid>')
      const cases = await exportCasesFromProduction(pool, {
        tenantId,
        ...(arg('project') ? { projectId: arg('project') } : {}),
        editedOnly: arg('edited-only') === true,
        limit: Number(arg('limit', '200')),
      })
      for (const c of cases) process.stdout.write(`${JSON.stringify(c)}\n`)
      console.error(`exported ${cases.length} case(s) from production`)
      return
    }

    const providerName = arg('provider', 'anthropic')
    const synthetic = providerName === 'selftest'
    const provider = synthetic
      ? new SelfTestProvider()
      : new AnthropicInterpretationProvider({ ...(arg('model') ? { model: arg('model') } : {}) })

    const casesFile = arg('cases', path.join(here, 'cases', 'capture-v1.jsonl'))
    const split = arg('split', 'all')
    const cases = await loadCases(casesFile, split)
    if (cases.length === 0) fail(`no cases matched in ${casesFile} (split=${split})`)

    if (!synthetic) {
      console.error(`Running ${cases.length} case(s) against the real model. This spends money.`)
    }

    const started = Date.now()
    let done = 0
    const run = await runEval({
      db: pool,
      provider,
      cases,
      tenantId: NIL_TENANT,
      concurrency: Number(arg('concurrency', '4')),
      onCase: () => {
        done += 1
        process.stderr.write(`\r${done}/${cases.length} cases`)
      },
    })
    process.stderr.write('\n')

    const runName = arg('name', synthetic ? 'selftest' : 'baseline')
    const outDir = arg('out', path.join(here, 'runs', runName))
    await mkdir(path.join(outDir, 'traces'), { recursive: true })

    await writeFile(
      path.join(outDir, 'results.jsonl'),
      run.results.map((r) => JSON.stringify({ ...r, trace: undefined })).join('\n') + '\n',
    )
    await writeFile(
      path.join(outDir, 'errors.jsonl'),
      run.errors.map((e) => JSON.stringify(e)).join('\n') + (run.errors.length ? '\n' : ''),
    )
    for (const result of run.results) {
      await writeFile(
        path.join(outDir, 'traces', `${result.prompt_id}_rep0.json`),
        JSON.stringify(result.trace, null, 2),
      )
    }
    await writeFile(
      path.join(outDir, '_state.json'),
      JSON.stringify(
        {
          schema: 'hillclimb/v2',
          metrics: EVAL_METRICS,
          perf_fields: ['latency_s', 'usage'],
          synthetic,
          generated_at: new Date().toISOString(),
          cases: casesFile,
          split,
        },
        null,
        2,
      ),
    )
    await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(run.summary, null, 2))

    const s = run.summary
    console.log(`\n${table(run.results)}\n`)
    if (synthetic) {
      console.log('PROVIDER: selftest stub — these numbers measure the harness, NOT a model.\n')
    }
    console.log(`cases          ${s.cases} scored, ${s.errored} errored (${split} split)`)
    console.log(`right type     ${pct(s.metrics.type_match)}   <- headline (scored where a type was determinable)`)
    console.log(`field recall   ${pct(s.metrics.field_recall)}`)
    console.log(`people         ${pct(s.metrics.people)}`)
    console.log(`no invention   ${pct(s.metrics.no_invention)}`)
    console.log(`well formed    ${pct(s.metrics.wellformed)}`)
    console.log(`calibration    ${s.calibration.toFixed(3)} Brier (0.25 = always guessing 0.5)`)
    console.log(`noise floor    ±${s.noiseFloorPoints} points at n=${s.cases} — smaller moves are not results`)
    console.log(`cost           $${(s.costMicros / 1_000_000).toFixed(4)} total, ${s.meanLatencySeconds}s mean latency`)
    console.log(`written to     ${path.relative(process.cwd(), outDir)}`)

    const baselineFile = arg('baseline', path.join(here, 'baseline.json'))

    if (arg('save-baseline')) {
      if (synthetic) {
        fail('\nRefusing to write a baseline from the selftest stub. Run against a real model first.')
      }
      await writeFile(baselineFile, JSON.stringify(run.summary, null, 2))
      console.log(`baseline       updated at ${path.relative(process.cwd(), baselineFile)}`)
      return
    }

    if (arg('check')) {
      let baseline
      try {
        baseline = JSON.parse(await readFile(baselineFile, 'utf8'))
      } catch {
        fail(`\nNo baseline at ${baselineFile}. Record one with --save-baseline against a real model.`)
      }
      const check = checkAgainstBaseline(run.summary, baseline)
      if (!check.passed) {
        console.error('\nREGRESSION:')
        for (const failure of check.failures) console.error(`  ${failure}`)
        process.exit(1)
      }
      console.log('\nno regression against the baseline')
    }
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
