import { withTenant, type Db } from '../db.js'
import { NotFoundError, PermissionDeniedError, ValidationError } from '../errors.js'
import type { Actor } from '../kernel.js'
import { hasLevel, hasPrivilege } from '../permissions.js'
import { loadAccess } from '../repositories/permissions.js'
import type { DurationUnit } from './calendar.js'
import { quoteAppearsIn } from './segmentation.js'

/**
 * Obligations, and the gate they pass through.
 *
 * An obligation is a machine-actionable rule extracted from a clause, and it
 * is the valuable object in the whole subsystem. It is also the dangerous
 * one: a wrong obligation silently mis-times a legal deadline, which is worse
 * than having no obligation at all, because somebody relied on it.
 *
 * So two rules, both enforced here rather than advised.
 *
 * A proposed obligation starts no clocks. Acceptance is a named human act,
 * and the schema will not store an accepted row without the name on it.
 *
 * And an obligation whose quote is not verbatim in its clause is DISCARDED,
 * not flagged. Flagging it would put a fabricated citation in front of a
 * reviewer who is approving forty of them in a sitting, and one fabricated
 * citation that reaches a mediation ends the product.
 */

export type ObligationType =
  | 'notice_of_delay'
  | 'notice_of_change'
  | 'notice_of_claim'
  | 'differing_site_conditions'
  | 'weather_day'
  | 'cure_period'
  | 'submittal_turnaround'
  | 'rfi_response_time'
  | 'payment_application_window'
  | 'payment_due'
  | 'retainage_release'
  | 'substantial_completion'
  | 'liquidated_damages'
  | 'insurance_certificate'
  | 'safety_reporting'
  | 'closeout_submission'

export type DeadlineBasis = 'from_occurrence' | 'from_awareness' | 'from_written_notice' | 'from_receipt'

export interface ProposedObligation {
  clauseId: string
  quote: string
  obligationType: ObligationType
  obligorParty: 'our_org' | 'counterparty' | 'either'
  obligeeParty: 'our_org' | 'counterparty' | 'either'
  triggerKind?: 'record_event' | 'schedule_event' | 'calendar_date' | 'manual'
  triggerMatch?: Record<string, unknown>
  triggerDescription: string
  durationValue: number
  durationUnit: DurationUnit
  deadlineBasis: DeadlineBasis
  countsStartDay?: boolean
  rollsForward?: boolean
  consequence?:
    | 'waiver_of_claim'
    | 'liquidated_damages'
    | 'payment_withheld'
    | 'default'
    | 'none_stated'
  formRequirements?: Record<string, unknown>
  confidence?: number
  rationale?: string
  extractedBy?: string
}

export interface ObligationRow {
  id: string
  documentId: string
  clauseId: string
  clauseNumber: string | null
  quote: string
  obligationType: ObligationType
  triggerDescription: string
  durationValue: number
  durationUnit: DurationUnit
  deadlineBasis: DeadlineBasis
  consequence: string
  confidence: string | null
  rationale: string | null
  status: 'proposed' | 'accepted' | 'rejected' | 'superseded'
  inheritedFromId: string | null
}

export interface ProposeResult {
  proposed: number
  /** Rejected before reaching the database, with why. */
  discarded: { reason: string; quote: string }[]
}

export class ObligationService {
  constructor(private readonly db: Db) {}

  /**
   * Writes proposals against a document's clauses.
   *
   * The provider seam lands above this: whatever produced these rows, they
   * arrive here and are checked the same way. A hand-entered obligation and
   * an extracted one pass through the identical gate, which is the only way
   * the gate stays honest.
   */
  async propose(actor: Actor, documentId: string, proposals: ProposedObligation[]): Promise<ProposeResult> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const doc = await this.loadDocument(tx, actor.tenantId, documentId)
      await this.assertPrivilege(tx, actor, doc.project_id, 'upload')

      const result: ProposeResult = { proposed: 0, discarded: [] }

