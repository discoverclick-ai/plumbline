import type { Pool } from 'pg'
import type { Db } from './db.js'
import { ClockEngine } from './contracts/clock-engine.js'
import { FinancialPostingService } from './financial-posting.js'
import { NotificationService, type MailSender } from './notifications.js'

/**
 * The passes nobody presses a button for.
 *
 * Four subsystems in this product read the event log forward from a durable
 * cursor and do something with what they find: notifications, financial
 * posting, escalation, and the notice clock. Every one of them was built,
 * tested and then left with no process to run it, which meant that in a real
 * deployment the budget never learned about an executed change, nobody was
 * ever told anything, and a notice clock counted down to a deadline that
 * arrived on no screen. The most important promise this product makes is that
 * a deadline lands on a desk before it matters, and until this file existed
 * that promise was kept only by somebody clicking.
 *
 * Three rules.
 *
 * ONE PASS FAILING MUST NOT STOP THE OTHERS. A malformed event that breaks
 * notification rendering must not also stop the clock engine, because the two
 * have nothing to do with each other and the clock is the one that costs
 * money to miss.
 *
 * IT RUNS ALONE. A second instance would not corrupt anything — every pass is
 * idempotent on a unique key, which is the property those keys exist for —
 * but it would double the work and halve the clarity of the logs. A Postgres
 * advisory lock is the whole mechanism, and an instance that cannot get it
 * exits rather than idling, so a supervisor restarting it is harmless.
 *
 * AND IT SAYS WHAT IT DID. Every tick logs a line whether or not anything
 * happened, because the failure mode of a worker is silence, and silence
 * looks exactly like a quiet afternoon.
 */

/** Postgres advisory lock id. Arbitrary and fixed; the value is the contract. */
const LOCK_ID = 0x706c756d // "plum"

export interface WorkerPass {
  name: string
  run(): Promise<Record<string, number>>
}

export interface WorkerOptions {
  mail: MailSender
  /** Milliseconds between ticks. */
  intervalMs?: number
  /** How long to wait after a pass throws, before the next tick. */
  backoffMs?: number
  log?: (line: string) => void
  now?: () => Date
}

export interface TickResult {
  passes: { name: string; result?: Record<string, number>; error?: string }[]
  did: number
}

export function buildPasses(db: Db, mail: MailSender): WorkerPass[] {
  const notifications = new NotificationService(db, mail)
  const posting = new FinancialPostingService(db)
  const clocks = new ClockEngine(db)

  return [
    // Ordered by what a person notices when it stops. A clock that does not
    // promote costs a claim; a notification that does not send costs a phone
    // call. Ordering also means a notice raised by the clock engine on this
    // tick is picked up by notifications on the next one, which is the right
    // way round: nothing is announced before it exists.
    {
      name: 'clocks.fire',
      run: async () => {
        const result = await clocks.fire()
        return { scanned: result.scanned, started: result.started, skipped: result.skipped.length }
      },
    },
    {
      name: 'clocks.promote',
      run: async () => {
        const result = await clocks.promote()
        return { promoted: result.promoted, expired: result.expired }
      },
    },
    {
      name: 'clocks.reconcile',
      run: async () => {
        const result = await clocks.reconcile()
        return { satisfied: result.satisfied, stoodDown: result.stoodDown }
      },
    },
    {
      name: 'financial.post',
      run: async () => {
        const result = await posting.post()
        return { scanned: result.scanned, posted: result.posted, skipped: result.skipped.length }
      },
    },
    {
      name: 'notifications.generate',
      run: async () => ({ queued: await notifications.generate() }),
    },
    {
      name: 'notifications.deliver',
      run: async () => {
        const result = await notifications.deliver()
        return { sent: result.sent, failed: result.failed }
      },
    },
  ]
}

/**
 * One tick over every pass.
 *
 * Exported and pure of scheduling so it can be tested and so an operator can
 * run exactly one tick by hand, which is the first thing anybody wants when a
 * queue looks stuck.
 */
