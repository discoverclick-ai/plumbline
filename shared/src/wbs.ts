import { withTenant, type Db } from './db.js'
import { NotFoundError, ValidationError } from './errors.js'

/**
 * The work breakdown structure.
 *
 * A budget code is not a string, it is a composition of segments. Cost code
 * and cost type are the two everybody has; sub job is the next most common;
 * beyond that companies segment by whatever their accounting system segments
 * by, which is phase, area, tower, funding source or tax jurisdiction
 * depending on who you ask.
 *
 * Getting this shape wrong is the mistake you cannot walk back, because every
 * budget line, commitment, change order, invoice and cost entry points at a
 * budget code, and an ERP sync is only possible if the code decomposes into
 * the same segments the ERP uses.
 */

export interface SegmentSpec {
  key: string
  label: string
  position: number
  builtin?: boolean
  required?: boolean
}

/**
 * What ships on day one. Cost code and cost type are marked builtin because
 * the rest of the financial schema names them; everything else a customer
 * adds is theirs, and so is the order.
 */
export const DEFAULT_SEGMENTS: SegmentSpec[] = [
  { key: 'cost_code', label: 'Cost Code', position: 10, builtin: true, required: true },
  { key: 'cost_type', label: 'Cost Type', position: 20, builtin: true, required: true },
  { key: 'sub_job', label: 'Sub Job', position: 30, required: false },
]

/**
 * The cost types every contractor has, because these are the columns a job
 * cost report is grouped by whatever else changes.
 */
export const DEFAULT_COST_TYPES: { code: string; label: string }[] = [
  { code: 'L', label: 'Labor' },
  { code: 'M', label: 'Material' },
  { code: 'E', label: 'Equipment' },
  { code: 'S', label: 'Subcontract' },
  { code: 'O', label: 'Other' },
  { code: 'C', label: 'Commitment' },
]

/**
 * A starter cost code list, from CSI MasterFormat division headings.
 *
 * Deliberately a DEFAULT rather than a built-in. Plenty of self-performing
 * contractors and most owners use their own chart, and a product that assumes
 * MasterFormat cannot be sold to a utility or a data centre operator.
 */
export const DEFAULT_COST_CODES: { code: string; label: string }[] = [
  { code: '01 00 00', label: 'General Requirements' },
  { code: '02 00 00', label: 'Existing Conditions' },
  { code: '03 00 00', label: 'Concrete' },
  { code: '04 00 00', label: 'Masonry' },
  { code: '05 00 00', label: 'Metals' },
  { code: '06 00 00', label: 'Wood, Plastics and Composites' },
  { code: '07 00 00', label: 'Thermal and Moisture Protection' },
  { code: '08 00 00', label: 'Openings' },
  { code: '09 00 00', label: 'Finishes' },
  { code: '10 00 00', label: 'Specialties' },
  { code: '11 00 00', label: 'Equipment' },
  { code: '12 00 00', label: 'Furnishings' },
  { code: '13 00 00', label: 'Special Construction' },
  { code: '14 00 00', label: 'Conveying Equipment' },
  { code: '21 00 00', label: 'Fire Suppression' },
  { code: '22 00 00', label: 'Plumbing' },
  { code: '23 00 00', label: 'Heating, Ventilating and Air Conditioning' },
  { code: '26 00 00', label: 'Electrical' },
  { code: '27 00 00', label: 'Communications' },
  { code: '28 00 00', label: 'Electronic Safety and Security' },
  { code: '31 00 00', label: 'Earthwork' },
  { code: '32 00 00', label: 'Exterior Improvements' },
  { code: '33 00 00', label: 'Utilities' },
]

export interface Segment {
  id: string
  key: string
  label: string
  position: number
  builtin: boolean
  required: boolean
}

export interface SegmentValue {
  id: string
  segmentId: string
  code: string
  label: string
  projectId: string | null
}

export interface BudgetCode {
  id: string
  projectId: string
  display: string
  retiredAt: Date | null
  segments: { segmentKey: string; code: string; label: string }[]
}

