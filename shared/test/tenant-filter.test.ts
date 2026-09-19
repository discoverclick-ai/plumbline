import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A lint rule, written as a test because it has earned one.
 *
 * Five separate times now a helper has read or written a tenant-scoped table
 * without filtering on the tenant, leaning on row-level security to confine
 * it. Each time it looked correct. Each time it was wrong for the same reason:
 * RLS confines the application role, and this codebase also runs provisioning,
 * tests and operator scripts on a SUPERUSER connection, where every policy is
 * silently skipped.
 *
 * The failures are quiet, which is what makes them expensive. A template
 * lookup that crossed tenants would hand somebody another company's
 * permissions. A self-organization lookup that crossed tenants put one
 * project's people into another company and stayed invisible for weeks.
 * Neither threw.
 *
 * The rule is deliberately narrow, because a rule that fires forty times is a
 * rule somebody deletes. All of them had one shape: the function was HANDED a
 * tenant and then wrote a query that did not use it. That is the whole rule. A
 * query in a function with no tenant in scope is withTenant's problem, not
 * this one's.
 *
 * "Handed a tenant" means a `tenantId` parameter OR an `actor`, because an
 * Actor is a tenant id and a user id in a wrapper. The fifth bug was a project
 * existence check taking an actor: it said yes to another tenant's project id,
 * and a company admin could then create a record pointing at it. The rule
 * missed it because it was only looking for the word `tenantId`.
 *
 * Genuine exceptions carry `// tenant-filter-exempt: <reason>` above the line,
 * and the reason becomes part of the record.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOTS = [
  join(HERE, '..', 'src'),
  join(HERE, '..', '..', 'api', 'src'),
  // Two of the four lived in test harnesses. Those run as superuser against a
  // database several suites share, which makes them the most exposed code in
  // the repository rather than the least.
  join(HERE, 'integration'),
  join(HERE, '..', '..', 'api', 'test'),
  join(HERE, '..', '..', 'web', 'test'),
]

const TENANT_SCOPED = [
  'organizations',
  'users',
  'projects',
  'project_memberships',
  'permission_templates',
  'records',
  'record_number_sequences',
  'record_participants',
  'record_assignments',
  'record_state_history',
  'record_comments',
  'record_attachments',
  'record_events',
  'audit_log',
  'user_credentials',
  'sessions',
  'captures',
  'capture_proposals',
  'ai_usage',
  'project_distribution_defaults',
]

const EXEMPT = /(?:--|\/\/)\s*tenant-filter-exempt:/

/**
 * Function DECLARATIONS only, matched at the start of a line. An earlier
 * version treated any `name(` as a boundary, which meant `db.query(` counted
 * as a function with no tenant parameter and shadowed the real enclosing one,
 * so the rule silently found nothing. Lint rules that quietly pass are worse
 * than no lint rule.
 */
const DECLARATION =
  /^[ \t]*(?:export\s+)?(?:async\s+)?(?:function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?|\w+)\s*\(/gm

interface Offence {
  file: string
  line: number
  table: string
  statement: string
}

interface Boundary {
  index: number
  hasTenant: boolean
}

function boundariesIn(source: string): Boundary[] {
  const out: Boundary[] = []
  const re = new RegExp(DECLARATION.source, DECLARATION.flags)
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    // Parameters run from the opening paren to the body, which is good enough
    // for a signature spanning several lines.
    const head = source.slice(m.index, m.index + 600)
    const body = head.indexOf('{')
    const params = body > 0 ? head.slice(0, body) : head
    out.push({ index: m.index, hasTenant: /\btenantId\b/.test(params) || /\bactor\s*:/.test(params) })
  }
  return out
}

