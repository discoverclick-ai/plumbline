import { describe, expect, it } from 'vitest'
import { mapRfiStatus, parseCsv, readColumn, splitName } from '../src/import/procore.js'

/**
 * Reading somebody else's export.
 *
 * All of this is pure, and all of it is the part that actually breaks. A
 * migration that loses a third of the rows to a naive comma split is a
 * migration the customer abandons, and they abandon it quietly, back to the
 * incumbent.
 */

describe('parsing a real export', () => {
  it('keeps a quoted field containing commas in one column', () => {
    const rows = parseCsv(
      ['Number,Subject,Status', '14,"Anchor bolts, grid C4",Open'].join('\n'),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.['Subject']).toBe('Anchor bolts, grid C4')
    expect(rows[0]?.['Status']).toBe('Open')
  })

  it('keeps a newline inside a quoted question, which every export has', () => {
    // An RFI question is a paragraph somebody typed with the return key, and a
    // line-based parser turns one row into three that look plausible.
    const rows = parseCsv(
      ['Number,Question', '14,"The detail shows nine inch embedment.\nThe shop drawings say seven.\nWhich governs?"'].join(
        '\n',
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.['Question']).toContain('Which governs?')
    expect(rows[0]?.['Question']?.split('\n')).toHaveLength(3)
  })

  it('unescapes a doubled quote', () => {
    const rows = parseCsv(['Subject', '"The ""north"" bay"'].join('\n'))
    expect(rows[0]?.['Subject']).toBe('The "north" bay')
  })

  it('drops blank rows rather than importing empty records', () => {
    const rows = parseCsv(['Number,Subject', '14,Anchor bolts', ',', '15,Duct routing'].join('\n'))
    expect(rows).toHaveLength(2)
  })

  it('refuses a file with no header', () => {
    expect(() => parseCsv('')).toThrow()
  })
})

describe('their column names, which are several', () => {
  it('reads the same field under any of its spellings', () => {
    expect(readColumn({ Subject: 'A' }, 'subject')).toBe('A')
    expect(readColumn({ Title: 'B' }, 'subject')).toBe('B')
    expect(readColumn({ 'Ball In Court': 'Ali Bishop' }, 'assignee')).toBe('Ali Bishop')
    expect(readColumn({ 'Responsible Contractor': 'Vega Steel' }, 'assignee')).toBe('Vega Steel')
  })

  it('treats an empty cell as absent', () => {
    expect(readColumn({ Subject: '   ' }, 'subject')).toBeNull()
  })
})

describe('mapping their statuses', () => {
  it('maps the ones we share', () => {
    expect(mapRfiStatus('Closed')).toEqual({ status: 'closed', guessed: false })
    expect(mapRfiStatus('open')).toEqual({ status: 'open', guessed: false })
    expect(mapRfiStatus('In Review')).toEqual({ status: 'open', guessed: false })
  })

  it('lands an unrecognised status OPEN and admits it guessed', () => {
    // Quietly closing work because somebody's company invented a status is
    // the failure that makes an import untrustworthy. Open is recoverable.
    expect(mapRfiStatus('Pending Owner Review')).toEqual({ status: 'open', guessed: true })
    expect(mapRfiStatus(null)).toEqual({ status: 'open', guessed: true })
  })
})

describe('names, which arrive three ways', () => {
  it('turns "Bishop, Ali" the right way round', () => {
    // Getting this wrong produces a directory full of people called "Bishop".
    expect(splitName('Bishop, Ali')).toEqual({ name: 'Ali Bishop', email: null })
  })

  it('leaves a plain name alone', () => {
    expect(splitName('Ali Bishop')).toEqual({ name: 'Ali Bishop', email: null })
  })

  it('pulls an email out of either bracket style', () => {
    expect(splitName('Ali Bishop <ali@bishop.test>')).toEqual({ name: 'Ali Bishop', email: 'ali@bishop.test' })
    expect(splitName('Bishop, Ali (ali@bishop.test)')).toEqual({ name: 'Ali Bishop', email: 'ali@bishop.test' })
  })
})
