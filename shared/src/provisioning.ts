import { hashPassword } from './auth.js'
import { withTenant, type Db } from './db.js'
import { NotFoundError } from './errors.js'
import type { OrganizationKind, PermissionLevel, PermissionScope, ProjectStage } from './types.js'

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
    name: 'Project Manager',
    scope: 'project',
    tools: [
      { toolKey: 'rfis', level: 'standard', privileges: ['create', 'respond', 'close'] },
      { toolKey: 'submittals', level: 'standard', privileges: ['create', 'review'] },
      { toolKey: 'punch_list', level: 'standard', privileges: ['create', 'verify'] },
      { toolKey: 'observations', level: 'standard', privileges: ['create', 'close'] },
      { toolKey: 'daily_log', level: 'standard', privileges: ['create'] },
      { toolKey: 'capture', level: 'standard', privileges: ['review'] },
      { toolKey: 'documents', level: 'standard' },
      { toolKey: 'project_team', level: 'standard', privileges: ['manage_members'] },
    ],
  },
  {
    name: 'Superintendent',
    scope: 'project',
    tools: [
      { toolKey: 'rfis', level: 'standard', privileges: ['create'] },
      { toolKey: 'submittals', level: 'read_only' },
      { toolKey: 'punch_list', level: 'standard', privileges: ['create', 'verify'] },
      { toolKey: 'observations', level: 'standard', privileges: ['create', 'close'] },
      { toolKey: 'daily_log', level: 'standard', privileges: ['create'] },
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
    isDefault: true,
    tools: [
      { toolKey: 'rfis', level: 'read_only', privileges: ['create'] },
      { toolKey: 'submittals', level: 'read_only', privileges: ['create'] },
      { toolKey: 'punch_list', level: 'standard' },
      { toolKey: 'observations', level: 'read_only' },
      { toolKey: 'daily_log', level: 'none' },
      { toolKey: 'capture', level: 'read_only' },
      { toolKey: 'documents', level: 'read_only' },
      { toolKey: 'project_team', level: 'read_only' },
    ],
  },
  {
    name: 'Design Team',
    scope: 'project',
    tools: [
      { toolKey: 'rfis', level: 'standard', privileges: ['respond'] },
      { toolKey: 'submittals', level: 'standard', privileges: ['review'] },
      { toolKey: 'punch_list', level: 'read_only' },
      { toolKey: 'observations', level: 'read_only', privileges: ['create'] },
      { toolKey: 'capture', level: 'read_only' },
      { toolKey: 'documents', level: 'read_only' },
      { toolKey: 'project_team', level: 'read_only' },
    ],
  },
  {
    name: 'Read Only',
    scope: 'project',
    tools: [
      { toolKey: 'rfis', level: 'read_only' },
      { toolKey: 'submittals', level: 'read_only' },
      { toolKey: 'punch_list', level: 'read_only' },
      { toolKey: 'observations', level: 'read_only' },
      { toolKey: 'daily_log', level: 'read_only' },
      { toolKey: 'capture', level: 'read_only' },
      { toolKey: 'documents', level: 'read_only' },
      { toolKey: 'project_team', level: 'read_only' },
    ],
  },
]

export async function createTemplate(db: Db, tenantId: string, spec: TemplateSpec): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO permission_templates (tenant_id, scope, name, is_default)
          VALUES ($1, $2, $3, $4)
       RETURNING id`,
    [tenantId, spec.scope, spec.name, spec.isDefault === true],
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
  input: { projectId: string; userId: string; permissionTemplateId?: string | null },
): Promise<void> {
  const templateId =
    input.permissionTemplateId === undefined ? await defaultTemplateId(db, tenantId, 'project') : input.permissionTemplateId

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
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM permission_templates WHERE tenant_id = $1 AND scope = $2 AND name = $3',
    [tenantId, scope, name],
  )
  const row = rows[0]
  if (!row) throw new NotFoundError('permission template', name)
  return row.id
}

async function defaultTemplateId(db: Db, tenantId: string, scope: PermissionScope): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM permission_templates WHERE tenant_id = $1 AND scope = $2 AND is_default',
    [tenantId, scope],
  )
  return rows[0]?.id ?? null
}
