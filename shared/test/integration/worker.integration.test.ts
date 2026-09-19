import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { ClockEngine } from '../../src/contracts/clock-engine.js'
import { ContractService } from '../../src/contracts/documents.js'
import { ObligationService } from '../../src/contracts/obligations.js'
import { createPool, withTenant } from '../../src/db.js'
import { RecordKernel, type Actor } from '../../src/kernel.js'
import { RecordingMailSender } from '../../src/notifications.js'
import {
  addProjectMember,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
} from '../../src/provisioning.js'
import { clearRecordTypeCache } from '../../src/repositories/record-types.js'
import { buildPasses, describeTick, takeLock, tick, type WorkerPass } from '../../src/worker.js'

/**
 * The process nobody presses a button for.
 *
 * Four subsystems here read the event log forward and act on it, and every
 * one of them was built, tested, and left with nothing to run it. In a real
 * deployment that meant the budget never learned about an executed change,
 * nobody was ever told anything, and a notice clock counted down to a
 * deadline that arrived on no screen.
 *
 * So the test is the unattended chain: raise something on site, run a tick,
 * and find the deadline on somebody's desk without a person touching it.
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

let pool: Pool
let kernel: RecordKernel
let passes: WorkerPass[]
let tenantId: string
let projectId: string
let pm: Actor
const lines: string[] = []
const log = (line: string): void => void lines.push(line)

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  kernel = new RecordKernel(pool)
  passes = buildPasses(pool, new RecordingMailSender())

  const tenant = await provisionTenant(pool, {
    tenantName: 'Unattended Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@unattended.test', name: 'Uma Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const pmId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@unattended.test',
      name: 'Pia Marsh',
      companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Employee'),
    })
    projectId = await createProject(tx, tenantId, { number: '26-031', name: 'Unattended Yard' })
    await addProjectMember(tx, tenantId, { projectId, userId: pmId, permissionTemplateName: 'Project Manager' })
    pm = { tenantId, userId: pmId }
  })

  const contracts = new ContractService(pool)
  const obligations = new ObligationService(pool)

  const doc = await contracts.createDocument(pm, { projectId, kind: 'prime_contract', title: 'Prime' })
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
      deadlineBasis: 'from_occurrence',
      consequence: 'waiver_of_claim',
    },
  ])
  const [proposed] = await obligations.list(pm, { documentId: doc.id })
  await obligations.accept(pm, proposed!.id)
})

afterAll(async () => {
  await pool.end()
  clearRecordTypeCache()
})

describe('a tick, unattended', () => {
  it('runs every pass and says what each one did, including the quiet ones', async () => {
    const result = await tick(passes, log)

    const names = result.passes.map((p) => p.name)
    expect(names).toEqual([
      'clocks.fire',
      'clocks.promote',
      'clocks.reconcile',
      'financial.post',
      'notifications.generate',
      'notifications.deliver',
    ])
    expect(result.passes.every((p) => p.error === undefined)).toBe(true)
    // Every pass reports, whether or not it found anything. Silence looks
    // exactly like a quiet afternoon.
    expect(describeTick(result)).toContain('clocks.fire=')
    expect(describeTick(result)).toContain('notifications.deliver=')
  })

  it('takes a condition on site all the way to a deadline, with nobody clicking', async () => {
    await kernel.create(pm, {
      projectId,
      typeKey: 'observation',
      title: 'Buried concrete obstruction at the north footing',
      body: { description: 'Not on any drawing we have.' },
    })

    const first = await tick(passes, log)
    expect(first.passes.find((p) => p.name === 'clocks.fire')!.result!['started']).toBe(1)

    const { rows } = await pool.query(
      `SELECT k.state::text AS state, k.due_at, r.designation
         FROM obligation_clocks k JOIN records r ON r.id = k.notice_record_id
        WHERE k.project_id = $1`,
      [projectId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.designation).toMatch(/^NOT-/)

    // A second tick does not start it again. Idempotency is what lets this
    // run every thirty seconds forever.
    const second = await tick(passes, log)
    expect(second.passes.find((p) => p.name === 'clocks.fire')!.result!['started']).toBe(0)
  })

  it('does not let one broken pass stop the one that costs money to miss', async () => {
    const exploding: WorkerPass = {
      name: 'notifications.generate',
      run: async () => {
        throw new Error('a malformed event broke rendering')
      },
    }
    // The broken pass runs BEFORE the clock, which is the ordering that would
    // hide the bug if the loop bailed on the first throw.
    const result = await tick([exploding, ...passes], log)

    expect(result.passes[0]!.error).toMatch(/malformed event/)
    expect(result.passes.find((p) => p.name === 'clocks.promote')!.error).toBeUndefined()
    expect(lines.some((l) => l.includes('FAILED'))).toBe(true)
  })
})

describe('running alone', () => {
  it('gives the lock to one taker and refuses the second', async () => {
    const other = createPool({ connectionString: inject('databaseUrl') })
    try {
      const held = await takeLock(pool)
      expect(held).not.toBeNull()
      // A second instance must not wait: a supervisor starting three of these
      // should end up with one worker and two clean exits, not three
      // processes and a mystery.
      expect(await takeLock(other)).toBeNull()

      await held!.release()
      const second = await takeLock(other)
      expect(second).not.toBeNull()
      await second!.release()
    } finally {
      await other.end()
    }
  })

  it('releases the lock from the connection that took it, not whichever is free', async () => {
    // The pool holds several connections, so a lock taken through the pool
    // and unlocked through the pool lands on different sessions: the unlock
    // returns false, warns into a log nobody reads, and the lock stays held
    // forever. This asserts the round trip works with the pool warmed up and
    // handing out different connections.
    const busy = createPool({ connectionString: inject('databaseUrl') })
    try {
      const clients = await Promise.all([busy.connect(), busy.connect(), busy.connect()])
      for (const c of clients) c.release()

      const held = await takeLock(busy)
      expect(held).not.toBeNull()
      // Churn the pool between take and release.
      await Promise.all([busy.query('SELECT 1'), busy.query('SELECT 1'), busy.query('SELECT 1')])
      await held!.release()

      const again = await takeLock(busy)
      expect(again, 'the lock was never actually released').not.toBeNull()
      await again!.release()
    } finally {
      await busy.end()
    }
  })
})
