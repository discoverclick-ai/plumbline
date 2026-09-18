#!/usr/bin/env node
// Plumbline migration runner.
// Applies db/migrations/NNNN_*.sql in filename order, exactly once each,
// recording progress in a schema_migrations table. Each file runs in its own
// transaction, and a checksum guards against editing an already-applied file.
//
// Usage:  DATABASE_URL=postgres://user:pass@host:5432/plumbline node migrate.mjs

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    // Serialize concurrent runners (e.g. two deploys racing) on one advisory lock.
    await client.query(`SELECT pg_advisory_lock(hashtext('plumbline:migrate'))`)
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        checksum   TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)

    const files = (await readdir(migrationsDir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()
    const { rows } = await client.query('SELECT filename, checksum FROM schema_migrations')
    const applied = new Map(rows.map((r) => [r.filename, r.checksum]))

    let ran = 0
    for (const file of files) {
      const sql = await readFile(path.join(migrationsDir, file), 'utf8')
      const checksum = createHash('sha256').update(sql).digest('hex')
      if (applied.has(file)) {
        if (applied.get(file) !== checksum) {
          throw new Error(`${file} was modified after being applied — add a new migration instead`)
        }
        continue
      }
      process.stdout.write(`applying ${file} ... `)
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        console.log('failed')
        throw err
      }
      console.log('ok')
      ran += 1
    }
    console.log(ran === 0 ? 'database is up to date' : `applied ${ran} migration(s)`)
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('plumbline:migrate'))`).catch(() => {})
    await client.end()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  if (!process.env.DATABASE_URL) {
    console.error('hint: set DATABASE_URL (postgres://user:pass@host:5432/dbname)')
  }
  process.exitCode = 1
})
