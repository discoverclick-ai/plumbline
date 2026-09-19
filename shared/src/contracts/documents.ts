import { withTenant, type Db } from '../db.js'
import { NotFoundError, PermissionDeniedError, ValidationError } from '../errors.js'
import type { Actor } from '../kernel.js'
import { hasLevel, hasPrivilege, type AccessSnapshot } from '../permissions.js'
import { loadAccess } from '../repositories/permissions.js'
import { DEFAULT_CALENDAR, type ProjectCalendar } from './calendar.js'
import { segment, type SegmentationResult } from './segmentation.js'

/**
 * The paper, and who is allowed to read it.
 *
 * Contract terms are the most sensitive data in this system, and the
 * permission rule is not the usual one. Everywhere else a project member sees
 * the project. Here a trade partner reads the subcontract they signed and
 * nothing else: not the prime's indemnity language, and above all not another
 * sub's price. So access is decided per instrument, by counterparty, and the
 * `view_terms` privilege gates clause text specifically.
 *
 * Nothing in this file reads anything. Segmentation is a parser, the quote
 * gate is a string comparison, and the deadlines are arithmetic. The model
 * arrives later, behind the same approval gate as every other agent here, and
 * it arrives into a schema where a citation is already a pointer at a page.
 */

export type ContractDocumentKind =
  | 'prime_contract'
  | 'subcontract'
  | 'purchase_order'
  | 'general_conditions'
  | 'supplementary_conditions'
  | 'amendment'
  | 'change_order'
  | 'exhibit'

export interface ContractDocumentRow {
  id: string
  projectId: string
  kind: ContractDocumentKind
  title: string
  counterpartyOrgId: string | null
  parentDocumentId: string | null
  executedAt: string | null
  effectiveAt: string | null
  status: 'uploaded' | 'segmented' | 'profiled' | 'active' | 'superseded'
  clauseCount: number
  version: number
}

export interface ClauseRow {
  id: string
  clauseNumber: string | null
  heading: string | null
  text: string
  page: number | null
  orderIndex: number
}

export class ContractService {
  constructor(private readonly db: Db) {}

  async createDocument(
    actor: Actor,
    input: {
      projectId: string
      kind: ContractDocumentKind
      title: string
      counterpartyOrgId?: string
      parentDocumentId?: string
      executedAt?: string
      effectiveAt?: string
      storageKey?: string
      pageCount?: number
    },
  ): Promise<{ id: string }> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await this.assertPrivilege(tx, actor, input.projectId, 'upload')

