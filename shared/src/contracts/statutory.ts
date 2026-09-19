import { withTenant, type Db } from '../db.js'
import { NotFoundError, PermissionDeniedError, ValidationError } from '../errors.js'
import type { Actor } from '../kernel.js'
import { RecordKernel } from '../kernel.js'
import { hasLevel, hasPrivilege } from '../permissions.js'
import { loadAccess } from '../repositories/permissions.js'
import { addCalendarDays, addMonths, type DurationUnit } from './calendar.js'

/**
 * Statutory deadlines.
 *
 * A contract deadline is a term two parties agreed. A statutory deadline is
 * law: lien rights, bond claim rights, prompt payment. Missing one does not
 * waive a claim you might have won, it removes the security for money you
 * have already earned and spent, which is why these are in some ways the more
 * valuable half of the subsystem.
 *
 * And they are a better engineering problem. The statute is public, so there
 * is no document to read and no citation anyone can fabricate. The window is
 * arithmetic once you know the state, the claimant's role in the chain, and
 * the furnishing dates. There is no provider seam in this file and there
 * never will be.
 *
 * The danger is entirely in the DATA. A wrong statutory deadline is worse
 * than none, because a contractor will rely on it and lose money they have
 * already earned. So the rule enforced here is absolute: a rule nobody has
 * verified against the statute, by name and on a date, starts no clocks. The
 * product ships with every rule unverified, and that is the correct default.
 */

export type StatutoryTrigger =
  | 'first_furnishing'
  | 'last_furnishing'
  | 'project_completion'
  | 'notice_of_completion'
  | 'notice_of_termination'
  | 'lien_recorded'
  | 'payment_due'
  | 'contract_execution'

export type ClaimantRole =
  | 'general_contractor'
  | 'first_tier_subcontractor'
  | 'second_tier_subcontractor'
  | 'supplier_to_gc'
  | 'supplier_to_sub'
  | 'design_professional'
  | 'equipment_lessor'

export interface StatutoryRule {
  id: string
  jurisdiction: string
  projectType: string
  deadlineType: string
  claimantRole: ClaimantRole
  trigger: StatutoryTrigger
  durationValue: number
  durationUnit: DurationUnit
  monthOffset: number | null
  dayOfMonth: number | null
  citation: string
  citationUrl: string | null
  summary: string
  consequence: string
  verifiedBy: string | null
  verifiedAt: string | null
}

export interface StatutoryFacts {
  jurisdiction: string
  projectType: string
  claimantRole: ClaimantRole
  firstFurnishing: string | null
  lastFurnishing: string | null
  completionDate: string | null
  noticeOfCompletionRecorded: string | null
  contractExecuted: string | null
}

export interface StatutoryClockRow {
  id: string
  state: string
  deadlineType: string
  citation: string
  citationUrl: string | null
  summary: string
  consequence: string
  startedOn: string
  dueOn: string
  warnOn: string
  triggeredBy: StatutoryTrigger
  noticeRecordId: string | null
  computation: Record<string, unknown>
}

export interface StatutorySweepResult {
  started: number
  /** Rules that matched but could not start, and why. Never silent. */
  skipped: { citation: string; reason: string }[]
  /** Rules that would apply but nobody has verified. The sales conversation. */
  unverified: { citation: string; summary: string }[]
}

/**
 * The deadline, computed.
 *
 * Two shapes. Most statutes give a plain window in days or months. Several
 * give a fixed day of a later month ("the fifteenth day of the third month
 * after"), which no number of days expresses, so that form is computed
 * separately rather than approximated. An approximated statutory deadline is
 * the exact failure this subsystem exists to prevent.
 */