/** Installs the default structure for a new tenant. Idempotent. */
export async function installDefaultWbs(db: Db, tenantId: string): Promise<void> {
  for (const spec of DEFAULT_SEGMENTS) {
    await db.query(
      `INSERT INTO wbs_segments (tenant_id, key, label, position, builtin, required)
            VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, key) DO NOTHING`,
      [tenantId, spec.key, spec.label, spec.position, spec.builtin ?? false, spec.required ?? true],
    )
  }

  const costCode = await findSegment(db, tenantId, 'cost_code')
  const costType = await findSegment(db, tenantId, 'cost_type')

  for (const [segment, values] of [
    [costCode, DEFAULT_COST_CODES],
    [costType, DEFAULT_COST_TYPES],
  ] as const) {
    let order = 0
    for (const value of values) {
      order += 10
      await db.query(
        `INSERT INTO wbs_segment_values (tenant_id, segment_id, code, label, sort_order)
              VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (segment_id, code) WHERE project_id IS NULL DO NOTHING`,
        [tenantId, segment.id, value.code, value.label, order],
      )
    }
  }
}

export async function findSegment(db: Db, tenantId: string, key: string): Promise<Segment> {
  const { rows } = await db.query<{
    id: string
    key: string
    label: string
    position: number
    builtin: boolean
    required: boolean
  }>(
    `SELECT id, key, label, position, builtin, required FROM wbs_segments
      WHERE tenant_id = $1 AND key = $2`,
    [tenantId, key],
  )
  const row = rows[0]
  if (!row) throw new NotFoundError('wbs segment', key)
  return row
}

export async function listSegments(db: Db, tenantId: string): Promise<Segment[]> {
  const { rows } = await db.query<Segment>(
    `SELECT id, key, label, position, builtin, required FROM wbs_segments
      WHERE tenant_id = $1 ORDER BY position`,
    [tenantId],
  )
  return rows
}

/**
 * Adds a segment of the customer's own. Position is theirs to choose because
 * the assembled code has to read the way their ERP reads it.
 */
