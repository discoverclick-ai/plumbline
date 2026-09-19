import { hashPassword } from './auth.js'
import { installDefaultWbs } from './wbs.js'
import { withTenant, type Db } from './db.js'
import { NotFoundError } from './errors.js'
import type {
  OrganizationKind,
  ParticipantRole,
  PermissionLevel,
  PermissionScope,
  ProjectStage,
} from './types.js'

/**
 * Account bootstrap and directory writes.
 *
 * The permission templates created here are the product's opinion about how a
 * construction company is organized, shipped as defaults rather than as a
 * blank grid the customer has to fill in on day one. Every one of them is
 * editable afterwards; none of them is special to the code.
 */

export interface TemplateSpec {
  name: string
  scope: PermissionScope
  /**
   * Which kinds of company this template is written for. Omitted means every
   * kind, and that universal template is the fallback when nothing matches.
   *
   * Procore's certification catalogue teaches "Project Manager" three separate
   * times, once for an owner, once for a general contractor and once for a
   * specialty contractor, because the same title does a different job on each
   * side of the contract. A single Project Manager template was therefore
   * wrong for two thirds of the people handed it.
   */
  appliesTo?: OrganizationKind[]
  isDefault?: boolean
  tools: { toolKey: string; level: PermissionLevel; privileges?: string[] }[]
}