export function offencesInSource(file: string, source: string): Offence[] {
  const lines = source.split('\n')
  const boundaries = boundariesIn(source)
  const offences: Offence[] = []

  const literal = /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g
  let match: RegExpExecArray | null
  while ((match = literal.exec(source)) !== null) {
    const sql = match[2] ?? ''
    if (!/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(sql)) continue
    if (/tenant_id/i.test(sql)) continue

    const enclosing = boundaries.filter((b) => b.index < match!.index).at(-1)
    if (!enclosing?.hasTenant) continue

    const line = source.slice(0, match.index).split('\n').length
    const preceding = lines.slice(Math.max(0, line - 4), line).join('\n')
    if (EXEMPT.test(preceding) || EXEMPT.test(sql)) continue

    for (const table of TENANT_SCOPED) {
      if (new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+${table}\\b`, 'i').test(sql)) {
        offences.push({ file, line, table, statement: sql.replace(/\s+/g, ' ').trim().slice(0, 110) })
        break
      }
    }
  }
  return offences
}

function sourceFiles(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(path)
  }
  return out
}

/**
 * A second rule, from the same afternoon.
 *
 * Two subsystems in this product were built, tested, committed and left with
 * no way for any client to call them: the submittal register and the Procore
 * importer. Both had a service, both had integration tests, and neither had a
 * single route. A backend nothing can reach is a promise, and passing tests
 * on it are a promise with a green tick.
 *
 * So the check is mechanical: every service class the shared package exports
 * is either reachable from the API or listed here as deliberately not. The
 * exemptions are the worker's, which run on a schedule and must NOT be
 * exposed over HTTP.
 */
const WORKER_ONLY = new Set([
  // Cursor-driven passes over the whole event log, across every tenant. A
  // route for one of these would let any project member do another tenant's
  // processing.
  'FinancialPostingService',
  'NotificationService',
])

describe('every service can be called by something', () => {
  it('finds no subsystem stranded without a route', () => {
    const shared = sourceFiles(join(HERE, '..', 'src'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')
    const server = readFileSync(join(HERE, '..', '..', 'api', 'src', 'server.ts'), 'utf8')

    const services = [
      ...new Set(
        [...shared.matchAll(/^export class (\w+(?:Service|Engine|Importer|Runner))\b/gm)].map((m) => m[1] as string),
      ),
    ]
    expect(services.length).toBeGreaterThan(10)

    // Word-boundary, not `includes`. A first version used `includes` and did
    // not fire when the reference was renamed to `ProcoreImporterXX`: a lint
    // rule that quietly passes is worse than no lint rule, which is the same
    // lesson the tenant-filter rule below learned the hard way.
    const stranded = services.filter(
      (name) => !WORKER_ONLY.has(name) && !new RegExp(`\\b${name}\\b`).test(server),
    )

    expect(
      stranded,
      `\n${stranded.join(', ')}\n\nEither wire it to a route, or add it to WORKER_ONLY with a reason.\n`,
    ).toEqual([])
  })
})

describe('a function handed a tenant id uses it', () => {
  it('finds nothing leaning on row-level security alone', () => {
    const offences = ROOTS.flatMap(sourceFiles).flatMap((file) =>
      offencesInSource(file, readFileSync(file, 'utf8')),
    )
    const report = offences
      .map((o) => `${o.file.split('/').slice(-3).join('/')}:${o.line} (${o.table})\n    ${o.statement}`)
      .join('\n')

    expect(
      offences,
      `\n${report}\n\nEither filter on tenant_id, or justify it with\n  // tenant-filter-exempt: <reason>\n`,
    ).toEqual([])
  })

  it('catches the bug it was written for', () => {
    // The self-organization lookup from the web harness, verbatim. It returned
    // another suite's company once two suites shared a database.
    const offences = offencesInSource(
      'inline.ts',
      [
        'export async function seedProject(pool: Pool, tenantId: string, label: string) {',
        "  const self = await tx.query('SELECT id FROM organizations WHERE is_self LIMIT 1')",
        '}',
      ].join('\n'),
    )
    expect(offences).toHaveLength(1)
    expect(offences[0]?.table).toBe('organizations')
  })

  it('treats an actor as a tenant, because that is what an actor is', () => {
    // The fifth bug, verbatim. RLS does not confine an owner connection, so
    // this said yes to another tenant's project and a company admin could
    // create a record pointing at it.
    const offences = offencesInSource(
      'inline.ts',
      [
        'async function assertProjectExists(tx: Db, actor: Actor, projectId: string) {',
        "  const { rows } = await tx.query('SELECT 1 FROM projects WHERE id = $1', [projectId])",
        '}',
      ].join('\n'),
    )
    expect(offences).toHaveLength(1)
    expect(offences[0]?.table).toBe('projects')
  })

  it('does not complain where there is no tenant to use', () => {
    expect(
      offencesInSource(
        'inline.ts',
        [
          'export async function findRecord(db: Db, recordId: string) {',
          "  return db.query('SELECT * FROM records WHERE id = $1', [recordId])",
          '}',
        ].join('\n'),
      ),
    ).toEqual([])
  })

  it('is satisfied by a query that does filter', () => {
    expect(
      offencesInSource(
        'inline.ts',
        [
          'export async function listProjects(db: Db, tenantId: string) {',
          "  return db.query('SELECT * FROM projects WHERE tenant_id = $1', [tenantId])",
          '}',
        ].join('\n'),
      ),
    ).toEqual([])
  })

  it('accepts a justified exemption', () => {
    expect(
      offencesInSource(
        'inline.ts',
        [
          'export async function odd(db: Db, tenantId: string, projectId: string) {',
          '  // tenant-filter-exempt: confined by the project, which was checked above',
          "  return db.query('SELECT * FROM records WHERE project_id = $1', [projectId])",
          '}',
        ].join('\n'),
      ),
    ).toEqual([])
  })
})
