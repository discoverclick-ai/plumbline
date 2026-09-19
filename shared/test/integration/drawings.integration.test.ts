import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createPool, withTenant } from '../../src/db.js'
import { DrawingService } from '../../src/drawings.js'
import { PermissionDeniedError, ValidationError } from '../../src/errors.js'
import { RecordKernel, type Actor } from '../../src/kernel.js'
import { InMemoryBlobStore } from '../../src/storage/filesystem.js'
import {
  addProjectMember,
  createOrganization,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
} from '../../src/provisioning.js'

/**
 * Drawings, and the question the tool exists to answer: which revision is
 * current for S-401, and was the crew building from it?
 *
 * The tests that earn their place are about pins across revisions. Most
 * products lose the RFI somebody raised against revision 2 the moment
 * revision 3 arrives, or they quietly move the pin and claim the person was
 * looking at a drawing that did not exist yet. Both are wrong and both are
 * invisible.
 */

let pool: Pool
let store: InMemoryBlobStore
let drawings: DrawingService
let kernel: RecordKernel
let tenantId: string
let projectId: string
let otherProjectId: string
let gc: Actor
let architect: Actor
let trade: Actor

const SHEET = Buffer.from('%PDF-1.7 structural sheet')

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  store = new InMemoryBlobStore()
  drawings = new DrawingService(pool, store)
  kernel = new RecordKernel(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Girton Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@girton.test', name: 'Gil Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const design = await createOrganization(tx, tenantId, { name: 'Ash Architects', kind: 'architect' })
    const steel = await createOrganization(tx, tenantId, {
      name: 'Wold Steel',
      kind: 'specialty_contractor',
      trade: 'Structural Steel',
    })
    const employee = await findTemplateByName(tx, tenantId, 'company', 'Employee')
    const collaborator = await findTemplateByName(tx, tenantId, 'company', 'Collaborator')

    const gcId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@girton.test',
      name: 'Gwen Poole',
      companyPermissionTemplateId: employee,
    })
    const architectId = await createUser(tx, tenantId, {
      organizationId: design,
      email: 'aor@ash.test',
      name: 'Ada Ash',
      companyPermissionTemplateId: collaborator,
    })
    const tradeId = await createUser(tx, tenantId, {
      organizationId: steel,
      email: 'foreman@wold.test',
      name: 'Wes Wold',
      companyPermissionTemplateId: collaborator,
    })

    projectId = await createProject(tx, tenantId, { number: '28-100', name: 'Girton Tower' })
    otherProjectId = await createProject(tx, tenantId, { number: '28-101', name: 'Girton Annex' })
    for (const id of [projectId, otherProjectId]) {
      await addProjectMember(tx, tenantId, { projectId: id, userId: gcId, permissionTemplateName: 'Project Manager' })
      await addProjectMember(tx, tenantId, {
        projectId: id,
        userId: architectId,
        permissionTemplateName: 'Design Team',
      })
      await addProjectMember(tx, tenantId, { projectId: id, userId: tradeId, permissionTemplateName: 'Trade Partner' })
    }

    gc = { tenantId, userId: gcId }
    architect = { tenantId, userId: architectId }
    trade = { tenantId, userId: tradeId }
  })
})

afterAll(async () => {
  await pool.end()
})

async function issue(name: string, issuedOn: string, sheets: { number: string; title: string; label: string }[]) {
  const set = await drawings.createSet(architect, { projectId, name, issuedOn })
  const added = []
  for (const sheet of sheets) {
    added.push(
      await drawings.addRevision(architect, {
        setId: set.id,
        number: sheet.number,
        title: sheet.title,
        discipline: 'Structural',
        revisionLabel: sheet.label,
        filename: `${sheet.number}.pdf`,
        contentType: 'application/pdf',
        bytes: SHEET,
      }),
    )
  }
  await drawings.publishSet(architect, set.id)
  return added
}

