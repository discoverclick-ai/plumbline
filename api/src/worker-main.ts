import { createPool, RecordingMailSender, startWorker } from '@plumbline/shared'

/**
 * The worker process.
 *
 * Separate from the API on purpose. The API serves one person's request and
 * must stay fast; these passes read the whole event log and take as long as
 * they take, and putting them on the same event loop would mean a slow
 * financial posting pass showing up as a slow page.
 *
 * The connection is NOT `plumbline_app`. Every pass here reads a cursor over
 * a log that spans every tenant, which row-level security correctly refuses
 * to the application role. That makes this the most privileged process in the
 * system, and the reason each pass writes through `withTenant` rather than
 * trusting its own connection: the tenant boundary is re-established at every
 * write, by the code, because the database is not enforcing it here.
 */
const pool = createPool({ connectionString: process.env['PLUMBLINE_WORKER_DATABASE_URL'] })

// Recording, not sending. The transport is a deployment decision and nothing
// in this repository should quietly acquire the ability to email a client's
// architect; swapping this for a real sender is a deliberate act.
const mail = new RecordingMailSender()

const worker = await startWorker(pool, {
  mail,
  intervalMs: Number(process.env['PLUMBLINE_WORKER_INTERVAL_MS'] ?? 30_000),
})

if (!worker) {
  await pool.end()
  process.exit(0)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      console.log(`[worker] ${signal}, finishing the tick in flight`)
      await worker.stop()
      await pool.end()
      process.exit(0)
    })()
  })
}
