import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  interface ProvidedContext {
    databaseUrl: string
  }
}

/**
 * Boots a real (embedded) Postgres for the integration suite, applies every
 * migration from db/migrations in order, and hands the connection URL to the
 * tests. See test/README.md for the Windows teardown caveat.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'plumbline-pg-'))
  const port = 54000 + Math.floor(Math.random() * 1000)

  const embedded = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    // `persistent: true` stops embedded-postgres from deleting the data
    // directory itself during stop(); on Windows postgres has not always
    // released its file handles by then, and its internal rmdir throws EBUSY,
    // which crashed the vitest process even when every assertion passed. We
    // own the cleanup instead and retry it. See test/README.md.
    persistent: true,
    // Windows initdb defaults to the system codepage (WIN1252); the platform
    // stores UTF-8 text, so the test cluster must too.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    // Postgres refuses to run as root, so when the harness is root (CI
    // containers, the cloud dev environment) embedded-postgres runs initdb and
    // the server as a `postgres` user. Without this it never takes ownership
    // of the data directory and initdb dies on "could not change permissions".
    createPostgresUser: true,
  })
  await embedded.initialise()
  await embedded.start()
  await embedded.createDatabase('plumbline_test')

  const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/plumbline_test`

  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations')
  const files = (await readdir(migrationsDir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    for (const file of files) {
      const sql = await readFile(path.join(migrationsDir, file), 'utf8')
      await client.query(sql)
    }
  } finally {
    await client.end()
  }

  process.env.TEST_DATABASE_URL = databaseUrl
  project.provide('databaseUrl', databaseUrl)

  return async () => {
    await teardownCluster(embedded, dataDir)
  }
}

/**
 * Teardown must never change the outcome of a run: assertions decide the exit
 * code, not filesystem noise from stopping a database we are about to delete.
 */
export async function teardownCluster(embedded: EmbeddedPostgres, dataDir: string): Promise<void> {
  try {
    await embedded.stop()
  } catch (err) {
    console.warn('[test-harness] embedded postgres stop() failed (ignored):', (err as Error).message)
  }
  await removeWithRetry(dataDir)
}

/** Windows releases postgres' file handles asynchronously; retry through EBUSY/EPERM. */
export async function removeWithRetry(dir: string, attempts = 12): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      return
    } catch (err) {
      if (attempt === attempts) {
        console.warn(`[test-harness] could not remove ${dir} (ignored): ${(err as Error).message}`)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt))
    }
  }
}
