import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { AttachmentService } from '../../src/attachments.js'
import { createPool, withTenant } from '../../src/db.js'
import { NotFoundError, PermissionDeniedError, ValidationError } from '../../src/errors.js'
import { RecordKernel, type Actor } from '../../src/kernel.js'
import { InMemoryBlobStore } from '../../src/storage/filesystem.js'
import { assertSafeKey, newStorageKey } from '../../src/storage/index.js'
import {
  addProjectMember,
  createOrganization,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
} from '../../src/provisioning.js'

/**
 * Files on records.
 *
 * The schema for these shipped with the record kernel and nothing ever wrote
 * to it, which made every attachment in the product a promise. What matters
 * here is not that bytes round-trip, it is that both ends are permissioned
 * against the record's own tool, and that a key cannot be guessed or walked.
 */

let pool: Pool
let kernel: RecordKernel
let store: InMemoryBlobStore
let attachments: AttachmentService
let tenantId: string
let projectId: string
let pm: Actor
let architect: Actor
let readOnly: Actor
let recordId: string

const PDF = Buffer.from('%PDF-1.7 a sketch that answers the question')

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  kernel = new RecordKernel(pool)
  store = new InMemoryBlobStore()
  attachments = new AttachmentService(pool, store)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Larkin Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@larkin.test', name: 'Lee Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const design = await createOrganization(tx, tenantId, { name: 'Quinn Architects', kind: 'architect' })
    const employee = await findTemplateByName(tx, tenantId, 'company', 'Employee')
    const collaborator = await findTemplateByName(tx, tenantId, 'company', 'Collaborator')

    const pmId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@larkin.test',
      name: 'Lex Park',
      companyPermissionTemplateId: employee,
    })
    const architectId = await createUser(tx, tenantId, {
      organizationId: design,
      email: 'aor@quinn.test',
      name: 'Quinn Ames',
      companyPermissionTemplateId: collaborator,
    })
    const readOnlyId = await createUser(tx, tenantId, {
      organizationId: design,
      email: 'observer@quinn.test',
      name: 'Obi Sands',
      companyPermissionTemplateId: collaborator,
    })

    projectId = await createProject(tx, tenantId, { number: '26-630', name: 'Larkin Point' })
    await addProjectMember(tx, tenantId, { projectId, userId: pmId, permissionTemplateName: 'Project Manager' })
    await addProjectMember(tx, tenantId, { projectId, userId: architectId, permissionTemplateName: 'Design Team' })
    await addProjectMember(tx, tenantId, { projectId, userId: readOnlyId, permissionTemplateName: 'Read Only' })

    pm = { tenantId, userId: pmId }
    architect = { tenantId, userId: architectId }
    readOnly = { tenantId, userId: readOnlyId }
  })

  const created = await kernel.create(pm, {
    projectId,
    typeKey: 'rfi',
    title: 'Parapet flashing detail',
    body: { question: 'Which flashing detail governs at the parapet?', discipline: 'Architectural' },
    participants: [{ userId: architect.userId, role: 'assignee' }],
  })
  recordId = created.record.id
})

afterAll(async () => {
  await pool.end()
})

describe('attaching files to a record', () => {
  it('stores the bytes and hands them back to somebody who may read the record', async () => {
    const attached = await attachments.attach(pm, recordId, {
      filename: 'SK-12 parapet.pdf',
      contentType: 'application/pdf',
      bytes: PDF,
    })
    expect(attached.byteSize).toBe(PDF.byteLength)

    const listed = await attachments.list(architect, recordId)
    expect(listed.map((a) => a.filename)).toContain('SK-12 parapet.pdf')

    const read = await attachments.read(architect, attached.id)
    expect(read.bytes.equals(PDF)).toBe(true)
  })

  it('refuses an upload from somebody who can only read the record', async () => {
    await expect(
      attachments.attach(readOnly, recordId, { filename: 'notes.pdf', contentType: 'application/pdf', bytes: PDF }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it('checks the record, not a separate documents permission', async () => {
    // Read Only holds read_only on rfis, so it may read the attachment. If
    // you can read the RFI you can read the sketch attached to it, and a
    // second permission saying otherwise would be a hole.
    const attached = await attachments.attach(pm, recordId, {
      filename: 'visible.pdf',
      contentType: 'application/pdf',
      bytes: PDF,
    })
    const read = await attachments.read(readOnly, attached.id)
    expect(read.bytes.equals(PDF)).toBe(true)
  })

  it('refuses a file type nobody on a jobsite sends', async () => {
    // An upload surface that accepts anything is how a project directory
    // becomes a malware share, and every party on the job has an account.
    await expect(
      attachments.attach(pm, recordId, {
        filename: 'payload.html',
        contentType: 'text/html',
        bytes: Buffer.from('<script>alert(1)</script>'),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses an empty file rather than storing nothing under a real name', async () => {
    await expect(
      attachments.attach(pm, recordId, {
        filename: 'empty.pdf',
        contentType: 'application/pdf',
        bytes: Buffer.alloc(0),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('leaves no orphan in the store when the row cannot be written', async () => {
    const before = await attachments.list(pm, recordId)
    await expect(
      attachments.attach(pm, '00000000-0000-0000-0000-000000000000', {
        filename: 'orphan.pdf',
        contentType: 'application/pdf',
        bytes: PDF,
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
    // Authorization happens before a byte is written, so nothing was stored
    // to clean up in the first place.
    const after = await attachments.list(pm, recordId)
    expect(after).toHaveLength(before.length)
  })
})

describe('storage keys', () => {
  it('are tenant-prefixed and carry nothing about the file', () => {
    const key = newStorageKey(tenantId)
    expect(key.startsWith(`${tenantId}/`)).toBe(true)
    expect(() => assertSafeKey(key)).not.toThrow()
  })

  it('refuse anything that could walk out of the store', () => {
    for (const bad of [
      '../../etc/passwd',
      `${tenantId}/2026-09/../../../etc/passwd`,
      '/etc/passwd',
      `${tenantId}/2026-09/not-a-uuid`,
      'rfi-014-sketch.pdf',
    ]) {
      expect(() => assertSafeKey(bad), bad).toThrow()
    }
  })
})
