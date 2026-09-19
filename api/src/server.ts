import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  AnthropicInterpretationProvider,
  AttachmentService,
  authenticate,
  DrawingService,
  ClockEngine,
  ContractService,
  EscalationService,
  McpToolRunner,
  ObligationService,
  TOOLS,
  SyncService,
  BudgetService,
  buildErpBatch,
  CommitmentService,
  CsvErpAdapter,
  InvoicingService,
  CaptureService,
  FilesystemBlobStore,
  MAX_UPLOAD_BYTES,
  KernelError,
  loadAccess,
  loadRecordTypes,
  RecordKernel,
  signIn,
  signOut,
  withTenant,
  type Actor,
  type BlobStore,
  type Db,
  type InterpretationProvider,
  type ParticipantRole,
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
  /** Routes whose request or response is bytes rather than JSON. */
  binary?: boolean
}

interface RequestContext {
  req: IncomingMessage
  params: Record<string, string>
  query: URLSearchParams
  body: Record<string, unknown>
  identity: SessionIdentity
  actor: Actor
  kernel: RecordKernel
  capture: CaptureService
  attachments: AttachmentService
  budget: BudgetService
  drawings: DrawingService
  sync: SyncService
  escalations: EscalationService
  contracts: ContractService
  obligations: ObligationService
  clocks: ClockEngine
  mcp: McpToolRunner
  commitments: CommitmentService
  invoicing: InvoicingService
  db: Pool
  res: ServerResponse
}

