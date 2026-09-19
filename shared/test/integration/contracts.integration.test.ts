import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
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

/**
 * From a foreman photographing standing water to a deadline on a PM's desk.
 *
 * This is the chain the whole product is for, and every link has to be
 * provable: the event that started it, the clause that imposes the window,
 * the arithmetic that reached the date, and the record that carries the ball.
 * A break anywhere and the deliverable is a report somebody reads on a
 * Friday, which is what the industry already has.
 */

const SUBCONTRACT = `
STANDARD FORM OF AGREEMENT BETWEEN CONTRACTOR AND SUBCONTRACTOR

ARTICLE 4  CLAIMS AND NOTICE

4.7.1 If the Subcontractor encounters conditions at the site which are
subsurface or otherwise concealed physical conditions which differ materially
from those indicated in the Subcontract Documents, the Subcontractor shall
give written notice to the Contractor within five days after the first
observance of the conditions, and in no event later than the commencement of
any work affected by the conditions.

4.7.2 Failure of the Subcontractor to give notice within the time required by
Section 4.7.1 shall constitute a waiver of any claim for additional cost or
time arising from the condition.

ARTICLE 9  PAYMENT

9.3.1 Applications for payment shall be submitted to the Contractor not later
than the twentieth day of each month.
`

let pool: Pool
let kernel: RecordKernel
let contracts: ContractService
let obligations: ObligationService
let engine: ClockEngine

let tenantId: string
let projectId: string
let gcPm: Actor
let sub: Actor
let subOrgId: string
let documentId: string
let clauseId: string

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  kernel = new RecordKernel(pool)
  contracts = new ContractService(pool)
  obligations = new ObligationService(pool)
  engine = new ClockEngine(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Ironvale Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@ironvale.test', name: 'Ada Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    subOrgId = await createOrganization(tx, tenantId, {
      name: 'Delta Excavation',
      kind: 'specialty_contractor',
      trade: 'Earthwork',
    })

    const pmId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@ironvale.test',
      name: 'Pat Moreno',
      companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Employee'),
    })
    const subId = await createUser(tx, tenantId, {
      organizationId: subOrgId,
      email: 'pm@delta.test',
      name: 'Dana Ruiz',
      companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Collaborator'),
    })

    projectId = await createProject(tx, tenantId, { number: '26-021', name: 'Ironvale Transit Center' })
    await addProjectMember(tx, tenantId, { projectId, userId: pmId, permissionTemplateName: 'Project Manager' })
    await addProjectMember(tx, tenantId, { projectId, userId: subId, permissionTemplateName: 'Trade Partner' })

    gcPm = { tenantId, userId: pmId }
    sub = { tenantId, userId: subId }
  })
})

afterAll(async () => {
  await pool.end()
  clearRecordTypeCache()
})

describe('the paper', () => {
  it('takes an instrument and cuts it into citable clauses', async () => {
    const doc = await contracts.createDocument(gcPm, {
      projectId,
      kind: 'subcontract',
      title: 'Delta Excavation Subcontract',
      counterpartyOrgId: subOrgId,
      executedAt: '2026-03-02',
    })
    documentId = doc.id

    const result = await contracts.segmentDocument(gcPm, documentId, SUBCONTRACT)
    expect(result.needsManualSegmentation).toBe(false)

    const clauses = await contracts.clauses(gcPm, documentId)
    const notice = clauses.find((c) => c.clauseNumber === '4.7.1')
    expect(notice).toBeDefined()
    // Verbatim, line breaks and all. The quote gate normalises whitespace
    // when it checks a citation; the stored text does not, because it is the
    // contract.
    expect(notice!.text).toContain('give written notice to the Contractor within five days after the first')
    expect(notice!.text.replace(/\s+/g, ' ')).toContain('within five days after the first observance')
    clauseId = notice!.id
  })

  it('shows a trade partner the instrument they signed', async () => {
    const theirs = await contracts.listDocuments(sub, projectId)
    expect(theirs.map((d) => d.id)).toEqual([documentId])
    // And its text, because a deadline you cannot check against the clause is
    // one you will not act on.
    const clauses = await contracts.clauses(sub, documentId)
    expect(clauses.some((c) => c.clauseNumber === '4.7.1')).toBe(true)
  })

  it('does not show them the prime', async () => {
    const prime = await contracts.createDocument(gcPm, {
      projectId,
      kind: 'prime_contract',
      title: 'Owner Prime Contract',
      executedAt: '2026-01-15',
    })

    const theirs = await contracts.listDocuments(sub, projectId)
    expect(theirs.map((d) => d.id)).not.toContain(prime.id)
    // Not "denied": not found. Telling a sub that a contract exists is itself
    // the leak, because the existence of an owner change order tells them the
    // markup on their own work.
    await expect(contracts.clauses(sub, prime.id)).rejects.toThrow(/not found|contract document/i)
  })
})