export const DEFAULT_TEMPLATES: TemplateSpec[] = [
  {
    name: 'Company Administrator',
    scope: 'company',
    tools: [
      { toolKey: 'directory', level: 'admin' },
      { toolKey: 'projects', level: 'admin' },
      { toolKey: 'admin', level: 'admin' },
    ],
  },
  {
    name: 'Employee',
    scope: 'company',
    isDefault: true,
    tools: [
      { toolKey: 'directory', level: 'read_only' },
      { toolKey: 'projects', level: 'read_only', privileges: ['create_projects'] },
    ],
  },
  {
    name: 'Collaborator',
    scope: 'company',
    tools: [{ toolKey: 'directory', level: 'read_only' }],
  },
  {
    // The general contractor's PM: runs the job, holds every workflow, and is
    // the only one of the three who closes things out.
    name: 'Project Manager',
    scope: 'project',
    appliesTo: ['general_contractor'],
    tools: [
      { toolKey: 'rfis', level: 'standard', privileges: ['create', 'respond', 'close'] },
      { toolKey: 'submittals', level: 'standard', privileges: ['create', 'review', 'forward'] },
      { toolKey: 'punch_list', level: 'standard', privileges: ['create', 'verify'] },
      { toolKey: 'observations', level: 'standard', privileges: ['create', 'close'] },
      { toolKey: 'daily_log', level: 'standard', privileges: ['create'] },
      { toolKey: 't_and_m', level: 'standard', privileges: ['sign'] },
      {
        toolKey: 'change_management',
        level: 'standard',
        privileges: ['create', 'price', 'submit_to_owner', 'execute'],
      },
      { toolKey: 'correspondence', level: 'standard', privileges: ['create', 'respond', 'close'] },
      { toolKey: 'meetings', level: 'standard', privileges: ['create', 'chair'] },
      { toolKey: 'tasks', level: 'standard', privileges: ['create', 'close'] },
      { toolKey: 'incidents', level: 'standard', privileges: ['create', 'investigate', 'sign'] },
      { toolKey: 'inspections', level: 'standard', privileges: ['create', 'close'] },
      { toolKey: 'budget', level: 'standard', privileges: ['manage_codes', 'view_costs'] },
      { toolKey: 'capture', level: 'standard', privileges: ['review'] },
      { toolKey: 'documents', level: 'standard' },
      { toolKey: 'project_team', level: 'standard', privileges: ['manage_members'] },
    ],
  },
  {
    // The owner's PM watches and approves. They do not raise RFIs against
    // their own project and they do not close a contractor's punch item,
    // because accepting the work is the point of the punch list.
    name: 'Project Manager',
    scope: 'project',
    appliesTo: ['owner'],
    tools: [
      { toolKey: 'rfis', level: 'read_only' },
      { toolKey: 'submittals', level: 'read_only' },
      { toolKey: 'punch_list', level: 'read_only', privileges: ['create'] },
      { toolKey: 'observations', level: 'standard', privileges: ['create'] },
      { toolKey: 'daily_log', level: 'read_only' },
      { toolKey: 't_and_m', level: 'read_only' },
      // Read-only on the whole job except this. Approving changes is the
      // reason an owner has a login at all.
      { toolKey: 'change_management', level: 'standard', privileges: ['approve'] },
      { toolKey: 'correspondence', level: 'standard', privileges: ['create', 'respond'] },
      { toolKey: 'meetings', level: 'read_only' },
      { toolKey: 'tasks', level: 'read_only', privileges: ['create'] },
      { toolKey: 'incidents', level: 'read_only' },
      { toolKey: 'inspections', level: 'read_only' },
      { toolKey: 'budget', level: 'read_only', privileges: ['view_costs'] },
      { toolKey: 'capture', level: 'read_only' },
      { toolKey: 'documents', level: 'read_only' },
      { toolKey: 'project_team', level: 'read_only' },
    ],
  },
  {
    // The subcontractor's PM: raises questions and submittals for their own
    // scope, fixes their own punch work, and sees no part of the job that is
    // not theirs. Same title as the GC's PM, barely any overlap.
    name: 'Project Manager',
    scope: 'project',
    appliesTo: ['specialty_contractor'],
    tools: [
      { toolKey: 'rfis', level: 'standard', privileges: ['create'] },
      { toolKey: 'submittals', level: 'standard', privileges: ['create'] },
      { toolKey: 'punch_list', level: 'standard' },
      { toolKey: 'observations', level: 'read_only' },
      { toolKey: 'daily_log', level: 'none' },
      { toolKey: 't_and_m', level: 'standard', privileges: ['create'] },
      { toolKey: 'change_management', level: 'read_only', privileges: ['price'] },
      { toolKey: 'correspondence', level: 'standard', privileges: ['create', 'respond'] },
      { toolKey: 'meetings', level: 'read_only' },
      { toolKey: 'tasks', level: 'standard' },
      { toolKey: 'incidents', level: 'standard', privileges: ['create', 'investigate'] },
      { toolKey: 'inspections', level: 'read_only' },
      { toolKey: 'budget', level: 'none' },
      { toolKey: 'capture', level: 'standard', privileges: ['review'] },
      { toolKey: 'documents', level: 'read_only' },
      { toolKey: 'project_team', level: 'read_only' },
    ],
  },
  {
    name: 'Superintendent',
    scope: 'project',
    appliesTo: ['general_contractor'],
    tools: [
      { toolKey: 'rfis', level: 'standard', privileges: ['create'] },
      { toolKey: 'submittals', level: 'read_only' },
      { toolKey: 'punch_list', level: 'standard', privileges: ['create', 'verify'] },
      { toolKey: 'observations', level: 'standard', privileges: ['create', 'close'] },
      { toolKey: 'daily_log', level: 'standard', privileges: ['create'] },
      // The super watched the work happen, so the super signs the ticket.
      { toolKey: 't_and_m', level: 'standard', privileges: ['sign'] },
      // Most change events start with the super noticing something on a walk.
      { toolKey: 'change_management', level: 'standard', privileges: ['create'] },
      { toolKey: 'correspondence', level: 'standard', privileges: ['create', 'respond'] },
      { toolKey: 'meetings', level: 'standard', privileges: ['create', 'chair'] },
      { toolKey: 'tasks', level: 'standard', privileges: ['create', 'close'] },
      { toolKey: 'incidents', level: 'standard', privileges: ['create', 'investigate'] },
      { toolKey: 'inspections', level: 'standard', privileges: ['create', 'close'] },
      { toolKey: 'budget', level: 'read_only' },
      { toolKey: 'capture', level: 'standard', privileges: ['review'] },
      { toolKey: 'documents', level: 'read_only' },
      { toolKey: 'project_team', level: 'read_only' },
    ],
  },
  {
    // The subcontractor's view: do the work assigned to you, raise questions,
    // see nothing else. This template is why unlimited users is affordable.
    name: 'Trade Partner',
    scope: 'project',
    appliesTo: ['specialty_contractor', 'supplier'],
    isDefault: true,
    tools: [
      // Standard, not read_only. Both of these types require `standard` to run
      // their own submit transition, so read_only plus a create privilege let
      // a trade partner raise an RFI and then never send it, which is a dead
      // record and a sub who concludes the software is broken.
      { toolKey: 'rfis', level: 'standard', privileges: ['create'] },
      { toolKey: 'submittals', level: 'standard', privileges: ['create'] },
      { toolKey: 'punch_list', level: 'standard' },
      { toolKey: 'observations', level: 'read_only' },
      { toolKey: 'daily_log', level: 'none' },
      { toolKey: 't_and_m', level: 'standard', privileges: ['create'] },
      { toolKey: 'change_management', level: 'read_only', privileges: ['price'] },
      { toolKey: 'correspondence', level: 'standard', privileges: ['respond'] },
      { toolKey: 'meetings', level: 'read_only' },
      { toolKey: 'tasks', level: 'standard' },
      { toolKey: 'incidents', level: 'standard', privileges: ['create'] },
      { toolKey: 'inspections', level: 'read_only' },
      { toolKey: 'budget', level: 'none' },
      { toolKey: 'capture', level: 'read_only' },
      { toolKey: 'documents', level: 'read_only' },
      { toolKey: 'project_team', level: 'read_only' },
    ],
  },
  {
    name: 'Design Team',
    scope: 'project',
    appliesTo: ['architect', 'engineer', 'consultant'],
    isDefault: true,
    tools: [
      { toolKey: 'rfis', level: 'standard', privileges: ['respond'] },
      { toolKey: 'submittals', level: 'standard', privileges: ['review'] },
      { toolKey: 'punch_list', level: 'read_only' },
      { toolKey: 'observations', level: 'read_only', privileges: ['create'] },
      { toolKey: 'correspondence', level: 'standard', privileges: ['create', 'respond'] },
      { toolKey: 'meetings', level: 'read_only' },
      { toolKey: 'tasks', level: 'standard' },
      { toolKey: 'incidents', level: 'read_only' },
      { toolKey: 'inspections', level: 'read_only' },
      { toolKey: 'budget', level: 'none' },
      { toolKey: 'capture', level: 'read_only' },
      { toolKey: 'change_management', level: 'read_only' },
      { toolKey: 'documents', level: 'read_only' },
      { toolKey: 'project_team', level: 'read_only' },
    ],
  },
  {
    // The universal fallback, and deliberately the least privileged one. A
    // person from a company we have no template for gets to look and nothing
    // else, until an administrator says otherwise. Defaulting a general
    // contractor's new hire straight to Project Manager would be the wrong
    // way round.
    name: 'Read Only',
    scope: 'project',
    isDefault: true,
    tools: [
      { toolKey: 'rfis', level: 'read_only' },
      { toolKey: 'submittals', level: 'read_only' },
      { toolKey: 'punch_list', level: 'read_only' },
      { toolKey: 'observations', level: 'read_only' },
      { toolKey: 'daily_log', level: 'read_only' },
      { toolKey: 't_and_m', level: 'read_only' },
      { toolKey: 'change_management', level: 'read_only' },
      { toolKey: 'correspondence', level: 'read_only' },
      { toolKey: 'meetings', level: 'read_only' },
      { toolKey: 'tasks', level: 'read_only' },
      { toolKey: 'incidents', level: 'read_only' },
      { toolKey: 'inspections', level: 'read_only' },
      { toolKey: 'budget', level: 'none' },
      { toolKey: 'capture', level: 'read_only' },
      { toolKey: 'documents', level: 'read_only' },
      { toolKey: 'project_team', level: 'read_only' },
    ],
  },
]

