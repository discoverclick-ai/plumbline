import { withTenant, type Db } from './db.js'
import { PermissionDeniedError, ValidationError } from './errors.js'
import type { Actor } from './kernel.js'
import { hasLevel, hasPrivilege } from './permissions.js'
import { addProjectMember, createOrganization, createProject, createUser } from './provisioning.js'
import type { OrganizationKind, ProjectStage } from './types.js'
import { loadAccess } from './repositories/permissions.js'

/**
 * Setting a company up, over the wire.
 *
 * There was no route to create a project, a company, a person or a
 * membership. Every one of those existed as a provisioning function called by
 * tests and a seed script, which meant a customer could not onboard at all:
 * the product could run a job beautifully and had no way to start one.
 *
 * The functions themselves are primitives with no permission checks, because
 * provisioning a tenant happens before there is anybody to check against.
 * Exposing them directly would have been a hole big enough to create a user
 * with a company administrator template. So this is the layer that decides
 * who may do each of them, and it is the ONLY thing above them that should
 * ever be routed.
 */

export interface OrganizationRow {
  id: string
  name: string
  kind: OrganizationKind
  trade: string | null
  isSelf: boolean
  userCount: number
}

export interface DirectoryUser {
  id: string
  name: string
  email: string
  jobTitle: string | null
  organizationId: string
  organizationName: string
  companyTemplateName: string | null
}

export interface PermissionTemplateRow {
  id: string
  name: string
  scope: 'company' | 'project'
  appliesToOrgKinds: string[] | null
  isDefault: boolean
}

export class AdministrationService {
  constructor(private readonly db: Db) {}

