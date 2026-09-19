import { describe, expect, it } from 'vitest'
import {
  addCalendarDays,
  addMonths,
  civilDate,
  computeDeadline,
  endOfDay,
  isWorkingDay,
  isoWeekday,
  warnAt,
  type ProjectCalendar,
} from '../src/contracts/calendar.js'

/**
 * The arithmetic that decides whether anyone trusts this product.
 *
 * Every case here is written from the direction of the error that costs
 * money. A deadline computed EARLIER than the truth is noise somebody
 * ignores. A deadline computed LATER than the truth is a claim waived on its
 * merits unheard, and the assertions are chosen to catch that direction
 * first.
 */

const DENVER: ProjectCalendar = {
  workDays: [1, 2, 3, 4, 5],
  timeZone: 'America/Denver',
  holidays: ['2026-07-03', '2026-09-07', '2026-11-26', '2026-11-27'],
}

const SIX_DAY: ProjectCalendar = { workDays: [1, 2, 3, 4, 5, 6], timeZone: 'America/Denver', holidays: [] }

describe('civil dates', () => {
  it('reads the date in the job’s zone, not the server’s', () => {
    // 06:00 UTC on the 12th is still the 11th in Denver. A clock that started
    // at 11pm local must not count from the following day.
    const lateEvening = new Date('2026-06-12T04:00:00Z')
    expect(civilDate(lateEvening, 'UTC')).toBe('2026-06-12')
    expect(civilDate(lateEvening, 'America/Denver')).toBe('2026-06-11')
  })

  it('counts weekdays the way the contract does', () => {
    expect(isoWeekday('2026-06-15')).toBe(1)
    expect(isoWeekday('2026-06-20')).toBe(6)
    expect(isoWeekday('2026-06-21')).toBe(7)
  })

  it('crosses months, years and a leap day without drifting', () => {
    expect(addCalendarDays('2026-12-30', 5)).toBe('2027-01-04')
    expect(addCalendarDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addCalendarDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('clamps a month rather than rolling it forward', () => {
    // One month from 31 January is 28 February. Rolling to 3 March would
    // invent three days the contract never gave.
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29')
    expect(addMonths('2026-08-31', 6)).toBe('2027-02-28')
  })

  it('treats a holiday as a non-working day even on a Tuesday', () => {
    expect(isWorkingDay('2026-09-07', DENVER)).toBe(false)
    expect(isWorkingDay('2026-09-08', DENVER)).toBe(true)
    expect(isWorkingDay('2026-06-20', DENVER)).toBe(false)
    expect(isWorkingDay('2026-06-20', SIX_DAY)).toBe(true)
  })

  it('ends the day at the last moment of it, in the job’s zone', () => {
    // A notice served at 4pm on the due date is timely. A deadline computed
    // as the start of the day would call it late, which is the whole product
    // failing at the last step.
    const end = endOfDay('2026-06-15', 'America/Denver')
    expect(civilDate(end, 'America/Denver')).toBe('2026-06-15')
    expect(end.toISOString()).toBe('2026-06-16T05:59:59.999Z')
  })

  it('survives the day the clocks change', () => {
    // 8 March 2026 is the spring-forward Sunday in Denver: a 23 hour day.
    const before = endOfDay('2026-03-07', 'America/Denver')
    const after = endOfDay('2026-03-08', 'America/Denver')
    expect(civilDate(before, 'America/Denver')).toBe('2026-03-07')
    expect(civilDate(after, 'America/Denver')).toBe('2026-03-08')
    expect(after.getTime() - before.getTime()).toBe(23 * 3_600_000)
  })
})

describe('calendar-day deadlines', () => {
  it('counts from the day after the event by default', () => {
    const { dueOn } = computeDeadline({
      startedAt: new Date('2026-06-15T15:00:00Z'),
      value: 10,
      unit: 'days',
      calendar: DENVER,
    })
    expect(dueOn).toBe('2026-06-25')
  })

  it('counts the day of the event when the contract says so, which is earlier', () => {
    const inclusive = computeDeadline({
      startedAt: new Date('2026-06-15T15:00:00Z'),
      value: 10,
      unit: 'days',
      calendar: DENVER,
      countStartDay: true,
    })
    expect(inclusive.dueOn).toBe('2026-06-24')
  })

  it('handles weeks and months', () => {
    expect(
      computeDeadline({ startedAt: new Date('2026-06-15T15:00:00Z'), value: 3, unit: 'weeks', calendar: DENVER })
        .dueOn,
    ).toBe('2026-07-06')
    expect(
      computeDeadline({ startedAt: new Date('2026-01-31T15:00:00Z'), value: 1, unit: 'months', calendar: DENVER })
        .dueOn,
    ).toBe('2026-02-28')
  })

  it('says a deadline lands on a Saturday rather than quietly moving it', () => {
    const result = computeDeadline({
      startedAt: new Date('2026-06-15T15:00:00Z'),
      value: 5,
      unit: 'days',
      calendar: DENVER,
    })
    expect(result.dueOn).toBe('2026-06-20')
    expect(isWorkingDay(result.dueOn, DENVER)).toBe(false)
    // Not rolled. Rolling by default would manufacture two days the contract
    // may not give, and somebody would rely on them.
    expect(result.computation.notes.join(' ')).toMatch(/not a working day/)
  })

  it('rolls forward only when the contract has been read and marked', () => {
    const result = computeDeadline({
      startedAt: new Date('2026-06-15T15:00:00Z'),
      value: 5,
      unit: 'days',
      calendar: DENVER,
      rollForward: true,
    })
    expect(result.dueOn).toBe('2026-06-22')
    expect(result.computation.notes.join(' ')).toMatch(/Rolled from 2026-06-20/)
  })
})

describe('business-day deadlines', () => {
  it('skips weekends', () => {
    // Monday 15 June plus five business days is Monday 22 June.
    const { dueOn, computation } = computeDeadline({
      startedAt: new Date('2026-06-15T15:00:00Z'),
      value: 5,
      unit: 'business_days',
      calendar: DENVER,
    })
    expect(dueOn).toBe('2026-06-22')
    expect(computation.steps.filter((s) => s.includes('skipped'))).toHaveLength(2)
  })

  it('skips holidays, and names which ones it applied', () => {
    // Monday 31 August plus five business days crosses Labor Day.
    const { dueOn, computation } = computeDeadline({
      startedAt: new Date('2026-08-31T15:00:00Z'),
      value: 5,
      unit: 'business_days',
      calendar: DENVER,
    })
    expect(dueOn).toBe('2026-09-08')
    expect(computation.holidaysApplied).toEqual(['2026-09-07'])
    expect(computation.steps.some((s) => s.includes('2026-09-07 skipped (holiday)'))).toBe(true)
  })

  it('gives a six day job a shorter window than a five day one', () => {
    const five = computeDeadline({
      startedAt: new Date('2026-06-15T15:00:00Z'),
      value: 10,
      unit: 'business_days',
      calendar: { ...DENVER, holidays: [] },
    })
    const six = computeDeadline({
      startedAt: new Date('2026-06-15T15:00:00Z'),
      value: 10,
      unit: 'business_days',
      calendar: SIX_DAY,
    })
    expect(five.dueOn).toBe('2026-06-29')
    expect(six.dueOn).toBe('2026-06-26')
  })

  it('counts the start day when told to, and only if it is a work day', () => {
    const fromSaturday = computeDeadline({
      startedAt: new Date('2026-06-20T15:00:00Z'),
      value: 3,
      unit: 'business_days',
      calendar: DENVER,
      countStartDay: true,
    })
    // Saturday cannot be day one, so the count starts Monday and the deadline
    // is Wednesday.
    expect(fromSaturday.dueOn).toBe('2026-06-24')

    const fromMonday = computeDeadline({
      startedAt: new Date('2026-06-15T15:00:00Z'),
      value: 3,
      unit: 'business_days',
      calendar: DENVER,
      countStartDay: true,
    })
    expect(fromMonday.dueOn).toBe('2026-06-17')
  })

  it('refuses a calendar it cannot finish counting on', () => {
    const shutdown: ProjectCalendar = {
      workDays: [1, 2, 3, 4, 5],
      timeZone: 'America/Denver',
      // A shutdown longer than the guard allows. Better a loud failure than a
      // worker spinning on a deadline nobody is watching.
      holidays: Array.from({ length: 400 }, (_, i) => addCalendarDays('2026-06-16', i)),
    }
    expect(() =>
      computeDeadline({ startedAt: new Date('2026-06-15T15:00:00Z'), value: 5, unit: 'business_days', calendar: shutdown }),
    ).toThrow(/check the project calendar/)
  })

  it('rejects a duration that is not a whole number of days', () => {
    expect(() =>
      computeDeadline({ startedAt: new Date('2026-06-15T15:00:00Z'), value: -3, unit: 'days', calendar: DENVER }),
    ).toThrow(/whole number/)
    expect(() =>
      computeDeadline({ startedAt: new Date('2026-06-15T15:00:00Z'), value: 2.5, unit: 'days', calendar: DENVER }),
    ).toThrow(/whole number/)
  })
})

describe('showing the work', () => {
  it('records every day it counted and every one it did not', () => {
    const { computation } = computeDeadline({
      startedAt: new Date('2026-11-23T15:00:00Z'),
      value: 5,
      unit: 'business_days',
      calendar: DENVER,
    })
    // Thanksgiving week: two holidays and a weekend inside a five day window.
    expect(computation.dueOn).toBe('2026-12-02')
    expect(computation.holidaysApplied).toEqual(['2026-11-26', '2026-11-27'])
    expect(computation.timeZone).toBe('America/Denver')
    expect(computation.workDays).toEqual([1, 2, 3, 4, 5])
    // The whole point: a person can read this back and check it by hand.
    expect(computation.steps.length).toBeGreaterThanOrEqual(9)
  })
})

describe('when to start bothering somebody', () => {
  it('warns at the halfway point of a long window', () => {
    const startedAt = new Date('2026-06-15T15:00:00Z')
    const { dueAt } = computeDeadline({ startedAt, value: 21, unit: 'days', calendar: DENVER })
    const warn = warnAt(startedAt, dueAt, DENVER)
    expect(civilDate(warn, 'America/Denver')).toBe('2026-06-26')
  })

  it('warns at least a working day out on a short window', () => {
    const startedAt = new Date('2026-06-15T15:00:00Z')
    const { dueAt } = computeDeadline({ startedAt, value: 2, unit: 'days', calendar: DENVER })
    const warn = warnAt(startedAt, dueAt, DENVER)
    // Halfway would be mid-Tuesday; the floor pulls it to end of Tuesday at
    // the latest, and never to the due date itself.
    expect(warn.getTime()).toBeLessThan(dueAt.getTime())
    expect(civilDate(warn, 'America/Denver')).toBe('2026-06-16')
  })

  it('skips back over a weekend to find the working day before', () => {
    // Deadline Monday: the warning belongs on the preceding Friday, not on
    // the Sunday nobody reads.
    const startedAt = new Date('2026-06-18T15:00:00Z')
    const { dueAt, dueOn } = computeDeadline({ startedAt, value: 4, unit: 'days', calendar: DENVER })
    expect(dueOn).toBe('2026-06-22')
    const warn = warnAt(startedAt, dueAt, DENVER)
    expect(isWorkingDay(civilDate(warn, 'America/Denver'), DENVER)).toBe(true)
  })

  it('never warns before the clock started', () => {
    const startedAt = new Date('2026-06-15T15:00:00Z')
    const { dueAt } = computeDeadline({ startedAt, value: 0, unit: 'days', calendar: DENVER })
    expect(warnAt(startedAt, dueAt, DENVER).getTime()).toBeGreaterThanOrEqual(startedAt.getTime())
  })
})
