import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createPool, withTenant } from '../../src/db.js'
import { PermissionDeniedError, ValidationError } from '../../src/errors.js'
import { RecordKernel, type Actor } from '../../src/kernel.js'
import {
  quoteIsFound,
  ScriptedExtractionProvider,
  SpecificationService,
} from '../../src/specifications.js'
import {
  addProjectMember,
  createOrganization,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
} from '../../src/provisioning.js'

/**
 * The submittal register, extracted from the spec book.
 *
 * Every project engineer builds this list by hand in the first fortnight of a
 * job, and missing one line is a material that arrives unapproved and becomes
 * a six week lead time nobody budgeted for. It is the best agent job in
 * construction precisely because it is checkable: every line traces to a
 * clause, or it does not exist.
 */

const SECTION_BODY = `
PART 1 - GENERAL

1.3 SUBMITTALS

A. Product Data: Submit manufacturer's product data for each type of structural
   steel fastener, including high-strength bolts, nuts and washers.

B. Shop Drawings: Submit shop drawings showing fabrication and erection of
   structural steel. Include details of cuts, connections, splices, camber and
   holes. Shop drawings shall be prepared under the seal of a professional
   engineer registered in the state of the project.

C. Mill Test Reports: Submit certified mill test reports for each heat of
   structural steel supplied.

1.4 QUALITY ASSURANCE

A. Fabricator shall be certified by AISC.
`

let pool: Pool
let provider: ScriptedExtractionProvider
let specs: SpecificationService
let kernel: RecordKernel
let tenantId: string
let projectId: string
let gc: Actor
let trade: Actor
let sectionId: string

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  provider = new ScriptedExtractionProvider()
  specs = new SpecificationService(pool, provider)
  kernel = new RecordKernel(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Hallow Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@hallow.test', name: 'Hal Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const steel = await createOrganization(tx, tenantId, {
      name: 'Marrow Steel',
      kind: 'specialty_contractor',
      trade: 'Structural Steel',
    })
    const gcId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@hallow.test',
      name: 'Hana Poole',
      companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Employee'),
    })
    const tradeId = await createUser(tx, tenantId, {
      organizationId: steel,
      email: 'pm@marrow.test',
      name: 'Mo Marrow',
      companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Collaborator'),
    })
    projectId = await createProject(tx, tenantId, { number: '28-200', name: 'Hallow Works' })
    await addProjectMember(tx, tenantId, { projectId, userId: gcId, permissionTemplateName: 'Project Manager' })
    await addProjectMember(tx, tenantId, { projectId, userId: tradeId, permissionTemplateName: 'Trade Partner' })
    gc = { tenantId, userId: gcId }
    trade = { tenantId, userId: tradeId }
  })

  const book = await specs.createBook(gc, { projectId, name: 'Project Manual', issuedOn: '2026-04-01' })
  const section = await specs.addSection(gc, {
    bookId: book.id,
    number: '05 12 00',
    title: 'Structural Steel Framing',
    body: SECTION_BODY,
  })
  sectionId = section.id
})

afterAll(async () => {
  await pool.end()
})

describe('the citation rule', () => {
  it('accepts a quote that differs only in whitespace', () => {
    // A model reflowing a line break inside a quote is not a hallucination,
    // and refusing it would train people to ignore the check.
    expect(quoteIsFound('Submit certified mill test reports for each heat', SECTION_BODY)).toBe(true)
    expect(
      quoteIsFound('Submit shop drawings showing fabrication and erection of structural steel.', SECTION_BODY),
    ).toBe(true)
  })

  it('rejects a quote with a word changed', () => {
    expect(quoteIsFound('Submit certified mill test reports for every heat', SECTION_BODY)).toBe(false)
    expect(quoteIsFound('Submit a bond and insurance certificate', SECTION_BODY)).toBe(false)
  })

  it('rejects an empty quote rather than matching everything', () => {
    expect(quoteIsFound('', SECTION_BODY)).toBe(false)
    expect(quoteIsFound('   ', SECTION_BODY)).toBe(false)
  })
})