      if (input.parentDocumentId) {
        const parent = await this.loadDocumentRow(tx, actor.tenantId, input.parentDocumentId)
        if (parent.project_id !== input.projectId) {
          // A flow-down chain that crosses projects is a mis-keyed id, and it
          // would silently import another job's terms onto this one.
          throw new ValidationError('That parent instrument belongs to a different project', [
            { field: 'parentDocumentId', message: 'Parent must be on the same project' },
          ])
        }
      }

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO contract_documents
           (tenant_id, project_id, kind, title, counterparty_org_id, parent_document_id,
            executed_at, effective_at, storage_key, page_count, uploaded_by)
         VALUES ($1, $2, $3::contract_document_kind, $4, $5, $6, $7::date, $8::date, $9, $10, $11)
         RETURNING id`,
        [
          actor.tenantId,
          input.projectId,
          input.kind,
          input.title,
          input.counterpartyOrgId ?? null,
          input.parentDocumentId ?? null,
          input.executedAt ?? null,
          input.effectiveAt ?? null,
          input.storageKey ?? null,
          input.pageCount ?? null,
          actor.userId,
        ],
      )
      return { id: rows[0]!.id }
    })
  }

  /**
   * Cuts a document into citable clauses.
   *
   * Idempotent by replacement: re-segmenting a document replaces its clauses
   * wholesale, which is the right shape while a document has no obligations
   * hanging off it and the wrong one afterwards. Once obligations cite these
   * clauses, re-segmentation is refused rather than cascading, because a
   * delete that takes citations with it is how a claim file loses its
   * evidence.
   */
  async segmentDocument(
    actor: Actor,
    documentId: string,
    text: string,
  ): Promise<SegmentationResult & { clauseIds: string[] }> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const doc = await this.loadDocumentRow(tx, actor.tenantId, documentId)
      await this.assertPrivilege(tx, actor, doc.project_id, 'segment')

      const { rows: citing } = await tx.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM contract_clauses c
          WHERE c.tenant_id = $1 AND c.document_id = $2
            AND EXISTS (SELECT 1 FROM contract_obligations o WHERE o.clause_id = c.id)`,
        [actor.tenantId, documentId],
      )
      if (Number(citing[0]?.count ?? 0) > 0) {
        throw new ValidationError('This document already has obligations citing its clauses', [
          {
            field: 'documentId',
            message:
              'Re-segmenting would orphan citations that a claim may depend on. Supersede the document with a new version instead.',
          },
        ])
      }

      const result = segment(text)

      await tx.query('DELETE FROM contract_clauses WHERE tenant_id = $1 AND document_id = $2', [
        actor.tenantId,
        documentId,
      ])

      const clauseIds: string[] = []
      for (const clause of result.clauses) {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO contract_clauses
             (tenant_id, document_id, clause_number, heading, text, page, order_index)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            actor.tenantId,
            documentId,
            clause.clauseNumber,
            clause.heading,
            clause.text,
            clause.page,
            clause.orderIndex,
          ],
        )
        clauseIds.push(rows[0]!.id)
      }

      // A document the parser could not read stays 'uploaded'. That gap is
      // meant to be visible on the profile screen rather than papered over
      // with a status that claims work happened.
      if (!result.needsManualSegmentation) {
        await tx.query(
          `UPDATE contract_documents SET status = 'segmented', version = version + 1, updated_at = now()
            WHERE tenant_id = $1 AND id = $2`,
          [actor.tenantId, documentId],
        )
      }

      return { ...result, clauseIds }
    })
  }

  /** Every instrument on the project this actor is entitled to see. */
  async listDocuments(actor: Actor, projectId: string): Promise<ContractDocumentRow[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
      if (!hasLevel(access, 'contracts', 'read_only') && !access.isCompanyAdmin) {
        throw new PermissionDeniedError('You cannot read contracts on this project', { tool: 'contracts' })
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT d.id, d.project_id, d.kind::text AS kind, d.title, d.counterparty_org_id, d.parent_document_id,
                d.executed_at, d.effective_at, d.status::text AS status, d.version,
                (SELECT count(*) FROM contract_clauses c WHERE c.document_id = d.id)::int AS clause_count
           FROM contract_documents d
          WHERE d.tenant_id = $1 AND d.project_id = $2
          ORDER BY d.kind, d.executed_at NULLS LAST, d.title`,
        [actor.tenantId, projectId],
      )

      const mine = await this.myOrganizationId(tx, actor)
      return rows
        .filter((r) => this.mayReadInstrument(access, (r['counterparty_org_id'] as string | null) ?? null, mine))
        .map((r) => ({
          id: r['id'] as string,
          projectId: r['project_id'] as string,
          kind: r['kind'] as ContractDocumentKind,
          title: r['title'] as string,
          counterpartyOrgId: (r['counterparty_org_id'] as string | null) ?? null,
          parentDocumentId: (r['parent_document_id'] as string | null) ?? null,
          executedAt: asDate(r['executed_at']),
          effectiveAt: asDate(r['effective_at']),
          status: r['status'] as ContractDocumentRow['status'],
          clauseCount: Number(r['clause_count'] ?? 0),
          version: Number(r['version'] ?? 1),
        }))
    })
  }

  /**
   * The clause text.
   *
   * Governed by the same rule as the instrument list: you read the paper you
   * signed, and `view_terms` is what extends that to the whole job. The
   * separate concern from the spec, that a superintendent must see a notice
   * is due today without seeing the prime's indemnity language, lives on the
   * notice record rather than here: the clock carries its clause NUMBER and
   * its deadline, and the text is one click further in behind this check.
   */
  async clauses(actor: Actor, documentId: string): Promise<ClauseRow[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const doc = await this.loadDocumentRow(tx, actor.tenantId, documentId)
      const access = await loadAccess(tx, {
        userId: actor.userId,
        tenantId: actor.tenantId,
        projectId: doc.project_id,
      })

      const mine = await this.myOrganizationId(tx, actor)
      // Being a party to the instrument IS the right to read it. `view_terms`
      // is what lets you read instruments you are not a party to, which is
      // the general contractor's own team and nobody else. A sub who could
      // see that their subcontract exists but not what it says would be
      // holding a deadline with no way to check it.
      if (!this.mayReadInstrument(access, doc.counterparty_org_id, mine)) {
        // Not a permission error. Telling a sub that a contract they cannot
        // read exists on this project is itself the leak: the existence of a
        // change order between the GC and the owner tells them the markup on
        // their own work.
        throw new NotFoundError('contract document', documentId)
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT id, clause_number, heading, text, page, order_index
           FROM contract_clauses WHERE tenant_id = $1 AND document_id = $2 ORDER BY order_index`,
        [actor.tenantId, documentId],
      )
      return rows.map((r) => ({
        id: r['id'] as string,
        clauseNumber: (r['clause_number'] as string | null) ?? null,
        heading: (r['heading'] as string | null) ?? null,
        text: r['text'] as string,
        page: r['page'] === null ? null : Number(r['page']),
        orderIndex: Number(r['order_index']),
      }))
    })
  }

  /**
   * The chain of instruments that bind a document.
   *
   * A prime incorporated into a subcontract incorporated into a purchase
   * order is three levels, and real projects do this. Returned root-first so
   * a reader sees where a term originated before where it landed.
   */
  async lineage(actor: Actor, documentId: string): Promise<ContractDocumentRow[]> {
    const doc = await withTenant(this.db, actor.tenantId, (tx) =>
      this.loadDocumentRow(tx, actor.tenantId, documentId),
    )
    const all = await this.listDocuments(actor, doc.project_id)
    const byId = new Map(all.map((d) => [d.id, d]))

    const chain: ContractDocumentRow[] = []
    let cursor = byId.get(documentId)
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id)
      chain.unshift(cursor)
      cursor = cursor.parentDocumentId ? byId.get(cursor.parentDocumentId) : undefined
    }
    return chain
  }

  // -------------------------------------------------------------------------
  // The project calendar
  // -------------------------------------------------------------------------

  async setCalendar(
    actor: Actor,
    projectId: string,
    input: { workDays?: number[]; timeZone?: string; dayDefinition?: string; sourceClauseId?: string },
  ): Promise<void> {
    await withTenant(this.db, actor.tenantId, async (tx) => {
      await this.assertPrivilege(tx, actor, projectId, 'manage_calendar')

      const workDays = input.workDays ?? DEFAULT_CALENDAR.workDays
      if (workDays.length === 0 || workDays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
        throw new ValidationError('A work week needs at least one day, numbered 1 (Monday) to 7', [
          { field: 'workDays', message: 'Use ISO weekday numbers, 1 = Monday' },
        ])
      }
      if (input.timeZone) assertZone(input.timeZone)

      await tx.query(
        `INSERT INTO project_calendars (project_id, tenant_id, work_days, time_zone, day_definition, source_clause_id)
              VALUES ($1, $2, $3::int[], $4, $5, $6)
         ON CONFLICT (project_id) DO UPDATE
            SET work_days = EXCLUDED.work_days, time_zone = EXCLUDED.time_zone,
                day_definition = EXCLUDED.day_definition, source_clause_id = EXCLUDED.source_clause_id,
                updated_at = now()`,
        [
          projectId,
          actor.tenantId,
          [...new Set(workDays)].sort(),
          input.timeZone ?? DEFAULT_CALENDAR.timeZone,
          input.dayDefinition ?? null,
          input.sourceClauseId ?? null,
        ],
      )
    })
  }

  async addHoliday(actor: Actor, projectId: string, observedOn: string, name: string): Promise<void> {
    await withTenant(this.db, actor.tenantId, async (tx) => {
      await this.assertPrivilege(tx, actor, projectId, 'manage_calendar')
      await tx.query(
        `INSERT INTO project_holidays (tenant_id, project_id, observed_on, name)
              VALUES ($1, $2, $3::date, $4)
         ON CONFLICT (project_id, observed_on) DO UPDATE SET name = EXCLUDED.name`,
        [actor.tenantId, projectId, observedOn, name],
      )
    })
  }

  /**
   * The calendar the arithmetic runs against.
   *
   * Readable by anyone on the project and gated by no privilege, because a
   * deadline nobody can check is a deadline nobody trusts, and the work week
   * is not a contract term.
   */
  async calendar(actor: Actor, projectId: string): Promise<ProjectCalendar> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
      if (!access.isProjectMember && !access.isCompanyAdmin) {
        throw new PermissionDeniedError('You are not on this project')
      }

      const { rows } = await tx.query<{ work_days: number[]; time_zone: string }>(
        `SELECT work_days, time_zone FROM project_calendars WHERE tenant_id = $1 AND project_id = $2`,
        [actor.tenantId, projectId],
      )
      const { rows: holidays } = await tx.query<{ observed_on: string }>(
        `SELECT to_char(observed_on, 'YYYY-MM-DD') AS observed_on
           FROM project_holidays WHERE tenant_id = $1 AND project_id = $2 ORDER BY observed_on`,
        [actor.tenantId, projectId],
      )

      const row = rows[0]
      return {
        workDays: row?.work_days ?? DEFAULT_CALENDAR.workDays,
        timeZone: row?.time_zone ?? DEFAULT_CALENDAR.timeZone,
        holidays: holidays.map((h) => h.observed_on),
      }
    })
  }

  // -------------------------------------------------------------------------

  /**
   * Whether this actor may know an instrument exists.
   *
   * Anyone with `view_terms` reads the job's paper, which is the GC's own
   * team. Everybody else sees only instruments their own company is a party
   * to. That is stricter than the rest of the product on purpose: a sub who
   * can see that a change order exists between the GC and the owner can infer
   * the markup on their own work.
   */
  private mayReadInstrument(
    access: AccessSnapshot,
    counterpartyOrgId: string | null,
    myOrganizationId: string | null,
  ): boolean {
    if (access.isCompanyAdmin) return true
    if (hasPrivilege(access, 'contracts', 'view_terms')) return true
    return counterpartyOrgId !== null && counterpartyOrgId === myOrganizationId
  }

  private async myOrganizationId(tx: Db, actor: Actor): Promise<string | null> {
    const { rows } = await tx.query<{ organization_id: string }>(
      'SELECT organization_id FROM users WHERE tenant_id = $1 AND id = $2',
      [actor.tenantId, actor.userId],
    )
    return rows[0]?.organization_id ?? null
  }

  private async loadDocumentRow(
    tx: Db,
    tenantId: string,
    documentId: string,
  ): Promise<{ id: string; project_id: string; counterparty_org_id: string | null }> {
    const { rows } = await tx.query<{ id: string; project_id: string; counterparty_org_id: string | null }>(
      'SELECT id, project_id, counterparty_org_id FROM contract_documents WHERE tenant_id = $1 AND id = $2',
      [tenantId, documentId],
    )
    const row = rows[0]
    if (!row) throw new NotFoundError('contract document', documentId)
    return row
  }

  private async assertPrivilege(tx: Db, actor: Actor, projectId: string, privilege: string): Promise<void> {
    const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
    if (!hasPrivilege(access, 'contracts', privilege) && !access.isCompanyAdmin) {
      throw new PermissionDeniedError(`You cannot ${privilege.replace('_', ' ')} contracts on this project`, {
        tool: 'contracts',
        privilege,
      })
    }
  }
}

function asDate(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
}

function assertZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone })
  } catch {
    throw new ValidationError(`"${timeZone}" is not a timezone this system recognises`, [
      { field: 'timeZone', message: 'Use an IANA zone, e.g. America/Denver' },
    ])
  }
}
