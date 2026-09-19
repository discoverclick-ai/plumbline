/**
 * Three-way field merge.
 *
 * Pure, because this is the piece that decides whose afternoon survives, and
 * it should be arguable without a database, a network or a device.
 *
 * The inputs are the three versions any offline edit has: the BASE the device
 * was working from, the SERVER as it stands now, and the DEVICE's own. For
 * each field the answer is one of four, and only the last needs a human.
 */

export interface MergeResult {
  /** What to write. Fields the server should keep are absent. */
  merged: Record<string, unknown>
  applied: string[]
  dropped: string[]
  conflicts: { field: string; base: unknown; server: unknown; device: unknown }[]
  /**
   * Whether the server had moved on from the base in any field.
   *
   * This is what separates "your edit went in as you left it" from "your edit
   * was blended with somebody else's". Counting applied fields against the
   * fields the device sent cannot tell them apart, because a client sending
   * its whole body back is normal and would make every push look merged.
   */
  serverAlsoChanged: boolean
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return false
  // Bodies are JSONB, so a field can legitimately hold an object or an array.
  // Comparing those by identity would call every untouched list a conflict.
  if (typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return false
}

/**
 * Merges one record body.
 *
 * Per field:
 *   the device did not change it      -> the server keeps what it has
 *   the server did not change it      -> the device's value is applied
 *   both changed it to the same thing -> nobody is in conflict about anything
 *   both changed it differently       -> conflict, and the server wins for now
 *
 * The server winning is not a judgement that it is right. It is that somebody
 * at a desk can see the conflict log and the person in the basement cannot, so
 * the version that stays is the one a human is in a position to correct.
 */
export function mergeBody(
  base: Record<string, unknown>,
  server: Record<string, unknown>,
  device: Record<string, unknown>,
): MergeResult {
  const result: MergeResult = { merged: {}, applied: [], dropped: [], conflicts: [], serverAlsoChanged: false }

  for (const field of Object.keys(server)) {
    if (!same(server[field], base[field])) result.serverAlsoChanged = true
  }

  for (const field of Object.keys(device)) {
    const baseValue = base[field]
    const serverValue = server[field]
    const deviceValue = device[field]

    // The device is carrying a field it never touched, which is what happens
    // when a client sends the whole body back. Not a change.
    if (same(deviceValue, baseValue)) continue

    if (same(serverValue, baseValue)) {
      result.merged[field] = deviceValue
      result.applied.push(field)
      continue
    }
    // Two people typed the same thing. Reporting it would train people to
    // ignore the log.
    if (same(serverValue, deviceValue)) continue

    result.dropped.push(field)
    result.conflicts.push({ field, base: baseValue, server: serverValue, device: deviceValue })
  }

  return result
}

/**
 * Whether an operation may be applied at all.
 *
 * A device dark for a fortnight can be pushing an edit to a record that has
 * since closed. Applying it would reopen the past, so the operation is kept as
 * rejected with a reason somebody can read out loud.
 */
export function canApplyTo(status: string, terminalStatuses: readonly string[]): boolean {
  return !terminalStatuses.includes(status)
}
