import { describe, expect, it } from 'vitest'
import { quoteAppearsIn, segment } from '../src/contracts/segmentation.js'

/**
 * Where every citation in the product points.
 *
 * A segmenter that guesses produces citations that are confidently wrong, and
 * one fabricated citation ends this product. So the tests are written against
 * real contract shapes, and the case that matters most is the one where the
 * parser admits it cannot do the job.
 */

const A201 = `
AIA Document A201 - 2017
General Conditions of the Contract for Construction

Page 1 of 3

ARTICLE 8  TIME

8.1 DEFINITIONS
8.1.1 Unless otherwise provided, Contract Time is the period of time, including
authorized adjustments, allotted in the Contract Documents for Substantial
Completion of the Work.

8.3 DELAYS AND EXTENSIONS OF TIME
8.3.1 If the Contractor is delayed at any time in the commencement or progress
of the Work by an act or neglect of the Owner or Architect, the Contract Time
shall be extended for such reasonable time as the Architect may determine.

Page 2 of 3

8.3.2 Claims relating to time shall be made in accordance with applicable
provisions of Article 15.

ARTICLE 15  CLAIMS AND DISPUTES

15.1.2 Claims by either the Owner or Contractor must be initiated by written
notice to the other party within 21 days after occurrence of the event giving
rise to such Claim or within 21 days after the claimant first recognizes the
condition giving rise to the Claim, whichever is later.

15.1.3 The Contractor shall proceed diligently with performance of the Contract
and the Owner shall continue to make payments in accordance with the Contract
Documents.
`

describe('segmenting a contract nobody wrote for us', () => {
  it('finds the decimal clauses and keeps them in document order', () => {
    const result = segment(A201)
    expect(result.needsManualSegmentation).toBe(false)
    expect(result.scheme).toBe('decimal')

    const numbers = result.clauses.map((c) => c.clauseNumber)
    expect(numbers).toContain('8.3.2')
    expect(numbers).toContain('15.1.2')
    // Articles survive alongside their children rather than being swallowed.
    expect(numbers).toContain('8')
    expect(numbers).toContain('15')
    expect(result.clauses.map((c) => c.orderIndex)).toEqual(result.clauses.map((_, i) => i))
  })

  it('keeps the clause text verbatim, because the quote gate depends on it', () => {
    const clause = segment(A201).clauses.find((c) => c.clauseNumber === '15.1.2')!
    expect(clause.text).toContain('within 21 days after occurrence of the event')
    // And stops where the next clause starts.
    expect(clause.text).not.toContain('proceed diligently')
  })

  it('tracks the page a clause is printed on', () => {
    const clauses = segment(A201).clauses
    expect(clauses.find((c) => c.clauseNumber === '8.3.1')!.page).toBe(1)
    expect(clauses.find((c) => c.clauseNumber === '15.1.2')!.page).toBe(2)
    // The page marker itself is not contract text and must not be citable.
    expect(clauses.some((c) => c.text.includes('Page 2 of 3'))).toBe(false)
  })

  it('counts form feeds as pages too', () => {
    const withFeeds = 'ARTICLE 1  ONE\n1.1 First.\n\f1.2 Second, on page two.\n\f1.3 Third, on page three.'
    const clauses = segment(withFeeds).clauses
    expect(clauses.find((c) => c.clauseNumber === '1.2')!.page).toBe(2)
    expect(clauses.find((c) => c.clauseNumber === '1.3')!.page).toBe(3)
  })

  it('keeps the unnumbered preamble rather than dropping it', () => {
    // Recitals carry terms more often than anybody admits.
    const first = segment(A201).clauses[0]!
    expect(first.clauseNumber).toBeNull()
    expect(first.text).toContain('General Conditions')
  })

  it('reads a heading as a heading and a running sentence as text', () => {
    const clauses = segment(A201).clauses
    expect(clauses.find((c) => c.clauseNumber === '8.1')!.heading).toBe('DEFINITIONS')
    // 8.1.1 runs straight on into the clause; calling that a heading would put
    // the terms in the wrong field.
    expect(clauses.find((c) => c.clauseNumber === '8.1.1')!.heading).toBeNull()
  })

  it('falls back to articles when a form numbers only at the top level', () => {
    const sparse = 'SECTION 1  SCOPE\nThe Subcontractor shall furnish all labor.\nSECTION 2  TIME\nTime is of the essence.'
    const result = segment(sparse)
    expect(result.scheme).toBe('article')
    expect(result.clauses.map((c) => c.clauseNumber)).toEqual(['1', '2'])
  })

  it('handles lettered subclauses when that is all there is', () => {
    const lettered = '(a) The Subcontractor shall give notice.\n(b) Notice shall be written.\n(c) Notice goes to the Owner.'
    const result = segment(lettered)
    expect(result.scheme).toBe('lettered')
    expect(result.clauses).toHaveLength(3)
  })

  it('reads a two-clause amendment, which is a real document', () => {
    const amendment =
      'AMENDMENT NO. 2\n\n4.7.1 The notice period is extended to ten days.\n\n4.7.2 All other terms are unchanged.'
    const result = segment(amendment)
    expect(result.scheme).toBe('decimal')
    expect(result.clauses.map((c) => c.clauseNumber)).toEqual([null, '4.7.1', '4.7.2'])
  })

  it('does not call one stray number a clause scheme', () => {
    // A single decimal at the start of a line is what a price list or a
    // measurement looks like. One is not evidence.
    const prose = 'The parties agree as follows.\n1.5 percent per month shall accrue on late payment.'
    expect(segment(prose).needsManualSegmentation).toBe(true)
  })

  it('refuses to guess at a document it cannot read', () => {
    // Scanned paper, and owner-drafted forms that number nothing. The right
    // answer is a visible gap, not a confident carve-up.
    const prose = 'The parties agree that the work shall be performed in a good and workmanlike manner and that time is of the essence throughout.'
    const result = segment(prose)
    expect(result.needsManualSegmentation).toBe(true)
    expect(result.clauses).toHaveLength(0)
    expect(result.reason).toMatch(/numbering the parser recognises/)
  })
})

describe('the quote gate', () => {
  const clause =
    'Claims by either the Owner or Contractor must be initiated by written notice\nto the other party within 21 days after occurrence of the event.'

  it('accepts a quote that is really there, across a line break', () => {
    expect(quoteAppearsIn('initiated by written notice to the other party within 21 days', clause)).toBe(true)
  })

  it('forgives the punctuation a PDF mangles', () => {
    const curly = 'The Owner’s notice — in writing — shall be given within ten days.'
    expect(quoteAppearsIn("The Owner's notice - in writing - shall be given within ten days.", curly)).toBe(true)
  })

  it('rejects a quote that is not there, however plausible it reads', () => {
    // This is the failure the whole schema exists to prevent: a sentence that
    // sounds exactly like the contract and is not in it.
    expect(quoteAppearsIn('must be initiated by written notice within 14 days', clause)).toBe(false)
  })

  it('rejects a quote too short to be evidence of anything', () => {
    expect(quoteAppearsIn('notice', clause)).toBe(false)
    expect(quoteAppearsIn('', clause)).toBe(false)
  })
})
