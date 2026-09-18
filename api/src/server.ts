import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  authenticate,
  KernelError,
  loadAccess,
  loadRecordTypes,
  RecordKernel,
  signIn,
  signOut,
  withTenant,
  type Actor,
  type Db,
  type SessionIdentity,
} from '@plumbline/shared'
import type { Pool } from 'pg'

/**
 * The HTTP surface over the record kernel.
 *
 * Deliberately thin. Routes parse, call one kernel method, and serialize; they
 * do not make authorization decisions of their own, because the kernel and the
 * database are the two places those are allowed to live. A route that needed
 * its own permission check would be a sign the kernel is missing something.
 *
 * Note the route shape: /projects/:id/records?type=rfi rather than /rfis. The
 * URL reflects the architecture — one kernel, many configured types — so a new
 * tool ships without a new endpoint, and an API client written today keeps
 * working against tools that do not exist yet.
 */

interface Route {
  method: string
  pattern: RegExp
  handler: (ctx: RequestContext) => Promise<unknown>
  /** Routes that run before a session exists. */
  public?: boolean
}

interface RequestContext {
  req: IncomingMessage
  params: Record<string, string>
  query: URLSearchParams
  body: Record<string, unknown>
  identity: SessionIdentity
  actor: Actor
  kernel: RecordKernel
  db: Pool
}

function route(
  method: string,
  path: string,
  handler: (ctx: RequestContext) => Promise<unknown>,
  options: { public?: boolean } = {},
): Route {
  const pattern = new RegExp(
    `^${path.replace(/:[a-zA-Z]+/g, (m) => `(?<${m.slice(1)}>[^/]+)`).replace(/\//g, '\\/')}$`,
  )
  return { method, pattern, handler, public: options.public === true }
}

