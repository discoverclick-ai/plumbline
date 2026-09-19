import { describe, expect, it } from 'vitest'
import { activitiesFromXer, hoursToDays, parseXer, xerDate } from '../src/schedule/xer.js'

/**
 * Reading a real export.
 *
 * XER is undocumented, its columns move between P6 versions, and every
 * product that reads it reads it slightly differently. So the tests are
 * written against the ways a real file is awkward rather than against a tidy
 * one: missing columns, a predecessor pointing outside the export, durations
 * in hours under a ten-hour day, a duplicated code from two projects exported
 * together.
 *
 * The number that must never be wrong is float. A scheduler who finds one
 * float value disagreeing with their own printout stops trusting the product,
 * once, permanently.
 */

const tab = (...cells: (string | number)[]): string => cells.join('\t')

const XER = [
  tab('ERMHDR', '18.8.0', '2026-03-02', 'Project', 'admin', 'Primavera P6'),
  tab('%T', 'PROJECT'),
  tab('%F', 'proj_id', 'proj_short_name', 'day_hr_cnt', 'last_recalc_date'),
  tab('%R', '100', 'HARBOR', '10', '2026-03-02 00:00'),
  tab('%T', 'PROJWBS'),
  tab('%F', 'wbs_id', 'proj_id', 'wbs_name', 'parent_wbs_id'),
  tab('%R', '1', '100', 'Harbor Point', ''),
  tab('%R', '2', '100', 'Structure', '1'),
  tab('%T', 'TASK'),
  tab(
    '%F',
    'task_id',
    'proj_id',
    'wbs_id',
    'task_code',
    'task_name',
    'task_type',
    'early_start_date',
    'early_end_date',
    'act_start_date',
    'act_end_date',
    'target_drtn_hr_cnt',
    'remain_drtn_hr_cnt',
    'total_float_hr_cnt',
    'free_float_hr_cnt',
    'driving_path_flag',
    'phys_complete_pct',
  ),
  tab('%R', '4711', '100', '2', 'A1010', 'Erect structural steel', 'TT_Task',
      '2026-03-05 08:00', '2026-03-19 17:00', '', '', '100', '100', '20', '0', 'Y', '0'),
  tab('%R', '4712', '100', '2', 'A1020', 'Install curtain wall', 'TT_Task',
      '2026-03-23 08:00', '2026-04-10 17:00', '', '', '140', '140', '160', '40', 'N', '0'),
  tab('%R', '4713', '100', '1', 'M1000', 'Substantial completion', 'TT_FinMile',
      '2026-09-30 17:00', '2026-09-30 17:00', '', '', '0', '0', '0', '0', 'N', ''),
  // No code. A row that cannot be identified cannot be linked to.
  tab('%R', '4714', '100', '2', '', 'Nameless work', 'TT_Task', '2026-03-05 08:00', '', '', '', '', '', '', '', '', ''),
  tab('%T', 'TASKPRED'),
  tab('%F', 'task_pred_id', 'task_id', 'pred_task_id', 'pred_type'),
  tab('%R', '1', '4712', '4711', 'PR_FS'),
  // Points outside the export, which happens whenever somebody filters.
  tab('%R', '2', '4712', '9999', 'PR_FS'),
  tab('%E'),
].join('\n')

describe('the file format', () => {
  it('reads tables by name, whatever order they come in', () => {
    const file = parseXer(XER)
    expect([...file.tables.keys()]).toEqual(['PROJECT', 'PROJWBS', 'TASK', 'TASKPRED'])
    expect(file.tables.get('TASK')!.rows).toHaveLength(4)
    expect(file.header.version).toBe('18.8.0')
  })

  it('survives a file with tables this product does not read', () => {
    const withExtras = XER.replace(
      tab('%T', 'TASKPRED'),
      [tab('%T', 'UDFTYPE'), tab('%F', 'udf_type_id', 'udf_type_label'), tab('%R', '1', 'Cost Code'), tab('%T', 'TASKPRED')].join('\n'),
    )
    // A file containing something we ignore is a normal file, not a broken
    // one. Rejecting it would mean rejecting most real exports.
    expect(activitiesFromXer(parseXer(withExtras)).activities).toHaveLength(3)
  })

  it('says so plainly when handed something that is not a schedule', () => {
    const result = activitiesFromXer(parseXer('ERMHDR\t18.8\t2026-01-01\nSomething else entirely'))
    expect(result.activities).toEqual([])
    expect(result.rejected[0]!.reason).toMatch(/not a schedule export/)
  })
})

