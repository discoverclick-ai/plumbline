import type { Db } from '../db.js'
import { NotFoundError } from '../errors.js'
import { parseRecordTypeDefinition, type RecordType } from '../record-type.js'

/**
 * The type registry. Definitions live in the database (migration 0004) so a
 * new tool ships without a code deploy, but they are parsed and validated on
 * the way in, so a bad definition fails at load rather than halfway through a
 * foreman's submit.
 *
 * Cached per process: the registry changes on migration, not on request.
 * `clearRecordTypeCache` exists for tests that install their own types.
 */

let cache: Map<string, RecordType> | null = null

export async function loadRecordTypes(db: Db): Promise<Map<string, RecordType>> {
  if (cache) return cache

  const { rows } = await db.query<{
    key: string
    tool_key: string
    display_name: string
    display_name_plural: string
    number_prefix: string
    definition: unknown
    version: number
  }>(
    `SELECT key, tool_key, display_name, display_name_plural, number_prefix, definition, version
       FROM record_types
      ORDER BY key`,
  )

  const types = new Map<string, RecordType>()
  for (const row of rows) {
    try {
      types.set(row.key, {
        key: row.key,
        toolKey: row.tool_key,
        displayName: row.display_name,
        displayNamePlural: row.display_name_plural,
        numberPrefix: row.number_prefix,
        version: row.version,
        definition: parseRecordTypeDefinition(row.definition),
      })
    } catch (err) {
      throw new Error(`record type "${row.key}" is not loadable: ${(err as Error).message}`)
    }
  }

  cache = types
  return types
}

export async function getRecordType(db: Db, key: string): Promise<RecordType> {
  const types = await loadRecordTypes(db)
  const type = types.get(key)
  if (!type) throw new NotFoundError('record type', key)
  return type
}

export function clearRecordTypeCache(): void {
  cache = null
}
