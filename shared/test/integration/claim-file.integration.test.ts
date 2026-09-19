import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { ClaimFileService, renderClaimFile } from '../../src/contracts/claim-file.js'
import { NoticeDraftService, TemplateNoticeDrafter, type NoticeDraftProvider } from '../../src/contracts/notice-drafter.js'
import { ClockEngine } from '../../src/contracts/clock-engine.js'
import { ContractService } from '../../src/contracts/documents.js'
import { ObligationService } from '../../src/contracts/obligations.js'
import { createPool, withTenant } from '../../src/db.js'
import { RecordKernel, type Actor } from '../../src/kernel.js'
import {
  addProjectMember,
  createOrganization,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
} from '../../src/provisioning.js'
import { clearRecordTypeCache } from '../../src/repositories/record-types.js'
import { ScheduleService } from '../../src/schedule/service.js'

/**
 * The file a dispute is decided on.
 *
 * Construction disputes are not decided on who was right. They are decided on
 * who can show, eighteen months later, what happened and when they said so.
 * Today that file is assembled by a project engineer under deposition
 * pressure, out of email and a phone that has been wiped, and most of it
 * cannot be assembled at all.
 *
 * So the test is the whole chain, assembled from what the job recorded while
 * it was happening, and then the thing that matters almost as much: whether
 * the file is honest about what it does not have.
 */

const CONTRACT = [
  'ARTICLE 4  NOTICE',
  '',
  '4.7.1 If the Contractor encounters concealed conditions differing materially from those',
  'indicated in the Contract Documents, the Contractor shall give written notice to the Owner',
  'within five days after the first observance of the conditions.',
  '',
  '4.7.2 Failure to give notice shall constitute a waiver of any claim.',
].join('\n')

const tab = (...cells: string[]): string => cells.join('\t')
const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

