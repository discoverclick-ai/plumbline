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

/**
 * Every tenant-scoped table, read from the migrations.
 *
 * This was a hand-written list of twenty names, and the schema is past
 * seventy tables. Everything added after the list was written — the budget,
 * commitments, invoices, contracts, clocks, photos, the statutory tables —
 * was simply not watched, and the rule reported a clean scan the whole time.
 * A lint rule with a stale allowlist does not fail; it reassures, which is
 * worse than not existing.
 *
 * So it is derived. A table is tenant-scoped if its CREATE TABLE has a
 * `tenant_id` column, which is the same fact the row-level security policies
 * are built on, and adding a table to the product now adds it to this rule
 * with nothing to remember.
 */
export function tenantScopedTables(migrationsDir: string): string[] {
  const sql = sourceFiles(migrationsDir, /\.sql$/)
    .sort()
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n')

  const tables: string[] = []
  const create = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(/gi
  let m: RegExpExecArray | null
  while ((m = create.exec(sql)) !== null) {
    const name = m[1] as string
    // Balance the parens rather than stopping at the first ");", because a
    // CHECK constraint or a DEFAULT can contain one.
    let depth = 0
    let k = create.lastIndex - 1
    for (; k < sql.length; k += 1) {
      if (sql[k] === '(') depth += 1
      else if (sql[k] === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    if (/\btenant_id\b/.test(sql.slice(create.lastIndex, k))) tables.push(name)
  }
  return [...new Set(tables)]
}

const TENANT_SCOPED = tenantScopedTables(join(HERE, '..', '..', 'db', 'migrations'))

const EXEMPT = /(?:--|\/\/)\s*tenant-filter-exempt:/

/**
 * Function DECLARATIONS only, matched at the start of a line. An earlier
 * version treated any `name(` as a boundary, which meant `db.query(` counted
 * as a function with no tenant parameter and shadowed the real enclosing one,
 * so the rule silently found nothing. Lint rules that quietly pass are worse
 * than no lint rule.
 *
 * Requiring the start of a line was not enough. `if (`, `for (` and `catch (`
 * all sit at the start of a line and all match `\w+\s*\(`, so each one
 * became a boundary with no tenant parameter and shadowed the real method
 * around it. Every query in this product that sits after a conditional — most
 * of the interesting ones — was invisible to the rule, which reported a clean
 * scan the whole time. That is the same failure as the stale table list, in a
 * different place: the rule did not fail, it reassured.
 */
const KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'do',
  'else',
  'await',
  'typeof',
  'new',
  'yield',
  'throw',
])

const DECLARATION =
  /^[ \t]*(?:export\s+)?(?:async\s+)?(?:function\s+(?<fn>\w+)|const\s+(?<c>\w+)\s*=\s*(?:async\s*)?|(?<m>\w+))\s*\(/gm

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

/**
 * The end of the argument list, found by balancing rather than by regex.
 *
 * A parameter list routinely contains parentheses — a default value, an
 * inline function type — and the first `)` is frequently not the last one.
 */
function closingParen(source: string, open: number): number {
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1
    else if (source[i] === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * A declaration has a BODY after its arguments. A call does not.
 *
 * This is the third shape that fooled the rule, and the worst of them,
 * because it looks so much like a declaration: `assertMoney(input.amount)` at
 * the start of a line matched `\w+\s*\(` exactly as `async revise(` does, so
 * a guard clause at the top of a method became the enclosing "function" —
 * one with no tenant parameter, which made everything after it exempt. The
 * method that had `actor: Actor` right there in its signature was never
 * consulted.
 *
 * So the test is what follows the closing paren: a return type annotation at
 * most, then `{` or `=>`. Nothing else is a declaration.
 */
function isDeclaration(source: string, open: number): boolean {
  const close = closingParen(source, open)
  if (close === -1) return false
  const tail = source.slice(close + 1, close + 200)
  return /^\s*(?::[^{;=]*)?(?:\{|=>)/.test(tail)
}

function boundariesIn(source: string): Boundary[] {
  const out: Boundary[] = []
  const re = new RegExp(DECLARATION.source, DECLARATION.flags)
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    const name = m.groups?.['fn'] ?? m.groups?.['c'] ?? m.groups?.['m'] ?? ''
    if (KEYWORDS.has(name)) continue
    const open = m.index + m[0].length - 1
    if (!isDeclaration(source, open)) continue
    // Parameters run from the opening paren to the closing one, which is
    // good enough for a signature spanning several lines.
    const params = source.slice(m.index, closingParen(source, open) + 1)
    out.push({ index: m.index, hasTenant: /\btenantId\b/.test(params) || /\bactor\s*:/.test(params) })
  }
  return out
}

/**
 * Blanks every comment, keeping offsets and line numbers exactly.
 *
 * This exists because the rule used to pair quotes with a regex over the raw
 * file, and an APOSTROPHE IN PROSE is a quote character. One "a machine's
 * reading" in a comment shifted the pairing for every literal after it in the
 * file, and the rule then reported a real query under the wrong table name at
 * the wrong line — which reads exactly like a genuine find and sends you
 * hunting through code that is fine.
 *
 * A comment-stripper that is itself a regex would have the same problem in
 * reverse (a `//` inside a URL string), so this walks the characters and
 * tracks what it is inside. Thirty lines to stop a lint rule lying is a good
 * trade: the second time a rule in this file matched the wrong thing, the
 * fix was making it match properly rather than remembering the quirk.
 */
export function blankComments(source: string): string {
  const out = source.split('')
  let i = 0
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n') out[k] = ' '
    }
  }

  while (i < source.length) {
    const two = source.slice(i, i + 2)
    if (two === '//') {
      const end = source.indexOf('\n', i)
      blank(i, end === -1 ? source.length : end)
      i = end === -1 ? source.length : end
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2)
      blank(i, end === -1 ? source.length : end + 2)
      i = end === -1 ? source.length : end + 2
    } else if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
      const quote = source[i]
      i += 1
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === quote) break
        i += 1
      }
      i += 1
    } else {
      i += 1
    }
  }
  return out.join('')
}