export async function tick(passes: WorkerPass[], log: (line: string) => void): Promise<TickResult> {
  const out: TickResult = { passes: [], did: 0 }

  for (const pass of passes) {
    try {
      const result = await pass.run()
      out.passes.push({ name: pass.name, result })
      out.did += Object.entries(result)
        .filter(([key]) => key !== 'scanned')
        .reduce((sum, [, value]) => sum + value, 0)
    } catch (err) {
      // Caught per pass, on purpose. A malformed event that breaks one
      // subsystem must not stop the one that costs money to miss.
      const message = err instanceof Error ? err.message : String(err)
      out.passes.push({ name: pass.name, error: message })
      log(`[worker] ${pass.name} FAILED: ${message}`)
    }
  }

  return out
}

export function describeTick(result: TickResult): string {
  const parts = result.passes.map((p) =>
    p.error
      ? `${p.name}=error`
      : `${p.name}=${Object.entries(p.result ?? {})
          .map(([k, v]) => `${k}:${v}`)
          .join(',')}`,
  )
  return parts.join(' ')
}

/**
 * Takes the lock on a connection of its own, and holds it.
 *
 * A session-scoped advisory lock taken through a POOL is a bug that passes
 * its own test. The pool hands the query to whichever connection is free, the
 * lock belongs to that session, and a later unlock issued through the pool
 * lands on a different connection, returns false and warns into a log nobody
 * reads. Worse, if the pool ever recycles the holding connection the lock
 * disappears and a second worker starts, which is the exact situation this
 * exists to prevent. So the lock gets a dedicated client, checked out for the
 * worker's whole life.
 *
 * `pg_try_advisory_lock`, not `pg_advisory_lock`: waiting would leave a second
 * instance holding a connection open indefinitely, and a supervisor that
 * starts three of these should end up with one worker and two clean exits
 * rather than three processes and a mystery.
 */
export interface HeldLock {
  release(): Promise<void>
}

export async function takeLock(pool: Pool): Promise<HeldLock | null> {
  const client = await pool.connect()
  try {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_ID])
    if (rows[0]?.locked !== true) {
      client.release()
      return null
    }
  } catch (err) {
    client.release()
    throw err
  }

  let released = false
  return {
    async release(): Promise<void> {
      if (released) return
      released = true
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID])
      } finally {
        // Released to the pool either way. A lock that could not be unlocked
        // is a connection that must not be reused holding it, and the pool
        // ending is what finally clears it.
        client.release()
      }
    },
  }
}

export interface RunningWorker {
  stop(): Promise<void>
}

export async function startWorker(pool: Pool, options: WorkerOptions): Promise<RunningWorker | null> {
  const log = options.log ?? ((line: string) => console.log(line))
  const intervalMs = options.intervalMs ?? 30_000
  const backoffMs = options.backoffMs ?? 120_000

  const lock = await takeLock(pool)
  if (!lock) {
    log('[worker] another instance holds the lock; exiting')
    return null
  }

  const passes = buildPasses(pool, options.mail)
  let stopped = false
  let timer: NodeJS.Timeout | null = null
  let running: Promise<void> = Promise.resolve()

  const loop = async (): Promise<void> => {
    if (stopped) return
    const started = Date.now()
    const result = await tick(passes, log)
    const failed = result.passes.filter((p) => p.error).length

    // Logged every tick, including the quiet ones. The failure mode of a
    // worker is silence, and silence looks exactly like a quiet afternoon.
    log(`[worker] tick ${Date.now() - started}ms did:${result.did} ${describeTick(result)}`)

    if (stopped) return
    timer = setTimeout(() => {
      running = loop()
      void running
    }, failed > 0 ? backoffMs : intervalMs)
  }

  running = loop()

  return {
    async stop(): Promise<void> {
      stopped = true
      if (timer) clearTimeout(timer)
      // Wait for the pass in flight rather than killing it. Half a tick is
      // safe because every pass is idempotent, but finishing is cleaner and
      // costs a few seconds at shutdown.
      await running
      await lock.release()
    },
  }
}