let pool: Pool
let kernel: RecordKernel
let claims: ClaimFileService
let tenantId: string
let projectId: string
let pm: Actor
let sub: Actor
let clockId: string
let noticeRecordId: string
let observationId: string

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  kernel = new RecordKernel(pool)
  claims = new ClaimFileService(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Deposition Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@deposition.test', name: 'Dee Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const trades = await createOrganization(tx, tenantId, {
      name: 'Delta Excavation',
      kind: 'specialty_contractor',
      trade: 'Earthwork',
    })
    const pmId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@deposition.test',
      name: 'Pia Marsh',
      companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Employee'),
    })
    const subId = await createUser(tx, tenantId, {
      organizationId: trades,
      email: 'pm@delta.test',
      name: 'Dana Ruiz',
      companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Collaborator'),
    })
    projectId = await createProject(tx, tenantId, { number: '26-051', name: 'Mercy Tower' })
    await addProjectMember(tx, tenantId, { projectId, userId: pmId, permissionTemplateName: 'Project Manager' })
    await addProjectMember(tx, tenantId, { projectId, userId: subId, permissionTemplateName: 'Trade Partner' })
    pm = { tenantId, userId: pmId }
    sub = { tenantId, userId: subId }
  })

  const contracts = new ContractService(pool)
  const obligations = new ObligationService(pool)
  const schedule = new ScheduleService(pool)
  const engine = new ClockEngine(pool)

  const doc = await contracts.createDocument(pm, { projectId, kind: 'prime_contract', title: 'Owner Prime Contract' })
  await contracts.segmentDocument(pm, doc.id, CONTRACT)
  const clause = (await contracts.clauses(pm, doc.id)).find((c) => c.clauseNumber === '4.7.1')!
  await contracts.setCalendar(pm, projectId, { workDays: [1, 2, 3, 4, 5], timeZone: 'America/Denver' })

  await obligations.propose(pm, doc.id, [
    {
      clauseId: clause.id,
      quote: 'give written notice to the Owner within five days after the first observance',
      obligationType: 'differing_site_conditions',
      obligorParty: 'our_org',
      obligeeParty: 'counterparty',
      triggerMatch: { type_key: 'observation', event: 'record.created' },
      triggerDescription: 'A concealed condition differing from the documents was observed',
      durationValue: 5,
      durationUnit: 'days',
      deadlineBasis: 'from_awareness',
      consequence: 'waiver_of_claim',
    },
  ])
  const [proposed] = await obligations.list(pm, { documentId: doc.id })
  await obligations.accept(pm, proposed!.id)

  await schedule.importXer(pm, {
    projectId,
    name: 'Update 4',
    text: [
      tab('ERMHDR', '18.8.0', '2026-03-02', 'Project', 'admin', 'P6'),
      tab('%T', 'PROJECT'),
      tab('%F', 'proj_id', 'day_hr_cnt', 'last_recalc_date'),
      tab('%R', '100', '8', '2026-03-02 00:00'),
      tab('%T', 'TASK'),
      tab('%F', 'task_id', 'task_code', 'task_name', 'task_type', 'early_start_date', 'total_float_hr_cnt'),
      tab('%R', '1', 'A2000', 'Pour north footings', 'TT_Task', `${inDays(6)} 08:00`, '24'),
      tab('%E'),
    ].join('\n'),
  })

  // The condition, as the field actually reports it.
  const observation = await kernel.create(pm, {
    projectId,
    typeKey: 'observation',
    title: 'Buried concrete obstruction at the north footing',
    body: { description: 'Not on any drawing we hold. Excavation stopped at 07:20.' },
  })
  observationId = observation.record.id

  // A capture behind it, which is the evidence nobody else can produce.
  await withTenant(pool, tenantId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO captures (tenant_id, project_id, captured_by, kind, text, captured_at, latitude, longitude)
            VALUES ($1, $2, $3, 'photo', 'Concrete obstruction, north footing, tape shows 1.2m below grade.',
                    now() - interval '2 days', 39.742043, -104.991531)
         RETURNING id`,
      [tenantId, projectId, pm.userId],
    )
    await tx.query(
      `INSERT INTO capture_proposals (tenant_id, capture_id, project_id, type_key, title, status, record_id, decided_by, decided_at)
            VALUES ($1, $2, $3, 'observation', 'Buried concrete obstruction', 'accepted', $4, $5, now())`,
      [tenantId, rows[0]!.id, projectId, observationId, pm.userId],
    )
  })

  await schedule.link(pm, { recordId: observationId, activityCode: 'A2000', kind: 'blocks' })
  await kernel.comment(pm, observationId, 'Called the owner rep at 08:05. They are sending their geotech.')

  await engine.fire()

  const { rows } = await pool.query('SELECT id, notice_record_id FROM obligation_clocks WHERE project_id = $1', [
    projectId,
  ])
  clockId = rows[0]!.id
  noticeRecordId = rows[0]!.notice_record_id
})

afterAll(async () => {
  await pool.end()
  clearRecordTypeCache()
})

describe('assembling the file', () => {
  it('carries the clause as printed, with the words the deadline rested on', async () => {
    const file = await claims.assemble(pm, clockId)

    expect(file.citation!.clauseNumber).toBe('4.7.1')
    expect(file.citation!.quote).toContain('within five days after the first observance')
    // The clause in full, not a summary of it. A claim file that paraphrases
    // the contract is one the other side reads the contract against.
    expect(file.citation!.clauseText).toContain('concealed conditions')
  })

  it('shows the arithmetic that produced the deadline', async () => {
    const file = await claims.assemble(pm, clockId)
    expect(Array.isArray(file.computation!['steps'])).toBe(true)
    expect(file.computation!['timeZone']).toBe('America/Denver')
  })

  it('produces the evidence nobody else can produce', async () => {
    const file = await claims.assemble(pm, clockId)

    expect(file.evidence.items).toHaveLength(1)
    const photo = file.evidence.items[0]!
    // Timestamped, located, and attributed to a person. That is a stronger
    // position than any reconstruction made eighteen months later.
    expect(photo.kind).toBe('photo')
    expect(photo.latitude).toBe('39.742043')
    expect(photo.capturedBy).toBe('Pia Marsh')
    expect(file.evidence.gap).toBeNull()
  })

  it('quantifies the delay in days of float, against a named schedule', async () => {
    const file = await claims.assemble(pm, clockId)

    const impact = file.scheduleImpact.items[0]!
    expect(impact.activityName).toBe('Pour north footings')
    expect(Number(impact.totalFloatDays)).toBe(3)
    // Which schedule, and as of when. "Three days of float" with no data date
    // is a number the other side's scheduler will take apart.
    expect(impact.scheduleName).toBe('Update 4')
    expect(impact.dataDate).toBe('2026-03-02')
  })

  it('carries the chronology and what people said at the time', async () => {
    const file = await claims.assemble(pm, clockId)

    expect(file.chronology.items.length).toBeGreaterThan(0)
    expect(file.correspondence.items[0]!.body).toContain('Called the owner rep at 08:05')
    expect(file.correspondence.items[0]!.author).toBe('Pia Marsh')
  })
})

describe('being honest about the holes', () => {
  it('leads with what is missing, before anything else', async () => {
    const file = await claims.assemble(pm, clockId)

    // Nothing has been served yet, and that is the first thing counsel will
    // ask. A file that buries it is a file whose holes get found by the other
    // side instead.
    expect(file.gaps[0]).toMatch(/not issued|Nothing was served/)

    const rendered = renderClaimFile(file)
    const missingAt = rendered.indexOf('## What is missing')
    const evidenceAt = rendered.indexOf('## The evidence')
    expect(missingAt).toBeGreaterThan(-1)
    expect(missingAt).toBeLessThan(evidenceAt)
  })

  it('stops flagging the notice once it is actually served', async () => {
    await kernel.transition(pm, noticeRecordId, {
      transitionKey: 'draft',
      body: { addressed_to: 'Mercy Health, attn. Owner Representative' },
    })
    await kernel.transition(pm, noticeRecordId, { transitionKey: 'review' })
    await kernel.transition(pm, noticeRecordId, {
      transitionKey: 'issue',
      body: { delivery_method: 'Certified Mail', delivered_on: inDays(-1), proof_of_delivery: 'USPS 9400 1000 0000' },
    })

    const file = await claims.assemble(pm, clockId)
    expect(file.notice!.status).toBe('issued')
    expect(file.notice!.proofOfDelivery).toBe('USPS 9400 1000 0000')
    expect(file.gaps.join(' ')).not.toMatch(/Nothing was served|not issued/)
  })

  it('says plainly when a record was typed rather than captured', async () => {
    const typed = await kernel.create(pm, {
      projectId,
      typeKey: 'observation',
      title: 'Second obstruction, east side',
      body: { description: 'Same as the first.' },
    })
    await new ClockEngine(pool).fire()

    const { rows } = await pool.query(
      'SELECT id FROM obligation_clocks WHERE triggering_record_id = $1',
      [typed.record.id],
    )
    const file = await claims.assemble(pm, rows[0]!.id)

    expect(file.evidence.items).toHaveLength(0)
    expect(file.gaps.join(' ')).toMatch(/typed rather than captured/)
    expect(file.gaps.join(' ')).toMatch(/cannot be quantified in days/)
  })
})

describe('who may assemble one', () => {
  it('refuses a sub the file for an instrument they are not a party to', async () => {
    // Every trade partner holds `contracts: read_only` so they can read their
    // own subcontract. Stopping at the level would have let a sub assemble
    // the full file for a clause of the PRIME, clause text included: exactly
    // the leak the instrument list already refuses, through a side door.
    await expect(claims.assemble(sub, clockId)).rejects.toThrow(/claim file/)
  })

  it('gives a sub the file for the instrument they signed', async () => {
    const contracts = new ContractService(pool)
    const obligations = new ObligationService(pool)
    const engine = new ClockEngine(pool)

    const subOrgId = await withTenant(pool, tenantId, async (tx) => {
      const { rows } = await tx.query<{ organization_id: string }>(
        'SELECT organization_id FROM users WHERE tenant_id = $1 AND id = $2',
        [tenantId, sub.userId],
      )
      return rows[0]!.organization_id
    })

    const theirs = await contracts.createDocument(pm, {
      projectId,
      kind: 'subcontract',
      title: 'Delta Excavation Subcontract',
      counterpartyOrgId: subOrgId,
    })
    await contracts.segmentDocument(pm, theirs.id, CONTRACT)
    const clause = (await contracts.clauses(pm, theirs.id)).find((c) => c.clauseNumber === '4.7.1')!

    await obligations.propose(pm, theirs.id, [
      {
        clauseId: clause.id,
        quote: 'give written notice to the Owner within five days after the first observance',
        obligationType: 'differing_site_conditions',
        obligorParty: 'counterparty',
        obligeeParty: 'our_org',
        triggerMatch: { type_key: 'daily_log', event: 'record.created' },
        triggerDescription: 'A concealed condition was observed by the subcontractor',
        durationValue: 5,
        durationUnit: 'days',
        deadlineBasis: 'from_occurrence',
      },
    ])
    const [proposal] = await obligations.list(pm, { documentId: theirs.id })
    await obligations.accept(pm, proposal!.id)

    await kernel.create(pm, {
      projectId,
      typeKey: 'daily_log',
      title: 'Obstruction reported by Delta',
      body: { log_date: inDays(0), work_performed: 'Excavation halted at the north footing.' },
    })
    await engine.fire()

    const { rows } = await pool.query(
      `SELECT k.id FROM obligation_clocks k
         JOIN contract_obligations o ON o.id = k.obligation_id
        WHERE o.document_id = $1`,
      [theirs.id],
    )
    // Their own paper, so their own file. Being a party to the instrument is
    // the right to read it.
    const file = await claims.assemble(sub, rows[0]!.id)
    expect(file.citation!.clauseNumber).toBe('4.7.1')
  })
})

describe('the document itself', () => {
  it('renders something a person can hand to counsel', async () => {
    const rendered = renderClaimFile(await claims.assemble(pm, clockId))

    expect(rendered).toContain('# Claim file — 26-051 Mercy Tower')
    expect(rendered).toContain('## The clause relied on')
    expect(rendered).toContain('> give written notice to the Owner within five days')
    expect(rendered).toContain('Pour north footings')
    expect(rendered).toContain('USPS 9400 1000 0000')
    expect(rendered).toContain('39.742043')
    // Markdown on purpose: it survives email, it diffs, and it prints.
    expect(rendered).not.toContain('undefined')
    expect(rendered).not.toContain('[object Object]')
  })
})

describe('photographs as evidence', () => {
  it('puts a photograph linked by hand in the file alongside the captures', async () => {
    const { PhotoService } = await import('../../src/photos/service.js')
    const { FilesystemBlobStore } = await import('../../src/storage/filesystem.js')
    const photos = new PhotoService(pool, new FilesystemBlobStore(`/tmp/plumbline-claim-photos-${Date.now()}`))

    const { photo } = await photos.upload(pm, {
      projectId,
      filename: 'obstruction.jpg',
      contentType: 'image/jpeg',
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 5, 5, 5, 5]),
      caption: 'Concrete obstruction at the north footing',
    })
    await photos.linkToRecord(pm, photo.id, observationId)

    const file = await claims.assemble(pm, clockId)
    const captions = file.evidence.items.map((i) => i.text).join(' ')
    expect(captions).toContain('Concrete obstruction at the north footing')
    // No timestamp from the camera, and the file says so rather than letting
    // a reader assume the upload time is when the photograph was taken.
    expect(captions).toMatch(/no timestamp from the camera/)
  })
})

describe('drafting the letter', () => {
  it('writes a notice that quotes the clause and claims nothing', async () => {
    const drafter = new NoticeDraftService(pool, new TemplateNoticeDrafter())
    const drafted = await drafter.draft(pm, clockId)

    // Quoted, never characterised. The reader checks it against their own
    // copy and finds it identical, which is the point.
    expect(drafted.body).toContain('give written notice to the Owner within five days after the first observance')
    expect(drafted.body).toContain('Mercy Tower')
    expect(drafted.body).toContain('Pia Marsh')
    // The evidence, with its timestamp and where it was taken.
    expect(drafted.body).toContain('39.742043')
    // The activity it affects, with the float as the schedule has it.
    expect(drafted.body).toContain('Pour north footings')

    // Rights reserved, nothing claimed. What to ask for is a commercial
    // decision a person makes, and a draft that filled in a number would be
    // making it for them.
    expect(drafted.body).toMatch(/reserve all rights/)
    expect(drafted.body).not.toMatch(/\$[0-9]/)
    // And no legal conclusions anywhere.
    expect(drafted.body).not.toMatch(/in breach|liable|entitled to compensation/i)
  })

  it('leaves the record exactly where it was', async () => {
    const drafter = new NoticeDraftService(pool, new TemplateNoticeDrafter())
    const before = await kernel.get(pm, noticeRecordId)
    await drafter.draft(pm, clockId)
    const after = await kernel.get(pm, noticeRecordId)

    // The body changed; the state did not. Advancing it here would turn "the
    // agent drafted a notice" into "the agent decided a notice was
    // warranted", and those are different products.
    expect(after.record.status).toBe(before.record.status)
    expect(after.record.body['description']).toContain('This is written notice under clause 4.7.1')
  })

  it('names what it could not say rather than filling the gap', async () => {
    const drafter = new NoticeDraftService(pool, new TemplateNoticeDrafter())

    const typed = await kernel.create(pm, {
      projectId,
      typeKey: 'observation',
      title: 'Third obstruction, west side',
      body: { description: 'Same again.' },
    })
    await new ClockEngine(pool).fire()
    const { rows } = await pool.query('SELECT id FROM obligation_clocks WHERE triggering_record_id = $1', [
      typed.record.id,
    ])

    const drafted = await drafter.draft(pm, rows[0]!.id)
    expect(drafted.missing.join(' ')).toMatch(/Contemporaneous evidence/)
    // And the letter says nothing about evidence it does not have.
    expect(drafted.body).not.toMatch(/evidenced by the following/)
  })

  it('throws away a draft that states a legal conclusion, whoever wrote it', async () => {
    // The seam exists so a customer can swap the drafter, so a rule only the
    // shipped provider honours is one the next provider breaks silently. The
    // service enforces it.
    const reckless: NoticeDraftProvider = {
      name: 'reckless',
      async draft(request) {
        const base = await new TemplateNoticeDrafter().draft(request)
        return { ...base, body: `${base.body}\n\nYou are in breach of the Contract and are liable for the delay.` }
      },
    }
    const drafted = await new NoticeDraftService(pool, reckless).draft(pm, clockId)

    expect(drafted.body).not.toMatch(/in breach/i)
    expect(drafted.missing.join(' ')).toMatch(/legal conclusion/)
    // And what landed on the record is the safe version, not the one that was
    // thrown away.
    const saved = await kernel.get(pm, noticeRecordId)
    expect(String(saved.record.body['description'])).not.toMatch(/in breach/i)
  })

  it('refuses a draft that no longer quotes the clause verbatim', async () => {
    // A drafter that tidied the quote has produced a misquotation of a
    // contract inside a legal document.
    const tidier: NoticeDraftProvider = {
      name: 'tidier',
      async draft(request) {
        const base = await new TemplateNoticeDrafter().draft(request)
        return { ...base, body: base.body.replace('within five days', 'within 5 days') }
      },
    }
    await expect(new NoticeDraftService(pool, tidier).draft(pm, clockId)).rejects.toThrow(/verbatim/)
  })

  it('refuses somebody who may not raise a notice', async () => {
    const drafter = new NoticeDraftService(pool, new TemplateNoticeDrafter())
    await expect(drafter.draft(sub, clockId)).rejects.toThrow()
  })
})
