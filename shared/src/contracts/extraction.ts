import type { DurationUnit } from './calendar.js'
import type { DeadlineBasis, ObligationType, ProposedObligation } from './obligations.js'

/**
 * The extraction seam, and the two-pass shape behind it.
 *
 * Screening is separate from extraction on purpose. A two hundred page
 * contract is a thousand clauses and maybe forty of them create a timed
 * obligation; sending all thousand through a careful extraction pass costs
 * twenty-five times what it needs to and, worse, gives a careful reader a
 * thousand chances to find an obligation in a clause that has none.
 *
 * So: a cheap pass tuned hard for RECALL decides which clauses are
 * candidates, and a careful pass reads only those. The asymmetry is the same
 * one that governs the deadline arithmetic. A clause wrongly screened in
 * costs thirty seconds of a reviewer's time. A clause wrongly screened out is
 * a deadline nobody ever hears about, and there is no screen anywhere in the
 * product that would show its absence.
 */

export interface ClauseForScreening {
  id: string
  clauseNumber: string | null
  heading: string | null
  text: string
}

export interface ScreenVerdict {
  clauseId: string
  /** Whether this clause plausibly creates a timed obligation. */
  candidate: boolean
  reason?: string
}

export interface ExtractionRequest {
  clause: ClauseForScreening
  /** What kind of instrument this is, which changes who is obliged. */
  documentKind: string
  /** The record types this deployment has, so a trigger can only name a real one. */
  availableTypeKeys: string[]
}

export interface ExtractedObligation {
  obligationType: ObligationType
  obligorParty: 'our_org' | 'counterparty' | 'either'
  obligeeParty: 'our_org' | 'counterparty' | 'either'
  quote: string
  triggerDescription: string
  triggerMatch?: Record<string, unknown>
  durationValue: number
  durationUnit: DurationUnit
  deadlineBasis: DeadlineBasis
  countsStartDay?: boolean
  rollsForward?: boolean
  consequence?: ProposedObligation['consequence']
  formRequirements?: Record<string, unknown>
  confidence?: number
  rationale?: string
}

/** One implementation per provider; nothing above here knows which. */
export interface ObligationExtractionProvider {
  readonly name: string
  screen(clauses: ClauseForScreening[]): Promise<{ verdicts: ScreenVerdict[]; model: string }>
  extract(request: ExtractionRequest): Promise<{ obligations: ExtractedObligation[]; model: string }>
}

/** Scripted, for tests and for seeding without spend. */
export class ScriptedObligationExtractor implements ObligationExtractionProvider {
  readonly name = 'scripted'
  private readonly screened: ScreenVerdict[][] = []
  private readonly extracted: ExtractedObligation[][] = []

  pushScreen(verdicts: ScreenVerdict[]): void {
    this.screened.push(verdicts)
  }
  pushExtraction(obligations: ExtractedObligation[]): void {
    this.extracted.push(obligations)
  }

  async screen(clauses: ClauseForScreening[]): Promise<{ verdicts: ScreenVerdict[]; model: string }> {
    const next = this.screened.shift()
    return {
      // Nothing queued means everything is a candidate. For a scripted
      // provider that is the safe default: a test that forgets to script the
      // screen over-extracts, which shows up, rather than silently extracting
      // nothing, which looks like a pass.
      verdicts: next ?? clauses.map((c) => ({ clauseId: c.id, candidate: true })),
      model: 'scripted',
    }
  }

  async extract(): Promise<{ obligations: ExtractedObligation[]; model: string }> {
    return { obligations: this.extracted.shift() ?? [], model: 'scripted' }
  }
}

/**
 * Words that put a deadline on somebody.
 *
 * Used by the heuristic screener below and worth stating plainly: this is a
 * cheap filter, not a reading. It exists so a deployment with no model
 * configured still gets a usable candidate list, and so the expensive pass
 * has something to be compared against.
 */
const TIMED_LANGUAGE = [
  // Any quantity followed by a period, wherever it appears. Deliberately not
  // anchored on "within": contracts say "shall run for twelve months", "seven
  // days to cure" and "five (5) business days" as readily, and an earlier
  // version anchored on the preposition missed all three. The parenthetical
  // numeral is how legal drafting writes every number.
  /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|sixty|ninety|\w+teen|\w+ty)\s*(?:\(\d+\)\s*)?(?:calendar\s+|business\s+|working\s+)?(?:days?|weeks?|months?|years?)\b/i,
  /\bno\s+later\s+than\b/i,
  /\bnot\s+later\s+than\b/i,
  /\bprior\s+to\s+the\s+commencement\b/i,
  /\bshall\s+give\s+(?:written\s+)?notice\b/i,
  /\bwritten\s+notice\b/i,
  /\btime\s+is\s+of\s+the\s+essence\b/i,
  /\bshall\s+be\s+deemed\s+waived\b/i,
  /\bconstitutes?\s+a\s+waiver\b/i,
  /\bliquidated\s+damages\b/i,
  /\bcure\s+(?:such\s+)?(?:default|breach)\b/i,
]

/**
 * A screener with no model in it.
 *
 * Deliberately generous. It exists as the floor: the recall number every
 * model-backed screener has to beat, and the thing a deployment without an
 * API key still gets. A regex cannot read a contract, but it can notice that
 * a clause says "within ten days", and a reviewer handed forty candidates is
 * in a far better position than one handed a thousand pages.
 */
export class HeuristicObligationScreener {
  readonly name = 'heuristic'

  async screen(clauses: ClauseForScreening[]): Promise<{ verdicts: ScreenVerdict[]; model: string }> {
    return {
      verdicts: clauses.map((clause) => {
        const hit = TIMED_LANGUAGE.find((pattern) => pattern.test(clause.text))
        return {
          clauseId: clause.id,
          candidate: hit !== undefined,
          ...(hit ? { reason: `Matched ${hit.source.slice(0, 40)}` } : {}),
        }
      }),
      model: 'heuristic',
    }
  }
}
