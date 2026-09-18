import { PermissionDeniedError } from './errors.js'
import type { TransitionSpec } from './record-type.js'
import type { ParticipantRole, PermissionLevel, PermissionScope } from './types.js'

/**
 * Permission resolution, in one place.
 *
 * The rules are small enough to state in full, which is the point. Every
 * authorization decision in the product runs through `buildAccess` and the
 * assertions below; no route handler is allowed to improvise.
 *
 *   1. A tool's level comes from the template for that tool's scope: company
 *      tools from the user's company template, project tools from the template
 *      on their membership of THIS project.
 *   2. No membership means no project tools. Not read-only. None.
 *   3. Granular privileges add specific actions on top of a level; they never
 *      substitute for one.
 *   4. A company administrator (admin on the company `directory` tool) is
 *      admin everywhere, with every privilege. This is the one escalation in
 *      the system and it exists so an account cannot lock itself out.
 */

const LEVEL_ORDER: Record<PermissionLevel, number> = {
  none: 0,
  read_only: 1,
  standard: 2,
  admin: 3,
}

export function levelAtLeast(actual: PermissionLevel, required: PermissionLevel): boolean {
  return LEVEL_ORDER[actual] >= LEVEL_ORDER[required]
}

export interface ToolAccess {
  level: PermissionLevel
  privileges: ReadonlySet<string>
  /** Company administrators hold every privilege, including ones added later. */
  allPrivileges: boolean
}

const NO_ACCESS: ToolAccess = { level: 'none', privileges: new Set(), allPrivileges: false }

export interface Grant {
  toolKey: string
  level: PermissionLevel
  privileges: string[]
}

export interface AccessSnapshot {
  userId: string
  tenantId: string
  projectId: string | null
  isCompanyAdmin: boolean
  isProjectMember: boolean
  tools: ReadonlyMap<string, ToolAccess>
}

export interface BuildAccessInput {
  userId: string
  tenantId: string
  projectId: string | null
  /** Every tool the product ships, with its scope. From the `tools` table. */
  toolScopes: ReadonlyMap<string, PermissionScope>
  companyGrants: Grant[]
  projectGrants: Grant[]
  isProjectMember: boolean
}

/** The tool whose admin level makes someone a company administrator. */
export const COMPANY_ADMIN_TOOL = 'directory'

export function buildAccess(input: BuildAccessInput): AccessSnapshot {
  const companyByTool = new Map(input.companyGrants.map((g) => [g.toolKey, g]))
  const projectByTool = new Map(input.projectGrants.map((g) => [g.toolKey, g]))

  const isCompanyAdmin = companyByTool.get(COMPANY_ADMIN_TOOL)?.level === 'admin'

  const tools = new Map<string, ToolAccess>()
  for (const [toolKey, scope] of input.toolScopes) {
    if (isCompanyAdmin) {
      tools.set(toolKey, { level: 'admin', privileges: new Set(), allPrivileges: true })
      continue
    }

    if (scope === 'project' && !input.isProjectMember) {
      tools.set(toolKey, NO_ACCESS)
      continue
    }

    const grant = scope === 'company' ? companyByTool.get(toolKey) : projectByTool.get(toolKey)
    tools.set(
      toolKey,
      grant ? { level: grant.level, privileges: new Set(grant.privileges), allPrivileges: false } : NO_ACCESS,
    )
  }

  return {
    userId: input.userId,
    tenantId: input.tenantId,
    projectId: input.projectId,
    isCompanyAdmin,
    isProjectMember: input.isProjectMember,
    tools,
  }
}

const FULL_ACCESS: ToolAccess = { level: 'admin', privileges: new Set(), allPrivileges: true }

export function toolAccess(access: AccessSnapshot, toolKey: string): ToolAccess {
  const known = access.tools.get(toolKey)
  if (known) return known
  // A tool the snapshot has never heard of — a key added by a migration that
  // landed after this process cached the catalogue. Deny it to everyone except
  // company administrators, who are admin everywhere by definition and should
  // not be locked out by a stale cache.
  return access.isCompanyAdmin ? FULL_ACCESS : NO_ACCESS
}

export function hasLevel(access: AccessSnapshot, toolKey: string, required: PermissionLevel): boolean {
  return levelAtLeast(toolAccess(access, toolKey).level, required)
}

export function hasPrivilege(access: AccessSnapshot, toolKey: string, privilege: string): boolean {
  const tool = toolAccess(access, toolKey)
  return tool.allPrivileges || tool.privileges.has(privilege)
}

export function assertLevel(access: AccessSnapshot, toolKey: string, required: PermissionLevel): void {
  if (!hasLevel(access, toolKey, required)) {
    throw new PermissionDeniedError(`You need ${required.replace('_', ' ')} access to ${toolKey}`, {
      tool: toolKey,
      required,
      actual: toolAccess(access, toolKey).level,
    })
  }
}

/**
 * Can this actor run this transition on this record?
 *
 * Three gates, all of which must pass: the level on the tool, the granular
 * privilege if the transition names one, and the actor's role ON THIS RECORD
 * if the transition names roles. The third is what keeps an RFI's author from
 * answering their own RFI while still letting them submit and close it.
 *
 * Company administrators clear the level and privilege gates. They do not
 * clear the participant gate, because "the architect of record responded" is a
 * fact about the record, not a permission.
 */
export function assertTransitionAllowed(
  access: AccessSnapshot,
  toolKey: string,
  transition: TransitionSpec,
  actorRolesOnRecord: ReadonlySet<ParticipantRole>,
): void {
  assertLevel(access, toolKey, transition.requires.level)

  const privilege = transition.requires.privilege
  if (privilege && !hasPrivilege(access, toolKey, privilege)) {
    throw new PermissionDeniedError(`You do not have the "${privilege}" privilege on ${toolKey}`, {
      tool: toolKey,
      privilege,
      transition: transition.key,
    })
  }

  const roles = transition.requires.participantRoles
  if (roles && roles.length > 0 && !roles.some((role) => actorRolesOnRecord.has(role))) {
    throw new PermissionDeniedError(`Only the ${roles.join(' or ')} can ${transition.label.toLowerCase()}`, {
      transition: transition.key,
      requiredRoles: roles,
      heldRoles: [...actorRolesOnRecord],
    })
  }
}
