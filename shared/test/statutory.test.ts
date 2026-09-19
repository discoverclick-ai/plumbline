import { describe, expect, it } from 'vitest'
import { statutoryDeadline, statutoryWarnOn } from '../src/contracts/statutory.js'

/**
 * Lien arithmetic.
 *
 * Missing a statutory deadline does not waive a claim you might have won. It
 * removes the security for money you have already earned and spent. So the
 * bias is the same as everywhere else in this subsystem and sharper: where
 * there is a choice, compute the EARLIER date.
 */

const plain = (value: number, unit: 'days' | 'months' | 'weeks') => ({
  durationValue: value,
  durationUnit: unit as never,
  monthOffset: null,
  dayOfMonth: null,
})

describe('a plain window', () => {
  it('counts calendar days, never business days', () => {
    // Statutes of limitation run on calendar days unless they say otherwise,
    // and assuming otherwise computes a LATER date, which is the direction
    // that loses the right.
    expect(statutoryDeadline(plain(90, 'days'), '2026-03-02').dueOn).toBe('2026-05-31')
    expect(statutoryDeadline(plain(20, 'days'), '2026-06-15').dueOn).toBe('2026-07-05')
  })

  it('handles months and years-expressed-as-months', () => {
    expect(statutoryDeadline(plain(12, 'months'), '2026-03-02').dueOn).toBe('2027-03-02')
    expect(statutoryDeadline(plain(4, 'months'), '2026-10-31').dueOn).toBe('2027-02-28')
  })

  it('shows its working', () => {
    const { steps } = statutoryDeadline(plain(90, 'days'), '2026-03-02')
    expect(steps[0]).toContain('2026-03-02 plus 90 days')
  })
})

describe('the fifteenth day of the third month', () => {
  const fixed = { durationValue: 0, durationUnit: 'days' as never, monthOffset: 3, dayOfMonth: 15 }

  it('counts to a day of a later month, which no number of days expresses', () => {
    // Several states write the deadline this way. Approximating it as ninety
    // days is the exact failure this subsystem exists to prevent.
    expect(statutoryDeadline(fixed, '2026-03-02').dueOn).toBe('2026-06-15')
    expect(statutoryDeadline(fixed, '2026-03-30').dueOn).toBe('2026-06-15')
    // Same month in, same deadline out, whatever day of it the work stopped.
    expect(statutoryDeadline(fixed, '2026-03-02').dueOn).toBe(statutoryDeadline(fixed, '2026-03-30').dueOn)
  })

  it('crosses a year end', () => {
    expect(statutoryDeadline(fixed, '2026-11-20').dueOn).toBe('2027-02-15')
  })

  it('clamps a day the month does not have rather than rolling forward', () => {
    const thirtyFirst = { durationValue: 0, durationUnit: 'days' as never, monthOffset: 1, dayOfMonth: 31 }
    // The 31st of February is the 28th, not the 3rd of March. Rolling forward
    // would invent days the statute did not give.
    expect(statutoryDeadline(thirtyFirst, '2026-01-10').dueOn).toBe('2026-02-28')
    expect(statutoryDeadline(thirtyFirst, '2028-01-10').dueOn).toBe('2028-02-29')
  })

  it('says when it clamped', () => {
    const thirtyFirst = { durationValue: 0, durationUnit: 'days' as never, monthOffset: 1, dayOfMonth: 31 }
    expect(statutoryDeadline(thirtyFirst, '2026-01-10').steps.join(' ')).toMatch(/clamped from day 31/)
  })
})

describe('when to start warning', () => {
  it('takes the earlier of three quarters elapsed and thirty days out', () => {
    // A year-long window: three quarters elapsed lands in November, well
    // before the thirty-day floor at the end of January, so November wins.
    expect(statutoryWarnOn('2026-03-02', '2027-03-02')).toBe('2026-11-30')
    // A four month window: the thirty-day floor is the earlier of the two.
    expect(statutoryWarnOn('2026-03-02', '2026-07-02')).toBe('2026-06-01')
  })

  it('warns immediately on a short window, which is the right answer', () => {
    // A thirty day preliminary notice window IS a thing to act on the day you
    // learn about it. Waiting to warn until three quarters of it had gone
    // would leave a week for certified mail and a legal description.
    expect(statutoryWarnOn('2026-03-02', '2026-04-01')).toBe('2026-03-02')
  })

  it('never warns after the deadline, or before the clock started', () => {
    expect(statutoryWarnOn('2026-03-02', '2026-03-05') >= '2026-03-02').toBe(true)
    expect(statutoryWarnOn('2026-03-02', '2026-03-05') <= '2026-03-05').toBe(true)
    expect(statutoryWarnOn('2026-03-02', '2026-03-02')).toBe('2026-03-02')
  })
})