describe('the gate', () => {
  it('discards an obligation whose quote is not in the clause', async () => {
    const result = await obligations.propose(gcPm, documentId, [
      {
        clauseId,
        // Reads exactly like the contract. Says fourteen days. It is not in it.
        quote: 'the Subcontractor shall give written notice to the Contractor within fourteen days',
        obligationType: 'differing_site_conditions',
        obligorParty: 'counterparty',
        obligeeParty: 'our_org',
        triggerDescription: 'A differing site condition was observed',
        durationValue: 14,
        durationUnit: 'days',
        deadlineBasis: 'from_awareness',
      },
    ])

    expect(result.proposed).toBe(0)
    expect(result.discarded[0]!.reason).toMatch(/does not appear in the cited clause/)
  })

  it('accepts one that is, and holds it as proposed until a person says otherwise', async () => {
    const result = await obligations.propose(gcPm, documentId, [
      {
        clauseId,
        quote: 'give written notice to the Contractor within five days after the first observance of the conditions',
        obligationType: 'differing_site_conditions',
        obligorParty: 'counterparty',
        obligeeParty: 'our_org',
        triggerMatch: { type_key: 'observation', event: 'record.created' },
        triggerDescription: 'A subsurface or concealed condition differing from the documents was observed on site',
        durationValue: 5,
        durationUnit: 'days',
        deadlineBasis: 'from_awareness',
        consequence: 'waiver_of_claim',
        confidence: 0.94,
        rationale: 'Express notice window with an express waiver at 4.7.2.',
        extractedBy: 'scripted',
      },
    ])
    expect(result.proposed).toBe(1)

    const listed = await obligations.list(gcPm, { documentId });
    expect(listed).toHaveLength(1)
    expect(listed[0]!.status).toBe('proposed')

    // A proposed obligation starts no clocks. Prove it rather than assert it.
    const before = await engine.fire()
    expect(before.started).toBe(0)
  })

  it('will not let a trade partner accept an obligation against themselves', async () => {
    const [proposal] = await obligations.list(gcPm, { documentId })
    await expect(obligations.accept(sub, proposal!.id)).rejects.toThrow(/accept obligation/i)
  })
})

describe('the clock', () => {
  let obligationId: string

  it('fires when the event the clause describes actually happens', async () => {
    const [proposal] = await obligations.list(gcPm, { documentId })
    obligationId = proposal!.id
    await obligations.accept(gcPm, obligationId)

    await contracts.setCalendar(gcPm, projectId, {
      workDays: [1, 2, 3, 4, 5],
      timeZone: 'America/Denver',
      dayDefinition: 'Calendar days unless stated',
    })

    await kernel.create(gcPm, {
      projectId,
      typeKey: 'observation',
      title: 'Standing water and soft soil at the east footings',
      body: { description: 'Subgrade will not compact. Not what the geotech report shows.' },
    })

    const fired = await engine.fire()
    expect(fired.started).toBe(1)
    expect(fired.skipped).toEqual([])
  })

  it('shows its arithmetic, and carries the clause it relies on', async () => {
    const { rows } = await pool.query(
      `SELECT state::text, due_at, warn_at, computation, notice_record_id FROM obligation_clocks
        WHERE obligation_id = $1`,
      [obligationId],
    )
    const clock = rows[0]!
    expect(clock.state).toBe('watching')

    const computation = clock.computation as Record<string, unknown>
    expect(computation['duration']).toEqual({ value: 5, unit: 'days' })
    expect(computation['timeZone']).toBe('America/Denver')
    expect(computation['clauseNumber']).toBe('4.7.1')
    expect(String(computation['quote'])).toContain('within five days after the first observance')
    // A person has to be able to check this by hand, or nobody will rely on it.
    expect(Array.isArray(computation['steps'])).toBe(true)
    expect(clock.warn_at.getTime()).toBeLessThan(clock.due_at.getTime())
  })

  it('puts nobody in the court yet', async () => {
    const { rows } = await pool.query(
      `SELECT a.due_at FROM obligation_clocks k
         JOIN record_assignments a ON a.record_id = k.notice_record_id AND a.released_at IS NULL
        WHERE k.obligation_id = $1`,
      [obligationId],
    )
    // The notice exists. It has no deadline on the assignment until the clock
    // promotes, because a queue full of speculative notices is a queue that
    // gets ignored inside a week.
    expect(rows[0]!.due_at).toBeNull()
  })

  it('does not double-fire when the log is replayed', async () => {
    await pool.query('UPDATE clock_engine_cursor SET last_event_id = 0 WHERE id = 1')
    const replay = await engine.fire()
    expect(replay.started).toBe(0)

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM obligation_clocks WHERE obligation_id = $1', [
      obligationId,
    ])
    expect(rows[0]!.n).toBe(1)
  })

  it('promotes the clock into somebody’s court before it runs out', async () => {
    const { rows: before } = await pool.query('SELECT warn_at, due_at FROM obligation_clocks WHERE obligation_id = $1', [
      obligationId,
    ])
    const promoted = await engine.promote(new Date(before[0]!.warn_at.getTime() + 1000))
    expect(promoted.promoted).toBe(1)
    expect(promoted.expired).toBe(0)

    const { rows } = await pool.query(
      `SELECT k.state::text, a.due_at, a.expected_action
         FROM obligation_clocks k
         JOIN record_assignments a ON a.record_id = k.notice_record_id AND a.released_at IS NULL
        WHERE k.obligation_id = $1`,
      [obligationId],
    )
    expect(rows[0]!.state).toBe('in_court')
    expect(rows[0]!.due_at.getTime()).toBe(before[0]!.due_at.getTime())
    // In the contract's own terms, with the clause number, and without the
    // clause text: the holder needs to know what is owed, not to read the
    // indemnity language.
    expect(rows[0]!.expected_action).toContain('4.7.1')
  })

  it('records an expiry rather than tidying it away', async () => {
    const { rows: before } = await pool.query('SELECT due_at FROM obligation_clocks WHERE obligation_id = $1', [
      obligationId,
    ])
    const result = await engine.promote(new Date(before[0]!.due_at.getTime() + 1000))
    expect(result.expired).toBe(1)

    const { rows } = await pool.query('SELECT state::text FROM obligation_clocks WHERE obligation_id = $1', [
      obligationId,
    ])
    // The fact that a deadline passed unanswered is itself evidence. A system
    // that deleted it would be destroying the record of its own failure.
    expect(rows[0]!.state).toBe('expired')
  })

  it('discharges when the notice is actually served', async () => {
    const { rows } = await pool.query('SELECT notice_record_id FROM obligation_clocks WHERE obligation_id = $1', [
      obligationId,
    ])
    const recordId = rows[0]!.notice_record_id as string

    const drafted = await kernel.transition(gcPm, recordId, {
      transitionKey: 'draft',
      body: { addressed_to: 'Delta Excavation, attn. Dana Ruiz' },
    })
    expect(drafted.record.status).toBe('drafted')

    await kernel.transition(gcPm, recordId, { transitionKey: 'review' })
    await kernel.transition(gcPm, recordId, {
      transitionKey: 'issue',
      body: { delivery_method: 'Certified Mail', delivered_on: '2026-06-18' },
    })

    const reconciled = await engine.reconcile()
    expect(reconciled.satisfied).toBe(1)

    const { rows: after } = await pool.query(
      'SELECT state::text, satisfied_by_record_id FROM obligation_clocks WHERE obligation_id = $1',
      [obligationId],
    )
    expect(after[0]!.state).toBe('satisfied')
    expect(after[0]!.satisfied_by_record_id).toBe(recordId)
  })
})

