import type { Db } from './db.js'
import { ValidationError } from './errors.js'
import { parseRecordTypeDefinition, type RecordTypeDefinition } from './record-type.js'
import { clearRecordTypeCache } from './repositories/record-types.js'

/**
 * Changing a tool's shape, safely.
 *
 * A record type is configuration, which is the point: a customer can have a
 * new tool in an afternoon instead of a release. The cost of that is that a
 * careless edit can strand the records already running under the old shape,
 * and the failure is not cosmetic. A record whose status no longer exists
 * cannot be labelled. A record in a state whose transitions were all removed
 * cannot move at all, which on a jobsite means somebody's work is stuck and
 * nobody can say why.
 *
 * So publishing a new definition is a migration with a gate, and the gate is
 * computed from the live data rather than from the author's intentions. The
 * checks are deliberately conservative and they all name the records at risk,
 * because "this change would strand 12 records in Ready for Review" is
 * actionable and "invalid definition" is not.
 *
 * This runs across every tenant at once, because a record type is global.
 * It is therefore an operator action on an operator connection, like a
 * migration, and not something the API exposes to a customer's admin.
 */

export interface TypeUsage {
  /** How many live records sit in each status. */
  statusCounts: Map<string, number>
  /** How many live records hold a non-null value for each body field. */
  fieldCounts: Map<string, number>
  /** Distinct values in use, gathered only for fields the NEXT definition calls a select. */
  selectValues: Map<string, Set<string>>
}

export interface Incompatibility {
  kind:
    | 'status_removed'
    | 'state_stranded'
    | 'field_removed'
    | 'field_retyped'
    | 'option_removed'
    | 'required_field_added'
  detail: string
  affectedRecords: number
}

/**
 * Pure, so the rules can be tested without a database and so a caller can ask
 * "what would this break" without publishing anything.
 */
export function checkCompatibility(next: RecordTypeDefinition, usage: TypeUsage): Incompatibility[] {
  const problems: Incompatibility[] = []

  const nextStates = new Map(next.workflow.states.map((s) => [s.key, s]))
  const nextFields = new Map(next.fields.map((f) => [f.key, f]))

  for (const [status, count] of usage.statusCounts) {
    if (count === 0) continue

    if (!nextStates.has(status)) {
      problems.push({
        kind: 'status_removed',
        detail: `state "${status}" is removed, and records are sitting in it`,
        affectedRecords: count,
      })
      continue
    }

    // A state nobody can leave is a stopped job. Terminal states are meant to
    // be dead ends; every other one needs a way out.
    const state = nextStates.get(status)
    if (state && !state.terminal && !next.workflow.transitions.some((t) => t.from.includes(status))) {
      problems.push({
        kind: 'state_stranded',
        detail: `state "${status}" has no transitions out of it, and records are sitting in it`,
        affectedRecords: count,
      })
    }
  }

  for (const [key, count] of usage.fieldCounts) {
    if (count === 0) continue
    const field = nextFields.get(key)

    if (!field) {
      problems.push({
        kind: 'field_removed',
        detail: `field "${key}" is removed, and records hold a value for it`,
        affectedRecords: count,
      })
      continue
    }

    if (field.type === 'select') {
      const allowed = new Set(field.options ?? [])
      const orphaned = [...(usage.selectValues.get(key) ?? [])].filter((v) => !allowed.has(v))
      if (orphaned.length > 0) {
        problems.push({
          kind: 'option_removed',
          detail: `field "${key}" no longer offers ${orphaned.map((v) => `"${v}"`).join(', ')}, which records hold`,
          affectedRecords: count,
        })
      }
    }
  }

  // Adding a required field with no default breaks the NEXT transition of
  // every record already out there, because the body is re-normalized on the
  // way through. A default makes the same change safe.
  const liveRecords = [...usage.statusCounts.values()].reduce((a, b) => a + b, 0)
  if (liveRecords > 0) {
    for (const field of next.fields) {
      if (!field.required) continue
      if (field.default !== undefined && field.default !== null) continue
      if (usage.fieldCounts.has(field.key)) continue
      problems.push({
        kind: 'required_field_added',
        detail: `field "${field.key}" is newly required with no default, and existing records have no value for it`,
        affectedRecords: liveRecords,
      })
    }
  }

  return problems
}