const ROUTES: Route[] = [
  route(
    'POST',
    '/auth/sign-in',
    async ({ body, db }) => {
      const result = await signIn(db, {
        email: String(body['email'] ?? ''),
        password: String(body['password'] ?? ''),
      })
      return { token: result.token, expiresAt: result.expiresAt.toISOString(), userId: result.identity.userId }
    },
    { public: true },
  ),

  route('POST', '/auth/sign-out', async ({ db, identity }) => {
    await signOut(db, identity)
    return { signedOut: true }
  }),

  route('GET', '/me', async ({ db, actor, query }) => {
    const projectId = query.get('projectId')
    return withTenant(db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT u.id, u.name, u.email, u.job_title, o.name AS organization
           FROM users u JOIN organizations o ON o.id = u.organization_id
          WHERE u.id = $1`,
        [actor.userId],
      )
      const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
      return {
        user: rows[0] ?? null,
        isCompanyAdmin: access.isCompanyAdmin,
        isProjectMember: access.isProjectMember,
        // The permission map the client uses to decide what to render. The
        // server still checks everything; this only saves the UI from
        // offering buttons that would be refused.
        tools: Object.fromEntries(
          [...access.tools].map(([key, value]) => [
            key,
            { level: value.level, privileges: value.allPrivileges ? '*' : [...value.privileges] },
          ]),
        ),
      }
    })
  }),

  route('GET', '/record-types', async ({ db }) => {
    const types = await loadRecordTypes(db)
    return {
      types: [...types.values()].map((type) => ({
        key: type.key,
        toolKey: type.toolKey,
        displayName: type.displayName,
        displayNamePlural: type.displayNamePlural,
        numberPrefix: type.numberPrefix,
        fields: type.definition.fields,
        states: type.definition.workflow.states,
        transitions: type.definition.workflow.transitions.map((t) => ({
          key: t.key,
          label: t.label,
          from: t.from,
          to: t.to,
        })),
      })),
    }
  }),

  route('GET', '/projects', async ({ db, actor }) =>
    withTenant(db, actor.tenantId, async (tx) => {
      const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId: null })
      // A company admin sees the portfolio; everyone else sees the jobs they
      // are actually on.
      const { rows } = access.isCompanyAdmin
        ? await tx.query(
            `SELECT id, number, name, stage, city, state_code, contract_value FROM projects ORDER BY number`,
          )
        : await tx.query(
            `SELECT p.id, p.number, p.name, p.stage, p.city, p.state_code, p.contract_value
               FROM projects p
               JOIN project_memberships m ON m.project_id = p.id
              WHERE m.user_id = $1
              ORDER BY p.number`,
            [actor.userId],
          )
      return { projects: rows }
    }),
  ),

  route('GET', '/projects/:projectId/records', async ({ kernel, actor, params, query }) => {
    const records = await kernel.list(actor, {
      projectId: params['projectId'] as string,
      ...(query.get('type') ? { typeKey: query.get('type') as string } : {}),
      ...(query.get('status') ? { status: query.get('status') as string } : {}),
      openOnly: query.get('open') === 'true',
      limit: Number(query.get('limit') ?? 50),
      offset: Number(query.get('offset') ?? 0),
    })
    return { records }
  }),

  route('POST', '/projects/:projectId/records', async ({ kernel, actor, params, body }) =>
    kernel.create(actor, {
      projectId: params['projectId'] as string,
      typeKey: String(body['typeKey'] ?? ''),
      title: String(body['title'] ?? ''),
      body: (body['body'] as Record<string, unknown>) ?? {},
      participants: (body['participants'] as { userId: string; role: never }[]) ?? [],
    }),
  ),

  route('GET', '/records/:recordId', async ({ kernel, actor, params }) =>
    kernel.get(actor, params['recordId'] as string),
  ),

  route('PATCH', '/records/:recordId', async ({ kernel, actor, params, body }) =>
    kernel.update(actor, params['recordId'] as string, {
      ...(body['title'] !== undefined ? { title: String(body['title']) } : {}),
      ...(body['body'] !== undefined ? { body: body['body'] as Record<string, unknown> } : {}),
      ...(body['expectedVersion'] !== undefined ? { expectedVersion: Number(body['expectedVersion']) } : {}),
    }),
  ),

  route('POST', '/records/:recordId/transitions', async ({ kernel, actor, params, body }) =>
    kernel.transition(actor, params['recordId'] as string, {
      transitionKey: String(body['transitionKey'] ?? ''),
      ...(body['body'] !== undefined ? { body: body['body'] as Record<string, unknown> } : {}),
      ...(body['note'] !== undefined ? { note: String(body['note']) } : {}),
      ...(body['expectedVersion'] !== undefined ? { expectedVersion: Number(body['expectedVersion']) } : {}),
    }),
  ),

  route('POST', '/records/:recordId/comments', async ({ kernel, actor, params, body }) =>
    kernel.comment(actor, params['recordId'] as string, String(body['body'] ?? '')),
  ),

  route('GET', '/records/:recordId/history', async ({ kernel, actor, params }) =>
    kernel.history(actor, params['recordId'] as string),
  ),

  /**
   * The view the product is organized around: who owes what, right now.
   * With no parameters it is your own workload, which is the field user's
   * home screen.
   */
  route('GET', '/ball-in-court', async ({ kernel, actor, query }) => {
    const entries = await kernel.ballInCourt(actor, {
      ...(query.get('projectId') ? { projectId: query.get('projectId') as string } : {}),
      ...(query.get('holderUserId') ? { holderUserId: query.get('holderUserId') as string } : {}),
      overdueOnly: query.get('overdue') === 'true',
      limit: Number(query.get('limit') ?? 100),
    })
    return { entries }
  }),
]

function send(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method === 'GET' || req.method === 'HEAD') return {}
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    // A record body is text and metadata; attachments get their own upload
    // path. Anything larger than this is a mistake or an attack.
    if (size > 1_000_000) throw new KernelError('payload_too_large', 'Request body is too large', 413)
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new KernelError('bad_request', 'Request body must be a JSON object', 400)
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    if (err instanceof KernelError) throw err
    throw new KernelError('bad_request', 'Request body is not valid JSON', 400)
  }
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers['authorization']
  if (typeof header !== 'string') return null
  const [scheme, token] = header.split(' ')
  return scheme?.toLowerCase() === 'bearer' && token ? token : null
}

export function createApiServer(pool: Pool): Server {
  const kernel = new RecordKernel(pool as Db)

  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const match = ROUTES.map((r) => ({ r, m: r.pattern.exec(url.pathname) })).find(
          ({ r, m }) => m !== null && r.method === req.method,
        )

        if (!match?.m) {
          const pathExists = ROUTES.some((r) => r.pattern.test(url.pathname))
          send(res, pathExists ? 405 : 404, { error: pathExists ? 'method_not_allowed' : 'not_found' })
          return
        }

        const body = await readBody(req)
        const params = match.m.groups ?? {}

        let identity: SessionIdentity = { sessionId: '', tenantId: '', userId: '' }
        if (!match.r.public) {
          const token = bearer(req)
          if (!token) {
            send(res, 401, { error: 'unauthenticated', message: 'Bearer token required' })
            return
          }
          identity = await authenticate(pool as Db, token)
        }

        const result = await match.r.handler({
          req,
          params,
          query: url.searchParams,
          body,
          identity,
          actor: { tenantId: identity.tenantId, userId: identity.userId },
          kernel,
          db: pool,
        })

        send(res, req.method === 'POST' && url.pathname.endsWith('/records') ? 201 : 200, result)
      } catch (err) {
        if (err instanceof KernelError) {
          send(res, err.status, { error: err.code, message: err.message, ...err.detail })
          return
        }
        // Never leak internals to the client; the log is where the detail goes.
        console.error('[api] unhandled error', err)
        send(res, 500, { error: 'internal_error' })
      }
    })()
  })
}