describe('flow-down', () => {
  it('copies a parent’s obligations as proposals, never as accepted rows', async () => {
    const prime = await contracts.createDocument(gcPm, {
      projectId,
      kind: 'general_conditions',
      title: 'General Conditions',
    })
    await contracts.segmentDocument(gcPm, prime.id, SUBCONTRACT)
    const primeClauses = await contracts.clauses(gcPm, prime.id)
    const primeClause = primeClauses.find((c) => c.clauseNumber === '9.3.1')!

    await obligations.propose(gcPm, prime.id, [
      {
        clauseId: primeClause.id,
        quote: 'Applications for payment shall be submitted to the Contractor not later than the twentieth day',
        obligationType: 'payment_application_window',
        obligorParty: 'counterparty',
        obligeeParty: 'our_org',
        triggerKind: 'calendar_date',
        triggerDescription: 'Monthly payment application window',
        durationValue: 20,
        durationUnit: 'days',
        deadlineBasis: 'from_occurrence',
      },
    ])
    const [proposed] = await obligations.list(gcPm, { documentId: prime.id })
    await obligations.accept(gcPm, proposed!.id)

    const child = await contracts.createDocument(gcPm, {
      projectId,
      kind: 'subcontract',
      title: 'Second Tier Subcontract',
      parentDocumentId: prime.id,
    })
    const flowed = await obligations.flowDown(gcPm, child.id)
    expect(flowed.proposed).toBe(1)

    const inherited = await obligations.list(gcPm, { documentId: child.id })
    // Proposed, not accepted. Incorporation by reference is a legal reading,
    // usually one sentence with an exception list attached, and the system
    // does not make that call on its own.
    expect(inherited[0]!.status).toBe('proposed')
    expect(inherited[0]!.inheritedFromId).toBe(proposed!.id)
    // The citation still points at the clause where the term is printed.
    expect(inherited[0]!.clauseId).toBe(primeClause.id)

    // Idempotent: running it twice does not duplicate.
    expect((await obligations.flowDown(gcPm, child.id)).proposed).toBe(0)
  })
})

describe('re-segmentation', () => {
  it('refuses once obligations cite the clauses', async () => {
    await expect(contracts.segmentDocument(gcPm, documentId, SUBCONTRACT)).rejects.toThrow(
      /already has obligations citing its clauses/,
    )
  })
})