export function statutoryDeadline(
  rule: Pick<StatutoryRule, 'durationValue' | 'durationUnit' | 'monthOffset' | 'dayOfMonth'>,
  startedOn: string,
): { dueOn: string; steps: string[] } {
  if (rule.monthOffset !== null && rule.dayOfMonth !== null) {
    const shifted = addMonths(`${startedOn.slice(0, 8)}01`, rule.monthOffset)
    const [year, month] = shifted.split('-') as [string, string]
    const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
    // Clamped, not rolled: "the 31st day of the second month" in February is
    // the 28th, and rolling into March would invent days the statute did not
    // give.
    const day = Math.min(rule.dayOfMonth, lastDay)
    const dueOn = `${year}-${month}-${String(day).padStart(2, '0')}`
    return {
      dueOn,
      steps: [
        `${startedOn} falls in ${year.length === 4 ? startedOn.slice(0, 7) : startedOn}`,
        `the statute counts to day ${rule.dayOfMonth} of the month ${rule.monthOffset} months later`,
        `which is ${dueOn}${day !== rule.dayOfMonth ? ` (clamped from day ${rule.dayOfMonth}, which that month does not have)` : ''}`,
      ],
    }
  }

  // Calendar days, always, and never business days: statutes of limitation
  // run on calendar days unless they say otherwise, and assuming otherwise
  // computes a LATER deadline, which is the direction that loses the right.
  const dueOn =
    rule.durationUnit === 'months'
      ? addMonths(startedOn, rule.durationValue)
      : rule.durationUnit === 'weeks'
        ? addCalendarDays(startedOn, rule.durationValue * 7)
        : addCalendarDays(startedOn, rule.durationValue)

  return {
    dueOn,
    steps: [`${startedOn} plus ${rule.durationValue} ${rule.durationUnit} = ${dueOn}`],
  }
}

/**
 * When to start warning.
 *
 * The EARLIER of three quarters elapsed and thirty days out. A lien deadline
 * is not something you handle the afternoon it arrives: a preliminary notice
 * needs addresses, a legal description and certified mail, and that is a week
 * of somebody's attention.
 *
 * On a short window the thirty-day floor lands before the clock even starts,
 * so it warns immediately, and that is the right answer rather than an edge
 * case: a twenty day preliminary notice window IS a thing to act on the day
 * you learn about it.
 */