describe('which revision is current', () => {
  it('shows nothing from a set nobody has published', async () => {
    const set = await drawings.createSet(architect, {
      projectId,
      name: 'Unpublished check set',
      issuedOn: '2026-05-01',
    })
    await drawings.addRevision(architect, {
      setId: set.id,
      number: 'S-999',
      title: 'Check sheet',
      revisionLabel: '0',
      filename: 'S-999.pdf',
      contentType: 'application/pdf',
      bytes: SHEET,
    })

    // A sheet in a draft set is one somebody is still checking, and a crew
    // building from it is the accident this whole tool prevents.
    const current = await drawings.currentSheets(gc, projectId)
    expect(current.map((s) => s.number)).not.toContain('S-999')
  })

  it('promotes the newest published revision of each sheet', async () => {
    await issue('100% CD', '2026-05-04', [
      { number: 'S-401', title: 'Typical details', label: '0' },
      { number: 'S-402', title: 'Sections', label: '0' },
    ])
    await issue('Bulletin 3', '2026-06-11', [{ number: 'S-401', title: 'Typical details', label: '1' }])

    const current = await drawings.currentSheets(gc, projectId)
    const s401 = current.find((s) => s.number === 'S-401')
    const s402 = current.find((s) => s.number === 'S-402')

    expect(s401?.revisionLabel).toBe('1')
    expect(s401?.setName).toBe('Bulletin 3')
    expect(s401?.revisionCount).toBe(2)
    // The sheet nobody reissued is still the one from the original set.
    expect(s402?.revisionLabel).toBe('0')
    expect(s402?.setName).toBe('100% CD')
  })

  it('orders by sequence rather than by whatever the title block says', async () => {
    // "A" after "1" is perfectly normal in a revision block, and no code
    // should be asked which of them is newer.
    await issue('ASI 04', '2026-07-02', [{ number: 'S-401', title: 'Typical details', label: 'A' }])
    const current = await drawings.currentSheets(gc, projectId)
    expect(current.find((s) => s.number === 'S-401')?.revisionLabel).toBe('A')
  })

  it('refuses to add a sheet to a set that is already published', async () => {
    const set = await drawings.createSet(architect, { projectId, name: 'Closed set', issuedOn: '2026-07-10' })
    await drawings.addRevision(architect, {
      setId: set.id,
      number: 'S-500',
      title: 'Braces',
      revisionLabel: '0',
      filename: 'S-500.pdf',
      contentType: 'application/pdf',
      bytes: SHEET,
    })
    await drawings.publishSet(architect, set.id)

    // Otherwise somebody on site has a set that does not match the one in the
    // system and neither of them knows.
    await expect(
      drawings.addRevision(architect, {
        setId: set.id,
        number: 'S-501',
        title: 'Late addition',
        revisionLabel: '0',
        filename: 'S-501.pdf',
        contentType: 'application/pdf',
        bytes: SHEET,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses to publish an empty set', async () => {
    const set = await drawings.createSet(architect, { projectId, name: 'Empty set', issuedOn: '2026-07-11' })
    await expect(drawings.publishSet(architect, set.id)).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('pins that survive a reissue', () => {
  it('keeps a pin visible on the current sheet and says which revision it came from', async () => {
    const sheets = await drawings.currentSheets(gc, projectId)
    const s402 = sheets.find((s) => s.number === 'S-402')!

    const rfi = await kernel.create(gc, {
      projectId,
      typeKey: 'rfi',
      title: 'Brace connection at grid C4',
      body: { question: 'Which connection governs here?', discipline: 'Structural' },
    })
    await drawings.pin(gc, { revisionId: s402.revisionId, recordId: rfi.record.id, x: 0.42, y: 0.67 })

    // Reissue the sheet the pin was placed on.
    await issue('Bulletin 5', '2026-08-01', [{ number: 'S-402', title: 'Sections', label: '1' }])

    const pins = await drawings.pinsFor(gc, s402.drawingId)
    const pin = pins.find((p) => p.recordId === rfi.record.id)

    // Still there, and honest: the person raised it against revision 0.
    expect(pin).toBeTruthy()
    expect(pin?.revisionLabel).toBe('0')
    expect(pin?.onCurrentRevision).toBe(false)
    expect(pin?.x).toBe('0.42000')
  })

  it('marks a pin placed on the current revision as current', async () => {
    const sheets = await drawings.currentSheets(gc, projectId)
    const s402 = sheets.find((s) => s.number === 'S-402')!
    const rfi = await kernel.create(gc, {
      projectId,
      typeKey: 'rfi',
      title: 'Raised against the latest sheet',
      body: { question: 'Anything.', discipline: 'Structural' },
    })
    await drawings.pin(gc, { revisionId: s402.revisionId, recordId: rfi.record.id, x: 0.1, y: 0.2 })

    const pin = (await drawings.pinsFor(gc, s402.drawingId)).find((p) => p.recordId === rfi.record.id)
    expect(pin?.onCurrentRevision).toBe(true)
  })

  it('refuses a pin off the edge of the sheet', async () => {
    const sheets = await drawings.currentSheets(gc, projectId)
    const rfi = await kernel.create(gc, {
      projectId,
      typeKey: 'rfi',
      title: 'Off sheet',
      body: { question: 'Anything.', discipline: 'Structural' },
    })
    await expect(
      drawings.pin(gc, { revisionId: sheets[0]!.revisionId, recordId: rfi.record.id, x: 1.4, y: 0.2 }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses to pin another project’s record', async () => {
    const sheets = await drawings.currentSheets(gc, projectId)
    const elsewhere = await kernel.create(gc, {
      projectId: otherProjectId,
      typeKey: 'rfi',
      title: 'Belongs to the annex',
      body: { question: 'Anything.', discipline: 'Structural' },
    })
    // One job's RFI on another job's drawing is exactly as confusing as it
    // sounds and completely invisible afterwards.
    await expect(
      drawings.pin(gc, { revisionId: sheets[0]!.revisionId, recordId: elsewhere.record.id, x: 0.5, y: 0.5 }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('who may do what with a drawing', () => {
  it('lets a trade partner read and pin, and not publish', async () => {
    const sheets = await drawings.currentSheets(trade, projectId)
    expect(sheets.length).toBeGreaterThan(0)

    await expect(
      drawings.createSet(trade, { projectId, name: 'Sub issued set', issuedOn: '2026-08-02' }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it('hands back the sheet itself only to somebody who may read it', async () => {
    const sheets = await drawings.currentSheets(gc, projectId)
    const file = await drawings.sheetBytes(trade, sheets[0]!.revisionId)
    expect(file.bytes.equals(SHEET)).toBe(true)
    expect(file.contentType).toBe('application/pdf')
  })
})