export async function createTemplate(db: Db, tenantId: string, spec: TemplateSpec): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO permission_templates (tenant_id, scope, name, is_default, applies_to_org_kinds)
          VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
    [tenantId, spec.scope, spec.name, spec.isDefault === true, spec.appliesTo ?? []],
  )
  const template = rows[0]
  if (!template) throw new Error('template insert returned no row')

  for (const tool of spec.tools) {
    await db.query(
      `INSERT INTO template_tool_permissions (template_id, tool_key, level) VALUES ($1, $2, $3)`,
      [template.id, tool.toolKey, tool.level],
    )
    for (const privilege of tool.privileges ?? []) {
      await db.query(
        `INSERT INTO template_granular_permissions (template_id, tool_key, privilege) VALUES ($1, $2, $3)`,
        [template.id, tool.toolKey, privilege],
      )
    }
  }
  return template.id
}

export interface ProvisionTenantInput {
  tenantName: string
  organizationName?: string
  organizationKind?: OrganizationKind
  admin: { email: string; name: string; password: string }
}

export interface ProvisionedTenant {
  tenantId: string
  organizationId: string
  adminUserId: string
  templateIds: Map<string, string>
}

/**
 * Stand up a new account: the tenant, its own firm, the default permission
 * templates, and the first administrator.
 */
