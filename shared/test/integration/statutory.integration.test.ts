import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { StatutoryService } from '../../src/contracts/statutory.js'
import { createPool, withTenant } from '../../src/db.js'
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