function route(
  method: string,
  path: string,
  handler: (ctx: RequestContext) => Promise<unknown>,
  options: { public?: boolean; binary?: boolean } = {},
): Route {
  const pattern = new RegExp(
    `^${path.replace(/:[a-zA-Z]+/g, (m) => `(?<${m.slice(1)}>[^/]+)`).replace(/\//g, '\\/')}$`,
  )
  // Both options have to be carried through. An earlier version dropped
  // `binary`, which silently sent every attachment upload through the JSON
  // body parser: the service was tested and the route was not, so the bug
  // lived behind a passing suite.
  return { method, pattern, handler, public: options.public === true, binary: options.binary === true }
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
          // What the client must collect before offering this move. Without it
          // a UI either asks for every field on every transition or guesses.
          requiresFields: t.requiresFields ?? [],
        })),
      })),
    }
  }),

  route('GET', '/projects', async ({ db, actor }) =>
    withTenant(db, actor.tenantId, async (tx) => {
      const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId: null })
      // A company admin sees the portfolio; everyone else sees the jobs they
      // are actually on.
      // Both filter on tenant_id explicitly even though withTenant has already
      // set the context and row-level security would confine them. Defence in
      // depth costs one clause here, and the alternative is a query whose
      // correctness depends on which pool happens to be passed in.
      const { rows } = access.isCompanyAdmin
        ? await tx.query(
            `SELECT id, number, name, stage, city, state_code, contract_value
               FROM projects
              WHERE tenant_id = $1
              ORDER BY number`,
            [actor.tenantId],
          )
        : await tx.query(
            `SELECT p.id, p.number, p.name, p.stage, p.city, p.state_code, p.contract_value
               FROM projects p
               JOIN project_memberships m ON m.project_id = p.id
              WHERE p.tenant_id = $1 AND m.user_id = $2
              ORDER BY p.number`,
            [actor.tenantId, actor.userId],
          )
      return { projects: rows }
    }),
  ),

  /**
   * The project team. A client needs this to put a person on a record, and a
   * record type whose next state hands the ball to an assignee cannot move
   * without one — so a UI that cannot pick people can create records that
   * dead-end.
   */
  route('GET', '/projects/:projectId/members', async ({ db, actor, params }) =>
    withTenant(db, actor.tenantId, async (tx) => {
      const projectId = params['projectId'] as string
      const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
      if (!access.isProjectMember && !access.isCompanyAdmin) {
        throw new KernelError('permission_denied', 'You are not on this project', 403)
      }
      const { rows } = await tx.query(
        `SELECT u.id AS "userId", u.name, u.job_title AS "jobTitle", o.name AS organization
           FROM project_memberships m
           JOIN users u ON u.id = m.user_id
           JOIN organizations o ON o.id = u.organization_id
          WHERE m.project_id = $1 AND u.is_active
          ORDER BY o.name, u.name`,
        [projectId],
      )
      return { members: rows }
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

  /**
   * Upload. Raw bytes with the filename in a header rather than multipart,
   * because multipart would mean a parser dependency for a form nobody is
   * submitting: every client here is fetch with a File.
   */
  route(
    'POST',
    '/records/:recordId/attachments',
    async ({ req, actor, params, attachments }) => {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += (chunk as Buffer).length
        if (size > MAX_UPLOAD_BYTES) {
          throw new KernelError('payload_too_large', 'That file is too large', 413)
        }
        chunks.push(chunk as Buffer)
      }
      const filename = req.headers['x-filename']
      if (typeof filename !== 'string' || filename.length === 0) {
        throw new KernelError('bad_request', 'An x-filename header is required', 400)
      }
      return attachments.attach(actor, params['recordId'] as string, {
        // Never trusted for anything but display: it is decoded so a client
        // can send a name with a space or an accent in it, and it never
        // touches a path, because the storage key is ours and random.
        filename: decodeURIComponent(filename),
        contentType: (req.headers['content-type'] ?? 'application/octet-stream').split(';')[0] as string,
        bytes: Buffer.concat(chunks),
      })
    },
    { binary: true },
  ),

  route('GET', '/records/:recordId/attachments', async ({ actor, params, attachments }) => ({
    attachments: await attachments.list(actor, params['recordId'] as string),
  })),

  /**
   * Download. No signed URL and no public path: every byte leaves through
   * here, after the reader's own access has been loaded, because a link that
   * works for anybody holding it is not a permission model.
   */
  route(
    'GET',
    '/attachments/:attachmentId',
    async ({ actor, params, attachments, res }) => {
      const { attachment, bytes } = await attachments.read(actor, params['attachmentId'] as string)
      res.writeHead(200, {
        'content-type': attachment.contentType,
        'content-length': bytes.byteLength,
        // attachment, always. An HTML or SVG file rendered inline would run
        // in this origin, and every party on the job can upload.
        'content-disposition': `attachment; filename="${attachment.filename.replace(/["\\]/g, '')}"`,
        'x-content-type-options': 'nosniff',
      })
      res.end(bytes)
      return undefined
    },
    { binary: true },
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
  /**
   * The capture pipeline. Note that nothing here can create a record: the only
   * route that produces one is /proposals/:id/accept, and it runs the ordinary
   * kernel path as the authenticated human.
   */
  route('POST', '/projects/:projectId/captures', async ({ capture, actor, params, body }) =>
    capture.record(actor, {
      projectId: params['projectId'] as string,
      kind: (body['kind'] as 'photo' | 'voice' | 'document' | 'text' | 'email') ?? 'text',
      ...(body['text'] !== undefined ? { text: String(body['text']) } : {}),
      ...(body['storageKey'] !== undefined ? { storageKey: String(body['storageKey']) } : {}),
      ...(body['contentType'] !== undefined ? { contentType: String(body['contentType']) } : {}),
      ...(body['byteSize'] !== undefined ? { byteSize: Number(body['byteSize']) } : {}),
      ...(body['capturedAt'] !== undefined ? { capturedAt: new Date(String(body['capturedAt'])) } : {}),
      ...(body['latitude'] !== undefined ? { latitude: Number(body['latitude']) } : {}),
      ...(body['longitude'] !== undefined ? { longitude: Number(body['longitude']) } : {}),
      ...(body['device'] !== undefined ? { device: body['device'] as Record<string, unknown> } : {}),
    }),
  ),

  route('GET', '/captures/:captureId', async ({ capture, actor, params }) =>
    capture.getCapture(actor, params['captureId'] as string),
  ),

  route('POST', '/captures/:captureId/interpret', async ({ capture, actor, params }) =>
    capture.interpret(actor, params['captureId'] as string),
  ),

  route('GET', '/projects/:projectId/proposals', async ({ capture, actor, params, query }) => {
    const proposals = await capture.inbox(actor, {
      projectId: params['projectId'] as string,
      ...(query.get('status')
        ? { status: query.get('status') as 'pending' | 'accepted' | 'rejected' | 'superseded' }
        : {}),
      limit: Number(query.get('limit') ?? 50),
    })
    return { proposals }
  }),

  route('POST', '/proposals/:proposalId/accept', async ({ capture, actor, params, body }) =>
    capture.accept(actor, params['proposalId'] as string, {
      ...(body['title'] !== undefined ? { title: String(body['title']) } : {}),
      ...(body['body'] !== undefined ? { body: body['body'] as Record<string, unknown> } : {}),
      ...(body['participants'] !== undefined
        ? { participants: body['participants'] as { userId: string; role: ParticipantRole }[] }
        : {}),
    }),
  ),

  route('POST', '/proposals/:proposalId/reject', async ({ capture, actor, params, body }) =>
    capture.reject(
      actor,
      params['proposalId'] as string,
      body['note'] === undefined ? undefined : String(body['note']),
    ),
  ),

  route('GET', '/projects/:projectId/capture-stats', async ({ capture, actor, params }) =>
    capture.stats(actor, { projectId: params['projectId'] as string }),
  ),

  /**
   * One search box for the whole account. Scoped to a project when asked, and
   * to what this person may actually read either way.
   */
  route('GET', '/search', async ({ actor, kernel, query }) => ({
    results: (
      await kernel.search(actor, {
        query: query.get('q') ?? '',
        ...(query.get('projectId') ? { projectId: query.get('projectId') as string } : {}),
        ...(query.get('limit') ? { limit: Number(query.get('limit')) } : {}),
      })
    ).map((hit) => ({
      id: hit.record.id,
      projectId: hit.record.projectId,
      projectName: hit.projectName,
      typeKey: hit.record.typeKey,
      designation: hit.record.designation,
      title: hit.record.title,
      status: hit.record.status,
    })),
  })),

  /**
   * The money.
   *
   * Every figure here comes out of a view rather than a column, so these
   * routes are thin even by the standard of the rest of this file: there is
   * no arithmetic to do on the way past, which is the point.
   */
  // Returns `costsVisible` alongside the lines, because a reader without the
  // cost privilege gets the same rows with the money nulled rather than a
  // refusal, and the client has to know which it is looking at.
  route('GET', '/projects/:projectId/budget', async ({ actor, params, budget }) =>
    budget.summary(actor, params['projectId'] as string),
  ),

  route('POST', '/projects/:projectId/budget/lines', async ({ actor, params, body, budget }) =>
    budget.addLine(actor, {
      projectId: params['projectId'] as string,
      budgetCodeId: body['budgetCodeId'] as string,
      description: body['description'] as string | undefined,
      originalAmount: String(body['originalAmount'] ?? ''),
      unitOfMeasure: body['unitOfMeasure'] as string | undefined,
      originalQuantity: body['originalQuantity'] as string | undefined,
    }),
  ),

  route('POST', '/budget-lines/:budgetLineId/revisions', async ({ actor, params, body, budget }) => {
    await budget.revise(actor, {
      budgetLineId: params['budgetLineId'] as string,
      amount: String(body['amount'] ?? ''),
      reason: String(body['reason'] ?? ''),
      ...(body['sourceRecordId'] ? { sourceRecordId: body['sourceRecordId'] as string } : {}),
    })
    return { ok: true }
  }),

  route('POST', '/projects/:projectId/costs', async ({ actor, params, body, budget }) =>
    budget.recordCost(actor, {
      projectId: params['projectId'] as string,
      budgetCodeId: body['budgetCodeId'] as string,
      kind: body['kind'] as 'committed' | 'actual' | 'pending' | 'forecast',
      amount: String(body['amount'] ?? ''),
      description: body['description'] as string | undefined,
      ...(body['sourceRecordId'] ? { sourceRecordId: body['sourceRecordId'] as string } : {}),
      ...(body['incurredOn'] ? { incurredOn: body['incurredOn'] as string } : {}),
    }),
  ),

  route('GET', '/projects/:projectId/commitments', async ({ actor, params, commitments }) => ({
    commitments: await commitments.summary(actor, params['projectId'] as string),
  })),

  route('POST', '/projects/:projectId/commitments', async ({ actor, params, body, commitments }) =>
    commitments.create(actor, {
      projectId: params['projectId'] as string,
      kind: body['kind'] as 'subcontract' | 'purchase_order',
      number: String(body['number'] ?? ''),
      title: String(body['title'] ?? ''),
      vendorOrgId: String(body['vendorOrgId'] ?? ''),
      ...(body['retainagePercent'] ? { retainagePercent: String(body['retainagePercent']) } : {}),
      lines: (body['lines'] ?? []) as { budgetCodeId: string; description: string; amount: string }[],
    }),
  ),

  route('POST', '/commitments/:commitmentId/execute', async ({ actor, params, body, commitments }) => {
    await commitments.execute(actor, params['commitmentId'] as string, body['executedOn'] as string | undefined)
    return { ok: true }
  }),

  route('POST', '/commitments/:commitmentId/change-orders', async ({ actor, params, body, commitments }) =>
    commitments.addChangeOrder(actor, {
      commitmentId: params['commitmentId'] as string,
      number: String(body['number'] ?? ''),
      title: String(body['title'] ?? ''),
      ...(body['sourceRecordId'] ? { sourceRecordId: body['sourceRecordId'] as string } : {}),
      lines: (body['lines'] ?? []) as { budgetCodeId: string; description: string; amount: string }[],
    }),
  ),

  route('POST', '/commitment-change-orders/:changeOrderId/execute', async ({ actor, params, body, commitments }) => {
    await commitments.executeChangeOrder(
      actor,
      params['changeOrderId'] as string,
      body['executedOn'] as string | undefined,
    )
    return { ok: true }
  }),

  route('GET', '/commitments/:commitmentId/invoices', async ({ actor, params, invoicing }) => ({
    invoices: await invoicing.summary(actor, params['commitmentId'] as string),
    lines: await invoicing.lineBilling(actor, params['commitmentId'] as string),
  })),

  route('POST', '/commitments/:commitmentId/invoices', async ({ actor, params, body, invoicing }) =>
    invoicing.createInvoice(actor, {
      commitmentId: params['commitmentId'] as string,
      number: String(body['number'] ?? ''),
      periodStart: String(body['periodStart'] ?? ''),
      periodEnd: String(body['periodEnd'] ?? ''),
      lines: (body['lines'] ?? []) as { commitmentLineId: string; amount: string; retainageAmount?: string }[],
    }),
  ),

  route('POST', '/invoices/:invoiceId/submit', async ({ actor, params, invoicing }) => {
    await invoicing.submit(actor, params['invoiceId'] as string)
    return { ok: true }
  }),

  route('POST', '/invoices/:invoiceId/approve', async ({ actor, params, invoicing }) => {
    await invoicing.approve(actor, params['invoiceId'] as string)
    return { ok: true }
  }),

  route('POST', '/invoices/:invoiceId/reject', async ({ actor, params, body, invoicing }) => {
    await invoicing.reject(actor, params['invoiceId'] as string, String(body['reason'] ?? ''))
    return { ok: true }
  }),

  route('POST', '/invoices/:invoiceId/lien-waiver', async ({ actor, params, invoicing }) => {
    await invoicing.recordLienWaiver(actor, params['invoiceId'] as string)
    return { ok: true }
  }),

  route('POST', '/invoices/:invoiceId/pay', async ({ actor, params, invoicing }) => {
    await invoicing.markPaid(actor, params['invoiceId'] as string)
    return { ok: true }
  }),

  route('POST', '/invoice-lines/:invoiceLineId/release-retainage', async ({ actor, params, body, invoicing }) => {
    await invoicing.releaseRetainage(actor, params['invoiceLineId'] as string, String(body['amount'] ?? ''))
    return { ok: true }
  }),

  /**
   * The accounting export.
   *
   * Binary because it hands back a file, and deliberately a download rather
   * than a push: the general ledger is the system of record for the business,
   * not for the job, and a platform that writes into it directly is one a
   * controller turns off.
   */
  route(
    'GET',
    '/projects/:projectId/erp-export',
    async ({ actor, params, budget, db, res }) => {
      const projectId = params['projectId'] as string
      // Explicitly, not by reading the summary: since the summary returns
      // nulled money rather than refusing, a route that called it and then
      // exported the real figures anyway would hand the whole budget to
      // somebody who may not see a single number of it.
      await budget.assertCostsVisible(actor, projectId)

      const batch = await withTenant(db as Db, actor.tenantId, (tx) => buildErpBatch(tx, actor.tenantId, projectId))
      const file = await new CsvErpAdapter().format(batch)
      res.writeHead(200, {
        'content-type': file.contentType,
        'content-length': Buffer.byteLength(file.body),
        'content-disposition': `attachment; filename="${file.filename}"`,
      })
      res.end(file.body)
      return undefined
    },
    { binary: true },
  ),

  route('GET', '/projects/:projectId/drawings', async ({ actor, params, query, drawings }) => ({
    sheets: await drawings.currentSheets(
      actor,
      params['projectId'] as string,
      query.get('discipline') ?? undefined,
    ),
  })),

  route('POST', '/projects/:projectId/drawing-sets', async ({ actor, params, body, drawings }) =>
    drawings.createSet(actor, {
      projectId: params['projectId'] as string,
      name: String(body['name'] ?? ''),
      issuedOn: String(body['issuedOn'] ?? ''),
      ...(body['receivedOn'] ? { receivedOn: String(body['receivedOn']) } : {}),
    }),
  ),

  route(
    'POST',
    '/drawing-sets/:setId/sheets',
    async ({ req, actor, params, drawings }) => {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += (chunk as Buffer).length
        if (size > MAX_UPLOAD_BYTES) throw new KernelError('payload_too_large', 'That sheet is too large', 413)
        chunks.push(chunk as Buffer)
      }
      const header = (name: string): string => {
        const value = req.headers[name]
        return typeof value === 'string' ? decodeURIComponent(value) : ''
      }
      if (!header('x-sheet-number')) {
        throw new KernelError('bad_request', 'An x-sheet-number header is required', 400)
      }
      return drawings.addRevision(actor, {
        setId: params['setId'] as string,
        number: header('x-sheet-number'),
        title: header('x-sheet-title'),
        ...(header('x-discipline') ? { discipline: header('x-discipline') } : {}),
        revisionLabel: header('x-revision') || '0',
        filename: header('x-filename') || `${header('x-sheet-number')}.pdf`,
        contentType: (req.headers['content-type'] ?? 'application/octet-stream').split(';')[0] as string,
        bytes: Buffer.concat(chunks),
      })
    },
    { binary: true },
  ),

  route('POST', '/drawing-sets/:setId/publish', async ({ actor, params, drawings }) => {
    await drawings.publishSet(actor, params['setId'] as string)
    return { ok: true }
  }),

  route('GET', '/drawings/:drawingId/pins', async ({ actor, params, drawings }) => ({
    pins: await drawings.pinsFor(actor, params['drawingId'] as string),
  })),

  route('POST', '/drawing-revisions/:revisionId/pins', async ({ actor, params, body, drawings }) =>
    drawings.pin(actor, {
      revisionId: params['revisionId'] as string,
      recordId: String(body['recordId'] ?? ''),
      ...(body['page'] ? { page: Number(body['page']) } : {}),
      x: Number(body['x']),
      y: Number(body['y']),
    }),
  ),

  route(
    'GET',
    '/drawing-revisions/:revisionId/file',
    async ({ actor, params, drawings, res }) => {
      const sheet = await drawings.sheetBytes(actor, params['revisionId'] as string)
      res.writeHead(200, {
        'content-type': sheet.contentType,
        'content-length': sheet.bytes.byteLength,
        'content-disposition': `attachment; filename="${sheet.number.replace(/["\\]/g, '')}.pdf"`,
        'x-content-type-options': 'nosniff',
      })
      res.end(sheet.bytes)
      return undefined
    },
    { binary: true },
  ),

  /**
   * Offline.
   *
   * Three calls and no more: claim a device, pull what you will need, push
   * what you did. Everything else about being offline is the client's problem,
   * which is the right place for it.
   */
  route('POST', '/sync/devices', async ({ actor, body, sync }) =>
    sync.registerDevice(actor, String(body['deviceKey'] ?? ''), body['label'] as string | undefined),
  ),

  route('GET', '/sync/pull', async ({ actor, query, sync }) =>
    sync.pull(actor, {
      deviceId: query.get('deviceId') ?? '',
      projectId: query.get('projectId') ?? '',
    }),
  ),

  route('POST', '/sync/push', async ({ actor, body, sync }) => ({
    results: await sync.push(
      actor,
      String(body['deviceId'] ?? ''),
      (body['operations'] ?? []) as Parameters<SyncService['push']>[2],
    ),
  })),

  route('GET', '/projects/:projectId/sync-conflicts', async ({ actor, params, sync }) => ({
    conflicts: await sync.conflicts(actor, params['projectId'] as string),
  })),

  route('GET', '/projects/:projectId/escalations', async ({ actor, params, escalations }) => ({
    escalations: await escalations.pending(actor, params['projectId'] as string),
  })),

  route('POST', '/projects/:projectId/escalations/sweep', async ({ actor, params, escalations }) =>
    escalations.sweep(actor, params['projectId'] as string),
  ),

  /**
   * The kernel as tools, for somebody else's agent.
   *
   * No separate auth and no service account: the same bearer token the web
   * client sends, resolved to the same person, carrying the same access
   * snapshot. An agent is a client, not a role, which is the only version of
   * this that does not need its own permission model to go wrong separately.
   */
  route('GET', '/mcp/tools', async () => ({ tools: TOOLS })),

  route('POST', '/mcp/call', async ({ actor, body, mcp }) => ({
    result: await mcp.call(actor, {
      name: String(body['name'] ?? ''),
      arguments: (body['arguments'] ?? {}) as Record<string, unknown>,
    }),
  })),

  // ---------------------------------------------------------------------
  // Contracts, obligations and the notice clock
  // ---------------------------------------------------------------------

  route('GET', '/projects/:projectId/contracts', async ({ actor, params, contracts }) => ({
    documents: await contracts.listDocuments(actor, params['projectId'] as string),
  })),

  route('POST', '/projects/:projectId/contracts', async ({ actor, params, body, contracts }) =>
    contracts.createDocument(actor, {
      projectId: params['projectId'] as string,
      kind: body['kind'] as Parameters<ContractService['createDocument']>[1]['kind'],
      title: String(body['title'] ?? ''),
      ...(body['counterpartyOrgId'] ? { counterpartyOrgId: String(body['counterpartyOrgId']) } : {}),
      ...(body['parentDocumentId'] ? { parentDocumentId: String(body['parentDocumentId']) } : {}),
      ...(body['executedAt'] ? { executedAt: String(body['executedAt']) } : {}),
      ...(body['effectiveAt'] ? { effectiveAt: String(body['effectiveAt']) } : {}),
    }),
  ),

  route('POST', '/contracts/:documentId/segment', async ({ actor, params, body, contracts }) =>
    contracts.segmentDocument(actor, params['documentId'] as string, String(body['text'] ?? '')),
  ),

  route('GET', '/contracts/:documentId/clauses', async ({ actor, params, contracts }) => ({
    clauses: await contracts.clauses(actor, params['documentId'] as string),
  })),

  route('GET', '/contracts/:documentId/lineage', async ({ actor, params, contracts }) => ({
    lineage: await contracts.lineage(actor, params['documentId'] as string),
  })),

  route('GET', '/contracts/:documentId/obligations', async ({ actor, params, query, obligations }) => ({
    obligations: await obligations.list(actor, {
      documentId: params['documentId'] as string,
      ...(query.get('status') ? { status: query.get('status') as string } : {}),
    }),
  })),

  route('POST', '/contracts/:documentId/obligations', async ({ actor, params, body, obligations }) =>
    obligations.propose(
      actor,
      params['documentId'] as string,
      (body['obligations'] ?? []) as Parameters<ObligationService['propose']>[2],
    ),
  ),

  route('POST', '/contracts/:documentId/flow-down', async ({ actor, params, obligations }) =>
    obligations.flowDown(actor, params['documentId'] as string),
  ),

  route('POST', '/obligations/:obligationId/accept', async ({ actor, params, obligations }) => {
    await obligations.accept(actor, params['obligationId'] as string)
    return { ok: true }
  }),

  route('POST', '/obligations/:obligationId/reject', async ({ actor, params, obligations }) => {
    await obligations.reject(actor, params['obligationId'] as string)
    return { ok: true }
  }),

  route('GET', '/projects/:projectId/obligations', async ({ actor, params, query, obligations }) => ({
    obligations: await obligations.list(actor, {
      projectId: params['projectId'] as string,
      ...(query.get('status') ? { status: query.get('status') as string } : {}),
    }),
  })),

  route('GET', '/projects/:projectId/calendar', async ({ actor, params, contracts }) =>
    contracts.calendar(actor, params['projectId'] as string),
  ),

  route('PUT', '/projects/:projectId/calendar', async ({ actor, params, body, contracts }) => {
    await contracts.setCalendar(actor, params['projectId'] as string, {
      ...(Array.isArray(body['workDays']) ? { workDays: (body['workDays'] as number[]).map(Number) } : {}),
      ...(body['timeZone'] ? { timeZone: String(body['timeZone']) } : {}),
      ...(body['dayDefinition'] ? { dayDefinition: String(body['dayDefinition']) } : {}),
    })
    return { ok: true }
  }),

  route('POST', '/projects/:projectId/calendar/holidays', async ({ actor, params, body, contracts }) => {
    await contracts.addHoliday(
      actor,
      params['projectId'] as string,
      String(body['observedOn'] ?? ''),
      String(body['name'] ?? ''),
    )
    return { ok: true }
  }),

  route('GET', '/projects/:projectId/clocks', async ({ actor, params, clocks }) => ({
    clocks: await clocks.list(actor, params['projectId'] as string),
  })),

  /**
   * The engine, on demand.
   *
   * It is a worker and it runs on a schedule; this exists because a PM who
   * has just accepted an obligation wants to see the clocks it would start
   * without waiting for the next tick, and because a deadline subsystem
   * nobody can force to run is one nobody will trust.
   */
  route('POST', '/projects/:projectId/clocks/sweep', async ({ actor, params, clocks }) =>
    // Scoped, and deliberately not advancing the global cursor: one tenant
    // pressing a button must not consume another tenant's backlog. The unique
    // index on (obligation, event) is what makes a full re-scan a no-op.
    clocks.sweepProject(actor, params['projectId'] as string),
  ),

  route('POST', '/escalations/:escalationId/approve', async ({ actor, params, escalations }) => {
    await escalations.approve(actor, params['escalationId'] as string)
    return { ok: true }
  }),

  route('POST', '/escalations/:escalationId/dismiss', async ({ actor, params, escalations }) => {
    await escalations.dismiss(actor, params['escalationId'] as string)
    return { ok: true }
  }),

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

export interface ApiServerOptions {
  /**
   * Injected by tests with a scripted double. Left unset in production, where
   * the default provider is constructed lazily — it resolves credentials at
   * construction, and a deployment that never captures should not need a
   * model key to boot.
   */
  interpretationProvider?: InterpretationProvider
  /**
   * Where attachments live. Defaults to a directory on this machine, which is
   * the right answer for a single-server install and for plenty of
   * contractors who will never want their drawings leaving the building.
   */
  blobStore?: BlobStore
}

export function createApiServer(pool: Pool, options: ApiServerOptions = {}): Server {
  const kernel = new RecordKernel(pool as Db)

  // Stateless over the pool, so unlike capture there is nothing to construct
  // lazily and no credential to resolve.
  const budgetService = new BudgetService(pool as Db)
  const syncService = new SyncService(pool as Db)
  const escalationService = new EscalationService(pool as Db)
  const contractService = new ContractService(pool as Db)
  const obligationService = new ObligationService(pool as Db)
  const clockEngine = new ClockEngine(pool as Db)
  const mcpRunner = new McpToolRunner(pool as Db)
  const commitmentService = new CommitmentService(pool as Db)
  const invoicingService = new InvoicingService(pool as Db)

  let drawings: DrawingService | null = null
  const drawingService = (): DrawingService => {
    drawings ??= new DrawingService(pool as Db, blobStore())
    return drawings
  }

  let store: BlobStore | null = null
  const blobStore = (): BlobStore => {
    // One store for attachments and drawings both. Two roots would mean two
    // places a file can be, and one of them is always the wrong one.
    store ??= options.blobStore ?? new FilesystemBlobStore(process.env['PLUMBLINE_BLOB_ROOT'] ?? './.blobs')
    return store
  }

  let attachmentService: AttachmentService | null = null
  const attachments = (): AttachmentService => {
    attachmentService ??= new AttachmentService(pool as Db, blobStore())
    return attachmentService
  }

  let captureService: CaptureService | null = null
  const capture = (): CaptureService => {
    captureService ??= new CaptureService(
      pool as Db,
      options.interpretationProvider ?? new AnthropicInterpretationProvider(),
    )
    return captureService
  }

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

        const body = match.r.binary ? {} : await readBody(req)
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
          capture: capture(),
          attachments: attachments(),
          budget: budgetService,
          drawings: drawingService(),
          sync: syncService,
          escalations: escalationService,
          contracts: contractService,
          obligations: obligationService,
          clocks: clockEngine,
          mcp: mcpRunner,
          commitments: commitmentService,
          invoicing: invoicingService,
          db: pool,
          res,
        })

        // A download has already written the response itself.
        if (res.writableEnded) return

        const created =
          req.method === 'POST' && (url.pathname.endsWith('/records') || url.pathname.endsWith('/captures'))
        send(res, created ? 201 : 200, result)
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