export async function provisionTenant(db: Db, input: ProvisionTenantInput): Promise<ProvisionedTenant> {
  const { rows } = await db.query<{ provision_tenant: string }>('SELECT provision_tenant($1)', [input.tenantName])
  const created = rows[0]
  if (!created) throw new Error('provision_tenant returned no row')
  const tenantId = created.provision_tenant

  return withTenant(db, tenantId, async (tx) => {
    const templateIds = new Map<string, string>()
    for (const spec of DEFAULT_TEMPLATES) {
      templateIds.set(spec.name, await createTemplate(tx, tenantId, spec))
    }

    // The chart of accounts a contractor already has. Shipped as a default
    // rather than a built-in, because plenty of them use their own.
    await installDefaultWbs(tx, tenantId)

    const organizationId = await createOrganization(tx, tenantId, {
      name: input.organizationName ?? input.tenantName,
      kind: input.organizationKind ?? 'general_contractor',
      isSelf: true,
    })

    const adminUserId = await createUser(tx, tenantId, {
      organizationId,
      email: input.admin.email,
      name: input.admin.name,
      password: input.admin.password,
      companyPermissionTemplateId: templateIds.get('Company Administrator') ?? null,
    })

    return { tenantId, organizationId, adminUserId, templateIds }
  })
}

export async function createOrganization(
  db: Db,
  tenantId: string,
  input: { name: string; kind: OrganizationKind; trade?: string; isSelf?: boolean },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO organizations (tenant_id, name, kind, trade, is_self)
          VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
    [tenantId, input.name, input.kind, input.trade ?? null, input.isSelf === true],
  )
  const row = rows[0]
  if (!row) throw new Error('organization insert returned no row')
  return row.id
}

export async function createUser(
  db: Db,
  tenantId: string,
  input: {
    organizationId: string
    email: string
    name: string
    password?: string
    jobTitle?: string
    companyPermissionTemplateId?: string | null
  },
): Promise<string> {
  const templateId =
    input.companyPermissionTemplateId === undefined
      ? await defaultTemplateId(db, tenantId, 'company')
      : input.companyPermissionTemplateId

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (tenant_id, organization_id, email, name, job_title, company_permission_template_id)
          VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
    [tenantId, input.organizationId, input.email.toLowerCase(), input.name, input.jobTitle ?? null, templateId],
  )
  const row = rows[0]
  if (!row) throw new Error('user insert returned no row')

  if (input.password) {
    await db.query(
      `INSERT INTO user_credentials (user_id, tenant_id, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`,
      [row.id, tenantId, await hashPassword(input.password)],
    )
  }
  return row.id
}

/**
 * Who this project copies on a kind of record by default.
 *
 * `typeKey` omitted means every type, which is the owner's rep who reads the
 * whole job: one row rather than one per tool.
 */
export async function setDistributionDefault(
  db: Db,
  tenantId: string,
  input: { projectId: string; userId: string; typeKey?: string; role?: ParticipantRole },
): Promise<void> {
  const role = input.role ?? 'distribution'
  if (input.typeKey) {
    await db.query(
      `INSERT INTO project_distribution_defaults (tenant_id, project_id, type_key, user_id, role)
            VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, type_key, user_id) WHERE type_key IS NOT NULL
         DO UPDATE SET role = EXCLUDED.role`,
      [tenantId, input.projectId, input.typeKey, input.userId, role],
    )
    return
  }
  await db.query(
    `INSERT INTO project_distribution_defaults (tenant_id, project_id, type_key, user_id, role)
          VALUES ($1, $2, NULL, $3, $4)
     ON CONFLICT (project_id, user_id) WHERE type_key IS NULL
       DO UPDATE SET role = EXCLUDED.role`,
    [tenantId, input.projectId, input.userId, role],
  )
}

export async function clearDistributionDefault(
  db: Db,
  tenantId: string,
  input: { projectId: string; userId: string; typeKey?: string },
): Promise<void> {
  await db.query(
    `DELETE FROM project_distribution_defaults
      WHERE tenant_id = $1 AND project_id = $2 AND user_id = $3
        AND type_key IS NOT DISTINCT FROM $4`,
    [tenantId, input.projectId, input.userId, input.typeKey ?? null],
  )
}

export async function createProject(
  db: Db,
  tenantId: string,
  input: {
    number: string
    name: string
    stage?: ProjectStage
    city?: string
    stateCode?: string
    timeZone?: string
    contractValue?: string
  },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO projects (tenant_id, number, name, stage, city, state_code, time_zone, contract_value)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
    [
      tenantId,
      input.number,
      input.name,
      input.stage ?? 'pre_construction',
      input.city ?? null,
      input.stateCode ?? null,
      input.timeZone ?? 'UTC',
      input.contractValue ?? null,
    ],
  )
  const row = rows[0]
  if (!row) throw new Error('project insert returned no row')
  return row.id
}

