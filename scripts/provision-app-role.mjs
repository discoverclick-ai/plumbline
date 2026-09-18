#!/usr/bin/env node
/**
 * Gives `plumbline_app` a login, proves it is actually confined by row-level
 * security, and only then writes the connection string.
 *
 * WHY THIS STEP EXISTS AT ALL
 *
 * Migration 0006 enables and FORCES row-level security on every tenant-scoped
 * table, then creates `plumbline_app` — a role with the grants the application
 * needs and, critically, without BYPASSRLS. It is created NOLOGIN on purpose:
 * issuing a credential is a deployment decision, not a schema one, and no
 * password belongs in a migration file.
 *
 * The consequence is a failure mode that is silent and total. Skip this step,
 * connect as whatever owner role the platform handed you, and every policy is
 * bypassed: tenant isolation is present in the schema and absent in reality.
 * Nothing errors. Nothing looks wrong. Queries simply return other tenants'
 * rows. Managed Postgres platforms routinely hand you an owner role carrying
 * BYPASSRLS — on Neon, `neondb_owner` does.
 *
 * It matters more here than in an ordinary application, because this database
 * is read by agents on a user's behalf. A retrieval layer running as a role
 * that bypasses RLS is a data breach waiting for its first prompt injection.
 *
 * Hence the verification below, which refuses to write a connection string
 * that has not demonstrated confinement in BOTH directions:
 *
 *   * with no tenant context, the role must see nothing;
 *   * with a tenant context, it must see that tenant's rows.
 *
 * The second half is what distinguishes "row-level security is working" from
 * "this role cannot read anything at all" — both of which produce zero rows on
 * the first check, and only one of which is a working deployment.
 *
 * Usage:
 *   OWNER_DATABASE_URL=postgresql://<owner>@<pooled-host>/<db> \
 *     node scripts/provision-app-role.mjs [--print]
 *
 * Re-running is safe; it rotates the password. `--print` writes the URL to
 * stdout instead of to a file, for deployments whose secrets live somewhere
 * other than a dotfile.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import pg from 'pg'

const ENV_PATH = '.env.local'
const ROLE = 'plumbline_app'
const printOnly = process.argv.includes('--print')

try {
  process.loadEnvFile(ENV_PATH)
} catch {
  // Fine — the variable may already be in the environment, or there may be no
  // file yet on a fresh clone.
}

const ownerUrl = process.env.OWNER_DATABASE_URL
if (!ownerUrl) {
  console.error(
    'OWNER_DATABASE_URL is not set. It must be a connection string for a role that can ALTER ROLE\n' +
      '(on Neon that is neondb_owner). Prefer the POOLED host so the app URL derived from it is pooled too.',
  )
  process.exit(1)
}

// Hex: no escaping needed in the SQL literal below, and no percent-encoding
// needed in the URL. Those are the two places a generated secret usually breaks.
const password = randomBytes(24).toString('hex')

const admin = new pg.Client({ connectionString: ownerUrl })
await admin.connect()
let probeTenantId = null
try {
  const roleExists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE])
  if (roleExists.rowCount === 0) {
    console.error(`Role ${ROLE} does not exist. Run the migrations first: npm run migrate`)
    process.exit(1)
  }

  await admin.query(`ALTER ROLE ${ROLE} WITH LOGIN PASSWORD '${password}'`)
  // Without these, a table added by a future migration would be invisible to
  // the app role — the same silent failure in a new disguise.
  await admin.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE}`,
  )
  await admin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ROLE}`)

  // Read through the owner connection, which bypasses RLS, so the positive
  // check below has a real tenant to scope to. The app role cannot find one
  // itself: with no context set it can see no tenants, which is the point.
  const anyTenant = await admin.query('SELECT id::text AS id FROM tenants LIMIT 1')
  probeTenantId = anyTenant.rows[0]?.id ?? null
} finally {
  await admin.end()
}

const appUrl = ownerUrl.replace(/^postgres(ql)?:\/\/[^@]+@/, (m) =>
  m.replace(/\/\/[^@]+@/, `//${ROLE}:${password}@`),
)

/**
 * Prove the role is confined before trusting it. A connection string that
 * silently bypasses row-level security is worse than none, because it looks
 * like it works.
 */
