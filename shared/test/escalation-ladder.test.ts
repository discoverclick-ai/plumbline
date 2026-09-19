import { describe, expect, it } from 'vitest'
import { audienceFor, DEFAULT_LADDER, describeImpact, levelFor, type OverdueItem } from '../src/escalation.js'

/**
 * The ladder, argued with directly.
 *
 * Pure, because the rules about when to chase somebody and who to tell are the
 * part that decides whether this tool gets used or filtered into a folder.
 */

function item(overrides: Partial<OverdueItem> = {}): OverdueItem {
  return {
    recordId: 'r1',
    projectId: 'p1',
    assignmentId: 'a1',
    designation: 'RFI-014',
    title: 'Anchor bolt embedment at grid C4',
    typeKey: 'rfi',
    expectedAction: 'Answer this RFI',
    holderId: 'architect',
    holderName: 'Ali Bishop',
    creatorId: 'pm',
    dueAt: new Date('2026-05-01'),
    daysWaiting: 9,
    daysPastDue: 0,
    ...overrides,
  }
}

describe('when something is worth chasing', () => {
  it('nudges before it is due, which is the only rung that prevents anything', () => {
    // A reminder two days out is worth ten escalations a week late.
    expect(levelFor(item({ daysPastDue: -2 }))?.level).toBe('reminder')
    expect(levelFor(item({ daysPastDue: -1 }))?.level).toBe('reminder')
  })

  it('says nothing at all while there is still time', () => {
    expect(levelFor(item({ daysPastDue: -10 }))).toBeNull()
    expect(levelFor(item({ daysPastDue: -3 }))).toBeNull()
  })

  it('climbs one rung at a time', () => {
    expect(levelFor(item({ daysPastDue: 1 }))?.level).toBe('overdue')
    expect(levelFor(item({ daysPastDue: 4 }))?.level).toBe('overdue')
    expect(levelFor(item({ daysPastDue: 5 }))?.level).toBe('escalated')
    expect(levelFor(item({ daysPastDue: 13 }))?.level).toBe('escalated')
    expect(levelFor(item({ daysPastDue: 14 }))?.level).toBe('critical')
  })

  it('reports only the highest rung reached', () => {
    // An item a fortnight late produces one critical, not four escalations on
    // the way up, which is what turns a chase into noise.
    expect(levelFor(item({ daysPastDue: 40 }))?.level).toBe('critical')
  })

  it('leaves alone anything with no due date', () => {
    // Plenty of work has no contractual clock on it, and inventing one to
    // justify a reminder is how a tool loses the room.
    expect(levelFor(item({ daysPastDue: null, dueAt: null }))).toBeNull()
  })
})

describe('who gets told', () => {
  it('starts with the person actually holding it', () => {
    expect(audienceFor(item(), 'reminder')).toBe('architect')
    expect(audienceFor(item(), 'overdue')).toBe('architect')
  })

  it('goes to whoever raised it once it is genuinely late', () => {
    // They carry the consequence and they are the one who can decide to work
    // around it. Nobody is escalated to their own boss by surprise.
    expect(audienceFor(item(), 'escalated')).toBe('pm')
    expect(audienceFor(item(), 'critical')).toBe('pm')
  })

  it('falls back to the holder when nobody raised it', () => {
    expect(audienceFor(item({ creatorId: null }), 'critical')).toBe('architect')
  })
})

describe('the ladder itself', () => {
  it('is short enough that each rung still means something', () => {
    // Four rungs is enough to be taken seriously and few enough that none of
    // them is ignored. A longer ladder is a filter rule.
    expect(DEFAULT_LADDER).toHaveLength(4)
    expect(DEFAULT_LADDER.filter((r) => r.daysPastDue < 0)).toHaveLength(1)
  })
})

describe('what the chase actually says', () => {
  it('names the activity, when it starts, and how much room is left', () => {
    // "RFI-014 is eleven days overdue" is a nag somebody files. This is a
    // phone call, because it tells the reader what it costs them to keep
    // sitting on it.
    expect(
      describeImpact({ activityName: 'Erect structural steel', startAt: '2026-03-05', floatDays: 2 }),
    ).toBe('This is holding up Erect structural steel, which starts 2026-03-05 with 2 days of float.')

    expect(describeImpact({ activityName: 'Install curtain wall', startAt: '2026-04-01', floatDays: 1 })).toContain(
      '1 day of float',
    )
  })

  it('says critical path rather than zero days of float', () => {
    expect(describeImpact({ activityName: 'Pour slab', startAt: '2026-03-09', floatDays: 0 })).toMatch(
      /on the critical path/,
    )
    expect(describeImpact({ activityName: 'Pour slab', startAt: '2026-03-09', floatDays: -3 })).toMatch(
      /on the critical path/,
    )
  })

  it('does not subtract the days already waited', () => {
    // That subtraction is a judgement a scheduler would not sign. The reader
    // can do it in their head, and they will.
    const line = describeImpact({ activityName: 'Erect steel', startAt: '2026-03-05', floatDays: 2 })
    expect(line).toContain('2 days of float')
    // No negative float, and no arithmetic the schedule did not do.
    expect(line).not.toMatch(/-\d+ days? of float/)
  })

  it('says nothing at all when nothing is linked', () => {
    // An invented consequence is worse than none: the first one a reader
    // checks and finds wrong is the last one they read.
    expect(describeImpact(null)).toBe('')
  })

  it('is honest about an activity with no dates on it', () => {
    expect(describeImpact({ activityName: 'Commissioning', startAt: null, floatDays: null })).toBe(
      'This is holding up Commissioning, which is not yet scheduled.',
    )
  })
})