/** Reads what the live records actually contain. Operator connection, all tenants. */
export async function readTypeUsage(db: Db, typeKey: string, next: RecordTypeDefinition): Promise<TypeUsage> {
  const { rows: statusRows } = await db.query<{ status: string; n: string }>(
    'SELECT status, COUNT(*)::text AS n FROM records WHERE type_key = $1 GROUP BY status',
    [typeKey],
  )

  const { rows: fieldRows } = await db.query<{ key: string; n: string }>(
    `SELECT kv.key, COUNT(*)::text AS n
       FROM records r, jsonb_each(r.body) AS kv(key, value)
      WHERE r.type_key = $1 AND kv.value <> 'null'::jsonb
      GROUP BY kv.key`,
    [typeKey],
  )

  // Only for the fields that are dropdowns in the proposed definition: those
  // are the only ones whose value set can be narrowed out from under a record.
  const selectValues = new Map<string, Set<string>>()
  for (const field of next.fields) {
    if (field.type !== 'select') continue
    const { rows } = await db.query<{ value: string }>(
      `SELECT DISTINCT r.body ->> $2 AS value
         FROM records r
        WHERE r.type_key = $1 AND r.body ->> $2 IS NOT NULL`,
      [typeKey, field.key],
    )
    selectValues.set(field.key, new Set(rows.map((r) => r.value)))
  }

  return {
    statusCounts: new Map(statusRows.map((r) => [r.status, Number(r.n)])),
    fieldCounts: new Map(fieldRows.map((r) => [r.key, Number(r.n)])),
    selectValues,
  }
}

export interface PublishResult {
  typeKey: string
  version: number
}

/**
 * Validate, gate against live data, then publish as a new version.
 *
 * `force` exists because there are legitimate reasons to accept the damage
 * (a type nobody uses in anger yet, a state being renamed in the same breath
 * as its records being moved). It is deliberately not the default and it is
 * recorded in the version note, so the history says a human overrode the gate.
 */
export async function publishRecordType(
  db: Db,
  typeKey: string,
  definition: unknown,
  options: { note?: string; force?: boolean } = {},
): Promise<PublishResult> {
  const next = parseRecordTypeDefinition(definition)

  const { rows } = await db.query<{ version: number }>('SELECT version FROM record_types WHERE key = $1', [typeKey])
  const current = rows[0]
  if (!current) throw new ValidationError(`No record type "${typeKey}"`, [{ field: 'typeKey', message: 'Unknown type' }])

  const problems = checkCompatibility(next, await readTypeUsage(db, typeKey, next))
  if (problems.length > 0 && !options.force) {
    throw new ValidationError(
      `This definition would strand records already running under "${typeKey}"`,
      problems.map((p) => ({ field: p.kind, message: `${p.detail} (${p.affectedRecords} records)` })),
    )
  }

  const version = current.version + 1
  const note = problems.length > 0 ? `${options.note ?? 'Published'} [forced past ${problems.length} incompatibilities]` : options.note ?? null

  await db.query('UPDATE record_types SET definition = $2, version = $3 WHERE key = $1', [typeKey, next, version])
  await db.query(
    'INSERT INTO record_type_versions (type_key, version, definition, note) VALUES ($1, $2, $3, $4)',
    [typeKey, version, next, note],
  )

  clearRecordTypeCache()
  return { typeKey, version }
}

/** The definition a record was created under, for reading back an old record faithfully. */
export async function getDefinitionAtVersion(
  db: Db,
  typeKey: string,
  version: number,
): Promise<RecordTypeDefinition | null> {
  const { rows } = await db.query<{ definition: unknown }>(
    'SELECT definition FROM record_type_versions WHERE type_key = $1 AND version = $2',
    [typeKey, version],
  )
  const row = rows[0]
  return row ? parseRecordTypeDefinition(row.definition) : null
}