  async projectStart(
    actor: Actor,
    input: {
      number: string
      name: string
      stage?: ProjectStage
      city?: string
      stateCode?: string
      timeZone?: string
      contractValue?: string
    },
  ): Promise<{ id: string }> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId: null })
      if (!hasPrivilege(access, 'projects', 'create_projects') && !access.isCompanyAdmin) {
        throw new PermissionDeniedError('You cannot start projects for this company', {
          tool: 'projects',
          privilege: 'create_projects',
        })
      }
      if (!input.number?.trim() || !input.name?.trim()) {
        throw new ValidationError('A project needs a number and a name', [
          { field: 'number', message: 'The job number everybody says out loud' },
          { field: 'name', message: 'The name on the contract' },
        ])
      }

      const id = await createProject(tx, actor.tenantId, {
        ...input,
        number: input.number.trim(),
        name: input.name.trim(),
      })

      // The person who starts a job is on it. Without this they would create
      // a project and immediately be unable to open it, which is the first
      // thing anybody would do and the first bug they would report.
      await addProjectMember(tx, actor.tenantId, { projectId: id, userId: actor.userId })
      return { id }
    })
  }

  async addCompany(
    actor: Actor,
    input: { name: string; kind: OrganizationKind; trade?: string },
  ): Promise<{ id: string }> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await this.assertDirectoryAdmin(tx, actor)
      if (!input.name?.trim()) {
        throw new ValidationError('A company needs a name', [{ field: 'name', message: 'Name is required' }])
      }
      // `isSelf` is deliberately NOT accepted. Exactly one organization per
      // tenant is the company itself, it is set when the tenant is
      // provisioned, and a second one would make every "which side of the
      // contract are you on" decision in the permission model ambiguous.
      const id = await createOrganization(tx, actor.tenantId, {
        name: input.name.trim(),
        kind: input.kind,
        ...(input.trade ? { trade: input.trade } : {}),
      })
      return { id }
    })
  }

  async addPerson(
    actor: Actor,
    input: {
      organizationId: string
      email: string
      name: string
      jobTitle?: string
      password?: string
      companyPermissionTemplateId?: string | null
    },
  ): Promise<{ id: string }> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await this.assertDirectoryAdmin(tx, actor)

      const email = input.email?.trim().toLowerCase()
      if (!email || !email.includes('@')) {
        throw new ValidationError('That is not an email address', [
          { field: 'email', message: 'People are identified by email across companies' },
        ])
      }

      // The template must belong to THIS tenant. The id comes from a form, so
      // without this check a company administrator could hand somebody a
      // template from another tenant and there is no reason it would fail.
      if (input.companyPermissionTemplateId) {
        const { rows } = await tx.query(
          `SELECT 1 FROM permission_templates
            WHERE tenant_id = $1 AND id = $2 AND scope = 'company'`,
          [actor.tenantId, input.companyPermissionTemplateId],
        )
        if (rows.length === 0) {
          throw new ValidationError('That is not a permission template on this company', [
            { field: 'companyPermissionTemplateId', message: 'Pick a company template' },
          ])
        }
      }

      const { rows: org } = await tx.query('SELECT 1 FROM organizations WHERE tenant_id = $1 AND id = $2', [
        actor.tenantId,
        input.organizationId,
      ])
      if (org.length === 0) {
        throw new ValidationError('That company is not on this account', [
          { field: 'organizationId', message: 'Pick a company from the directory' },
        ])
      }

      const id = await createUser(tx, actor.tenantId, {
        organizationId: input.organizationId,
        email,
        name: input.name?.trim() || email,
        ...(input.jobTitle ? { jobTitle: input.jobTitle } : {}),
        ...(input.password ? { password: input.password } : {}),
        ...(input.companyPermissionTemplateId !== undefined
          ? { companyPermissionTemplateId: input.companyPermissionTemplateId }
          : {}),
      })
      return { id }
    })
  }

  async addMember(
    actor: Actor,
    input: { projectId: string; userId: string; permissionTemplateName?: string; permissionTemplateId?: string },
  ): Promise<void> {
    await withTenant(this.db, actor.tenantId, async (tx) => {
      const access = await loadAccess(tx, {
        userId: actor.userId,
        tenantId: actor.tenantId,
        projectId: input.projectId,
      })
      if (!hasPrivilege(access, 'project_team', 'manage_members') && !access.isCompanyAdmin) {
        throw new PermissionDeniedError('You cannot manage who is on this project', {
          tool: 'project_team',
          privilege: 'manage_members',
        })
      }

      const { rows } = await tx.query('SELECT 1 FROM users WHERE tenant_id = $1 AND id = $2', [
        actor.tenantId,
        input.userId,
      ])
      if (rows.length === 0) {
        throw new ValidationError('That person is not on this account', [
          { field: 'userId', message: 'Add them to the directory first' },
        ])
      }

      await addProjectMember(tx, actor.tenantId, {
        projectId: input.projectId,
        userId: input.userId,
        ...(input.permissionTemplateId ? { permissionTemplateId: input.permissionTemplateId } : {}),
        ...(input.permissionTemplateName ? { permissionTemplateName: input.permissionTemplateName } : {}),
      })
    })
  }

  /** The companies on this account, with how many people each has. */
  async companies(actor: Actor): Promise<OrganizationRow[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await this.assertDirectoryReader(tx, actor)
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT o.id, o.name, o.kind::text AS kind, o.trade, o.is_self,
                (SELECT count(*) FROM users u WHERE u.organization_id = o.id)::int AS user_count
           FROM organizations o
          WHERE o.tenant_id = $1
          ORDER BY o.is_self DESC, o.name`,
        [actor.tenantId],
      )
      return rows.map((r) => ({
        id: r['id'] as string,
        name: r['name'] as string,
        kind: r['kind'] as OrganizationKind,
        trade: (r['trade'] as string | null) ?? null,
        isSelf: r['is_self'] === true,
        userCount: Number(r['user_count'] ?? 0),
      }))
    })
  }

  async people(actor: Actor): Promise<DirectoryUser[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await this.assertDirectoryReader(tx, actor)
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT u.id, u.name, u.email, u.job_title, u.organization_id,
                o.name AS organization_name, t.name AS template_name
           FROM users u
           JOIN organizations o ON o.id = u.organization_id AND o.tenant_id = u.tenant_id
      LEFT JOIN permission_templates t ON t.id = u.company_permission_template_id
          WHERE u.tenant_id = $1
          ORDER BY o.is_self DESC, o.name, u.name`,
        [actor.tenantId],
      )
      return rows.map((r) => ({
        id: r['id'] as string,
        name: r['name'] as string,
        email: r['email'] as string,
        jobTitle: (r['job_title'] as string | null) ?? null,
        organizationId: r['organization_id'] as string,
        organizationName: r['organization_name'] as string,
        companyTemplateName: (r['template_name'] as string | null) ?? null,
      }))
    })
  }

  /**
   * The templates somebody may hand out.
   *
   * Project templates carry the org kinds they were written for, because
   * "Project Manager" now names three templates that differ only by which
   * side of the contract the person sits on, and picking the wrong one is
   * silent.
   */
  async templates(actor: Actor, scope?: 'company' | 'project'): Promise<PermissionTemplateRow[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await this.assertDirectoryReader(tx, actor)
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT id, name, scope::text AS scope, applies_to_org_kinds::text[] AS applies_to_org_kinds, is_default
           FROM permission_templates
          WHERE tenant_id = $1 AND ($2::text IS NULL OR scope::text = $2::text)
          ORDER BY scope, name`,
        [actor.tenantId, scope ?? null],
      )
      return rows.map((r) => ({
        id: r['id'] as string,
        name: r['name'] as string,
        scope: r['scope'] as 'company' | 'project',
        appliesToOrgKinds: (r['applies_to_org_kinds'] as string[] | null) ?? null,
        isDefault: r['is_default'] === true,
      }))
    })
  }

  private async assertDirectoryAdmin(tx: Db, actor: Actor): Promise<void> {
    const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId: null })
    if (!hasLevel(access, 'directory', 'admin') && !access.isCompanyAdmin) {
      throw new PermissionDeniedError('You cannot change the company directory', { tool: 'directory' })
    }
  }

  private async assertDirectoryReader(tx: Db, actor: Actor): Promise<void> {
    const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId: null })
    if (!hasLevel(access, 'directory', 'read_only') && !access.isCompanyAdmin) {
      throw new PermissionDeniedError('You cannot see the company directory', { tool: 'directory' })
    }
  }
}
