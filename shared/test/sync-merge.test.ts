import { describe, expect, it } from 'vitest'
import { canApplyTo, mergeBody } from '../src/sync/merge.js'

/**
 * The piece that decides whose afternoon survives.
 *
 * Two people editing one record offline is normal on a job, not an edge case,
 * and last-write-wins throws away real work with no trace. These are the rules
 * that stop that, and they are pure so they can be argued with directly.
 */

describe('merging an offline edit', () => {
  it('applies a field only the device changed', () => {
    const result = mergeBody(
      { description: 'Loose handrail', priority: 'Medium' },
      { description: 'Loose handrail', priority: 'Medium' },
      { description: 'Loose handrail at the level 4 stair', priority: 'Medium' },
    )
    expect(result.merged).toEqual({ description: 'Loose handrail at the level 4 stair' })
    expect(result.applied).toEqual(['description'])
    expect(result.conflicts).toEqual([])
  })

  it('keeps a field only the server changed, without reporting anything', () => {
    const result = mergeBody(
      { description: 'Loose handrail', priority: 'Medium' },
      { description: 'Loose handrail', priority: 'High' },
      { description: 'Loose handrail', priority: 'Medium' },
    )
    // The device is carrying a field it never touched, which is what happens
    // when a client sends the whole body back.
    expect(result.merged).toEqual({})
    expect(result.conflicts).toEqual([])
    expect(result.dropped).toEqual([])
  })

  it('keeps both edits when they are to different fields', () => {
    // The case that matters most: a superintendent fixes the description in a
    // basement while a PM sets the priority at a desk, and last-write-wins
    // would throw one of them away.
    const result = mergeBody(
      { description: 'Loose handrail', priority: 'Medium', trade: 'Steel' },
      { description: 'Loose handrail', priority: 'High', trade: 'Steel' },
      { description: 'Loose handrail at the level 4 stair', priority: 'Medium', trade: 'Steel' },
    )
    expect(result.merged).toEqual({ description: 'Loose handrail at the level 4 stair' })
    expect(result.applied).toEqual(['description'])
    expect(result.conflicts).toEqual([])
  })

  it('says nothing when both people typed the same thing', () => {
    const result = mergeBody({ priority: 'Medium' }, { priority: 'High' }, { priority: 'High' })
    // Reporting this as a conflict would train people to ignore the log.
    expect(result.conflicts).toEqual([])
    expect(result.dropped).toEqual([])
  })

  it('conflicts when both changed the same field differently, and keeps both values', () => {
    const result = mergeBody({ priority: 'Medium' }, { priority: 'High' }, { priority: 'Low' })
    expect(result.merged).toEqual({})
    expect(result.dropped).toEqual(['priority'])
    expect(result.conflicts).toEqual([
      { field: 'priority', base: 'Medium', server: 'High', device: 'Low' },
    ])
  })

  it('treats a field the record never had as the device adding it', () => {
    const result = mergeBody({}, {}, { location: 'Level 4 stair' })
    expect(result.merged).toEqual({ location: 'Level 4 stair' })
    expect(result.applied).toEqual(['location'])
  })

  it('compares objects and arrays by value, not identity', () => {
    // A field can legitimately hold a list, and comparing by identity would
    // call every untouched one a conflict.
    const result = mergeBody(
      { tags: ['safety', 'level-4'] },
      { tags: ['safety', 'level-4'] },
      { tags: ['safety', 'level-4'] },
    )
    expect(result.applied).toEqual([])
    expect(result.conflicts).toEqual([])
  })

  it('handles a field cleared on the device', () => {
    const result = mergeBody({ trade: 'Steel' }, { trade: 'Steel' }, { trade: null })
    expect(result.merged).toEqual({ trade: null })
    expect(result.applied).toEqual(['trade'])
  })
})

describe('whether an operation may be applied at all', () => {
  it('refuses to edit a record that has since closed', () => {
    // A device dark for a fortnight can be pushing an edit to something that
    // is finished, and applying it would reopen the past.
    expect(canApplyTo('closed', ['closed', 'void'])).toBe(false)
    expect(canApplyTo('void', ['closed', 'void'])).toBe(false)
    expect(canApplyTo('open', ['closed', 'void'])).toBe(true)
  })
})

describe('telling a blend from a clean apply', () => {
  it('reports the server moved on, even on a field the device never sent', () => {
    // The distinction a client shows the person: "your edit went in as you
    // left it" against "somebody else had changed this too".
    const result = mergeBody(
      { description: 'Loose handrail', priority: 'Medium' },
      { description: 'Loose handrail', priority: 'High' },
      { description: 'Loose handrail at the level 4 stair' },
    )
    expect(result.serverAlsoChanged).toBe(true)
    expect(result.applied).toEqual(['description'])
  })

  it('reports nothing moved when the server is still at the base', () => {
    const result = mergeBody(
      { description: 'Loose handrail', priority: 'Medium' },
      { description: 'Loose handrail', priority: 'Medium' },
      { description: 'Loose handrail at the level 4 stair', priority: 'Medium' },
    )
    expect(result.serverAlsoChanged).toBe(false)
  })
})