export function offencesInSource(file: string, rawSource: string): Offence[] {
  // Line numbers and the exemption markers come from the file as written;
  // the literal scan runs over the same bytes with comments blanked.
  const source = blankComments(rawSource)
  const lines = rawSource.split('\n')
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

function sourceFiles(dir: string, pattern = /\.tsx?$/): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path, pattern))
    else if (pattern.test(entry) && !entry.endsWith('.d.ts')) out.push(path)
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

/**
 * The same rule, one layer further out.
 *
 * A route with no client is the same failure as a service with no route, and
 * the product had a whole subsystem in that state: record attachments had a
 * service, routes to upload, list and download, integration tests over all
 * three, and not one line in the web client that called any of them. A record
 * could hold the sketch that answers the RFI and no screen could put one
 * there.
 *
 * So the check is mechanical: every path the API serves is either fetched by
 * the web client or named here as deliberately not. The exemptions are the
 * things a browser genuinely never calls.
 */
const NOT_FOR_THE_BROWSER = new Set([
  // The MCP surface. A customer's agent speaks this; the web client has no
  // reason to, and giving it one would mean the browser could ask for work
  // the agent gate is there to mediate.
  '/mcp/tools',
  '/mcp/call',
  // The device sync protocol, for a client that keeps a local copy and
  // reconciles. The web app is online-only and pulls live, so these are for
  // the field client that does not exist yet rather than for this one.
  '/sync/devices',
  '/sync/pull',
  '/sync/push',
])

/**
 * Routes with a service, a test and no screen. The honest backlog.
 *
 * Every one of these is a working subsystem a customer cannot reach, which is
 * the gap between what this product does and what it looks like it does. They
 * are listed rather than exempted, and the assertion below is a RATCHET: a
 * new unreachable route fails the build, and an entry that has since been
 * wired up fails it too, so the list can only shrink and cannot quietly
 * become a graveyard.
 */
const NOT_YET_IN_THE_CLIENT = [
  // Capture: reading a file without proposing a record off it, and what the
  // pipeline has cost.
  '/captures/:captureId/transcribe',
  '/projects/:projectId/capture-stats',
  // Money: revising a budget line, change orders against a commitment,
  // releasing retainage, and the accounting export.
  '/budget-lines/:budgetLineId/revisions',
  '/commitments/:commitmentId/change-orders',
  '/commitment-change-orders/:changeOrderId/execute',
  '/invoice-lines/:invoiceLineId/release-retainage',
  '/projects/:projectId/erp-export',
  // Bringing a job across from Procore.
  '/projects/:projectId/imports/procore/rfis',
  // Specifications: the book, its sections, and pulling submittal
  // requirements out of one.
  '/projects/:projectId/specification-books',
  '/specification-books/:bookId/sections',
  '/specification-sections/:sectionId/extract',
  // Photos: albums, and the photographs attached to a record.
  '/photo-albums/:albumId/photos',
  '/records/:recordId/photos',
  // Contracts: where a clause came from, flowing a requirement down to a
  // subcontract, and the obligations extracted from an instrument.
  '/contracts/:documentId/lineage',
  '/contracts/:documentId/flow-down',
  '/projects/:projectId/obligations',
  // The working calendar a deadline is counted against.
  '/projects/:projectId/calendar',
  '/projects/:projectId/calendar/holidays',
]