describe('dates and durations', () => {
  it('takes the date off a P6 timestamp and leaves the time', () => {
    expect(xerDate('2026-03-05 08:00')).toBe('2026-03-05')
    expect(xerDate('2026-03-05')).toBe('2026-03-05')
    expect(xerDate('')).toBeNull()
    expect(xerDate(undefined)).toBeNull()
  })

  it('converts hours at the schedule’s own hours per day', () => {
    // Eight is the default and ten is common on civil work. Getting this
    // wrong turns every duration and every float into nonsense with exactly
    // the right shape, which is worse than a blank.
    expect(hoursToDays('80', 8)).toBe('10.00')
    expect(hoursToDays('80', 10)).toBe('8.00')
    expect(hoursToDays('', 8)).toBeNull()
    expect(hoursToDays('not a number', 8)).toBeNull()
  })
})

describe('the activities', () => {
  const result = activitiesFromXer(parseXer(XER))

  it('reads float in days, under the project’s ten-hour day', () => {
    const steel = result.activities.find((a) => a.activityCode === 'A1010')!
    const glass = result.activities.find((a) => a.activityCode === 'A1020')!

    expect(result.meta['hoursPerDay']).toBe(10)
    // 20 hours at ten hours a day is two days, not two and a half.
    expect(steel.totalFloatDays).toBe('2.00')
    expect(glass.totalFloatDays).toBe('16.00')
    expect(glass.freeFloatDays).toBe('4.00')
  })

  it('takes critical from P6 rather than recomputing it', () => {
    const steel = result.activities.find((a) => a.activityCode === 'A1010')!
    const glass = result.activities.find((a) => a.activityCode === 'A1020')!
    // Steel has two days of float and P6 still calls it driving. A different
    // threshold here would disagree with the printout on the scheduler's
    // wall, and theirs is the one people work from.
    expect(steel.isCritical).toBe(true)
    expect(glass.isCritical).toBe(false)
  })

  it('treats zero float as critical when the file does not say', () => {
    const milestone = result.activities.find((a) => a.activityCode === 'M1000')!
    expect(milestone.isCritical).toBe(true)
    expect(milestone.isMilestone).toBe(true)
  })

  it('builds the WBS path from the tree', () => {
    expect(result.activities.find((a) => a.activityCode === 'A1010')!.wbsPath).toBe('Harbor Point / Structure')
    expect(result.activities.find((a) => a.activityCode === 'M1000')!.wbsPath).toBe('Harbor Point')
  })

  it('keeps an activity whose predecessor was filtered out of the export', () => {
    const glass = result.activities.find((a) => a.activityCode === 'A1020')!
    // One of its two predecessors is not in the file. That is a fact about
    // the export, not a reason to drop the activity.
    expect(glass.predecessors).toEqual(['A1010'])
  })

  it('rejects a row it cannot identify, and says which', () => {
    expect(result.activities).toHaveLength(3)
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]!.reason).toMatch(/needs a code and a name/)
  })

  it('refuses a duplicated code rather than keeping whichever came last', () => {
    // Two P6 projects exported together. Silently keeping the last one means
    // every link points at whichever activity happened to be later in the
    // file, which nobody would ever notice.
    const doubled = XER.replace(
      tab('%T', 'TASKPRED'),
      [tab('%R', '4715', '100', '2', 'A1010', 'Erect steel, other project', 'TT_Task',
           '2026-05-05 08:00', '', '', '', '', '', '999', '', '', ''),
       tab('%T', 'TASKPRED')].join('\n'),
    )
    const clash = activitiesFromXer(parseXer(doubled))
    expect(clash.activities.find((a) => a.activityCode === 'A1010')!.totalFloatDays).toBe('2.00')
    expect(clash.rejected.some((r) => /Duplicate activity code/.test(r.reason))).toBe(true)
  })

  it('reads the data date, which is not the date of the import', () => {
    // A month-old update imported today describes last month.
    expect(result.dataDate).toBe('2026-03-02')
  })
})
