import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { StatutoryService } from '../../src/contracts/statutory.js'
import { createPool, withTenant } from '../../src/db.js'
import { ValidationError } from '../../src/errors.js'
import type { Actor } from '../../src/kernel.js'
import {
  addProjectMember,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
} from '../../src/provisioning.js'
import { clearRecordTypeCache } from '../../src/repositories/record-types.js'

/**
 * Lien rights, which are a different animal.
 *
 * Missing a contract deadline waives a claim you might have won. Missing a
 * statutory one removes the security for money you have already earned and
 * spent. The statute is public, the arithmetic is deterministic, and no model
 * is involved anywhere.
 *
 * Which leaves exactly one place this can go wrong: the data. A wrong
 * statutory deadline is worse than none, because a contractor will rely on it
 * and lose real money. So the property this file exists to hold is that an
 * unverified rule starts NOTHING, and that the customer is told it exists
 * anyway.
 */

let pool: Pool
let statutory: StatutoryService
let tenantId: string
let projectId: string
let pm: Actor
let ruleId: string

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  statutory = new StatutoryService(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Lien Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@lien.test', name: 'Lin Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const pmId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@lien.test',
      name: 'Perry Marsh',
      companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Employee'),
    })
    projectId = await createProject(tx, tenantId, { number: '26-061', name: 'Federal Courthouse Annex' })
    await addProjectMember(tx, tenantId, { projectId, userId: pmId, permissionTemplateName: 'Project Manager' })
    pm = { tenantId, userId: pmId }
  })

  const { rows } = await pool.query(
    `SELECT id FROM statutory_rules WHERE citation = '40 U.S.C. § 3133(b)(2)'`,
  )
  ruleId = rows[0]!.id
})

afterAll(async () => {
  await pool.end()
  clearRecordTypeCache()
})

describe('the gate', () => {
  it('ships with every rule unverified', async () => {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM statutory_rules WHERE verified_at IS NOT NULL')
    // Not caution theatre. Seeding fifty states of lien law from memory would
    // be fifty confident numbers, each one relied upon, none checked.
    expect(rows[0]!.n).toBe(0)
  })

  it('starts no clocks from an unverified rule, but says the deadline exists', async () => {
    await statutory.setFacts(pm, projectId, {
      jurisdiction: 'US-MILLER',
      projectType: 'federal',
      claimantRole: 'first_tier_subcontractor',
      lastFurnishing: '2026-03-02',
    })

    const result = await statutory.sweep(pm, projectId)

    expect(result.started).toBe(0)
    expect(await statutory.clocks(pm, projectId)).toEqual([])
    // Told, not hidden. An applicable rule nobody has verified is a deadline
    // that exists whether or not this product knows the number, and the
    // customer needs to see it.
    expect(result.unverified.map((u) => u.citation)).toContain('40 U.S.C. § 3133(b)(2)')
  })

  it('will not record a verification without a name and a date', async () => {
    await expect(
      pool.query(`UPDATE statutory_rules SET verified_by = 'somebody' WHERE id = $1`, [ruleId]),
    ).rejects.toThrow(/statutory_rules_verification_is_named/)
  })
})