export function statutoryWarnOn(startedOn: string, dueOn: string): string {
  const days = Math.round(
    (Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${startedOn}T00:00:00Z`)) / 86_400_000,
  )
  const quarter = addCalendarDays(startedOn, Math.floor(days * 0.75))
  const thirtyBefore = addCalendarDays(dueOn, -30)
  const chosen = quarter < thirtyBefore ? quarter : thirtyBefore
  return chosen < startedOn ? startedOn : chosen
}

export class StatutoryService {
  private readonly kernel: RecordKernel

  constructor(private readonly db: Db) {
    this.kernel = new RecordKernel(db)
  }

  async setFacts(actor: Actor, projectId: string, facts: Partial<StatutoryFacts>): Promise<void> {
    await withTenant(this.db, actor.tenantId, async (tx) => {
      const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
      if (!hasPrivilege(access, 'contracts', 'manage_statutory') && !access.isCompanyAdmin) {
        throw new PermissionDeniedError('You cannot record the statutory dates on this project', {
          tool: 'contracts',
          privilege: 'manage_statutory',
        })
      }
      if (!facts.jurisdiction || !facts.claimantRole) {
        throw new ValidationError('A jurisdiction and a role in the contract chain are both required', [
          { field: 'jurisdiction', message: 'The state or federal scheme this job sits under' },
          { field: 'claimantRole', message: 'Where your company sits in the chain ON THIS JOB' },
        ])
      }

      await tx.query(
        `INSERT INTO project_statutory_facts
           (project_id, tenant_id, jurisdiction, project_type, claimant_role, first_furnishing,
            last_furnishing, completion_date, notice_of_completion_recorded, contract_executed, updated_by)
         VALUES ($1, $2, $3, $4, $5::claimant_role, $6::date, $7::date, $8::date, $9::date, $10::date, $11)
         ON CONFLICT (project_id) DO UPDATE
            SET jurisdiction = EXCLUDED.jurisdiction, project_type = EXCLUDED.project_type,
                claimant_role = EXCLUDED.claimant_role, first_furnishing = EXCLUDED.first_furnishing,
                last_furnishing = EXCLUDED.last_furnishing, completion_date = EXCLUDED.completion_date,
                notice_of_completion_recorded = EXCLUDED.notice_of_completion_recorded,
                contract_executed = EXCLUDED.contract_executed,
                updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [
          projectId,
          actor.tenantId,
          facts.jurisdiction,
          facts.projectType ?? 'private',
          facts.claimantRole,
          facts.firstFurnishing ?? null,
          facts.lastFurnishing ?? null,
          facts.completionDate ?? null,
          facts.noticeOfCompletionRecorded ?? null,
          facts.contractExecuted ?? null,
          actor.userId,
        ],
      )
    })
  }

  /**
   * Starts every clock the facts now support.
   *
   * Idempotent on (project, rule, start date), so running it after every edit
   * to the facts is safe and is what the worker does. A fact that CHANGES —
   * last furnishing moves because the crew went back for a punch item —
   * produces a new clock rather than editing the old one, because the old one
   * was real while it was believed, and a deadline that silently moved is one
   * nobody can explain later.
   */
  async sweep(actor: Actor, projectId: string): Promise<StatutorySweepResult> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
      if (!access.isProjectMember && !access.isCompanyAdmin) {
        throw new PermissionDeniedError('You are not on this project')
      }

      const facts = await this.loadFacts(tx, actor.tenantId, projectId)
      const result: StatutorySweepResult = { started: 0, skipped: [], unverified: [] }

      const { rows: rules } = await tx.query<Record<string, unknown>>(
        `SELECT id, jurisdiction, project_type, deadline_type::text AS deadline_type,
                claimant_role::text AS claimant_role, trigger::text AS trigger,
                duration_value, duration_unit::text AS duration_unit, month_offset, day_of_month,
                citation, citation_url, summary, consequence, verified_by,
                to_char(verified_at, 'YYYY-MM-DD') AS verified_at
           FROM statutory_rules
          WHERE jurisdiction = $1 AND project_type = $2 AND claimant_role = $3::claimant_role
            AND superseded_on IS NULL`,
        [facts.jurisdiction, facts.projectType, facts.claimantRole],
      )

      for (const row of rules) {
        const rule = toRule(row)

        // The gate. Named here rather than filtered out of the query on
        // purpose: an applicable rule nobody has verified is something the
        // customer needs to SEE, because it is a deadline that exists whether
        // or not this product knows the number.
        if (!rule.verifiedAt) {
          result.unverified.push({ citation: rule.citation, summary: rule.summary })
          continue
        }

        const startedOn = this.startDateFor(rule.trigger, facts)
        if (!startedOn) {
          result.skipped.push({
            citation: rule.citation,
            reason: `No date recorded for ${rule.trigger.replace(/_/g, ' ')}, so this clock cannot start`,
          })
          continue
        }

        const { dueOn, steps } = statutoryDeadline(rule, startedOn)
        const warnOn = statutoryWarnOn(startedOn, dueOn)

        const { rowCount } = await tx.query(
          `INSERT INTO statutory_clocks
             (tenant_id, project_id, rule_id, triggered_by, started_on, due_on, warn_on, computation)
           VALUES ($1, $2, $3, $4::statutory_trigger, $5::date, $6::date, $7::date, $8::jsonb)
           ON CONFLICT (project_id, rule_id, started_on) DO NOTHING`,
          [
            actor.tenantId,
            projectId,
            rule.id,
            rule.trigger,
            startedOn,
            dueOn,
            warnOn,
            JSON.stringify({
              steps,
              citation: rule.citation,
              citationUrl: rule.citationUrl,
              summary: rule.summary,
              consequence: rule.consequence,
              jurisdiction: rule.jurisdiction,
              claimantRole: rule.claimantRole,
              verifiedBy: rule.verifiedBy,
              verifiedAt: rule.verifiedAt,
              trigger: rule.trigger,
              startedOn,
            }),
          ],
        )
        if ((rowCount ?? 0) > 0) result.started += 1
      }

      return result
    })
  }

  async clocks(actor: Actor, projectId: string): Promise<StatutoryClockRow[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
      if (!hasLevel(access, 'contracts', 'read_only') && !access.isCompanyAdmin) {
        throw new PermissionDeniedError('You cannot see the statutory deadlines on this project', {
          tool: 'contracts',
        })
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT k.id, k.state::text AS state, k.triggered_by::text AS triggered_by,
                to_char(k.started_on, 'YYYY-MM-DD') AS started_on,
                to_char(k.due_on, 'YYYY-MM-DD') AS due_on,
                to_char(k.warn_on, 'YYYY-MM-DD') AS warn_on,
                k.notice_record_id, k.computation,
                r.deadline_type::text AS deadline_type, r.citation, r.citation_url, r.summary, r.consequence
           FROM statutory_clocks k
           JOIN statutory_rules r ON r.id = k.rule_id
          WHERE k.tenant_id = $1 AND k.project_id = $2
          ORDER BY k.due_on`,
        [actor.tenantId, projectId],
      )

      return rows.map((r) => ({
        id: r['id'] as string,
        state: r['state'] as string,
        deadlineType: r['deadline_type'] as string,
        citation: r['citation'] as string,
        citationUrl: (r['citation_url'] as string | null) ?? null,
        summary: r['summary'] as string,
        consequence: r['consequence'] as string,
        startedOn: r['started_on'] as string,
        dueOn: r['due_on'] as string,
        warnOn: r['warn_on'] as string,
        triggeredBy: r['triggered_by'] as StatutoryTrigger,
        noticeRecordId: (r['notice_record_id'] as string | null) ?? null,
        computation: r['computation'] as Record<string, unknown>,
      }))
    })
  }

  private startDateFor(trigger: StatutoryTrigger, facts: StatutoryFacts): string | null {
    switch (trigger) {
      case 'first_furnishing':
        return facts.firstFurnishing
      case 'last_furnishing':
        return facts.lastFurnishing
      case 'project_completion':
        return facts.completionDate
      case 'notice_of_completion':
        return facts.noticeOfCompletionRecorded
      case 'contract_execution':
        return facts.contractExecuted
      default:
        // lien_recorded, notice_of_termination and payment_due are events
        // rather than project facts. They will come from the event log the
        // way contract clocks do; until they do, saying nothing beats
        // guessing at a date.
        return null
    }
  }

  private async loadFacts(tx: Db, tenantId: string, projectId: string): Promise<StatutoryFacts> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT jurisdiction, project_type, claimant_role::text AS claimant_role,
              to_char(first_furnishing, 'YYYY-MM-DD') AS first_furnishing,
              to_char(last_furnishing, 'YYYY-MM-DD') AS last_furnishing,
              to_char(completion_date, 'YYYY-MM-DD') AS completion_date,
              to_char(notice_of_completion_recorded, 'YYYY-MM-DD') AS notice_of_completion_recorded,
              to_char(contract_executed, 'YYYY-MM-DD') AS contract_executed
         FROM project_statutory_facts WHERE tenant_id = $1 AND project_id = $2`,
      [tenantId, projectId],
    )
    const row = rows[0]
    if (!row) {
      throw new NotFoundError('statutory facts', projectId)
    }
    return {
      jurisdiction: row['jurisdiction'] as string,
      projectType: row['project_type'] as string,
      claimantRole: row['claimant_role'] as ClaimantRole,
      firstFurnishing: (row['first_furnishing'] as string | null) ?? null,
      lastFurnishing: (row['last_furnishing'] as string | null) ?? null,
      completionDate: (row['completion_date'] as string | null) ?? null,
      noticeOfCompletionRecorded: (row['notice_of_completion_recorded'] as string | null) ?? null,
      contractExecuted: (row['contract_executed'] as string | null) ?? null,
    }
  }
}

function toRule(row: Record<string, unknown>): StatutoryRule {
  return {
    id: row['id'] as string,
    jurisdiction: row['jurisdiction'] as string,
    projectType: row['project_type'] as string,
    deadlineType: row['deadline_type'] as string,
    claimantRole: row['claimant_role'] as ClaimantRole,
    trigger: row['trigger'] as StatutoryTrigger,
    durationValue: Number(row['duration_value']),
    durationUnit: row['duration_unit'] as DurationUnit,
    monthOffset: row['month_offset'] === null ? null : Number(row['month_offset']),
    dayOfMonth: row['day_of_month'] === null ? null : Number(row['day_of_month']),
    citation: row['citation'] as string,
    citationUrl: (row['citation_url'] as string | null) ?? null,
    summary: row['summary'] as string,
    consequence: row['consequence'] as string,
    verifiedBy: (row['verified_by'] as string | null) ?? null,
    verifiedAt: (row['verified_at'] as string | null) ?? null,
  }
}
