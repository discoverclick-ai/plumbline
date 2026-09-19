/**
 * Primavera P6's export format, read.
 *
 * XER is tab-delimited, table-oriented, and utterly undocumented by Oracle,
 * which is why every product that reads it reads it slightly differently. The
 * shape is:
 *
 *   ERMHDR  <version>  <date>  <project>  <user>  ...
 *   %T  TASK
 *   %F  task_id  proj_id  task_code  task_name  ...
 *   %R  4711     1234     A1010      Excavate footings  ...
 *   %E
 *
 * `%T` names a table, `%F` names its columns, each `%R` is a row, `%E` ends
 * the file. Columns vary by P6 version and by what the exporter chose to
 * include, so everything here is read BY NAME and every field is optional
 * except the two that identify an activity.
 *
 * Deterministic, and no model anywhere near it. A schedule import that
 * guessed at a float value would put a number in front of a scheduler who
 * would then find it wrong, once, and never trust the product again.
 */

export interface XerTable {
  name: string
  fields: string[]
  rows: Record<string, string>[]
}

export interface XerFile {
  header: { version: string | null; exportedAt: string | null; tool: string | null }
  tables: Map<string, XerTable>
}

export function parseXer(text: string): XerFile {
  const file: XerFile = { header: { version: null, exportedAt: null, tool: null }, tables: new Map() }
  let current: XerTable | null = null

  for (const raw of text.split(/\r?\n/)) {
    if (raw === '') continue
    const cells = raw.split('\t')
    const tag = cells[0]

    if (tag === 'ERMHDR') {
      file.header = {
        version: cells[1] ?? null,
        exportedAt: cells[2] ?? null,
        // Position varies by version; the exporting tool is the last thing
        // anybody needs and the first thing they ask for when a number looks
        // wrong, so it is taken loosely rather than not at all.
        tool: cells.slice(3).find((c) => /[A-Za-z]/.test(c ?? '')) ?? null,
      }
      continue
    }
    if (tag === '%T') {
      current = { name: cells[1] ?? '', fields: [], rows: [] }
      file.tables.set(current.name, current)
      continue
    }
    if (tag === '%F' && current) {
      current.fields = cells.slice(1).map((c) => c.trim())
      continue
    }
    if (tag === '%R' && current) {
      const values = cells.slice(1)
      const row: Record<string, string> = {}
      current.fields.forEach((field, i) => {
        row[field] = values[i] ?? ''
      })
      current.rows.push(row)
      continue
    }
    // %E and anything else: ignored rather than rejected. A file with a table
    // this product does not read is a normal file, not a broken one.
  }

  return file
}

export interface ImportedActivity {
  activityCode: string
  name: string
  wbsPath: string | null
  startAt: string | null
  finishAt: string | null
  actualStart: string | null
  actualFinish: string | null
  durationDays: string | null
  remainingDays: string | null
  percentComplete: string | null
  totalFloatDays: string | null
  freeFloatDays: string | null
  isCritical: boolean
  isMilestone: boolean
  predecessors: string[]
  responsible: string | null
}

export interface ImportedSchedule {
  activities: ImportedActivity[]
  dataDate: string | null
  meta: Record<string, unknown>
  /** Rows the parser could not use, with why. Surfaced, never swallowed. */
  rejected: { reason: string; row: string }[]
}