describe('once counsel has signed it off', () => {
  beforeAll(async () => {
    await pool.query(
      `UPDATE statutory_rules
          SET verified_by = 'Reyes & Cole LLP', verified_at = '2026-01-15',
              verified_note = 'Confirmed against the current text.'
        WHERE id = $1`,
      [ruleId],
    )
  })

  it('starts the clock and freezes who verified it', async () => {
    const result = await statutory.sweep(pm, projectId)
    expect(result.started).toBe(1)

    const [clock] = await statutory.clocks(pm, projectId)
    expect(clock!.citation).toBe('40 U.S.C. § 3133(b)(2)')
    expect(clock!.startedOn).toBe('2026-03-02')
    expect(clock!.dueOn).toBe('2026-05-31')
    // The name goes into the frozen computation, not just the rule row. A
    // correction next year must not silently rewrite the provenance of a
    // deadline somebody already acted on.
    expect(clock!.computation['verifiedBy']).toBe('Reyes & Cole LLP')
  })

  it('says what missing it costs, in the contractor’s own terms', async () => {
    const [clock] = await statutory.clocks(pm, projectId)
    expect(clock!.consequence).toMatch(/payment bond/)
    // On federal work there is no lien to fall back on, and the copy says so
    // rather than leaving it to be inferred.
    expect(clock!.consequence).toMatch(/no mechanics lien rights against federal property/)
  })

  it('does not start the same clock twice', async () => {
    expect((await statutory.sweep(pm, projectId)).started).toBe(0)
    expect(await statutory.clocks(pm, projectId)).toHaveLength(1)
  })

  it('starts a NEW clock when the furnishing date moves, and keeps the old one', async () => {
    // The crew went back for a punch item. The old clock was real while it
    // was believed, and a deadline that silently moved is one nobody can
    // explain later.
    await statutory.setFacts(pm, projectId, {
      jurisdiction: 'US-MILLER',
      projectType: 'federal',
      claimantRole: 'first_tier_subcontractor',
      lastFurnishing: '2026-04-10',
    })
    expect((await statutory.sweep(pm, projectId)).started).toBe(1)

    const clocks = await statutory.clocks(pm, projectId)
    expect(clocks).toHaveLength(2)
    expect(clocks.map((c) => c.startedOn).sort()).toEqual(['2026-03-02', '2026-04-10'])
  })

  it('names the rules it could not start, rather than dropping them', async () => {
    const other = await withTenant(pool, tenantId, async (tx) => {
      const id = await createProject(tx, tenantId, { number: '26-062', name: 'Annex Phase 2' })
      await addProjectMember(tx, tenantId, { projectId: id, userId: pm.userId, permissionTemplateName: 'Project Manager' })
      return id
    })

    await statutory.setFacts(pm, other, {
      jurisdiction: 'US-MILLER',
      projectType: 'federal',
      claimantRole: 'first_tier_subcontractor',
      // No last furnishing date yet.
    })

    const result = await statutory.sweep(pm, other)
    expect(result.started).toBe(0)
    expect(result.skipped[0]!.reason).toMatch(/No date recorded for last furnishing/)
  })
})

describe('the facts', () => {
  it('insists on a jurisdiction and a place in the chain', async () => {
    // The same contractor is a GC on one job and a second tier sub on the
    // next, and the deadline is different for each. Defaulting either would
    // be guessing at the answer that matters most.
    await expect(statutory.setFacts(pm, projectId, { lastFurnishing: '2026-03-02' })).rejects.toThrow(
      /jurisdiction and a role/,
    )
  })

  it('refuses a project this person is not on', async () => {
    const stranger = await provisionTenant(pool, {
      tenantName: 'Unrelated',
      organizationKind: 'general_contractor',
      admin: { email: 'admin@unrelated-lien.test', name: 'Una', password: 'correct horse battery staple' },
    })
    await expect(
      statutory.sweep({ tenantId: stranger.tenantId, userId: stranger.adminUserId }, projectId),
    ).rejects.toThrow()
  })
})

/**
 * The three triggers the product does not witness.
 *
 * Five of the eight statutory triggers are facts about the job and the job
 * knows them. A lien recorded at the county, a notice of termination served,
 * a payment falling due under terms in a contract nobody here wrote: nothing
 * in this product sees any of those, so every rule hanging off one of them
 * was skipped with a reason the customer could not act on. Somebody records
 * them, which is the honest answer rather than the clever one.
 */
