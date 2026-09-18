import { createPool } from '@plumbline/shared'
import { createApiServer } from './server.js'

/**
 * Entry point. The pool must connect as `plumbline_app` (or a role holding
 * it): row-level security is the backstop under every authorization decision
 * the kernel makes, and a superuser connection silently removes it.
 */
const pool = createPool()
const port = Number(process.env.PORT ?? 8080)

createApiServer(pool).listen(port, () => {
  console.log(`plumbline api listening on :${port}`)
})
