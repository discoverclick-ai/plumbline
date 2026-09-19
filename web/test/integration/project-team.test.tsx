import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { AdministrationService, createPool, provisionTenant } from '@plumbline/shared'
import { ProjectTeam, templateLabel, templatesFor } from '../../src/screens/ProjectTeam.tsx'
import { renderAsUser, seedProject, startHarness, tokenFor, type Harness, type SeededProject } from '../support/harness.tsx'

/**
 * Who is on this job.
 *
 * The last link in the onboarding loop, and the one screen where a wrong
 * choice is SILENT: "Project Manager" names three templates that differ only
 * by which side of the contract the person sits on, and picking the wrong one
 * gives somebody access that looks plausible and is wrong in ways nobody
 * notices until a trade partner can see the budget.
 */

const t = (name: string, appliesToOrgKinds: string[] | null): never =>
  ({ id: name + (appliesToOrgKinds ?? []).join(''), name, scope: 'project', appliesToOrgKinds, isDefault: false }) as never

let harness: Harness
let project: SeededProject
let adminToken: string

beforeAll(async () => {
  harness = await startHarness(inject('databaseUrl'))
  const tenant = await provisionTenant(harness.superPool, {
    tenantName: 'Team Web',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@teamweb.test', name: 'Tam Admin', password: 'a-long-enough-password' },
  })
  project = await seedProject(harness.superPool, tenant.tenantId, 'teamweb')
  adminToken = await tokenFor(harness.superPool, 'admin@teamweb.test')

  const pool = createPool({ connectionString: inject('databaseUrl') })
  try {
    // Somebody in the directory who is NOT on the job, which is the whole
    // point of the screen.
    const admin = new AdministrationService(pool)
    const owner = { tenantId: project.tenantId, userId: tenant.adminUserId }
    const steel = await admin.addCompany(owner, { name: 'Vega Steel', kind: 'specialty_contractor' })
    await admin.addPerson(owner, {
      organizationId: steel.id,
      email: 'sasha@vega.test',
      name: 'Sasha Vega',
      jobTitle: 'Project Manager',
    })
  } finally {
    await pool.end()
  }
})

afterEach(() => cleanup())
afterAll(async () => {
  await harness.close()
})

describe('offering the right template', () => {
  const templates = [
    t('Project Manager', ['general_contractor']),
    t('Project Manager', ['owner']),
    t('Project Manager', ['specialty_contractor']),
    t('Trade Partner', ['specialty_contractor', 'supplier']),
    t('Read Only', null),
  ]

  it('offers only what was written for that company kind', () => {
    const forSub = templatesFor(templates, 'specialty_contractor')
    expect(forSub.map((x) => x.name).sort()).toEqual(['Project Manager', 'Read Only', 'Trade Partner'])
    // Offering a subcontractor's PM the OWNER's Project Manager template is
    // offering the wrong answer to the most important question on the screen.
    expect(forSub.filter((x) => x.name === 'Project Manager')).toHaveLength(1)
    expect(forSub.find((x) => x.name === 'Project Manager')!.appliesToOrgKinds).toEqual(['specialty_contractor'])
  })

  it('keeps the universal template for everybody', () => {
    expect(templatesFor(templates, 'architect').map((x) => x.name)).toContain('Read Only')
  })

  it('shows everything before anybody is chosen, rather than an empty list', () => {
    // An empty picker looks like a broken screen.
    expect(templatesFor(templates, null)).toHaveLength(5)
  })

  it('spells out the audience when the bare name is ambiguous', () => {
    const all = templatesFor(templates, null)
    expect(templateLabel(templates[0]!, all)).toBe('Project Manager (general contractor)')
    // And says nothing extra when the name stands alone.
    expect(templateLabel(templates[4]!, all)).toBe('Read Only')
  })
})

describe('the screen', () => {
  it('lists who is on the job with their company', async () => {
    renderAsUser(harness, adminToken, <ProjectTeam projectId={project.projectId} projectName={project.projectName} />)

    const row = (await screen.findByText('Pat Moreno')).closest('tr') as HTMLElement
    expect(within(row).getByText(/Team Web/)).toBeInTheDocument()
  })

  it('offers only people who are not already on it', async () => {
    renderAsUser(harness, adminToken, <ProjectTeam projectId={project.projectId} projectName={project.projectName} />)
    await screen.findByText('Pat Moreno')
    await userEvent.click(screen.getByRole('button', { name: 'Add somebody' }))

    const picker = screen.getAllByRole('combobox')[0]!
    const options = within(picker).getAllByRole('option').map((o) => o.textContent)
    expect(options.some((o) => o?.includes('Sasha Vega'))).toBe(true)
    expect(options.some((o) => o?.includes('Pat Moreno'))).toBe(false)
  })

  it('puts somebody on the job', async () => {
    renderAsUser(harness, adminToken, <ProjectTeam projectId={project.projectId} projectName={project.projectName} />)
    await screen.findByText('Pat Moreno')
    await userEvent.click(screen.getByRole('button', { name: 'Add somebody' }))

    await userEvent.selectOptions(screen.getAllByRole('combobox')[0]!, [
      within(screen.getAllByRole('combobox')[0]!).getByRole('option', { name: /Sasha Vega/ }),
    ])
    await userEvent.click(screen.getByRole('button', { name: 'Add to the job' }))

    await waitFor(() => expect(screen.getByText('Sasha Vega')).toBeInTheDocument())
  })
})
