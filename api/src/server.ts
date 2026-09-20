import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  AnthropicInterpretationProvider,
  AnthropicTranscriptionProvider,
  AdministrationService,
  addSegmentValue,
  createBudgetCode,
  listBudgetCodes,
  listSegments,
  listSegmentValues,
  AnthropicNoticeDrafter,
  AnthropicObligationExtractor,
  AnthropicRequirementExtractor,
  AttachmentService,
  authenticate,
  DrawingService,
  ClaimFileService,
  ClockEngine,
  ContractService,
  EscalationService,
  McpToolRunner,
  NoticeDraftService,
  ObligationService,
  parseCsv,
  PhotoService,
  ProcoreImporter,
  renderClaimFile,
  ScheduleService,
  SpecificationService,
  StatutoryService,
  type ObligationExtractionProvider,
  type RequirementExtractionProvider,
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
  type TranscriptionProvider,
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
  claims: ClaimFileService
  statutory: StatutoryService
  drafter: NoticeDraftService
  photos: PhotoService
  specs: SpecificationService
  procore: ProcoreImporter
  admin: AdministrationService
  schedule: ScheduleService
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
           JOIN users u ON u.id = m.user_id AND u.tenant_id = m.tenant_id
           JOIN organizations o ON o.id = u.organization_id AND o.tenant_id = u.tenant_id
          WHERE m.tenant_id = $1 AND m.project_id = $2 AND u.is_active
          ORDER BY o.name, u.name`,
        [actor.tenantId, projectId],
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

  // Interpretation transcribes on its way in, so this route exists for the
  // two cases that one does not cover: reading a file without proposing a
  // record off it, and re-reading one whose transcript was wrong.
  route('POST', '/captures/:captureId/transcribe', async ({ capture, actor, params, body }) =>
    capture.transcribe(actor, params['captureId'] as string, {
      force: body['force'] === true,
    }),
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

  // ---------------------------------------------------------------------
  // The cost breakdown a budget hangs off
  // ---------------------------------------------------------------------
  //
  // These had no routes either, which meant a budget line could not be
  // created from any client: the money subsystem was unreachable for setup
  // while being fully built underneath.

  // These functions set their own tenant context now, so a route cannot
  // forget it. The first version of these three did, and the symptom was not
  // an error: FORCED row-level security on a confined connection with no
  // tenant set returns ZERO ROWS, which showed up as an empty cost code
  // picker on a screen where empty reads as "nothing defined yet".
  route('GET', '/wbs/segments', async ({ actor, db }) => ({
    segments: await listSegments(db, actor.tenantId),
  })),

  route('GET', '/projects/:projectId/wbs/:segmentKey', async ({ actor, params, db }) => ({
    values: await listSegmentValues(db, actor.tenantId, {
      segmentKey: params['segmentKey'] as string,
      projectId: params['projectId'] as string,
    }),
  })),

  route('POST', '/projects/:projectId/wbs/:segmentKey', async ({ actor, params, body, db, budget }) => {
    // Gated on the budget tool's own privilege rather than on nothing: a
    // cost code is part of the financial structure, and anybody who can
    // invent one can make the budget say whatever they like.
    await budget.assertCanManageCodes(actor, params['projectId'] as string)
    return withTenant(db, actor.tenantId, (tx) =>
      addSegmentValue(tx, actor.tenantId, {
        segmentKey: params['segmentKey'] as string,
        code: String(body['code'] ?? ''),
        label: String(body['label'] ?? ''),
        projectId: params['projectId'] as string,
      }),
    )
  }),

  route('GET', '/projects/:projectId/budget-codes', async ({ actor, params, db }) => ({
    codes: await listBudgetCodes(db, actor.tenantId, params['projectId'] as string),
  })),

  route('POST', '/projects/:projectId/budget-codes', async ({ actor, params, body, db, budget }) => {
    await budget.assertCanManageCodes(actor, params['projectId'] as string)
    return createBudgetCode(db as Db, actor.tenantId, {
      projectId: params['projectId'] as string,
      values: (body['values'] ?? {}) as Record<string, string>,
    })
  }),

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

  // Listed before anything is added, because the rolled-up total on the
  // budget line cannot tell a person which of those dollars the posting
  // worker already wrote off an invoice. Without this the natural mistake is
  // to enter the same invoice twice.
  route('GET', '/projects/:projectId/costs', async ({ actor, params, query, budget }) =>
    budget.costs(actor, params['projectId'] as string, {
      ...(query.get('budgetCodeId') ? { budgetCodeId: query.get('budgetCodeId') as string } : {}),
    }),
  ),

  route('POST', '/projects/:projectId/costs', async ({ actor, params, body, budget }) =>
    budget.recordCost(actor, {
      projectId: params['projectId'] as string,
      budgetCodeId: body['budgetCodeId'] as string,
      kind: body['kind'] as 'committed' | 'actual' | 'pending' | 'forecast',
      amount: String(body['amount'] ?? ''),
      description: body['description'] as string | undefined,
      ...(body['quantity'] ? { quantity: String(body['quantity']) } : {}),
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
  // Setting a company up
  // ---------------------------------------------------------------------
  //
  // There was no route to create a project, a company, a person or a
  // membership. The product could run a job beautifully and had no way to
  // start one.

  route('POST', '/projects', async ({ actor, body, admin }) =>
    admin.projectStart(actor, {
      number: String(body['number'] ?? ''),
      name: String(body['name'] ?? ''),
      ...(body['stage'] ? { stage: body['stage'] as Parameters<AdministrationService['projectStart']>[1]['stage'] } : {}),
      ...(body['city'] ? { city: String(body['city']) } : {}),
      ...(body['stateCode'] ? { stateCode: String(body['stateCode']) } : {}),
      ...(body['timeZone'] ? { timeZone: String(body['timeZone']) } : {}),
      ...(body['contractValue'] ? { contractValue: String(body['contractValue']) } : {}),
    }),
  ),

  route('GET', '/companies', async ({ actor, admin }) => ({ companies: await admin.companies(actor) })),

  route('POST', '/companies', async ({ actor, body, admin }) =>
    admin.addCompany(actor, {
      name: String(body['name'] ?? ''),
      kind: body['kind'] as Parameters<AdministrationService['addCompany']>[1]['kind'],
      ...(body['trade'] ? { trade: String(body['trade']) } : {}),
    }),
  ),

  route('GET', '/people', async ({ actor, admin }) => ({ people: await admin.people(actor) })),

  route('POST', '/people', async ({ actor, body, admin }) =>
    admin.addPerson(actor, {
      organizationId: String(body['organizationId'] ?? ''),
      email: String(body['email'] ?? ''),
      name: String(body['name'] ?? ''),
      ...(body['jobTitle'] ? { jobTitle: String(body['jobTitle']) } : {}),
      ...(body['password'] ? { password: String(body['password']) } : {}),
      ...(body['companyPermissionTemplateId'] !== undefined
        ? { companyPermissionTemplateId: body['companyPermissionTemplateId'] as string | null }
        : {}),
    }),
  ),

  route('GET', '/permission-templates', async ({ actor, query, admin }) => ({
    templates: await admin.templates(actor, (query.get('scope') as 'company' | 'project' | null) ?? undefined),
  })),

  route('POST', '/projects/:projectId/members', async ({ actor, params, body, admin }) => {
    await admin.addMember(actor, {
      projectId: params['projectId'] as string,
      userId: String(body['userId'] ?? ''),
      ...(body['permissionTemplateName'] ? { permissionTemplateName: String(body['permissionTemplateName']) } : {}),
      ...(body['permissionTemplateId'] ? { permissionTemplateId: String(body['permissionTemplateId']) } : {}),
    })
    return { ok: true }
  }),

  /**
   * Bringing a job across from Procore.
   *
   * The thing that decides whether anybody can leave the incumbent, and it
   * had no route either: the importer was written and tested and could not be
   * called from any client in the product.
   *
   * The CSV is posted as text rather than multipart, because a Procore export
   * is a file somebody downloaded and this is a paste box as much as an
   * upload. The result names every row it skipped and every company and
   * person it invented, because an import that silently conjures an
   * organization is one nobody can audit afterwards.
   */
  route(
    'POST',
    '/projects/:projectId/imports/procore/rfis',
    async ({ actor, params, req, procore }) => {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += (chunk as Buffer).length
        if (size > MAX_UPLOAD_BYTES) {
          throw new KernelError('payload_too_large', 'That export is too large', 413)
        }
        chunks.push(chunk as Buffer)
      }
      const rows = parseCsv(Buffer.concat(chunks).toString('utf8'))
      return procore.importRfis(actor, { projectId: params['projectId'] as string, rows })
    },
    { binary: true },
  ),

  // ---------------------------------------------------------------------
  // Specifications, and the submittal register hiding in them
  // ---------------------------------------------------------------------
  //
  // The whole subsystem had no routes at all, which made the best agent job
  // in construction unreachable from every client in the product.

  route('GET', '/projects/:projectId/submittal-register', async ({ actor, params, specs }) => ({
    requirements: await specs.register(actor, params['projectId'] as string),
  })),

  route('POST', '/projects/:projectId/specification-books', async ({ actor, params, body, specs }) =>
    specs.createBook(actor, {
      projectId: params['projectId'] as string,
      name: String(body['name'] ?? ''),
      ...(body['issuedOn'] ? { issuedOn: String(body['issuedOn']) } : {}),
    }),
  ),

  route('POST', '/specification-books/:bookId/sections', async ({ actor, params, body, specs }) =>
    specs.addSection(actor, {
      bookId: params['bookId'] as string,
      number: String(body['number'] ?? ''),
      title: String(body['title'] ?? ''),
      body: String(body['body'] ?? ''),
    }),
  ),

  /** Proposals, never submittals. Same gate as every other agent here. */
  route('POST', '/specification-sections/:sectionId/extract', async ({ actor, params, specs }) =>
    specs.extractRequirements(actor, params['sectionId'] as string),
  ),

  route('POST', '/submittal-requirements/:requirementId/accept', async ({ actor, params, body, specs }) =>
    specs.accept(actor, params['requirementId'] as string, {
      ...(body['specSection'] ? { specSection: String(body['specSection']) } : {}),
      ...(body['assigneeUserId'] ? { assigneeUserId: String(body['assigneeUserId']) } : {}),
    }),
  ),

  route('POST', '/submittal-requirements/:requirementId/reject', async ({ actor, params, specs }) => {
    await specs.reject(actor, params['requirementId'] as string)
    return { ok: true }
  }),

  // ---------------------------------------------------------------------
  // Photographs
  // ---------------------------------------------------------------------

  route('GET', '/projects/:projectId/photos', async ({ actor, params, query, photos }) => ({
    photos: await photos.list(actor, params['projectId'] as string, {
      ...(query.get('from') ? { from: query.get('from') as string } : {}),
      ...(query.get('to') ? { to: query.get('to') as string } : {}),
      ...(query.get('albumId') ? { albumId: query.get('albumId') as string } : {}),
      ...(query.get('recordId') ? { recordId: query.get('recordId') as string } : {}),
      ...(query.get('undated') === 'true' ? { undatedOnly: true } : {}),
    }),
  })),

  route(
    'POST',
    '/projects/:projectId/photos',
    async ({ actor, params, req, photos }) => {
      // Streamed and size-capped here rather than buffered by a body parser,
      // same as attachments: a phone uploading a twelve megapixel photograph
      // over site wifi is the normal case, not the edge.
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += (chunk as Buffer).length
        if (size > MAX_UPLOAD_BYTES) {
          throw new KernelError('payload_too_large', 'That photograph is too large', 413)
        }
        chunks.push(chunk as Buffer)
      }
      const bytes = Buffer.concat(chunks)

      return photos.upload(actor, {
        projectId: params['projectId'] as string,
        filename: String(req.headers['x-filename'] ?? 'photo.jpg'),
        contentType: String(req.headers['content-type'] ?? 'image/jpeg'),
        bytes,
        ...(req.headers['x-caption'] ? { caption: String(req.headers['x-caption']) } : {}),
      })
    },
    { binary: true },
  ),

  route('GET', '/photos/:photoId/file', async ({ actor, params, photos, res }) => {
    const file = await photos.download(actor, params['photoId'] as string)
    res.writeHead(200, {
      'content-type': file.contentType,
      'content-length': file.bytes.byteLength,
      // Inline: a photograph is looked at, not filed.
      'content-disposition': `inline; filename="${file.filename.replace(/"/g, '')}"`,
    })
    res.end(file.bytes)
    return null
  }),

  route('POST', '/projects/:projectId/photo-albums', async ({ actor, params, body, photos }) =>
    photos.createAlbum(
      actor,
      params['projectId'] as string,
      String(body['name'] ?? ''),
      body['description'] ? String(body['description']) : undefined,
    ),
  ),

  route('POST', '/photo-albums/:albumId/photos', async ({ actor, params, body, photos }) =>
    photos.addToAlbum(actor, params['albumId'] as string, (body['photoIds'] ?? []) as string[]),
  ),

  route('POST', '/records/:recordId/photos', async ({ actor, params, body, photos }) => {
    await photos.linkToRecord(actor, String(body['photoId'] ?? ''), params['recordId'] as string)
    return { ok: true }
  }),

  // ---------------------------------------------------------------------
  // Schedule
  // ---------------------------------------------------------------------

  route('GET', '/projects/:projectId/schedules', async ({ actor, params, schedule }) => ({
    schedules: await schedule.schedules(actor, params['projectId'] as string),
  })),

  route('POST', '/projects/:projectId/schedules', async ({ actor, params, body, schedule }) =>
    schedule.importXer(actor, {
      projectId: params['projectId'] as string,
      name: String(body['name'] ?? 'Schedule update'),
      text: String(body['text'] ?? ''),
      ...(body['asBaseline'] === true ? { asBaseline: true } : {}),
    }),
  ),

  route('GET', '/projects/:projectId/lookahead', async ({ actor, params, query, schedule }) => ({
    activities: await schedule.lookahead(
      actor,
      params['projectId'] as string,
      Number(query.get('weeks') ?? 3),
    ),
  })),

  /**
   * What is going to stop us this week.
   *
   * The morning meeting, as a query. An activity with two days of float and
   * an RFI that has been sitting eleven is not two problems.
   */
  route('GET', '/projects/:projectId/exposure', async ({ actor, params, schedule }) => ({
    exposure: await schedule.exposure(actor, params['projectId'] as string),
  })),

  route('GET', '/records/:recordId/activities', async ({ actor, params, schedule }) => ({
    activities: await schedule.linksFor(actor, params['recordId'] as string),
  })),

  route('POST', '/records/:recordId/activities', async ({ actor, params, body, schedule }) => {
    await schedule.link(actor, {
      recordId: params['recordId'] as string,
      activityCode: String(body['activityCode'] ?? ''),
      ...(body['kind'] ? { kind: body['kind'] as 'blocks' | 'informs' | 'delivers' | 'documents' } : {}),
      ...(body['note'] ? { note: String(body['note']) } : {}),
    })
    return { ok: true }
  }),

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

  /**
   * Read the whole instrument.
   *
   * Runs the cheap screening pass over every clause and the careful pass over
   * the candidates, and writes what survives the quote gate as proposals.
   * Nothing it produces starts a clock.
   */
  route('POST', '/contracts/:documentId/profile', async ({ actor, params, obligations }) =>
    obligations.profile(actor, params['documentId'] as string),
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
  // ---------------------------------------------------------------------
  // Statutory deadlines
  // ---------------------------------------------------------------------

  route('GET', '/projects/:projectId/statutory-clocks', async ({ actor, params, statutory }) => ({
    clocks: await statutory.clocks(actor, params['projectId'] as string),
  })),

  route('PUT', '/projects/:projectId/statutory-facts', async ({ actor, params, body, statutory }) => {
    await statutory.setFacts(actor, params['projectId'] as string, {
      jurisdiction: String(body['jurisdiction'] ?? ''),
      projectType: String(body['projectType'] ?? 'private'),
      claimantRole: body['claimantRole'] as Parameters<StatutoryService['setFacts']>[2]['claimantRole'],
      ...(body['firstFurnishing'] ? { firstFurnishing: String(body['firstFurnishing']) } : {}),
      ...(body['lastFurnishing'] ? { lastFurnishing: String(body['lastFurnishing']) } : {}),
      ...(body['completionDate'] ? { completionDate: String(body['completionDate']) } : {}),
      ...(body['contractExecuted'] ? { contractExecuted: String(body['contractExecuted']) } : {}),
    })
    // Swept immediately. A date typed into a form and a deadline appearing on
    // a screen should be the same action; making somebody press a second
    // button is how a lien window gets recorded and never watched.
    return statutory.sweep(actor, params['projectId'] as string)
  }),

  route('POST', '/projects/:projectId/statutory-clocks/sweep', async ({ actor, params, statutory }) =>
    statutory.sweep(actor, params['projectId'] as string),
  ),

  // The three triggers this product does not witness. Without these routes
  // every rule hanging off a recorded lien, a served termination or a payment
  // falling due was skipped with a reason nobody could act on.
  route('GET', '/projects/:projectId/statutory-events', async ({ actor, params, statutory }) => ({
    events: await statutory.events(actor, params['projectId'] as string),
  })),

  route('POST', '/projects/:projectId/statutory-events', async ({ actor, params, body, statutory }) =>
    statutory.recordEvent(actor, params['projectId'] as string, {
      kind: body['kind'] as 'notice_of_termination' | 'lien_recorded' | 'payment_due',
      occurredOn: String(body['occurredOn'] ?? ''),
      reference: body['reference'] as string | undefined,
      note: body['note'] as string | undefined,
    }),
  ),

  /**
   * The claim file.
   *
   * A query, never a stored document. Every piece of it was recorded as a
   * side effect of doing the work, so it exists continuously rather than
   * being reconstructed by a project engineer under deposition pressure.
   */
  /**
   * Drafts the letter into the notice record, and stops.
   *
   * The record does not move state. An agent may draft anything here and
   * serve nothing: every route out of a draft is a human transition.
   */
  route('POST', '/clocks/:clockId/draft-notice', async ({ actor, params, drafter }) =>
    drafter.draft(actor, params['clockId'] as string),
  ),

  route('GET', '/clocks/:clockId/claim-file', async ({ actor, params, claims }) =>
    claims.assemble(actor, params['clockId'] as string),
  ),

  route('GET', '/clocks/:clockId/claim-file.md', async ({ actor, params, claims, res }) => {
    const file = await claims.assemble(actor, params['clockId'] as string)
    const body = Buffer.from(renderClaimFile(file), 'utf8')
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-length': body.byteLength,
      // Named for the job and the deadline, because these end up in a folder
      // with forty others and "claim-file.md" helps nobody.
      'content-disposition': `attachment; filename="claim-${file.project.number}-${(file.clock?.dueAt ?? '').slice(0, 10)}.md"`,
    })
    res.end(body)
    return null
  }),

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
  transcriptionProvider?: TranscriptionProvider
  /**
   * Where attachments live. Defaults to a directory on this machine, which is
   * the right answer for a single-server install and for plenty of
   * contractors who will never want their drawings leaving the building.
   */
  blobStore?: BlobStore
  /**
   * Reads contracts. Injected by tests; constructed lazily otherwise, for the
   * same reason as the interpreter, and a deployment can run the whole
   * contracts subsystem without one by entering obligations by hand.
   */
  obligationExtractor?: ObligationExtractionProvider
  /** Reads spec sections and proposes the submittals they require. */
  requirementExtractor?: RequirementExtractionProvider
}

