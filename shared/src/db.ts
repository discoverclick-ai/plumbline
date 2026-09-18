import pg from 'pg'
import type { Pool, PoolClient } from 'pg'

/**
 * What repositories run their SQL against: either a pool (the repository
 * manages its own transactions) or a client whose transaction the caller owns.
 */
export type Db = Pool | PoolClient

let parsersConfigured = false

/**
 * Output parsers used across the platform:
 * - BIGINT (int8) → number: used for version counters and bigserial ids, all
 *   far below Number.MAX_SAFE_INTEGER.
 * - DATE → 'YYYY-MM-DD' string: day-precision values must not pick up a
 *   timezone.
 * - NUMERIC stays a string (pg default) so money/scores keep exact precision.
 */
export function configureTypeParsers(): void {
  if (parsersConfigured) return
  parsersConfigured = true
  pg.types.setTypeParser(20, (v) => Number(v))
  pg.types.setTypeParser(1082, (v) => v)
}

export interface CreatePoolOptions {
  /** Defaults to process.env.DATABASE_URL. */
  connectionString?: string
  max?: number
}

export function createPool(options: CreatePoolOptions = {}): Pool {
  configureTypeParsers()
  return new pg.Pool({
    connectionString: options.connectionString ?? process.env.DATABASE_URL,
    max: options.max,
  })
}

export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // the original error is the one worth surfacing
    }
    throw err
  } finally {
    client.release()
  }
}

/**
 * Run fn atomically against db.
 *
 * - Pool: a client is checked out and wrapped in BEGIN/COMMIT.
 * - Client: composes with the caller's open transaction via a savepoint, so a
 *   failure rolls back only this unit of work. Passing a client that is not
 *   inside a transaction is a contract violation and fails loudly (SAVEPOINT
 *   is only valid inside a transaction block).
 */
/**
 * Session GUC read by the RLS policies (migration 0006). Set it with
 * `is_local = true` so it is scoped to the surrounding transaction and reset
 * automatically on commit or rollback — a pooled connection can never leak
 * one request's tenant into the next.
 *
 * Must be called inside a transaction: outside one, a local setting applies
 * only to the current statement and silently does nothing useful.
 */
export async function setTenantContext(db: Db, tenantId: string): Promise<void> {
  await db.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId])
}

/**
 * Run fn in a transaction with the RLS tenant context set. Under the
 * application role this is what makes the database — not application
 * diligence — the thing enforcing tenant isolation.
 */
export async function withTenant<T>(db: Db, tenantId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return transact(db, async (tx) => {
    await setTenantContext(tx, tenantId)
    return fn(tx)
  })
}

export async function transact<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  if (db instanceof pg.Pool) {
    return withTransaction(db, fn)
  }
  await db.query('SAVEPOINT plumbline_repo')
  try {
    const result = await fn(db)
    await db.query('RELEASE SAVEPOINT plumbline_repo')
    return result
  } catch (err) {
    try {
      await db.query('ROLLBACK TO SAVEPOINT plumbline_repo')
    } catch {
      // the original error is the one worth surfacing
    }
    throw err
  }
}
