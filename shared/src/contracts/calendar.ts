/**
 * Deadline arithmetic.
 *
 * No model touches this, ever. A deadline is arithmetic, and a deadline a
 * model produced is one nobody can defend in a claim, which makes it worth
 * less than no deadline at all.
 *
 * The one rule that governs every judgment call here: BIAS EARLY. Where the
 * basis is ambiguous, compute the earliest plausible deadline. An early
 * warning is an annoyance. A late one is a waived claim, and the asymmetry
 * between those two is the entire reason this product exists.
 *
 * Everything is computed in the project's own timezone against the project's
 * own work week, because "ten days" under a contract that defines days as
 * working days and "ten days" under one that does not differ by a week, and
 * the job's calendar is the only one that means anything.
 */

export type DurationUnit = 'days' | 'business_days' | 'weeks' | 'months'

export interface ProjectCalendar {
  /** ISO weekday numbers, 1 = Monday. Six day weeks are normal on a job. */
  workDays: number[]
  /** IANA zone, e.g. 'America/Denver'. */
  timeZone: string
  /** Dates as YYYY-MM-DD in the project's zone. */
  holidays: string[]
}

export const DEFAULT_CALENDAR: ProjectCalendar = {
  workDays: [1, 2, 3, 4, 5],
  timeZone: 'UTC',
  holidays: [],
}

/**
 * The frozen record of how one deadline was reached.
 *
 * Stored with the clock and never recomputed. A contract's holidays get
 * edited, a work week gets corrected, and the deadline a notice was served
 * against has to stay the one the system actually showed at the time. A
 * deadline you cannot show your work for is a deadline nobody will rely on.
 */
export interface DeadlineComputation {
  startedAt: string
  duration: { value: number; unit: DurationUnit }
  workDays: number[]
  timeZone: string
  holidaysApplied: string[]
  /** Every day counted, in order, with why it counted or did not. */
  steps: string[]
  dueOn: string
  notes: string[]
}

export interface DeadlineResult {
  /** End of the due day, in the project's zone, as an instant. */
  dueAt: Date
  dueOn: string
  computation: DeadlineComputation
}

const MS_PER_DAY = 86_400_000

/** YYYY-MM-DD for an instant, read in a given zone. */
export function civilDate(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
  // en-CA already formats as YYYY-MM-DD; normalising anyway because a runtime
  // that disagrees would otherwise produce dates that are wrong by a century
  // and still parse.
  const [y, m, d] = parts.split('-')
  return `${y}-${m}-${d}`
}

/** Civil date arithmetic on the YYYY-MM-DD string, with no zone involved. */
export function addCalendarDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * MS_PER_DAY)
  return shifted.toISOString().slice(0, 10)
}

/** 1 = Monday through 7 = Sunday, matching ISO and the stored work week. */
export function isoWeekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return day === 0 ? 7 : day
}

export function isWorkingDay(date: string, calendar: ProjectCalendar): boolean {
  if (!calendar.workDays.includes(isoWeekday(date))) return false
  return !calendar.holidays.includes(date)
}

export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const target = new Date(Date.UTC(y, m - 1 + months, 1))
  // Clamp rather than roll over. "One month from 31 January" is 28 February,
  // not 3 March: rolling forward would compute a deadline LATER than the one
  // a reader of the contract would write down, which is the direction that
  // loses claims.
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  const day = Math.min(d, lastDay)
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * The end of a civil day in a zone, as an instant.
 *
 * Built by probing the offset at midday on that date rather than by string
 * surgery, so it survives DST without a table. Deliberately the LAST moment of
 * the day: a notice served at 4pm on the due date is timely, and a system that
 * computed the deadline as the start of the day would call it late.
 */
export function endOfDay(date: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const noonUtc = Date.UTC(y, m - 1, d, 12)
  const offsetMs = zoneOffsetMs(new Date(noonUtc), timeZone)
  const localEnd = Date.UTC(y, m - 1, d, 23, 59, 59, 999)
  return new Date(localEnd - offsetMs)
}

function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  // Intl renders midnight as hour 24 in some runtimes; 24 is the same instant
  // as 0 on that date for offset purposes.
  const hour = get('hour') % 24
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'))
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

export interface DeadlineInput {
  /** When the clock started, as an instant. */
  startedAt: Date
  value: number
  unit: DurationUnit
  calendar: ProjectCalendar
  /**
   * Whether the day the clock started counts as day one.
   *
   * Contracts are split on this and most are silent. The default is false
   * ("within ten days after") because that is the common drafting, but where
   * a contract is ambiguous the caller passes true, which produces the
   * EARLIER deadline. Bias early.
   */
  countStartDay?: boolean
  /**
   * Whether a deadline landing on a non-working day rolls forward.
   *
   * Default false, and that default is a deliberate refusal of a convenience.
   * Many contracts do roll a deadline to the next business day; many say
   * nothing. Rolling forward by default would manufacture extra time the
   * contract may not give, which is the one error that costs a claim.
   */
  rollForward?: boolean
}

