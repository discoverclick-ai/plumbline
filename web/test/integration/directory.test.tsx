import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { provisionTenant } from '@plumbline/shared'
import { Directory } from '../../src/screens/Directory.tsx'
import { renderAsUser, seedProject, startHarness, tokenFor, type Harness, type SeededProject } from '../support/harness.tsx'

/**
 * Onboarding, in a browser.
 *
 * Nothing in this product could add a company or a person, which meant a
 * customer could not start: the software could run a job beautifully and had
 * no way to put anybody on one.
 *
 * The organising idea the screen has to carry is that a person belongs to a
 * COMPANY, and the company kind decides most of what they may do.
 */

let harness: Harness
let project: SeededProject
let adminToken: string
let pmToken: string

beforeAll(async () => {
  harness = await startHarness(inject('databaseUrl'))
  const tenant = await provisionTenant(harness.superPool, {
    tenantName: 'Directory Web',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@directoryweb.test', name: 'Dana Admin', password: 'a-long-enough-password' },
  })
  project = await seedProject(harness.superPool, tenant.tenantId, 'directoryweb')
  adminToken = await tokenFor(harness.superPool, 'admin@directoryweb.test')
  pmToken = await tokenFor(harness.superPool, project.users.pm.email)
})

afterEach(() => cleanup())
afterAll(async () => {
  await harness.close()
})

describe('the directory', () => {
  it('lists everybody with the company they belong to', async () => {
    renderAsUser(harness, adminToken, <Directory />)

    const row = (await screen.findByText('Pat Moreno')).closest('tr') as HTMLElement
    // Never a name without its company: "Project Manager" means three
    // different jobs depending on which side of the contract the company is
    // on.
    expect(within(row).getByText(/Directory Web/)).toBeInTheDocument()
  })

  it('says what company access somebody holds', async () => {
    renderAsUser(harness, adminToken, <Directory />)
    const row = (await screen.findByText('Dana Admin')).closest('tr') as HTMLElement

    // "Why can they see the budget" is a question somebody asks about once a
    // month, and a directory that cannot answer it sends them to support.
    expect(within(row).getByText('Company Administrator')).toBeInTheDocument()
  })

  it('adds a company and then a person in it', async () => {
    renderAsUser(harness, adminToken, <Directory />)
    await screen.findByText('Pat Moreno')

    await userEvent.click(screen.getByRole('tab', { name: /Companies/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Add a company' }))
    await userEvent.type(screen.getByPlaceholderText('Vega Steel'), 'Bishop Architects')
    await userEvent.selectOptions(screen.getByDisplayValue('Specialty contractor'), 'architect')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(screen.getByText('Bishop Architects')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('tab', { name: /People/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Add a person' }))
    await userEvent.selectOptions(screen.getByDisplayValue(/Directory Web|Bishop/), 'Bishop Architects')
    await userEvent.type(screen.getByPlaceholderText('ali@bishop.test'), 'ALI@Bishop.test')
    await userEvent.type(screen.getByPlaceholderText('Ali Bishop'), 'Ali Bishop')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))

    // Lowercased on the way in: people are identified by email across
    // companies, and two rows differing only by capitals are two people.
    expect(await screen.findByText('ali@bishop.test')).toBeInTheDocument()
  })

  it('marks which company is the account itself', async () => {
    renderAsUser(harness, adminToken, <Directory />)
    await screen.findByText('Pat Moreno')
    await userEvent.click(screen.getByRole('tab', { name: /Companies/ }))

    // Exactly one, and it is not a field anybody can set.
    expect(await screen.findByText('You')).toBeInTheDocument()
  })

  it('tells somebody without directory access why it is empty', async () => {
    renderAsUser(harness, pmToken, <Directory />)

    // The Employee template grants read_only on the directory, so this
    // person sees it and cannot change it. The add buttons still appear and
    // the server refuses them, which is the honest version: the button they
    // press tells them the rule.
    expect(await screen.findByText('Pat Moreno')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Add a person' }))
    await userEvent.type(screen.getByPlaceholderText('ali@bishop.test'), 'x@directoryweb.test')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))

    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toMatch(/cannot change the company directory/i)
  })
})
