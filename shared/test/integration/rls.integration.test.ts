import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createPool, withTenant } from '../../src/db.js'
import { RecordKernel } from '../../src/kernel.js'
import { addProjectMember, createProject, findTemplateByName, provisionTenant } from '../../src/provisioning.js'

/**
 * Proves tenant isolation is enforced by POSTGRES, not by application care.
 *
 * The superuser pool seeds (superusers always bypass RLS — a Postgres
 * invariant, not a gap in the policies). Every isolation assertion then runs
 * through `appPool`, which connects as a non-superuser role holding
 * plumbline_app: exactly how the API is meant to run.
 *
 * The probe queries below deliberately carry NO `WHERE tenant_id`. That is the
 * point. Forgetting the filter must not leak another tenant's rows, because
 * the moment an agent is reading this database on a user's behalf, "the
 * application always remembers to filter" stops being a safety story.
 */

let superPool: Pool
let appPool: Pool

const LOGIN_ROLE = 'plumbline_rls_probe'
const LOGIN_PASSWORD = 'probe-password'

interface Fixture {
  tenantId: string
  projectId: string
  recordId: string
  templateId: string
}

let alpha: Fixture
let beta: Fixture

async function seed(name: string): Promise<Fixture> {
  const tenant = await provisionTenant(superPool, {
    tenantName: `${name} Construction`,
    admin: { email: `admin@${name.toLowerCase()}.test`, name: `${name} Admin`, password: 'a-long-enough-password' },
  })

  const projectId = await withTenant(superPool, tenant.tenantId, async (tx) => {
    const id = await createProject(tx, tenant.tenantId, { number: `${name}-1`, name: `${name} Tower` })
    await addProjectMember(tx, tenant.tenantId, {
      projectId: id,
      userId: tenant.adminUserId,
      permissionTemplateName: 'Project Manager',
    })
    return id
  })

  const kernel = new RecordKernel(superPool)
  const created = await kernel.create(
    { tenantId: tenant.tenantId, userId: tenant.adminUserId },
    {
      projectId,
      typeKey: 'observation',
      title: `${name} observation`,
      body: { description: 'Guardrail missing at level 5.' },
    },
  )

  // The tenant admin is in the tenant's own organization, a general
  // contractor, so this resolves to the GC's Project Manager rather than the
  // owner's or the sub's.
  const templateId = await withTenant(superPool, tenant.tenantId, (tx) =>
    findTemplateByName(tx, tenant.tenantId, 'project', 'Project Manager', 'general_contractor'),
  )

  return { tenantId: tenant.tenantId, projectId, recordId: created.record.id, templateId }
}

beforeAll(async () => {
  const databaseUrl = inject('databaseUrl')
  superPool = createPool({ connectionString: databaseUrl })

  alpha = await seed(`Alpha${randomUUID().slice(0, 4)}`)
  beta = await seed(`Beta${randomUUID().slice(0, 4)}`)

  await superPool.query(`DROP ROLE IF EXISTS ${LOGIN_ROLE}`)
  await superPool.query(`CREATE ROLE ${LOGIN_ROLE} LOGIN PASSWORD '${LOGIN_PASSWORD}'`)
  await superPool.query(`GRANT plumbline_app TO ${LOGIN_ROLE}`)

  const url = new URL(databaseUrl)
  url.username = LOGIN_ROLE
  url.password = LOGIN_PASSWORD
  appPool = createPool({ connectionString: url.toString() })
})

afterAll(async () => {
  await appPool?.end()
  await superPool?.query(`DROP ROLE IF EXISTS ${LOGIN_ROLE}`).catch(() => {})
  await superPool?.end()
})

