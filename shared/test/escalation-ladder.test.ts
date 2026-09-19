import { describe, expect, it } from 'vitest'
import { audienceFor, DEFAULT_LADDER, levelFor, type OverdueItem } from '../src/escalation.js'

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
