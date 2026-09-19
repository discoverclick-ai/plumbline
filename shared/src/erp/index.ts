import type { Db } from '../db.js'

/**
 * The accounting boundary.
 *
 * Every construction platform eventually has to hand its numbers to the system
 * that actually writes the cheques, and this is the seam where that happens.
 * Same shape as the model provider and the blob store: one interface, one
 * adapter per system, and nothing above this line knowing which.
 *
 * The reason the work breakdown structure was built the way it was lands here.
 * An export is only possible because a budget code DECOMPOSES into the segments
 * the accounting system already understands. Handing Sage a string like
 * "03 00 00.L.T2" is useless; handing it a cost code, a cost type and a sub job
 * in their own columns is an import.
 *
 * Two things this interface deliberately does not do.
 *
 * It does not push. A construction platform that writes directly into a
 * company's general ledger is one their controller will not approve, and
 * rightly: the ledger is the system of record for the business, not for the
 * job. Adapters produce a batch, a human reviews it, their system imports it.
 * Anything that skips that step gets turned off.
 *
 * It does not reconcile. Deciding that our actual cost and their posted cost
 * disagree is a judgement with money attached, and the honest version of that
 * feature reports the difference rather than resolving it.
 */

export interface ErpBatchLine {
  /** The assembled code, for a human reading the batch. */
  budgetCode: string
  /** The same code decomposed, which is what an adapter actually maps. */
  segments: Record<string, string>
  projectNumber: string
  projectName: string
  kind: 'budget' | 'committed' | 'actual' | 'pending'
  amount: string
  description: string
  /** Our designation, so a line in their system points back at ours. */
  reference: string | null
}

export interface ErpBatch {
  tenantId: string
  projectId: string
  generatedAt: string
  lines: ErpBatchLine[]
}

export interface ErpAdapter {
  readonly name: string
  /** What this system calls each of our segments, for the mapping screen. */
  readonly segmentMapping: Record<string, string>
  format(batch: ErpBatch): Promise<{ filename: string; contentType: string; body: string }>
}

/**
 * Reads a project's financial position into a batch.
 *
 * Every figure comes from the same views the product's own screens read, which
 * is the point: an export computing its own totals would be a third place for
 * the numbers to disagree.
 */
export async function buildErpBatch(db: Db, tenantId: string, projectId: string): Promise<ErpBatch> {
  const { rows: project } = await db.query<{ number: string; name: string }>(
    `SELECT number, name FROM projects WHERE tenant_id = $1 AND id = $2`,
    [tenantId, projectId],
  )
  const job = project[0]
  if (!job) throw new Error(`No project ${projectId}`)

  const { rows } = await db.query<{
    budget_code: string
    segments: Record<string, string>
    current_budget: string
    committed_cost: string
    actual_cost: string
    pending_cost: string
    description: string
  }>(
    `SELECT bs.budget_code,
            COALESCE(
              (SELECT jsonb_object_agg(s.key, v.code)
                 FROM budget_code_segments bcs
                 JOIN wbs_segments s ON s.id = bcs.segment_id
                 JOIN wbs_segment_values v ON v.id = bcs.value_id
                WHERE bcs.budget_code_id = bs.budget_code_id),
              '{}'::jsonb
            ) AS segments,
            bs.current_budget, bs.committed_cost, bs.actual_cost, bs.pending_cost, bs.description
       FROM budget_summary bs
      WHERE bs.tenant_id = $1 AND bs.project_id = $2
      ORDER BY bs.budget_code`,
    [tenantId, projectId],
  )

  const lines: ErpBatchLine[] = []
  for (const row of rows) {
    for (const [kind, amount] of [
      ['budget', row.current_budget],
      ['committed', row.committed_cost],
      ['actual', row.actual_cost],
      ['pending', row.pending_cost],
    ] as const) {
      // Zero rows are noise in somebody else's system, and a controller
      // scrolling past four hundred of them stops reading the batch.
      if (Number(amount) === 0) continue
      lines.push({
        budgetCode: row.budget_code,
        segments: row.segments,
        projectNumber: job.number,
        projectName: job.name,
        kind,
        amount,
        description: row.description,
        reference: null,
      })
    }
  }

  return { tenantId, projectId, generatedAt: new Date().toISOString(), lines }
}

/**
 * A plain CSV, one row per amount, segments in their own columns.
 *
 * Not a fallback. Every accounting package on earth imports a CSV whose
 * columns you can name, and for a mid-sized contractor this IS the
 * integration: a controller downloads it once a month and imports it. Vendor
 * adapters exist for the customers who want it to happen without a human,
 * which is a smaller group than any integrations roadmap assumes.
 */
export class CsvErpAdapter implements ErpAdapter {
  readonly name = 'csv'
  readonly segmentMapping: Record<string, string> = {}

  constructor(private readonly segmentKeys: string[] = ['cost_code', 'cost_type', 'sub_job']) {}

  async format(batch: ErpBatch): Promise<{ filename: string; contentType: string; body: string }> {
    const header = [
      'project_number',
      'project_name',
      'budget_code',
      ...this.segmentKeys,
      'kind',
      'amount',
      'description',
      'reference',
    ]
    const rows = batch.lines.map((line) =>
      [
        line.projectNumber,
        line.projectName,
        line.budgetCode,
        ...this.segmentKeys.map((key) => line.segments[key] ?? ''),
        line.kind,
        line.amount,
        line.description,
        line.reference ?? '',
      ].map(csvCell),
    )
    return {
      filename: `plumbline-${batch.projectId}-${batch.generatedAt.slice(0, 10)}.csv`,
      contentType: 'text/csv',
      body: [header.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n',
    }
  }
}

/**
 * Anything holding a comma, a quote or a newline is quoted, and a quote inside
 * is doubled. A project called "Harbor Point, Phase II" is not an edge case,
 * it is Tuesday, and a batch that silently splits it across two columns is a
 * controller's afternoon.
 */
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}