export async function addSegment(db: Db, tenantId: string, spec: SegmentSpec): Promise<Segment> {
  if (!/^[a-z][a-z0-9_]*$/.test(spec.key)) {
    throw new ValidationError('A segment key must be a plain identifier', [
      { field: 'key', message: 'Use lower case letters, digits and underscores' },
    ])
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO wbs_segments (tenant_id, key, label, position, builtin, required)
          VALUES ($1, $2, $3, $4, FALSE, $5)
       RETURNING id`,
    [tenantId, spec.key, spec.label, spec.position, spec.required ?? false],
  )
  const id = rows[0]?.id
  if (!id) throw new Error('segment insert returned no row')
  return { id, key: spec.key, label: spec.label, position: spec.position, builtin: false, required: spec.required ?? false }
}

export async function addSegmentValue(
  db: Db,
  tenantId: string,
  input: { segmentKey: string; code: string; label: string; projectId?: string },
): Promise<SegmentValue> {
  const segment = await findSegment(db, tenantId, input.segmentKey)
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO wbs_segment_values (tenant_id, segment_id, code, label, project_id)
          VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
    [tenantId, segment.id, input.code, input.label, input.projectId ?? null],
  )
  const id = rows[0]?.id
  if (!id) throw new Error('segment value insert returned no row')
  return { id, segmentId: segment.id, code: input.code, label: input.label, projectId: input.projectId ?? null }
}

export async function listSegmentValues(
  db: Db,
  tenantId: string,
  input: { segmentKey: string; projectId?: string },
): Promise<SegmentValue[]> {
  const segment = await findSegment(db, tenantId, input.segmentKey)
  const { rows } = await db.query<{
    id: string
    segment_id: string
    code: string
    label: string
    project_id: string | null
  }>(
    `SELECT id, segment_id, code, label, project_id FROM wbs_segment_values
      WHERE tenant_id = $1 AND segment_id = $2 AND active
        AND (project_id IS NULL OR project_id = $3)
      ORDER BY sort_order, code`,
    [tenantId, segment.id, input.projectId ?? null],
  )
  return rows.map((r) => ({
    id: r.id,
    segmentId: r.segment_id,
    code: r.code,
    label: r.label,
    projectId: r.project_id,
  }))
}

/**
 * Assembles a budget code from one value per segment.
 *
 * Every required segment must be given, and the assembled display string is
 * stored rather than computed. It appears on signed subcontracts and on
 * invoices that outlive any config change, and a code printed on paper cannot
 * change shape later because somebody reordered a segment.
 */
export async function createBudgetCode(
  db: Db,
  tenantId: string,
  input: { projectId: string; values: Record<string, string> },
): Promise<BudgetCode> {
  return withTenant(db, tenantId, async (tx) => {
    const segments = await listSegments(tx, tenantId)
    const chosen: { segment: Segment; value: SegmentValue }[] = []

    for (const segment of segments) {
      const code = input.values[segment.key]
      if (!code) {
        if (segment.required) {
          throw new ValidationError(`${segment.label} is required`, [
            { field: segment.key, message: `${segment.label} is required for a budget code` },
          ])
        }
        continue
      }
      const values = await listSegmentValues(tx, tenantId, {
        segmentKey: segment.key,
        projectId: input.projectId,
      })
      const value = values.find((v) => v.code === code)
      if (!value) {
        throw new ValidationError(`${code} is not a ${segment.label} on this project`, [
          { field: segment.key, message: `Unknown ${segment.label}: ${code}` },
        ])
      }
      chosen.push({ segment, value })
    }

    const display = chosen.map((c) => c.value.code).join('.')
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO budget_codes (tenant_id, project_id, display)
            VALUES ($1, $2, $3)
       ON CONFLICT (project_id, display) DO UPDATE SET display = EXCLUDED.display
         RETURNING id`,
      [tenantId, input.projectId, display],
    )
    const id = rows[0]?.id as string

    for (const { segment, value } of chosen) {
      await tx.query(
        `INSERT INTO budget_code_segments (budget_code_id, segment_id, value_id)
              VALUES ($1, $2, $3)
         ON CONFLICT (budget_code_id, segment_id) DO NOTHING`,
        [id, segment.id, value.id],
      )
    }

    return {
      id,
      projectId: input.projectId,
      display,
      retiredAt: null,
      segments: chosen.map((c) => ({ segmentKey: c.segment.key, code: c.value.code, label: c.value.label })),
    }
  })
}

export async function listBudgetCodes(db: Db, tenantId: string, projectId: string): Promise<BudgetCode[]> {
  const { rows } = await db.query<{
    id: string
    project_id: string
    display: string
    retired_at: Date | null
    segment_key: string
    code: string
    label: string
  }>(
    `SELECT bc.id, bc.project_id, bc.display, bc.retired_at,
            s.key AS segment_key, v.code, v.label
       FROM budget_codes bc
       LEFT JOIN budget_code_segments bcs ON bcs.budget_code_id = bc.id
       LEFT JOIN wbs_segments s ON s.id = bcs.segment_id
       LEFT JOIN wbs_segment_values v ON v.id = bcs.value_id
      WHERE bc.tenant_id = $1 AND bc.project_id = $2
      ORDER BY bc.display, s.position`,
    [tenantId, projectId],
  )

  const byId = new Map<string, BudgetCode>()
  for (const row of rows) {
    let code = byId.get(row.id)
    if (!code) {
      code = { id: row.id, projectId: row.project_id, display: row.display, retiredAt: row.retired_at, segments: [] }
      byId.set(row.id, code)
    }
    if (row.segment_key) code.segments.push({ segmentKey: row.segment_key, code: row.code, label: row.label })
  }
  return [...byId.values()]
}

/**
 * Retires a code rather than editing it.
 *
 * A budget code edited after costs are posted against it silently rewrites
 * history in the accounting system too, and the first anybody hears about it
 * is a reconciliation that does not balance three months later.
 */
export async function retireBudgetCode(db: Db, tenantId: string, budgetCodeId: string): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE budget_codes SET retired_at = now()
      WHERE tenant_id = $1 AND id = $2 AND retired_at IS NULL`,
    [tenantId, budgetCodeId],
  )
  if (rowCount === 0) throw new NotFoundError('budget code', budgetCodeId)
}
