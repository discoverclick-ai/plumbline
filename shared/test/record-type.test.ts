import { describe, expect, it } from 'vitest'
import { ValidationError } from '../src/errors.js'
import { normalizeBody, parseRecordTypeDefinition, type FieldSpec } from '../src/record-type.js'

/**
 * Type definitions are data loaded from the database, which makes them input.
 * These tests pin the two things that matter: a bad definition fails loudly at
 * load, and a body is normalized the same way whether it came from a form, an
 * import, or an agent.
 */

const VALID = {
  fields: [{ key: 'question', label: 'Question', type: 'multiline', required: true }],
  workflow: {
    initial: 'draft',
    states: [
      { key: 'draft', label: 'Draft', ballInCourt: 'creator' },
      { key: 'open', label: 'Open', ballInCourt: 'assignee' },
    ],
    transitions: [
      { key: 'submit', label: 'Submit', from: ['draft'], to: 'open', requires: { level: 'standard' } },
    ],
  },
}

describe('parseRecordTypeDefinition', () => {
  it('accepts a well-formed definition', () => {
    const definition = parseRecordTypeDefinition(VALID)
    expect(definition.fields).toHaveLength(1)
    expect(definition.workflow.transitions[0]?.key).toBe('submit')
  })

  it('rejects a transition pointing at a state that does not exist', () => {
    const broken = structuredClone(VALID)
    broken.workflow.transitions[0]!.to = 'nowhere'
    // Left unchecked this strands records in a status nothing can act on.
    expect(() => parseRecordTypeDefinition(broken)).toThrow(/unknown state "nowhere"/)
  })

  it('rejects an initial state that does not exist', () => {
    const broken = structuredClone(VALID)
    broken.workflow.initial = 'missing'
    expect(() => parseRecordTypeDefinition(broken)).toThrow(/workflow.initial/)
  })

  it('rejects a select field with no options', () => {
    const broken = structuredClone(VALID)
    broken.fields.push({ key: 'trade', label: 'Trade', type: 'select', required: false })
    expect(() => parseRecordTypeDefinition(broken)).toThrow(/needs options/)
  })

  it('rejects an unknown permission level on a transition', () => {
    const broken = structuredClone(VALID)
    broken.workflow.transitions[0]!.requires.level = 'superuser'
    expect(() => parseRecordTypeDefinition(broken)).toThrow(/unknown level/)
  })

  it('rejects requiresFields naming a field that does not exist', () => {
    const broken = structuredClone(VALID) as Record<string, any>
    broken['workflow'].transitions[0].requiresFields = ['ghost']
    expect(() => parseRecordTypeDefinition(broken)).toThrow(/unknown field "ghost"/)
  })
})

const FIELDS: FieldSpec[] = [
  { key: 'question', label: 'Question', type: 'multiline', required: true },
  { key: 'count', label: 'Workers', type: 'number' },
  { key: 'urgent', label: 'Urgent', type: 'boolean' },
  { key: 'log_date', label: 'Date', type: 'date' },
  { key: 'impact', label: 'Cost Impact', type: 'select', options: ['Yes', 'No', 'TBD'], default: 'TBD' },
]

describe('normalizeBody', () => {
  it('coerces the strings a form or an agent will send', () => {
    const body = normalizeBody(FIELDS, {
      question: 'Which detail governs?',
      count: '14',
      urgent: 'true',
      log_date: '2026-03-02',
    })
    expect(body['count']).toBe(14)
    expect(body['urgent']).toBe(true)
    expect(body['log_date']).toBe('2026-03-02')
  })

  it('applies defaults for fields the caller left out', () => {
    const body = normalizeBody(FIELDS, { question: 'q' })
    expect(body['impact']).toBe('TBD')
  })

  it('drops keys the type does not declare', () => {
    const body = normalizeBody(FIELDS, { question: 'q', smuggled: 'value' })
    expect(Object.keys(body)).not.toContain('smuggled')
  })

  it('collects every issue rather than stopping at the first', () => {
    try {
      normalizeBody(FIELDS, { count: 'fourteen', impact: 'Maybe' })
      expect.unreachable('invalid body should not normalize')
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError)
      const fields = (err as ValidationError).issues.map((i) => i.field)
      expect(fields).toContain('question')
      expect(fields).toContain('count')
      expect(fields).toContain('impact')
    }
  })

  it('leaves absent fields alone in partial mode, so an edit cannot blank them', () => {
    const body = normalizeBody(FIELDS, { count: 9 }, { partial: true })
    expect(body).toEqual({ count: 9 })
  })
})