export function createApiServer(pool: Pool, options: ApiServerOptions = {}): Server {
  const kernel = new RecordKernel(pool as Db)

  // Stateless over the pool, so unlike capture there is nothing to construct
  // lazily and no credential to resolve.
  const budgetService = new BudgetService(pool as Db)
  const syncService = new SyncService(pool as Db)
  const escalationService = new EscalationService(pool as Db)
  const contractService = new ContractService(pool as Db)
  // The service is built once; the EXTRACTOR behind it is built on first use.
  // The context object is assembled per request, so anything constructed here
  // that resolves credentials would be constructed on every request and would
  // take down every route on a deployment that never reads a contract.
  let extractor: ObligationExtractionProvider | null = null
  const obligationService = new ObligationService(pool as Db, () => {
    extractor ??= options.obligationExtractor ?? new AnthropicObligationExtractor()
    return extractor
  })
  const clockEngine = new ClockEngine(pool as Db)
  const scheduleService = new ScheduleService(pool as Db)
  const claimFileService = new ClaimFileService(pool as Db)
  const statutoryService = new StatutoryService(pool as Db)

  // Same lazily-built provider pattern as the extractor: the SDK resolves
  // credentials in its constructor, and a deployment that never drafts a
  // notice must still serve every other route.
  let noticeDrafter: AnthropicNoticeDrafter | null = null
  const draftService = new NoticeDraftService(pool as Db, {
    name: 'lazy',
    draft: (request) => {
      noticeDrafter ??= new AnthropicNoticeDrafter()
      return noticeDrafter.draft(request)
    },
  })
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

  // Same lazily-built provider as the other two: constructing the SDK
  // eagerly would stop a deployment with no model key serving any route.
  let specExtractor: RequirementExtractionProvider | null = null
  const specService = new SpecificationService(pool as Db, {
    name: 'lazy',
    extract: (request) => {
      const provider = (specExtractor ??= options.requirementExtractor ?? new AnthropicRequirementExtractor())
      return provider.extract(request)
    },
  })

  const procoreImporter = new ProcoreImporter(pool as Db)
  const administration = new AdministrationService(pool as Db)

  let photoService: PhotoService | null = null
  const photos = (): PhotoService => {
    photoService ??= new PhotoService(pool as Db, blobStore())
    return photoService
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
      {
        // Thunks, not instances. Constructing a model client can throw in
        // some runtimes, and building one eagerly here would take every
        // route on the server down with it — which it did once already.
        transcriber: () => options.transcriptionProvider ?? new AnthropicTranscriptionProvider(),
        blobs: () => blobStore(),
      },
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
          schedule: scheduleService,
          claims: claimFileService,
          statutory: statutoryService,
          drafter: draftService,
          photos: photos(),
          specs: specService,
          procore: procoreImporter,
          admin: administration,
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
