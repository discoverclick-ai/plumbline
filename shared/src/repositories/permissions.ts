import type { Db } from '../db.js'
import { buildAccess, type AccessSnapshot, type Grant } from '../permissions.js'
import type { PermissionLevel, PermissionScope } from '../types.js'

/**
 * Loading an access snapshot. Every request does this exactly once, up front,
 * and every authorization decision downstream reads from the snapshot rather
 * than going back to the database. One query shape, one place to audit.
 */

let toolScopeCache: Map<string, PermissionScope> | null = null

export async function loadToolScopes(db: Db): Promise<Map<string, PermissionScope>> {
  if (toolScopeCache) return toolScopeCache
  const { rows } = await db.query<{ key: string; scope: PermissionScope }>('SELECT key, scope FROM tools')
  toolScopeCache = new Map(rows.map((r) => [r.key, r.scope]))
  return toolScopeCache
}

export function clearToolScopeCache(): void {
  toolScopeCache = null
}

async function loadGrants(db: Db, templateId: string | null): Promise<Grant[]> {
  if (!templateId) return []
  const { rows } = await db.query<{ tool_key: string; level: PermissionLevel; privileges: string[] | null }>(
    `SELECT ttp.tool_key,
            ttp.level,
            COALESCE(
              ARRAY(
                SELECT tgp.privilege
                  FROM template_granular_permissions tgp
                 WHERE tgp.template_id = ttp.template_id
                   AND tgp.tool_key = ttp.tool_key
              ),
              ARRAY[]::text[]
            ) AS privileges
       FROM template_tool_permissions ttp
      WHERE ttp.template_id = $1`,
    [templateId],
  )
  return rows.map((r) => ({ toolKey: r.tool_key, level: r.level, privileges: r.privileges ?? [] }))
}

export interface LoadAccessInput {
  userId: string
  tenantId: string
  /** null for company-level work (portfolio, directory, admin). */
  projectId: string | null
}

/**
 * Resolve what this user may do, optionally within one project.
 *
 * Note what is NOT trusted from the caller: the user's active flag and both
 * template ids are re-read from the live rows every time. A person removed
 * from a project loses project tools on their next request, not whenever their
 * token happens to expire.
 */
export async function loadAccess(db: Db, input: LoadAccessInput): Promise<AccessSnapshot> {
  const toolScopes = await loadToolScopes(db)

  const { rows: userRows } = await db.query<{ company_permission_template_id: string | null }>(
    'SELECT company_permission_template_id FROM users WHERE id = $1 AND is_active',
    [input.userId],
  )
  const userRow = userRows[0]
  if (!userRow) {
    // Inactive or invisible under this tenant context: no access to anything.
    return buildAccess({
      userId: input.userId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      toolScopes,
      companyGrants: [],
      projectGrants: [],
      isProjectMember: false,
    })
  }

  let projectTemplateId: string | null = null
  let isProjectMember = false
  if (input.projectId) {
    const { rows } = await db.query<{ permission_template_id: string | null }>(
      'SELECT permission_template_id FROM project_memberships WHERE project_id = $1 AND user_id = $2',
      [input.projectId, input.userId],
    )
    const membership = rows[0]
    if (membership) {
      isProjectMember = true
      projectTemplateId = membership.permission_template_id
    }
  }

  const [companyGrants, projectGrants] = await Promise.all([
    loadGrants(db, userRow.company_permission_template_id),
    loadGrants(db, projectTemplateId),
  ])

  return buildAccess({
    userId: input.userId,
    tenantId: input.tenantId,
    projectId: input.projectId,
    toolScopes,
    companyGrants,
    projectGrants,
    isProjectMember,
  })
}
