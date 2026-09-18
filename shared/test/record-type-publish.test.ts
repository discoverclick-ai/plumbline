import { describe, expect, it } from 'vitest'
import { checkCompatibility, type TypeUsage } from '../src/record-type-publish.js'
import { parseRecordTypeDefinition } from '../src/record-type.js'

/**
 * The gate that stands between "a tool is configuration" and "somebody's job
 * is stopped and nobody can say why".
 */

function definition(
  overrides: { fields?: unknown[]; states?: unknown[]; transitions?: unknown[]; initial?: string } = {},
) {
  return parseRecordTypeDefinition({
    fields: overrides.fields ?? [
      { key: 'description', label: 'Description', type: 'multiline', required: true },
      { key: 'priority', label: 'Priority', type: 'select', options: ['Low', 'Medium', 'High'], default: 'Medium' },
    ],
    workflow: {
      initial: overrides.initial ?? 'draft',
      states: overrides.states ?? [
        { key: 'draft', label: 'Draft', ballInCourt: 'creator' },
        { key: 'open', label: 'Open', ballInCourt: 'assignee' },
        { key: 'closed', label: 'Closed', terminal: true, ballInCourt: 'none' },
      ],
      transitions: overrides.transitions ?? [
        { key: 'issue', label: 'Issue', from: ['draft'], to: 'open', requires: { level: 'standard' } },
        { key: 'close', label: 'Close', from: ['open'], to: 'closed', requires: { level: 'standard' } },
      ],
    },
  })
}

function usage(over: Partial<TypeUsage> = {}): TypeUsage {
  return {
    statusCounts: over.statusCounts ?? new Map([['open', 12]]),
    fieldCounts: over.fieldCounts ?? new Map([['description', 12]]),
    selectValues: over.selectValues ?? new Map(),
  }
}

describe('publishing a definition over live records', () => {
  it('allows a change nothing is using', () => {
    expect(checkCompatibility(definition(), usage())).toEqual([])
  })

  it('refuses to delete a state records are sitting in, and counts them', () => {
    const next = definition({
      states: [
        { key: 'draft', label: 'Draft', ballInCourt: 'creator' },
        { key: 'closed', label: 'Closed', terminal: true, ballInCourt: 'none' },
      ],
      transitions: [{ key: 'close', label: 'Close', from: ['draft'], to: 'closed', requires: { level: 'standard' } }],
    })
    const problems = checkCompatibility(next, usage())
    expect(problems).toHaveLength(1)
    expect(problems[0]?.kind).toBe('status_removed')
    expect(problems[0]?.affectedRecords).toBe(12)
  })

  it('refuses a change that leaves records in a state with no way out', () => {
    // The state survives. Every transition out of it does not. This is the
    // one that does real damage, because the records look fine until somebody
    // tries to move one.
    const next = definition({
      transitions: [{ key: 'issue', label: 'Issue', from: ['draft'], to: 'open', requires: { level: 'standard' } }],
    })
    const problems = checkCompatibility(next, usage())
    expect(problems).toHaveLength(1)
    expect(problems[0]?.kind).toBe('state_stranded')
    expect(problems[0]?.detail).toContain('no transitions out')
  })

  it('does not mind a terminal state having no way out, because that is what terminal means', () => {
    expect(checkCompatibility(definition(), usage({ statusCounts: new Map([['closed', 40]]) }))).toEqual([])
  })

  it('refuses to delete a field that holds values', () => {
    const next = definition({ fields: [{ key: 'priority', label: 'Priority', type: 'text' }] })
    const problems = checkCompatibility(next, usage())
    expect(problems.map((p) => p.kind)).toContain('field_removed')
  })

  it('refuses to narrow a dropdown out from under the records holding the dropped value', () => {
    const next = definition({
      fields: [
        { key: 'description', label: 'Description', type: 'multiline', required: true },
        { key: 'priority', label: 'Priority', type: 'select', options: ['Low', 'High'], default: 'Low' },
      ],
    })
    const problems = checkCompatibility(
      next,
      usage({
        fieldCounts: new Map([
          ['description', 12],
          ['priority', 12],
        ]),
        selectValues: new Map([['priority', new Set(['Low', 'Medium', 'High'])]]),
      }),
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]?.kind).toBe('option_removed')
    expect(problems[0]?.detail).toContain('"Medium"')
  })

  it('allows widening a dropdown', () => {
    const next = definition({
      fields: [
        { key: 'description', label: 'Description', type: 'multiline', required: true },
        {
          key: 'priority',
          label: 'Priority',
          type: 'select',
          options: ['Low', 'Medium', 'High', 'Critical'],
          default: 'Medium',
        },
      ],
    })
    expect(
      checkCompatibility(
        next,
        usage({
          fieldCounts: new Map([
            ['description', 12],
            ['priority', 12],
          ]),
          selectValues: new Map([['priority', new Set(['Low', 'Medium'])]]),
        }),
      ),
    ).toEqual([])
  })

  it('refuses a newly required field with no default while records exist', () => {
    const next = definition({
      fields: [
        { key: 'description', label: 'Description', type: 'multiline', required: true },
        { key: 'trade', label: 'Trade', type: 'text', required: true },
      ],
    })
    const problems = checkCompatibility(next, usage())
    expect(problems).toHaveLength(1)
    expect(problems[0]?.kind).toBe('required_field_added')
  })

  it('allows a newly required field that carries a default', () => {
    const next = definition({
      fields: [
        { key: 'description', label: 'Description', type: 'multiline', required: true },
        { key: 'trade', label: 'Trade', type: 'text', required: true, default: 'General' },
      ],
    })
    expect(checkCompatibility(next, usage())).toEqual([])
  })

  it('allows anything at all when the type has no records yet', () => {
    const next = definition({
      fields: [],
      initial: 'brand_new',
      states: [{ key: 'brand_new', label: 'Brand New', ballInCourt: 'creator' }],
      transitions: [],
    })
    expect(
      checkCompatibility(next, { statusCounts: new Map(), fieldCounts: new Map(), selectValues: new Map() }),
    ).toEqual([])
  })

  it('reports every problem at once rather than the first', () => {
    const next = definition({
      fields: [{ key: 'trade', label: 'Trade', type: 'text', required: true }],
      states: [{ key: 'draft', label: 'Draft', ballInCourt: 'creator' }],
      transitions: [],
    })
    const kinds = checkCompatibility(next, usage()).map((p) => p.kind)
    expect(kinds).toContain('status_removed')
    expect(kinds).toContain('field_removed')
    expect(kinds).toContain('required_field_added')
  })
})
