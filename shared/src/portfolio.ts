import { withTenant, type Db } from './db.js'
import type { Actor } from './kernel.js'
import { hasLevel, hasPrivilege } from './permissions.js'
import { loadAccess } from './repositories/permissions.js'

/**
 * The company view: every job at once, with the numbers that decide which one
 * you open.
 *
 * This replaced a table of project names and contract values, which told a
 * project manager running six jobs nothing at all. The question somebody has
 * when they sign in is not "what are my projects called", it is "which one is
 * on fire". So the row carries what is overdue, what is sitting in their own
 * court, and where the money is going, and the list can be ordered by any of
 * them.
 *
 * Everything is computed in ONE query with lateral counts rather than a
 * request per project. Six jobs is fine either way; a general contractor with
 * ninety is not, and a portfolio screen that takes eleven seconds is a
 * portfolio screen people learn to skip.
 */

export interface PortfolioProject {
  id: string
  number: string
  name: string
  stage: string
  city: string | null
  stateCode: string | null
  contractValue: string | null

  /** Records with no `closed_at`, which is the honest definition of open. */
  openRecords: number
  /** Live assignments past their due date. The number people act on. */
  overdue: number
  /** Live assignments held by the person asking. Their own workload. */
  mine: number
  /** Live assignments due in the next seven days, not yet overdue. */
  dueSoon: number
  /** The most recent thing that happened on the job, for "is this alive". */
  lastActivityAt: string | null

  /**
   * Null for somebody who may see the job and not what it costs.
   *
   * Nulled per project rather than for the whole screen: the same person is
   * routinely cleared for the money on their own jobs and not on the one they
   * were added to for a single inspection.
   */
  currentBudget: string | null
  projectedOverUnder: string | null
}

export class PortfolioService {
  constructor(private readonly db: Db) {}

  async summary(actor: Actor): Promise<{ projects: PortfolioProject[] }> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId: null })

      // A company administrator sees every job; everybody else sees the ones
      // they are on. Same rule as the plain project list, which this replaces.
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT p.id, p.number, p.name, p.stage, p.city, p.state_code, p.contract_value,
                COALESCE(r.open_records, 0)::int   AS open_records,
                COALESCE(a.overdue, 0)::int        AS overdue,
                COALESCE(a.mine, 0)::int           AS mine,
                COALESCE(a.due_soon, 0)::int       AS due_soon,
                to_char(r.last_activity_at, 'YYYY-MM-DD"T"HH24:MI:SSZ') AS last_activity_at,
                b.current_budget,
                b.projected_over_under
           FROM projects p
           LEFT JOIN LATERAL (
             SELECT COUNT(*) FILTER (WHERE closed_at IS NULL) AS open_records,
                    MAX(updated_at) AS last_activity_at
               FROM records
              WHERE tenant_id = p.tenant_id AND project_id = p.id
           ) r ON TRUE
           LEFT JOIN LATERAL (
             SELECT COUNT(*) FILTER (WHERE due_at IS NOT NULL AND due_at < now())            AS overdue,
                    COUNT(*) FILTER (WHERE holder_user_id = $2)                              AS mine,
                    COUNT(*) FILTER (WHERE due_at IS NOT NULL AND due_at >= now()
                                       AND due_at < now() + interval '7 days')               AS due_soon
               FROM record_assignments
              WHERE tenant_id = p.tenant_id AND released_at IS NULL
                AND record_id IN (SELECT id FROM records
                                   WHERE tenant_id = p.tenant_id AND project_id = p.id)
           ) a ON TRUE
           LEFT JOIN LATERAL (
             -- Summed from the view, so the portfolio and the budget screen
             -- cannot disagree: there is one definition of current budget in
             -- this product and it is a view.
             SELECT SUM(current_budget) AS current_budget,
                    SUM(projected_over_under) AS projected_over_under
               FROM budget_summary
              WHERE tenant_id = p.tenant_id AND project_id = p.id
           ) b ON TRUE
          WHERE p.tenant_id = $1
            AND ($3 OR EXISTS (SELECT 1 FROM project_memberships m
                                WHERE m.tenant_id = p.tenant_id
                                  AND m.project_id = p.id AND m.user_id = $2))
          ORDER BY p.number`,
        [actor.tenantId, actor.userId, access.isCompanyAdmin],
      )

      // Cost visibility is per project and the rule lives in TypeScript, so it
      // is resolved per row rather than in the query above. Bounded by the
      // number of jobs somebody is actually on, which is small; if that stops
      // being true this is the thing to move into SQL.
      const projects: PortfolioProject[] = []
      for (const row of rows) {
        const projectId = row['id'] as string
        const projectAccess = await loadAccess(tx, {
          userId: actor.userId,
          tenantId: actor.tenantId,
          projectId,
        })
        const costsVisible =
          hasLevel(projectAccess, 'budget', 'read_only') &&
          (hasPrivilege(projectAccess, 'budget', 'view_costs') || projectAccess.isCompanyAdmin)

        projects.push({
          id: projectId,
          number: row['number'] as string,
          name: row['name'] as string,
          stage: row['stage'] as string,
          city: (row['city'] as string | null) ?? null,
          stateCode: (row['state_code'] as string | null) ?? null,
          // The contract value is on the project record and is not a cost
          // figure: a trade partner knows roughly what the job is worth.
          contractValue: (row['contract_value'] as string | null) ?? null,
          openRecords: Number(row['open_records'] ?? 0),
          overdue: Number(row['overdue'] ?? 0),
          mine: Number(row['mine'] ?? 0),
          dueSoon: Number(row['due_soon'] ?? 0),
          lastActivityAt: (row['last_activity_at'] as string | null) ?? null,
          currentBudget: costsVisible ? ((row['current_budget'] as string | null) ?? null) : null,
          projectedOverUnder: costsVisible ? ((row['projected_over_under'] as string | null) ?? null) : null,
        })
      }
      return { projects }
    })
  }
}