      for (const proposal of proposals) {
        const { rows: clauseRows } = await tx.query<{ id: string; text: string; document_id: string }>(
          'SELECT id, text, document_id FROM contract_clauses WHERE tenant_id = $1 AND id = $2',
          [actor.tenantId, proposal.clauseId],
        )
        const clause = clauseRows[0]

        if (!clause || clause.document_id !== documentId) {
          result.discarded.push({
            reason: 'The cited clause is not in this document',
            quote: proposal.quote.slice(0, 120),
          })
          continue
        }
        if (!quoteAppearsIn(proposal.quote, clause.text)) {
          // The important one. A quote that is not in the clause is a
          // fabricated citation, and it does not get a review queue.
          result.discarded.push({
            reason: 'The quote does not appear in the cited clause',
            quote: proposal.quote.slice(0, 120),
          })
          continue
        }
        if (!Number.isInteger(proposal.durationValue) || proposal.durationValue < 0) {
          result.discarded.push({
            reason: `A duration must be a whole number of ${proposal.durationUnit}`,
            quote: proposal.quote.slice(0, 120),
          })
          continue
        }

        await tx.query(
          `INSERT INTO contract_obligations
             (tenant_id, project_id, document_id, clause_id, quote, obligation_type, obligor_party, obligee_party,
              trigger_kind, trigger_match, trigger_description, duration_value, duration_unit, deadline_basis,
              counts_start_day, rolls_forward, consequence, form_requirements, confidence, rationale, extracted_by)
           VALUES ($1, $2, $3, $4, $5, $6::obligation_type, $7::obligation_party, $8::obligation_party,
                   $9::obligation_trigger_kind, $10::jsonb, $11, $12, $13::duration_unit, $14::deadline_basis,
                   $15, $16, $17::obligation_consequence, $18::jsonb, $19, $20, $21)`,
          [
            actor.tenantId,
            doc.project_id,
            documentId,
            proposal.clauseId,
            proposal.quote,
            proposal.obligationType,
            proposal.obligorParty,
            proposal.obligeeParty,
            proposal.triggerKind ?? 'record_event',
            JSON.stringify(proposal.triggerMatch ?? {}),
            proposal.triggerDescription,
            proposal.durationValue,
            proposal.durationUnit,
            proposal.deadlineBasis,
            proposal.countsStartDay ?? false,
            proposal.rollsForward ?? false,
            proposal.consequence ?? 'none_stated',
            JSON.stringify(proposal.formRequirements ?? {}),
            proposal.confidence ?? null,
            proposal.rationale ?? null,
            proposal.extractedBy ?? null,
          ],
        )
        result.proposed += 1
      }

