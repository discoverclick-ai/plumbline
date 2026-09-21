/**
 * Boots an embedded Postgres, migrates it, provisions the confined app role,
 * seeds the demo tenant, and leaves the cluster running for the API server.
 */
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'

const ROOT = '/home/user/plumbline'
const dataDir = await mkdtemp(path.join(tmpdir(), 'plumbline-demo-pg-'))
const port = 55432

const embedded = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  createPostgresUser: process.getuid?.() === 0,
})
await embedded.initialise()
await embedded.start()
await embedded.createDatabase('plumbline')

const ownerUrl = `postgres://postgres:postgres@127.0.0.1:${port}/plumbline`
const migrationsDir = path.join(ROOT, 'db', 'migrations')
const files = (await readdir(migrationsDir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()

const client = new pg.Client({ connectionString: ownerUrl })
await client.connect()
for (const file of files) {
  await client.query(await readFile(path.join(migrationsDir, file), 'utf8'))
}
// A login for the confined role, so the API runs as plumbline_app and every
// row-level policy is actually in force — which is the whole point.
await client.query(`ALTER ROLE plumbline_app WITH LOGIN PASSWORD 'demo-app-password'`)
await client.end()

const appUrl = `postgres://plumbline_app:demo-app-password@127.0.0.1:${port}/plumbline`
await writeFile('/tmp/claude-0/demo/urls.json', JSON.stringify({ ownerUrl, appUrl, port, dataDir }, null, 2))
console.log('READY', appUrl)