/** P6 writes dates as "2026-03-04 08:00" and sometimes with no time at all. */
export function xerDate(value: string | undefined): string | null {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

/** Hours to days, at the schedule's own hours-per-day, defaulting to eight. */
export function hoursToDays(value: string | undefined, hoursPerDay = 8): string | null {
  if (!value || value.trim() === '') return null
  const hours = Number(value)
  if (!Number.isFinite(hours)) return null
  return (hours / hoursPerDay).toFixed(2)
}

const MILESTONE_TYPES = new Set(['TT_Mile', 'TT_FinMile', 'TT_Task_Mile'])

export function activitiesFromXer(file: XerFile): ImportedSchedule {
  const tasks = file.tables.get('TASK')
  const rejected: { reason: string; row: string }[] = []
  if (!tasks) {
    return {
      activities: [],
      dataDate: null,
      meta: {},
      rejected: [{ reason: 'No TASK table: this file is not a schedule export', row: '' }],
    }
  }

  // Hours per day comes from the project table when the export includes it.
  // Getting this wrong turns every duration and every float into nonsense
  // with the right shape, which is worse than a missing number.
  const project = file.tables.get('PROJECT')?.rows[0]
  const hoursPerDay = Number(project?.['day_hr_cnt'] ?? 8) || 8
  const dataDate = xerDate(project?.['last_recalc_date']) ?? xerDate(project?.['plan_start_date'])

  const wbsById = new Map<string, { name: string; parent: string | null }>()
  for (const row of file.tables.get('PROJWBS')?.rows ?? []) {
    const id = row['wbs_id']
    if (id) wbsById.set(id, { name: row['wbs_name'] ?? '', parent: row['parent_wbs_id'] || null })
  }

  const predecessorsByTask = new Map<string, string[]>()
  const codeByTaskId = new Map<string, string>()
  for (const row of tasks.rows) {
    const id = row['task_id']
    const code = row['task_code']
    if (id && code) codeByTaskId.set(id, code)
  }
  for (const row of file.tables.get('TASKPRED')?.rows ?? []) {
    const task = row['task_id']
    const pred = row['pred_task_id']
    if (!task || !pred) continue
    const taskCode = codeByTaskId.get(task)
    const predCode = codeByTaskId.get(pred)
    // A predecessor outside the export is a fact about the file, not a
    // reason to reject the activity. It is dropped from the list and the
    // activity is kept.
    if (!taskCode || !predCode) continue
    predecessorsByTask.set(taskCode, [...(predecessorsByTask.get(taskCode) ?? []), predCode])
  }

  const activities: ImportedActivity[] = []
  const seen = new Set<string>()

  for (const row of tasks.rows) {
    const activityCode = (row['task_code'] ?? '').trim()
    const name = (row['task_name'] ?? '').trim()

    if (!activityCode || !name) {
      rejected.push({
        reason: 'An activity needs a code and a name',
        row: `${activityCode || '(no code)'} ${name || '(no name)'}`,
      })
      continue
    }
    if (seen.has(activityCode)) {
      // Duplicated codes happen when two P6 projects are exported together.
      // Silently keeping the last one would mean links point at whichever
      // activity happened to be later in the file.
      rejected.push({ reason: 'Duplicate activity code in this file', row: activityCode })
      continue
    }
    seen.add(activityCode)

    const totalFloat = hoursToDays(row['total_float_hr_cnt'], hoursPerDay)
    activities.push({
      activityCode,
      name,
      wbsPath: wbsPathFor(row['wbs_id'], wbsById),
      startAt: xerDate(row['early_start_date'] ?? row['target_start_date']),
      finishAt: xerDate(row['early_end_date'] ?? row['target_end_date']),
      actualStart: xerDate(row['act_start_date']),
      actualFinish: xerDate(row['act_end_date']),
      durationDays: hoursToDays(row['target_drtn_hr_cnt'], hoursPerDay),
      remainingDays: hoursToDays(row['remain_drtn_hr_cnt'], hoursPerDay),
      percentComplete: percent(row['phys_complete_pct'] ?? row['complete_pct']),
      totalFloatDays: totalFloat,
      freeFloatDays: hoursToDays(row['free_float_hr_cnt'], hoursPerDay),
      // Critical is whatever P6 said, falling back to zero-or-less float.
      // Recomputing it under a different threshold would disagree with the
      // scheduler's own printout, and theirs is the one on the wall.
      isCritical: row['driving_path_flag'] === 'Y' || (totalFloat !== null && Number(totalFloat) <= 0),
      isMilestone: MILESTONE_TYPES.has(row['task_type'] ?? ''),
      predecessors: predecessorsByTask.get(activityCode) ?? [],
      responsible: row['rsrc_name'] || null,
    })
  }

  return {
    activities,
    dataDate,
    meta: {
      tool: file.header.tool,
      version: file.header.version,
      exportedAt: file.header.exportedAt,
      hoursPerDay,
      projectId: project?.['proj_short_name'] ?? null,
      tables: [...file.tables.keys()],
    },
    rejected,
  }
}

function wbsPathFor(wbsId: string | undefined, wbs: Map<string, { name: string; parent: string | null }>): string | null {
  if (!wbsId) return null
  const parts: string[] = []
  let cursor: string | null = wbsId
  const seen = new Set<string>()
  // Guarded: a WBS that references itself is a corrupt export and not a
  // reason to hang the import.
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const node = wbs.get(cursor)
    if (!node) break
    parts.unshift(node.name)
    cursor = node.parent
  }
  return parts.length > 0 ? parts.join(' / ') : null
}

function percent(value: string | undefined): string | null {
  if (!value || value.trim() === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  // P6 stores this as 0-100 in some columns and 0-1 in others.
  return (n <= 1 ? n * 100 : n).toFixed(2)
}