const app = new pg.Client({ connectionString: appUrl })
await app.connect()
let verdict
try {
  const who = await app.query(
    'SELECT current_user AS role, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass',
  )
  const bare = await app.query('SELECT count(*)::int AS n FROM users')

  let scoped = null
  if (probeTenantId) {
    await app.query(`SELECT set_config('app.current_tenant', $1, false)`, [probeTenantId])
    const r = await app.query('SELECT count(*)::int AS n FROM users WHERE tenant_id = $1', [probeTenantId])
    const expected = await app.query('SELECT count(*)::int AS n FROM users')
    scoped = { visible: r.rows[0].n, total: expected.rows[0].n }
  }

  verdict = {
    role: who.rows[0].role,
    bypass: who.rows[0].bypass,
    bare: bare.rows[0].n,
    scoped,
  }
} catch (err) {
  // A missing GRANT is the likeliest cause and it is a deployment problem with
  // a specific fix, not something to hand back as a driver stack trace.
  if (err?.code === '42501') {
    console.error(`Refusing to hand out a connection string for ${ROLE}: ${err.message}`)
    console.error(`\nThe role exists but cannot read the schema. Check the GRANTs in migration 0006.`)
    process.exit(1)
  }
  throw err
} finally {
  await app.end()
}

console.log(`role              : ${verdict.role}`)
console.log(`bypassrls         : ${verdict.bypass}          (must be false)`)
console.log(`rows without ctx  : ${verdict.bare}              (must be 0)`)
if (verdict.scoped) {
  console.log(`rows with ctx     : ${verdict.scoped.total}              (all belong to the probe tenant)`)
} else {
  console.log('rows with ctx     : not checked   (no tenants exist yet)')
}

const failures = []
if (verdict.bypass !== false) failures.push(`${verdict.role} carries BYPASSRLS, so no policy applies to it.`)
if (verdict.bare !== 0) {
  failures.push(`${verdict.bare} row(s) were readable with no tenant context set; it must be 0.`)
}
if (verdict.scoped && verdict.scoped.total !== verdict.scoped.visible) {
  // Under a working policy the unfiltered read returns exactly the probe
  // tenant's rows. More than that means another tenant leaked into it.
  failures.push(
    `an unfiltered read returned ${verdict.scoped.total} row(s) but the probe tenant owns only ` +
      `${verdict.scoped.visible}; rows from another tenant are visible.`,
  )
}
if (verdict.scoped && verdict.scoped.total === 0 && verdict.scoped.visible === 0) {
  failures.push(
    'with a valid tenant context the role still saw nothing. Row-level security may be fine, but this ' +
      'role cannot read its own tenant either — check the GRANTs in migration 0006.',
  )
}

if (failures.length > 0) {
  console.error('\nRefusing to hand out a connection string for this role:')
  for (const failure of failures) console.error(`  ${failure}`)
  console.error('\nCheck that migration 0006 ran and that the role was not granted BYPASSRLS.')
  process.exit(1)
}

if (printOnly) {
  // The URL, and only the URL, on stdout: safe to pipe into a secret manager.
  console.log('')
  process.stdout.write(`${appUrl}\n`)
  process.exit(0)
}

const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
const lines = existing.length > 0 ? existing.split(/\r?\n/) : []
const hasLine = lines.some((l) => /^DATABASE_URL=/.test(l))
const next = hasLine
  ? lines.map((l) => (/^DATABASE_URL=/.test(l) ? `DATABASE_URL=${appUrl}` : l))
  : [...lines.filter((l) => l.length > 0), `DATABASE_URL=${appUrl}`, '']
writeFileSync(ENV_PATH, next.join('\n'), 'utf8')

console.log(`\nDATABASE_URL written to ${ENV_PATH} for role ${ROLE}.`)
console.log('Set the same value as DATABASE_URL in the deployment environment.')