export function computeDeadline(input: DeadlineInput): DeadlineResult {
  const { calendar, value, unit } = input
  const notes: string[] = []
  const steps: string[] = []

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`A duration must be a whole number of ${unit}, got ${value}`)
  }

  const startOn = civilDate(input.startedAt, calendar.timeZone)
  let dueOn: string

  if (unit === 'business_days') {
    const countStart = input.countStartDay === true
    let counted = 0
    let cursor = startOn

    if (countStart && isWorkingDay(startOn, calendar)) {
      counted = 1
      steps.push(`${startOn} counted as day 1 (the contract counts the day of the event)`)
    }

    // A guard rather than a while(true). A calendar with no working days is
    // rejected at the schema, but a holiday list that swallows a season is
    // not, and an unbounded loop in deadline code is how a worker wedges.
    //
    // The slack is ninety calendar days beyond what the count needs. A window
    // that cannot close inside that is not a long shutdown, it is a calendar
    // somebody entered wrong, and the right answer is to say so loudly rather
    // than to return a deadline three years out that nobody reads.
    const limit = Math.max(value, 1) * 7 + 90
    let iterations = 0

    while (counted < value) {
      cursor = addCalendarDays(cursor, 1)
      iterations += 1
      if (iterations > limit) {
        throw new Error(`Could not reach ${value} business days from ${startOn}; check the project calendar`)
      }
      if (isWorkingDay(cursor, calendar)) {
        counted += 1
        steps.push(`${cursor} counted as day ${counted}`)
      } else {
        const why = calendar.holidays.includes(cursor) ? 'holiday' : 'not a work day'
        steps.push(`${cursor} skipped (${why})`)
      }
    }
    dueOn = value === 0 ? startOn : cursor
  } else {
    const offset = unit === 'weeks' ? value * 7 : value
    dueOn =
      unit === 'months'
        ? addMonths(startOn, value)
        : addCalendarDays(startOn, input.countStartDay === true ? Math.max(offset - 1, 0) : offset)
    steps.push(
      `${startOn} plus ${value} ${unit}${input.countStartDay === true ? ', counting the start day' : ''} = ${dueOn}`,
    )
  }

  const holidaysApplied = calendar.holidays.filter((h) => h >= startOn && h <= dueOn)

  if (input.rollForward === true) {
    let rolled = dueOn
    let guard = 0
    while (!isWorkingDay(rolled, calendar)) {
      rolled = addCalendarDays(rolled, 1)
      if ((guard += 1) > 400) throw new Error(`Could not roll ${dueOn} forward to a work day; check the calendar`)
    }
    if (rolled !== dueOn) {
      notes.push(`Rolled from ${dueOn} to ${rolled}: the contract moves a deadline off a non-working day.`)
      steps.push(`${dueOn} is not a work day, rolled to ${rolled}`)
      dueOn = rolled
    }
  } else if (!isWorkingDay(dueOn, calendar)) {
    // Said out loud rather than fixed. Somebody has to serve a notice on a
    // Saturday, or read the contract and tell the system to roll it.
    notes.push(
      `${dueOn} is not a working day on this project, and this contract has not been marked as rolling deadlines forward. The deadline stands.`,
    )
  }

  return {
    dueAt: endOfDay(dueOn, calendar.timeZone),
    dueOn,
    computation: {
      startedAt: input.startedAt.toISOString(),
      duration: { value, unit },
      workDays: [...calendar.workDays],
      timeZone: calendar.timeZone,
      holidaysApplied,
      steps,
      dueOn,
      notes,
    },
  }
}

/**
 * When to start bothering somebody about a clock.
 *
 * Half the window, floored at one working day before the deadline. Half is
 * arbitrary and is meant to be: the real constraint is that the warning must
 * land while there is still time to draft, review and serve, and on a five day
 * notice window that is about two days.
 */
export function warnAt(startedAt: Date, dueAt: Date, calendar: ProjectCalendar): Date {
  const halfway = new Date(startedAt.getTime() + (dueAt.getTime() - startedAt.getTime()) / 2)

  const dueOn = civilDate(dueAt, calendar.timeZone)
  let oneWorkDayBefore = addCalendarDays(dueOn, -1)
  let guard = 0
  while (!isWorkingDay(oneWorkDayBefore, calendar)) {
    oneWorkDayBefore = addCalendarDays(oneWorkDayBefore, -1)
    if ((guard += 1) > 400) break
  }
  const floor = endOfDay(oneWorkDayBefore, calendar.timeZone)

  // Whichever comes first, and never after the deadline itself. A warning that
  // arrives on the due date is not a warning.
  const earliest = halfway.getTime() < floor.getTime() ? halfway : floor
  return earliest.getTime() < startedAt.getTime() ? startedAt : earliest
}