export async function addProjectMember(
  db: Db,
  tenantId: string,
  input: {
    projectId: string
    userId: string
    /** An explicit template. Wins over everything, including as an explicit null. */
    permissionTemplateId?: string | null
    /**
     * A template by name, resolved against THIS member's own company. Prefer
     * this over looking the id up yourself: a name like "Project Manager" now
     * belongs to several templates that differ only by audience, and picking
     * the wrong one is silent.
     */
    permissionTemplateName?: string
  },
): Promise<void> {
  const orgKind =
    input.permissionTemplateId === undefined ? await organizationKindOfUser(db, input.userId) : undefined

  const templateId =
    input.permissionTemplateId !== undefined
      ? input.permissionTemplateId
      : input.permissionTemplateName
        ? await findTemplateByName(db, tenantId, 'project', input.permissionTemplateName, orgKind)
        : await defaultTemplateId(db, tenantId, 'project', orgKind)

  await db.query(
    `INSERT INTO project_memberships (tenant_id, project_id, user_id, permission_template_id)
          VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, user_id) DO UPDATE SET permission_template_id = EXCLUDED.permission_template_id`,
    [tenantId, input.projectId, input.userId, templateId],
  )
}

/**
 * Both lookups filter on tenant_id explicitly even though RLS already confines
 * them. These helpers also run from provisioning and migration paths, which
 * may hold a connection that bypasses RLS, and a template lookup that silently
 * crosses tenants hands somebody another company's permissions.
 */
export async function findTemplateByName(
  db: Db,
  tenantId: string,
  scope: PermissionScope,
  name: string,
  orgKind?: OrganizationKind,
): Promise<string> {
  const { rows } = await db.query<{ id: string; applies_to_org_kinds: OrganizationKind[] }>(
    `SELECT id, applies_to_org_kinds::text[] AS applies_to_org_kinds
       FROM permission_templates
      WHERE tenant_id = $1 AND scope = $2 AND name = $3`,
    [tenantId, scope, name],
  )
  if (rows.length === 0) throw new NotFoundError('permission template', name)

  const chosen = pickForOrgKind(rows, orgKind)
  if (chosen) return chosen.id

  // A name can now belong to several templates that differ only by audience,
  // so an unqualified lookup that matches more than one is ambiguous. Picking
  // the first row would hand somebody a plausible-looking set of permissions
  // written for a different kind of company, which is the sort of thing nobody
  // notices until a sub can close the owner's punch items.
  throw new NotFoundError(
    'permission template',
    orgKind
      ? `${name} (for ${orgKind}; candidates are ${describeAudiences(rows)})`
      : `${name} (ambiguous without an organization kind; candidates are ${describeAudiences(rows)})`,
  )
}

async function defaultTemplateId(
  db: Db,
  tenantId: string,
  scope: PermissionScope,
  orgKind?: OrganizationKind,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string; applies_to_org_kinds: OrganizationKind[] }>(
    `SELECT id, applies_to_org_kinds::text[] AS applies_to_org_kinds
       FROM permission_templates
      WHERE tenant_id = $1 AND scope = $2 AND is_default`,
    [tenantId, scope],
  )
  return pickForOrgKind(rows, orgKind)?.id ?? null
}

/**
 * A template written for this kind of company wins; the universal one (empty
 * audience) is the fallback. With no kind to go on, only an unambiguous single
 * candidate is returned, and the caller decides what to do about the rest.
 */
function pickForOrgKind<T extends { applies_to_org_kinds: OrganizationKind[] }>(
  rows: T[],
  orgKind: OrganizationKind | undefined,
): T | null {
  if (orgKind) {
    const specific = rows.find((r) => r.applies_to_org_kinds.includes(orgKind))
    if (specific) return specific
  }
  const universal = rows.find((r) => r.applies_to_org_kinds.length === 0)
  if (universal) return universal
  return rows.length === 1 ? (rows[0] as T) : null
}

function describeAudiences(rows: { applies_to_org_kinds: OrganizationKind[] }[]): string {
  return rows.map((r) => (r.applies_to_org_kinds.length === 0 ? 'any company' : r.applies_to_org_kinds.join('/'))).join(', ')
}

async function organizationKindOfUser(db: Db, userId: string): Promise<OrganizationKind | undefined> {
  const { rows } = await db.query<{ kind: OrganizationKind }>(
    `SELECT o.kind FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.id = $1`,
    [userId],
  )
  return rows[0]?.kind
}