describe('extracting the register', () => {
  it('proposes what the section requires, and discards what it cannot cite', async () => {
    provider.push([
      {
        submittalType: 'Product Data',
        description: 'Fastener product data, including high-strength bolts, nuts and washers',
        quote: "Submit manufacturer's product data for each type of structural steel fastener",
        paragraph: '1.3.A',
        confidence: 0.94,
      },
      {
        submittalType: 'Shop Drawing',
        description: 'Structural steel fabrication and erection drawings, sealed',
        quote: 'Submit shop drawings showing fabrication and erection of structural steel.',
        paragraph: '1.3.B',
        confidence: 0.96,
      },
      {
        submittalType: 'Test Report',
        description: 'Certified mill test reports per heat',
        quote: 'Submit certified mill test reports for each heat of structural steel supplied.',
        paragraph: '1.3.C',
        confidence: 0.91,
      },
      {
        // Plausible, entirely absent from the section, and exactly the kind of
        // line that would be defended in a meeting until somebody looked.
        submittalType: 'Certificate',
        description: 'Welder qualification certificates',
        quote: 'Submit welder qualification certificates for all field welding.',
        paragraph: '1.3.D',
        confidence: 0.72,
      },
      {
        submittalType: 'Widget',
        description: 'Something the submittal log cannot hold',
        quote: 'Fabricator shall be certified by AISC.',
      },
    ])

    const result = await specs.extractRequirements(gc, sectionId)
    expect(result.proposed).toBe(3)
    expect(result.discarded).toHaveLength(2)
    expect(result.discarded[0]?.reason).toContain('quote not found')
    expect(result.discarded[1]?.reason).toContain('unknown submittal type')

    const register = await specs.register(gc, projectId)
    expect(register.map((r) => r.submittalType).sort()).toEqual(['Product Data', 'Shop Drawing', 'Test Report'])
    expect(register.every((r) => r.status === 'proposed')).toBe(true)
    // Every line carries the clause it came from, which is the only reason a
    // project engineer will trust the list instead of rebuilding it.
    expect(register.every((r) => quoteIsFound(r.quote, SECTION_BODY))).toBe(true)
  })

  it('creates nothing on its own', async () => {
    // An agent may propose anything and create nothing. Until a human accepts,
    // the submittal log is untouched.
    const submittals = await kernel.list(gc, { projectId, typeKey: 'submittal' })
    expect(submittals).toHaveLength(0)
  })
})

describe('accepting a requirement', () => {
  it('raises the submittal that satisfies it, carrying the section and the type', async () => {
    const register = await specs.register(gc, projectId)
    const shopDrawings = register.find((r) => r.submittalType === 'Shop Drawing')!

    const { submittalId } = await specs.accept(gc, shopDrawings.id)
    const submittal = await kernel.get(gc, submittalId)

    expect(submittal.record.typeKey).toBe('submittal')
    expect(submittal.record.body['spec_section']).toBe('05 12 00')
    expect(submittal.record.body['submittal_type']).toBe('Shop Drawing')
    expect(submittal.record.title).toContain('05 12 00')

    const after = (await specs.register(gc, projectId)).find((r) => r.id === shopDrawings.id)
    expect(after?.status).toBe('accepted')
    expect(after?.submittalId).toBe(submittalId)
  })

  it('will not decide the same requirement twice', async () => {
    const accepted = (await specs.register(gc, projectId)).find((r) => r.status === 'accepted')!
    await expect(specs.accept(gc, accepted.id)).rejects.toBeInstanceOf(ValidationError)
  })

  it('records a rejection rather than deleting the line', async () => {
    const register = await specs.register(gc, projectId)
    const productData = register.find((r) => r.submittalType === 'Product Data')!
    await specs.reject(gc, productData.id)

    // Kept, because "we decided this one was not required" is the answer to a
    // question somebody asks four months later.
    const after = (await specs.register(gc, projectId)).find((r) => r.id === productData.id)
    expect(after?.status).toBe('rejected')
  })
})

describe('who may work the register', () => {
  it('lets a trade partner read it and decide nothing', async () => {
    const register = await specs.register(trade, projectId)
    expect(register.length).toBeGreaterThan(0)

    const open = register.find((r) => r.status === 'proposed')!
    await expect(specs.accept(trade, open.id)).rejects.toBeInstanceOf(PermissionDeniedError)
    await expect(
      specs.addSection(trade, { bookId: '00000000-0000-0000-0000-000000000000', number: 'x', title: 'x', body: 'x' }),
    ).rejects.toThrow()
  })
})