/**
 * `/projects/:projectId/records` → a regex the client's own path must match.
 *
 * A parameter becomes `${...}`, and the whole thing may be written in a
 * template literal or, where it has no parameters, in ordinary quotes. Both
 * are how the client actually writes paths, and a pattern that insisted on
 * backticks reported a dozen routes as unreachable that are called on every
 * page load — a lint rule crying wolf gets muted, which is the same failure
 * as one that never fires.
 */
function pathPattern(path: string): RegExp {
  const source = path
    .split('/')
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith(':')
        ? '\\$\\{[^}]+\\}'
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/')
  // Ends at a quote, a query string, or another segment.
  return new RegExp(`['"\`]?/${source}(['"\`]|\\?|/|\\$\\{)`)
}

describe('every route can be called by something', () => {
  it('finds no API route the client cannot reach', () => {
    const server = readFileSync(join(HERE, '..', '..', 'api', 'src', 'server.ts'), 'utf8')
    const client = readFileSync(join(HERE, '..', '..', 'web', 'src', 'api', 'client.ts'), 'utf8')

    const paths = [
      ...new Set([...server.matchAll(/route\(\s*'[A-Z]+',\s*'([^']+)'/g)].map((m) => m[1] as string)),
    ]
    expect(paths.length).toBeGreaterThan(50)

    const unreachable = paths.filter((path) => !NOT_FOR_THE_BROWSER.has(path) && !pathPattern(path).test(client))
    const known = new Set(NOT_YET_IN_THE_CLIENT)

    const surprises = unreachable.filter((path) => !known.has(path))
    expect(
      surprises,
      `\n${surprises.join('\n')}\n\nA route with no client is a subsystem a customer cannot reach. Call it from the web client, or add it to NOT_YET_IN_THE_CLIENT with a reason.\n`,
    ).toEqual([])
  })

  it('has no stale entries on the backlog', () => {
    // The half of the ratchet that makes it one. Without this the list is a
    // graveyard: routes get wired up, nobody removes them from here, and the
    // number stops meaning anything.
    const server = readFileSync(join(HERE, '..', '..', 'api', 'src', 'server.ts'), 'utf8')
    const client = readFileSync(join(HERE, '..', '..', 'web', 'src', 'api', 'client.ts'), 'utf8')
    const served = new Set([...server.matchAll(/route\(\s*'[A-Z]+',\s*'([^']+)'/g)].map((m) => m[1] as string))

    const stale = NOT_YET_IN_THE_CLIENT.filter(
      (path) => !served.has(path) || pathPattern(path).test(client),
    )
    expect(
      stale,
      `\n${stale.join('\n')}\n\nThese are reachable now, or no longer served. Delete them from NOT_YET_IN_THE_CLIENT.\n`,
    ).toEqual([])
  })
})

describe('a function handed a tenant id uses it', () => {
  it('finds nothing leaning on row-level security alone', () => {
    // Called through an arrow, not passed by reference: flatMap hands the
    // callback an INDEX as its second argument, which lands in the pattern
    // parameter as a number.
    const offences = ROOTS.flatMap((root) => sourceFiles(root)).flatMap((file) =>
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

  it('is not thrown off by an apostrophe in prose', () => {
    // How this rule started lying. It paired quotes with a regex over the raw
    // file, so "a machine's reading" in a comment opened a string that ran to
    // the next apostrophe, and every literal after it in the file was paired
    // one off. The rule then reported a query that WAS filtered, under the
    // wrong table, at the wrong line — which reads exactly like a real find.
    const offences = offencesInSource(
      'inline.ts',
      [
        'export async function fine(db: Db, tenantId: string) {',
        "  // A machine's reading and a person's words are not the same fact.",
        "  return db.query('SELECT * FROM records WHERE tenant_id = $1', [tenantId])",
        '}',
      ].join('\n'),
    )
    expect(offences).toEqual([])
  })

  it('still sees a real offence sitting under a comment full of apostrophes', () => {
    const offences = offencesInSource(
      'inline.ts',
      [
        'export async function bad(db: Db, tenantId: string, id: string) {',
        "  // The crew's note, the foreman's account, somebody's guess.",
        "  return db.query('SELECT * FROM records WHERE id = $1', [id])",
        '}',
      ].join('\n'),
    )
    expect(offences).toHaveLength(1)
    expect(offences[0]?.table).toBe('records')
  })

  it('does not mistake a URL for a comment', () => {
    // The obvious way to strip comments is a regex for //, which eats the
    // rest of any line holding an https:// and takes a real query with it.
    const offences = offencesInSource(
      'inline.ts',
      [
        'export async function bad(db: Db, tenantId: string, id: string) {',
        "  const docs = 'https://example.test/docs'",
        "  return db.query('SELECT * FROM records WHERE id = $1', [id, docs])",
        '}',
      ].join('\n'),
    )
    expect(offences).toHaveLength(1)
    expect(offences[0]?.table).toBe('records')
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
