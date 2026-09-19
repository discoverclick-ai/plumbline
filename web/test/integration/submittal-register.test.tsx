import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { ScriptedExtractionProvider, SpecificationService, createPool, provisionTenant } from '@plumbline/shared'
import { SubmittalRegister, confidenceLabel, groupBySection } from '../../src/screens/SubmittalRegister.tsx'
import { renderAsUser, seedProject, startHarness, tokenFor, type Harness, type SeededProject } from '../support/harness.tsx'

/**
 * The submittal register, in a browser.
 *
 * The screen is built for one thing: checking a line against the clause it
 * came from, in two seconds, without leaving the row. A register a project
 * engineer cannot check is one they will rebuild by hand anyway, and then the
 * extraction cost them time rather than saving it.
 */

const SECTION = `
2.1 ANCHOR BOLTS
A. Submit product data for all anchor bolts and anchor rods prior to fabrication.
B. Submit shop drawings showing setting plans, dimensions and embedment.
C. Anchor bolts shall be hot-dip galvanised in accordance with ASTM A153.
`

let harness: Harness
let project: SeededProject
let pmToken: string

beforeAll(async () => {
  harness = await startHarness(inject('databaseUrl'))
  const tenant = await provisionTenant(harness.superPool, {
    tenantName: 'Register Web',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@registerweb.test', name: 'Reg Admin', password: 'a-long-enough-password' },
  })
  project = await seedProject(harness.superPool, tenant.tenantId, 'registerweb')
  pmToken = await tokenFor(harness.superPool, project.users.pm.email)

  const pool = createPool({ connectionString: inject('databaseUrl') })
  try {
    const scripted = new ScriptedExtractionProvider()
    const specs = new SpecificationService(pool, scripted)
    const pm = { tenantId: project.tenantId, userId: project.users.pm.id }

    const book = await specs.createBook(pm, { projectId: project.projectId, name: 'Project Manual' })
    const section = await specs.addSection(pm, {
      bookId: book.id,
      number: '05 12 00',
      title: 'Structural Steel Framing',
      body: SECTION,
    })

    scripted.push([
      {
        submittalType: 'Product Data',
        description: 'Anchor bolts and anchor rods',
        quote: 'Submit product data for all anchor bolts and anchor rods prior to fabrication.',
        confidence: 0.96,
      },
      {
        submittalType: 'Shop Drawing',
        description: 'Anchor bolt setting plans',
        quote: 'Submit shop drawings showing setting plans, dimensions and embedment.',
        confidence: 0.74,
      },
      {
        // Not in the section. The server discards it before it is stored, and
        // this asserts the screen never has a chance to show it.
        submittalType: 'Certificate',
        description: 'Galvanising certificate',
        quote: 'Submit a certificate of galvanising compliance for every bolt.',
        confidence: 0.61,
      },
    ])
    await specs.extractRequirements(pm, section.id)
  } finally {
    await pool.end()
  }
})

afterEach(() => cleanup())
afterAll(async () => {
  await harness.close()
})

describe('reading the register', () => {
  it('groups by section in the order a spec book is bound', () => {
    const line = (sectionNumber: string): never => ({ sectionNumber, id: sectionNumber } as never)
    const groups = groupBySection([line('07 52 00'), line('03 30 00'), line('07 52 00')])
    // Anybody looking for 07 52 00 expects to find it after 03 30 00.
    expect(groups.map((g) => g.section)).toEqual(['03 30 00', '07 52 00'])
    expect(groups[1]!.items).toHaveLength(2)
  })

  it('says nothing about a confident line and flags an unsure one', () => {
    // Bands, not percentages. A reviewer does not act differently on 0.82
    // versus 0.86, and two decimals invites them to think they should.
    expect(confidenceLabel('0.96')).toBeNull()
    expect(confidenceLabel('0.74')).toBe('worth a look')
    expect(confidenceLabel('0.41')).toBe('check this one')
    expect(confidenceLabel(null)).toBeNull()
  })
})

describe('the screen', () => {
  it('shows only what the extractor could cite', async () => {
    renderAsUser(harness, pmToken, <SubmittalRegister projectId={project.projectId} projectName={project.projectName} />)

    expect(await screen.findByText('Anchor bolts and anchor rods')).toBeInTheDocument()
    expect(screen.getByText('Anchor bolt setting plans')).toBeInTheDocument()
    // The third line quoted a sentence that is not in the section. It was
    // discarded before it reached the database, so the screen never had a
    // chance to put a fabricated citation in front of a reviewer.
    expect(screen.queryByText('Galvanising certificate')).not.toBeInTheDocument()
  })

  it('puts the clause under every line, verbatim', async () => {
    renderAsUser(harness, pmToken, <SubmittalRegister projectId={project.projectId} projectName={project.projectName} />)
    const card = (await screen.findByText('Anchor bolts and anchor rods')).closest('article') as HTMLElement

    expect(within(card).getByText(/Submit product data for all anchor bolts/)).toBeInTheDocument()
  })

  it('flags the line worth a second look and leaves the confident one alone', async () => {
    renderAsUser(harness, pmToken, <SubmittalRegister projectId={project.projectId} projectName={project.projectName} />)
    await screen.findByText('Anchor bolts and anchor rods')

    const shop = screen.getByText('Anchor bolt setting plans').closest('article') as HTMLElement
    const data = screen.getByText('Anchor bolts and anchor rods').closest('article') as HTMLElement
    expect(within(shop).getByText('worth a look')).toBeInTheDocument()
    expect(within(data).queryByText(/worth a look|check this one/)).not.toBeInTheDocument()
  })

  it('offers no bulk accept, because accepting raises a real submittal', async () => {
    renderAsUser(harness, pmToken, <SubmittalRegister projectId={project.projectId} projectName={project.projectName} />)
    await screen.findByText('Anchor bolts and anchor rods')

    // Forty submittals created in one click is forty records nobody chose.
    expect(screen.queryByRole('button', { name: /accept all|add all/i })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Add to register' })).toHaveLength(2)
  })

  it('raises a submittal and moves the line onto the register', async () => {
    renderAsUser(harness, pmToken, <SubmittalRegister projectId={project.projectId} projectName={project.projectName} />)
    const card = (await screen.findByText('Anchor bolts and anchor rods')).closest('article') as HTMLElement

    await userEvent.click(within(card).getByRole('button', { name: 'Add to register' }))

    await waitFor(() => expect(screen.getByText(/raised as a submittal/)).toBeInTheDocument())
    await userEvent.click(screen.getByRole('tab', { name: /On the register/ }))
    expect(await screen.findByText('Anchor bolts and anchor rods')).toBeInTheDocument()
  })
})