      return result
    })
  }

  /** Accepting is what lets an obligation start clocks, so it is a named act. */
  async accept(actor: Actor, obligationId: string): Promise<void> {
    await this.decide(actor, obligationId, 'accepted')
  }

  async reject(actor: Actor, obligationId: string): Promise<void> {
    await this.decide(actor, obligationId, 'rejected')
  }

  private async decide(actor: Actor, obligationId: string, status: 'accepted' | 'rejected'): Promise<void> {
    await withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<{ project_id: string; status: string }>(
        `SELECT project_id, status::text AS status FROM contract_obligations WHERE tenant_id = $1 AND id = $2`,
        [actor.tenantId, obligationId],
      )
      const row = rows[0]
      if (!row) throw new NotFoundError('obligation', obligationId)
      await this.assertPrivilege(tx, actor, row.project_id, 'accept_obligation')

      if (row.status !== 'proposed') {
        throw new ValidationError(`That obligation has already been ${row.status}`, [
          { field: 'status', message: 'Only a proposed obligation can be decided' },
        ])
      }

      await tx.query(
        `UPDATE contract_obligations
            SET status = $3::obligation_status, reviewed_by = $2, reviewed_at = now()
          WHERE tenant_id = $1 AND id = $4`,
        [actor.tenantId, actor.userId, status, obligationId],
      )
    })
  }

  /**
   * Flows a parent instrument's accepted obligations down to a child.
   *
   * A subcontract that incorporates the prime by reference inherits the
   * prime's obligations. The copies arrive as PROPOSALS, not as accepted
   * rows, because incorporation by reference is a legal reading and the
   * clause that does it is usually one sentence with an exception list
   * attached. Copying them in already accepted would be the system making
   * that call on its own.
   */
  async flowDown(actor: Actor, childDocumentId: string): Promise<{ proposed: number }> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const child = await this.loadDocument(tx, actor.tenantId, childDocumentId)
      await this.assertPrivilege(tx, actor, child.project_id, 'upload')

      if (!child.parent_document_id) {
        throw new ValidationError('That instrument does not incorporate another', [
          { field: 'parentDocumentId', message: 'Set the parent instrument before flowing obligations down' },
        ])
      }

      const { rowCount } = await tx.query(
        `INSERT INTO contract_obligations
           (tenant_id, project_id, document_id, clause_id, quote, obligation_type, obligor_party, obligee_party,
            trigger_kind, trigger_match, trigger_description, duration_value, duration_unit, deadline_basis,
            counts_start_day, rolls_forward, consequence, form_requirements, rationale, inherited_from_id, status)
         SELECT o.tenant_id, o.project_id, $2, o.clause_id, o.quote, o.obligation_type, o.obligor_party,
                o.obligee_party, o.trigger_kind, o.trigger_match, o.trigger_description, o.duration_value,
                o.duration_unit, o.deadline_basis, o.counts_start_day, o.rolls_forward, o.consequence,
                o.form_requirements,
                'Inherited from ' || p.title || ', which this instrument incorporates by reference.',
                o.id, 'proposed'
           FROM contract_obligations o
           JOIN contract_documents p ON p.id = o.document_id
          WHERE o.tenant_id = $1 AND o.document_id = $3 AND o.status = 'accepted'
            AND NOT EXISTS (
              SELECT 1 FROM contract_obligations existing
               WHERE existing.document_id = $2 AND existing.inherited_from_id = o.id
            )`,
        [actor.tenantId, childDocumentId, child.parent_document_id],
      )

      // The citation still points at the PARENT's clause, which is correct:
      // the term is printed there and nowhere else, and a reader following
      // the citation has to land on the page where it is actually written.
      return { proposed: rowCount ?? 0 }
    })
  }

  async list(
    actor: Actor,
    filter: { projectId?: string; documentId?: string; status?: string },
  ): Promise<ObligationRow[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const projectId =
        filter.projectId ??
        (filter.documentId ? (await this.loadDocument(tx, actor.tenantId, filter.documentId)).project_id : null)
      if (!projectId) {
        throw new ValidationError('Name a project or a document', [
          { field: 'projectId', message: 'One of projectId or documentId is required' },
        ])
      }

      const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
      if (!hasLevel(access, 'contracts', 'read_only') && !access.isCompanyAdmin) {
        throw new PermissionDeniedError('You cannot read contracts on this project', { tool: 'contracts' })
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT o.id, o.document_id, o.clause_id, c.clause_number, o.quote,
                o.obligation_type::text AS obligation_type, o.trigger_description,
                o.duration_value, o.duration_unit::text AS duration_unit,
                o.deadline_basis::text AS deadline_basis, o.consequence::text AS consequence,
                o.confidence::text AS confidence, o.rationale, o.status::text AS status, o.inherited_from_id
           FROM contract_obligations o
           JOIN contract_clauses c ON c.id = o.clause_id
          WHERE o.tenant_id = $1 AND o.project_id = $2
            AND ($3::uuid IS NULL OR o.document_id = $3::uuid)
            AND ($4::text IS NULL OR o.status::text = $4::text)
          ORDER BY c.order_index`,
        [actor.tenantId, projectId, filter.documentId ?? null, filter.status ?? null],
      )

      return rows.map((r) => ({
        id: r['id'] as string,
        documentId: r['document_id'] as string,
        clauseId: r['clause_id'] as string,
        clauseNumber: (r['clause_number'] as string | null) ?? null,
        quote: r['quote'] as string,
        obligationType: r['obligation_type'] as ObligationType,
        triggerDescription: r['trigger_description'] as string,
        durationValue: Number(r['duration_value']),
        durationUnit: r['duration_unit'] as DurationUnit,
        deadlineBasis: r['deadline_basis'] as DeadlineBasis,
        consequence: r['consequence'] as string,
        confidence: (r['confidence'] as string | null) ?? null,
        rationale: (r['rationale'] as string | null) ?? null,
        status: r['status'] as ObligationRow['status'],
        inheritedFromId: (r['inherited_from_id'] as string | null) ?? null,
      }))
    })
  }

  private async loadDocument(
    tx: Db,
    tenantId: string,
    documentId: string,
  ): Promise<{ project_id: string; parent_document_id: string | null; title: string }> {
    const { rows } = await tx.query<{ project_id: string; parent_document_id: string | null; title: string }>(
      'SELECT project_id, parent_document_id, title FROM contract_documents WHERE tenant_id = $1 AND id = $2',
      [tenantId, documentId],
    )
    const row = rows[0]
    if (!row) throw new NotFoundError('contract document', documentId)
    return row
  }

  private async assertPrivilege(tx: Db, actor: Actor, projectId: string, privilege: string): Promise<void> {
    const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
    if (!hasPrivilege(access, 'contracts', privilege) && !access.isCompanyAdmin) {
      throw new PermissionDeniedError(`You cannot ${privilege.replace(/_/g, ' ')} on this project`, {
        tool: 'contracts',
        privilege,
      })
    }
  }
}