describe('the triggers somebody has to type in', () => {
  let foreclosureRuleId: string

  beforeAll(async () => {
    // No shipped rule uses an event trigger, because the shipped dataset is
    // two federal rules and both hang off last furnishing. Verified here, by
    // name and on a date, exactly as the gate demands of a real one.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO statutory_rules
         (jurisdiction, project_type, deadline_type, claimant_role, trigger, duration_value, duration_unit,
          citation, summary, consequence, verified_by, verified_at)
       VALUES ('US-MILLER', 'federal', 'lien_foreclosure', 'first_tier_subcontractor', 'lien_recorded',
               90, 'days', 'TEST-LIEN-FORECLOSURE',
               'Suit to foreclose must be brought within the window after the lien was recorded.',
               'The lien expires and the security is gone.',
               'Reyes & Cole LLP', '2026-01-15')
       RETURNING id`,
    )
    foreclosureRuleId = rows[0]!.id
  })

  afterAll(async () => {
    await pool.query('DELETE FROM statutory_clocks WHERE rule_id = $1', [foreclosureRuleId])
    await pool.query('DELETE FROM statutory_rules WHERE id = $1', [foreclosureRuleId])
  })

  it('says plainly that it has no date, rather than guessing at one', async () => {
    const result = await statutory.sweep(pm, projectId)
    const skip = result.skipped.find((s) => s.citation === 'TEST-LIEN-FORECLOSURE')
    // A guessed statutory deadline is the exact failure this subsystem
    // exists to prevent, so silence beats invention.
    expect(skip?.reason).toMatch(/No date recorded for lien recorded/)
  })

  it('starts the clock from the date the lien was recorded, not the date it was typed', async () => {
    await statutory.recordEvent(pm, projectId, {
      kind: 'lien_recorded',
      occurredOn: '2026-04-10',
      reference: 'Instrument 2026-0041882',
      note: 'Recorded with the county clerk.',
    })

    expect((await statutory.sweep(pm, projectId)).started).toBeGreaterThan(0)

    const clock = (await statutory.clocks(pm, projectId)).find((c) => c.citation === 'TEST-LIEN-FORECLOSURE')
    expect(clock?.startedOn).toBe('2026-04-10')
    expect(clock?.dueOn).toBe('2026-07-09')
    // "Why does this say the 9th of July" has to have an answer, and for a
    // trigger a person typed the answer is the thing they typed.
    expect(clock?.sourceEvent?.reference).toBe('Instrument 2026-0041882')
  })

  it('gives a second lien its own deadline', async () => {
    // A job where a lien was recorded in April and again in July has two
    // deadlines to foreclose. Flattening the kind into one column per project
    // would let the second overwrite the first, which is how a deadline that
    // was real disappears.
    await statutory.recordEvent(pm, projectId, {
      kind: 'lien_recorded',
      occurredOn: '2026-07-01',
      reference: 'Instrument 2026-0077310',
    })
    await statutory.sweep(pm, projectId)

    const clocks = (await statutory.clocks(pm, projectId)).filter((c) => c.citation === 'TEST-LIEN-FORECLOSURE')
    expect(clocks.map((c) => c.startedOn).sort()).toEqual(['2026-04-10', '2026-07-01'])
    expect(clocks.map((c) => c.dueOn).sort()).toEqual(['2026-07-09', '2026-09-29'])
  })

  it('treats two liens recorded on the same day as one deadline', async () => {
    const before = (await statutory.clocks(pm, projectId)).length
    await statutory.recordEvent(pm, projectId, {
      kind: 'lien_recorded',
      occurredOn: '2026-07-01',
      reference: 'Instrument 2026-0077311',
    })
    await statutory.sweep(pm, projectId)
    // Same date, same rule, same deadline. Two rows would be two identical
    // warnings about one thing, which is how people learn to ignore them.
    expect((await statutory.clocks(pm, projectId)).length).toBe(before)
  })

  it('treats the same lien recorded twice as a duplicate, not a second lien', async () => {
    const again = await statutory.recordEvent(pm, projectId, {
      kind: 'lien_recorded',
      occurredOn: '2026-04-10',
      reference: 'Instrument 2026-0041882',
      note: 'Recorded with the county clerk.',
    })
    const events = (await statutory.events(pm, projectId)).filter(
      (e) => e.reference === 'Instrument 2026-0041882',
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.id).toBe(again.id)
  })

  it('refuses a date that is not one', async () => {
    await expect(
      statutory.recordEvent(pm, projectId, { kind: 'payment_due', occurredOn: 'last Tuesday' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('keeps the deadline where it was when the rule is corrected later', async () => {
    // The computation is frozen on the clock. A correction to the rule next
    // year must not silently move a deadline somebody already acted on.
    await pool.query(`UPDATE statutory_rules SET duration_value = 30 WHERE id = $1`, [foreclosureRuleId])
    await statutory.sweep(pm, projectId)
    const clock = (await statutory.clocks(pm, projectId)).find(
      (c) => c.citation === 'TEST-LIEN-FORECLOSURE' && c.startedOn === '2026-04-10',
    )
    expect(clock?.dueOn).toBe('2026-07-09')
    await pool.query(`UPDATE statutory_rules SET duration_value = 90 WHERE id = $1`, [foreclosureRuleId])
  })
})
