import { describe, expect, it } from 'vitest'
import { HeuristicObligationScreener, ScriptedObligationExtractor } from '../src/contracts/extraction.js'

/**
 * The screening floor.
 *
 * A regex cannot read a contract. It can notice that a clause says "within
 * ten days", and that is enough to hand a reviewer forty candidates instead
 * of a thousand pages. This exists as the number a model-backed screener has
 * to beat, and as what a deployment with no API key still gets.
 *
 * Every case is scored on RECALL. A clause wrongly passed through costs a
 * reviewer thirty seconds; a clause wrongly filtered out is a deadline nobody
 * in the company will ever hear about, and no screen in the product would
 * show them it is missing.
 */

const screener = new HeuristicObligationScreener()

const TIMED = [
  ['written notice window', 'The Contractor shall give written notice to the Owner within twenty-one days.'],
  ['numeric days', 'Applications for payment shall be submitted within 10 days of month end.'],
  ['business days', 'The Architect shall respond within five (5) business days of receipt.'],
  ['no later than', 'Certificates of insurance shall be delivered no later than the commencement of the Work.'],
  ['waiver', 'Failure to give notice shall constitute a waiver of any claim for additional time.'],
  ['deemed waived', 'Any claim not submitted in accordance with this Article shall be deemed waived.'],
  ['cure', 'The Subcontractor shall have seven days to cure such default after written notice.'],
  ['liquidated damages', 'The Contractor shall pay liquidated damages of $2,500 per day of delay.'],
  ['months', 'The warranty period shall run for twelve months from Substantial Completion.'],
]

const UNTIMED = [
  ['definition', 'The Contract Documents consist of the Agreement, the Conditions, the Drawings and the Specifications.'],
  ['indemnity', 'The Contractor shall indemnify and hold harmless the Owner from claims arising out of the Work.'],
  ['governing law', 'This Agreement shall be governed by the laws of the State of Colorado.'],
  ['coverage amount', 'Commercial General Liability coverage shall be not less than $2,000,000 per occurrence.'],
]

describe('the heuristic screener', () => {
  it('catches every clause with a time limit in it', async () => {
    const clauses = TIMED.map(([name, text], i) => ({ id: `t${i}`, clauseNumber: name!, heading: null, text: text! }))
    const { verdicts } = await screener.screen(clauses)

    const missed = verdicts
      .map((v, i) => (v.candidate ? null : TIMED[i]![0]))
      .filter((name): name is string => name !== null)

    // Recall is the number that matters, and the failure message names what
    // was missed rather than a count, because the fix is always a pattern.
    expect(missed, `missed: ${missed.join(', ')}`).toEqual([])
  })

  it('leaves out the clauses with no deadline in them', async () => {
    const clauses = UNTIMED.map(([name, text], i) => ({ id: `u${i}`, clauseNumber: name!, heading: null, text: text! }))
    const { verdicts } = await screener.screen(clauses)

    // Precision matters far less, so this is allowed to be imperfect. It is
    // asserted at all so a pattern that matches everything gets noticed.
    expect(verdicts.filter((v) => v.candidate)).toHaveLength(0)
  })

  it('says why it passed a clause through', async () => {
    const { verdicts } = await screener.screen([
      { id: 'c1', clauseNumber: '8.3', heading: null, text: 'Notice shall be given within five days.' },
    ])
    expect(verdicts[0]!.candidate).toBe(true)
    expect(verdicts[0]!.reason).toBeTruthy()
  })
})

describe('the scripted extractor', () => {
  it('treats an unscripted screen as passing everything through', async () => {
    // A test that forgets to script the screen should over-extract, which is
    // visible, rather than extract nothing, which looks like a pass.
    const scripted = new ScriptedObligationExtractor()
    const { verdicts } = await scripted.screen([
      { id: 'a', clauseNumber: null, heading: null, text: 'anything' },
      { id: 'b', clauseNumber: null, heading: null, text: 'anything' },
    ])
    expect(verdicts.every((v) => v.candidate)).toBe(true)
  })

  it('returns what was queued, in order, and nothing after', async () => {
    const scripted = new ScriptedObligationExtractor()
    scripted.pushExtraction([
      {
        obligationType: 'notice_of_delay',
        obligorParty: 'our_org',
        obligeeParty: 'counterparty',
        quote: 'within ten days',
        triggerDescription: 'A delay occurs',
        durationValue: 10,
        durationUnit: 'days',
        deadlineBasis: 'from_occurrence',
      },
    ])
    expect((await scripted.extract()).obligations).toHaveLength(1)
    expect((await scripted.extract()).obligations).toHaveLength(0)
  })
})
