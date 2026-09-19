import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createPool, withTenant } from '../../src/db.js'
import { NotFoundError, ValidationError } from '../../src/errors.js'
import { createProject, provisionTenant } from '../../src/provisioning.js'
import {
  addSegment,
  addSegmentValue,
  createBudgetCode,
  listBudgetCodes,
  listSegments,
  listSegmentValues,
  retireBudgetCode,
} from '../../src/wbs.js'

/**
 * The work breakdown structure.
 *
 * The one piece of this product that cannot be retrofitted, because every
 * financial row points at a budget code and an ERP sync is only possible if
 * that code decomposes into the segments the ERP already uses.
 */

let pool: Pool
let tenantId: string
let projectId: string

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  const tenant = await provisionTenant(pool, {
    tenantName: 'Ellsworth Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@ellsworth.test', name: 'El Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId
  projectId = await withTenant(pool, tenantId, (tx) =>
    createProject(tx, tenantId, { number: '26-900', name: 'Ellsworth Tower' }),
  )
})

afterAll(async () => {
  await pool.end()
})

describe('what a new company starts with', () => {
  it('has cost code and cost type, in that order, both required', async () => {
    const segments = await withTenant(pool, tenantId, (tx) => listSegments(tx, tenantId))
    expect(segments.map((s) => s.key)).toEqual(['cost_code', 'cost_type', 'sub_job'])
    expect(segments[0]?.required).toBe(true)
    expect(segments[1]?.required).toBe(true)
    // Sub job is common but not universal, so it is optional out of the box.
    expect(segments[2]?.required).toBe(false)
  })

  it('ships MasterFormat as a default rather than baking it in', async () => {
    const values = await withTenant(pool, tenantId, (tx) =>
      listSegmentValues(tx, tenantId, { segmentKey: 'cost_code' }),
    )
    expect(values.map((v) => v.code)).toContain('03 00 00')

    // And it is editable, which is the point: plenty of self-performing
    // contractors and most owners use their own chart, and a product that
    // assumes MasterFormat cannot be sold to a utility.
    await withTenant(pool, tenantId, (tx) =>
      addSegmentValue(tx, tenantId, { segmentKey: 'cost_code', code: '99 10 00', label: 'Substation Civil' }),
    )
    const after = await withTenant(pool, tenantId, (tx) =>
      listSegmentValues(tx, tenantId, { segmentKey: 'cost_code' }),
    )
    expect(after.map((v) => v.code)).toContain('99 10 00')
  })
})

describe('assembling a budget code', () => {
  it('joins one value per segment into the code that goes on paper', async () => {
    const code = await createBudgetCode(pool, tenantId, {
      projectId,
      values: { cost_code: '03 00 00', cost_type: 'L' },
    })
    expect(code.display).toBe('03 00 00.L')
    expect(code.segments.map((s) => s.segmentKey)).toEqual(['cost_code', 'cost_type'])
  })

  it('refuses a code missing a required segment', async () => {
    await expect(
      createBudgetCode(pool, tenantId, { projectId, values: { cost_code: '03 00 00' } }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses a value that is not in the segment', async () => {
    await expect(
      createBudgetCode(pool, tenantId, { projectId, values: { cost_code: '03 00 00', cost_type: 'ZZ' } }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('takes a project-scoped value alongside the company-wide ones', async () => {
    // A sub job usually exists on one job and nowhere else.
    await withTenant(pool, tenantId, (tx) =>
      addSegmentValue(tx, tenantId, {
        segmentKey: 'sub_job',
        code: 'T2',
        label: 'Tower 2',
        projectId,
      }),
    )
    const code = await createBudgetCode(pool, tenantId, {
      projectId,
      values: { cost_code: '03 00 00', cost_type: 'M', sub_job: 'T2' },
    })
    expect(code.display).toBe('03 00 00.M.T2')
  })

  it('does not offer another project’s sub jobs', async () => {
    const other = await withTenant(pool, tenantId, (tx) =>
      createProject(tx, tenantId, { number: '26-901', name: 'Ellsworth Annex' }),
    )
    await expect(
      createBudgetCode(pool, tenantId, {
        projectId: other,
        values: { cost_code: '03 00 00', cost_type: 'M', sub_job: 'T2' },
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('a company whose accounting does not look like anybody else’s', () => {
  it('takes a segment of their own, in their own position', async () => {
    await withTenant(pool, tenantId, async (tx) => {
      await addSegment(tx, tenantId, { key: 'funding_source', label: 'Funding Source', position: 5 })
      await addSegmentValue(tx, tenantId, { segmentKey: 'funding_source', code: 'FED', label: 'Federal' })
    })

    // Position 5 puts it in FRONT of the cost code, because the assembled
    // code has to read the way their ERP reads it, not the way ours does.
    const code = await createBudgetCode(pool, tenantId, {
      projectId,
      values: { funding_source: 'FED', cost_code: '26 00 00', cost_type: 'S' },
    })
    expect(code.display).toBe('FED.26 00 00.S')
  })

  it('rejects a segment key that is not a plain identifier', async () => {
    await expect(
      withTenant(pool, tenantId, (tx) =>
        addSegment(tx, tenantId, { key: 'Funding Source!', label: 'Nope', position: 99 }),
      ),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('codes are retired, never edited', () => {
  it('retires a code and leaves it readable', async () => {
    const code = await createBudgetCode(pool, tenantId, {
      projectId,
      values: { funding_source: 'FED', cost_code: '09 00 00', cost_type: 'S' },
    })
    await withTenant(pool, tenantId, (tx) => retireBudgetCode(tx, tenantId, code.id))

    const codes = await withTenant(pool, tenantId, (tx) => listBudgetCodes(tx, tenantId, projectId))
    const retired = codes.find((c) => c.id === code.id)
    // Still there, still readable, still pointing at the same segments: a
    // code that vanished would orphan every invoice posted against it.
    expect(retired?.retiredAt).toBeTruthy()
    expect(retired?.segments.map((s) => s.code)).toContain('09 00 00')
  })

  it('will not retire the same code twice', async () => {
    const code = await createBudgetCode(pool, tenantId, {
      projectId,
      values: { funding_source: 'FED', cost_code: '22 00 00', cost_type: 'S' },
    })
    await withTenant(pool, tenantId, (tx) => retireBudgetCode(tx, tenantId, code.id))
    await expect(
      withTenant(pool, tenantId, (tx) => retireBudgetCode(tx, tenantId, code.id)),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})
