#!/usr/bin/env node
/**
 * Test runner for the Plumbline workspaces.
 *
 * Why this exists instead of `npm run test --workspaces`:
 *
 * 1. `npm run test --workspaces` does not propagate a workspace's non-zero
 *    exit status — a failing suite still produced an overall exit 0.
 * 2. More seriously, `vitest run` itself exits 0 despite reported failures
 *    when a project's globalSetup boots embedded-postgres: the lingering
 *    server process means vitest force-exits and the failure status is lost.
 *    Reproduced with an identical failing test: exit 1 without the
 *    globalSetup, exit 0 with it.
 *
 * Trusting either signal would let a genuinely broken test suite pass CI, so
 * this runner ignores exit codes entirely and derives the verdict from
 * vitest's JSON reporter — the actual per-test results. It fails closed: a
 * missing, empty, or unparseable report is treated as a failure, never a pass.
 *
 * Each package still streams its normal human-readable output.
 *
 * BUILD PREREQUISITES: this spawns `vitest` directly, which bypasses npm
 * lifecycle hooks — a package's own `pretest` does NOT run here (it only fires
 * on `npm test -w <pkg>`). Anything that must be built before the suites run
 * belongs in the ROOT `pretest`: today that is `shared`, which `api` imports as
 * a package, and `api` itself, whose `dist/server.js` the web tests boot.
 * A clean clone is the check that catches a miss here.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Packages with a test suite, in run order. */
const PACKAGES = [
  { name: '@plumbline/shared', dir: 'shared' },
  { name: '@plumbline/api', dir: 'api' },
  { name: '@plumbline/web', dir: 'web' },
]

function runVitest(cwd, reportPath) {
  return new Promise((resolve) => {
    const child = spawn(
      'npx',
      ['vitest', 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`],
      { cwd, stdio: 'inherit', shell: true },
    )
    child.on('close', (code) => resolve(code))
    child.on('error', () => resolve(1))
  })
}

/**
 * Read the JSON report and decide. Returns {ok, passed, failed, reason}.
 * Anything unexpected is a failure — never assume success.
 */
async function readVerdict(reportPath) {
  let raw
  try {
    raw = await readFile(reportPath, 'utf8')
  } catch {
    return { ok: false, passed: 0, failed: 0, reason: 'no JSON report was written' }
  }
  let report
  try {
    report = JSON.parse(raw)
  } catch {
    return { ok: false, passed: 0, failed: 0, reason: 'JSON report was unparseable' }
  }
  const passed = Number(report.numPassedTests ?? 0)
  const failed = Number(report.numFailedTests ?? 0)
  const suitesFailed = Number(report.numFailedTestSuites ?? 0)
  const total = Number(report.numTotalTests ?? 0)
  if (total === 0 && passed === 0) {
    return { ok: false, passed, failed, reason: 'report contained no tests' }
  }
  if (failed > 0 || suitesFailed > 0 || report.success === false) {
    return { ok: false, passed, failed, reason: `${failed} failing test(s), ${suitesFailed} failing suite(s)` }
  }
  return { ok: true, passed, failed, reason: '' }
}

const reportDir = await mkdtemp(path.join(tmpdir(), 'plumbline-testreports-'))
const summary = []

try {
  for (const pkg of PACKAGES) {
    console.log(`\n──────── ${pkg.name} ────────`)
    const reportPath = path.join(reportDir, `${pkg.dir}.json`)
    const exitCode = await runVitest(path.join(repoRoot, pkg.dir), reportPath)
    const verdict = await readVerdict(reportPath)
    summary.push({ pkg: pkg.name, exitCode, ...verdict })
  }
} finally {
  await rm(reportDir, { recursive: true, force: true }).catch(() => {})
}

console.log('\n════════ test summary ════════')
let anyFailed = false
for (const row of summary) {
  const status = row.ok ? 'PASS' : 'FAIL'
  const detail = row.ok ? `${row.passed} passed` : `${row.reason}`
  // Surface the disagreement rather than hiding it: a green suite that
  // reported exit 0 while failing is exactly the bug this runner guards.
  const note = row.ok || row.exitCode !== 0 ? '' : '  [vitest exited 0 despite failures]'
  console.log(`  ${status}  ${row.pkg} — ${detail}${note}`)
  if (!row.ok) anyFailed = true
}

if (anyFailed) {
  console.error('\nTests FAILED')
  process.exit(1)
}
console.log('\nAll suites passed')
process.exit(0)
