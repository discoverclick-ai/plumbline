import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { render, type RenderResult } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Pool } from 'pg'
import { createApiServer } from '@plumbline/api/dist/server.js'
import { FilesystemBlobStore } from '@plumbline/shared'
import {
  addProjectMember,
  createOrganization,
  createPool,
  createProject,
  createUser,
  findTemplateByName,
  signIn,
  withTenant,
  type InterpretationProvider,
  type ProviderRequest,
  type ProviderResponse,
} from '@plumbline/shared'
import { SessionProvider } from '../../src/session/SessionProvider.tsx'

/**
 * Boots the REAL API against the REAL database and renders React against it.
 *
 * Nothing is stubbed except the model: a component under test issues actual
 * HTTP requests, the API runs its actual permission and transaction pipeline,
 * and assertions can read back from Postgres. A component that merely updated
 * its own state would fail every test in this directory.
 *
 * The API connects as a non-superuser role holding `plumbline_app`, exactly as
 * it must in production, so row-level security is underneath these tests too.
 */

export class ScriptedProvider implements InterpretationProvider {
  readonly name = 'scripted'
  private readonly queue: unknown[] = []

  push(output: unknown): void {
    this.queue.push(output)
  }

  async interpret(_request: ProviderRequest): Promise<ProviderResponse> {
    const next = this.queue.shift()
    if (next === undefined) throw new Error('ScriptedProvider ran out of queued outputs')
    return {
      output: next,
      model: 'claude-opus-5',
      usage: { inputTokens: 900, outputTokens: 140, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }
  }
}

export interface Harness {
  baseUrl: string
  /** Superuser pool, for seeding and for verifying effects landed. */
  superPool: Pool
  provider: ScriptedProvider
  close: () => Promise<void>
}

export async function startHarness(databaseUrl: string, options: { blobRoot?: string } = {}): Promise<Harness> {
  const superPool = createPool({ connectionString: databaseUrl })

  const roleName = `web_probe_${randomUUID().slice(0, 8).replace(/-/g, '')}`
  await superPool.query(`CREATE ROLE ${roleName} LOGIN PASSWORD 'probe'`)
  await superPool.query(`GRANT plumbline_app TO ${roleName}`)
  const url = new URL(databaseUrl)
  url.username = roleName
  url.password = 'probe'
  const appPool = createPool({ connectionString: url.toString() })

  const provider = new ScriptedProvider()
  // The blob root is shared with whatever seeded the data. A test that seeds
  // photographs through its own store and then serves them from the default
  // one gets a gallery of broken images and an unhelpful ENOENT.
  const server: Server = createApiServer(appPool, {
    interpretationProvider: provider,
    ...(options.blobRoot ? { blobStore: new FilesystemBlobStore(options.blobRoot) } : {}),
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    superPool,
    provider,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
      await appPool.end()
      await superPool.query(`DROP ROLE IF EXISTS ${roleName}`).catch(() => {})
      await superPool.end()
    },
  }
}

export interface SeededProject {
  tenantId: string
  projectId: string
  projectName: string
  users: Record<'pm' | 'superintendent' | 'architect' | 'trade', { id: string; email: string }>
}

const PASSWORD = 'a-long-enough-password'

/**
 * A project with the cast that makes permissions visible: a PM who can do
 * everything, an architect who answers but cannot close, and a trade partner
 * who may raise and capture but not decide.
 */
export async function seedProject(pool: Pool, tenantId: string, label: string): Promise<SeededProject> {
  return withTenant(pool, tenantId, async (tx) => {
    const design = await createOrganization(tx, tenantId, { name: `${label} Architects`, kind: 'architect' })
    const trades = await createOrganization(tx, tenantId, {
      name: `${label} Mechanical`,
      kind: 'specialty_contractor',
    })
    // Explicitly tenant-filtered. This pool is a superuser, so row-level
    // security does not confine it, and with two suites provisioning tenants
    // into one database an unfiltered `WHERE is_self` happily returns the
    // OTHER suite's company. That put this project's people in another
    // tenant's organization, which stayed invisible until something joined
    // users to organizations.
    const self = await tx.query<{ id: string }>(
      'SELECT id FROM organizations WHERE tenant_id = $1 AND is_self LIMIT 1',
      [tenantId],
    )
    const selfOrg = self.rows[0]?.id as string

    const employee = await findTemplateByName(tx, tenantId, 'company', 'Employee')
    const collaborator = await findTemplateByName(tx, tenantId, 'company', 'Collaborator')

    const pm = await createUser(tx, tenantId, {
      organizationId: selfOrg,
      email: `pm-${label}@web.test`,
      name: 'Pat Moreno',
      jobTitle: 'Project Manager',
      password: PASSWORD,
      companyPermissionTemplateId: employee,
    })
    const architect = await createUser(tx, tenantId, {
      organizationId: design,
      email: `aor-${label}@web.test`,
      name: 'Ali Ward',
      password: PASSWORD,
      companyPermissionTemplateId: collaborator,
    })
    const superintendent = await createUser(tx, tenantId, {
      organizationId: selfOrg,
      email: `super-${label}@web.test`,
      name: 'Sam Ruiz',
      jobTitle: 'Superintendent',
      password: PASSWORD,
      companyPermissionTemplateId: employee,
    })
    const trade = await createUser(tx, tenantId, {
      organizationId: trades,
      email: `foreman-${label}@web.test`,
      name: 'Bo Bell',
      password: PASSWORD,
      companyPermissionTemplateId: collaborator,
    })

    const projectName = `${label} Tower`
    const projectId = await createProject(tx, tenantId, { number: `W-${label}`, name: projectName })

    for (const [userId, template] of [
      [pm, 'Project Manager'],
      [superintendent, 'Superintendent'],
      [architect, 'Design Team'],
      [trade, 'Trade Partner'],
    ] as const) {
      await addProjectMember(tx, tenantId, {
        projectId,
        userId,
        permissionTemplateName: template,
      })
    }

    return {
      tenantId,
      projectId,
      projectName,
      users: {
        pm: { id: pm, email: `pm-${label}@web.test` },
        superintendent: { id: superintendent, email: `super-${label}@web.test` },
        architect: { id: architect, email: `aor-${label}@web.test` },
        trade: { id: trade, email: `foreman-${label}@web.test` },
      },
    }
  })
}

/** A real token, minted by the same code path the sign-in screen uses. */
export async function tokenFor(pool: Pool, email: string): Promise<string> {
  const result = await signIn(pool, { email, password: PASSWORD })
  return result.token
}

export function renderAsUser(harness: Harness, token: string, children: ReactNode): RenderResult {
  return render(
    <SessionProvider baseUrl={harness.baseUrl} initialToken={token}>
      {children}
    </SessionProvider>,
  )
}