describe('row-level security', () => {
  it('confirms the probe role bypasses nothing (otherwise the rest proves nothing)', async () => {
    const { rows } = await appPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    )
    expect(rows[0]?.rolsuper).toBe(false)
    expect(rows[0]?.rolbypassrls).toBe(false)
  })

  it('returns nothing at all when no tenant context is set', async () => {
    // Fails closed: app_current_tenant() is NULL, and `tenant_id = NULL` is
    // never true.
    for (const table of ['projects', 'records', 'users', 'record_assignments']) {
      const { rows } = await appPool.query(`SELECT 1 FROM ${table}`)
      expect(rows).toHaveLength(0)
    }
  })

  it('shows only the current tenant for unfiltered reads across the kernel tables', async () => {
    await withTenant(appPool, alpha.tenantId, async (tx) => {
      for (const table of [
        'projects',
        'records',
        'users',
        'organizations',
        'record_participants',
        'record_assignments',
        'record_state_history',
        'record_events',
        'permission_templates',
      ]) {
        const { rows } = await tx.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${table}`)
        expect(rows.length).toBeGreaterThan(0)
        for (const row of rows) expect(row.tenant_id).toBe(alpha.tenantId)
      }
    })
  })

  it('cannot read another tenant row even when addressed by its exact primary key', async () => {
    await withTenant(appPool, alpha.tenantId, async (tx) => {
      for (const [table, id] of [
        ['projects', beta.projectId],
        ['records', beta.recordId],
        ['permission_templates', beta.templateId],
      ] as const) {
        const { rows } = await tx.query(`SELECT id FROM ${table} WHERE id = $1`, [id])
        expect(rows).toHaveLength(0)
      }
    })
  })

  it('confines the template child tables, which carry no tenant_id of their own', async () => {
    // These reach the tenant only through their parent template, so their
    // policies subquery it. A bare select must still be confined.
    await withTenant(appPool, alpha.tenantId, async (tx) => {
      const { rows } = await tx.query<{ template_id: string }>('SELECT template_id FROM template_tool_permissions')
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.map((r) => r.template_id)).not.toContain(beta.templateId)
    })
  })

  it('refuses to write a row belonging to another tenant', async () => {
    await expect(
      withTenant(appPool, alpha.tenantId, (tx) =>
        tx.query('INSERT INTO projects (tenant_id, number, name) VALUES ($1, $2, $3)', [
          beta.tenantId,
          'smuggled-1',
          'Smuggled Project',
        ]),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('cannot update another tenant row it cannot see', async () => {
    const result = await withTenant(appPool, alpha.tenantId, (tx) =>
      tx.query('UPDATE records SET title = $2 WHERE id = $1', [beta.recordId, 'rewritten']),
    )
    expect(result.rowCount).toBe(0)

    const { rows } = await withTenant(superPool, beta.tenantId, (tx) =>
      tx.query<{ title: string }>('SELECT title FROM records WHERE id = $1', [beta.recordId]),
    )
    expect(rows[0]?.title).not.toBe('rewritten')
  })

  it('runs the whole kernel correctly under the confined role', async () => {
    // Isolation is worth nothing if the application cannot actually work
    // inside it, so the kernel gets exercised through the same pool.
    const kernel = new RecordKernel(appPool)
    // Note the explicit tenant filter: superPool is a superuser and bypasses
    // RLS, so the surrounding context does NOT confine this read. That is the
    // whole reason the application never connects as one.
    const { rows } = await withTenant(superPool, alpha.tenantId, (tx) =>
      tx.query<{ id: string }>('SELECT id FROM users WHERE tenant_id = $1 LIMIT 1', [alpha.tenantId]),
    )
    const userId = rows[0]?.id
    expect(userId).toBeDefined()

    const created = await kernel.create(
      { tenantId: alpha.tenantId, userId: userId as string },
      {
        projectId: alpha.projectId,
        typeKey: 'observation',
        title: 'Written through the confined role',
        body: { description: 'Housekeeping in the north stair.' },
      },
    )
    expect(created.record.designation).toMatch(/^OBS-\d{3}$/)
  })
})
