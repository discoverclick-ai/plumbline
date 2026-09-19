/**
 * Cutting a contract into clauses.
 *
 * Deterministic parsing, never a model. Segmentation decides where every
 * citation in the product points, so a segmenter that guesses produces
 * citations that are confidently wrong, which is the one failure that ends
 * the product. Where the parser cannot find boundaries it says so and the
 * document is flagged for manual segmentation. A document nobody segmented is
 * a visible gap; a document segmented badly is an invisible one.
 */

export interface ParsedClause {
  clauseNumber: string | null
  heading: string | null
  text: string
  page: number | null
  orderIndex: number
}

export interface SegmentationResult {
  clauses: ParsedClause[]
  /** Set when the parser could not find a numbering scheme it trusts. */
  needsManualSegmentation: boolean
  reason: string | null
  /** Which pattern won, for the review screen and for bug reports. */
  scheme: 'decimal' | 'article' | 'lettered' | null
}

/**
 * Page breaks. A contract converted to text carries them as form feeds; some
 * converters emit a bare "Page 12 of 340" line instead, which is recognised
 * here because the alternative is every citation on the wrong page.
 */
const PAGE_BREAK = /\f|^\s*Page\s+(\d+)\s+of\s+\d+\s*$/gim

interface NumberedLine {
  index: number
  number: string
  heading: string | null
  page: number
}

/** "8.3.2", "8.3.2.1" — AIA and most owner forms. */
const DECIMAL = /^\s{0,8}(\d+(?:\.\d+){1,5})\.?\s+(.*)$/
/** "ARTICLE 8" / "SECTION 8" — the top level of the same documents. */
const ARTICLE = /^\s{0,8}(?:ARTICLE|SECTION)\s+(\d+(?:\.\d+)*)\.?\s*(.*)$/i
/** "(a)", "(iv)" — subclause lettering, common in supplementary conditions. */
const LETTERED = /^\s{0,8}\(([a-z]{1,2}|[ivxlc]{1,6})\)\s+(.*)$/

export function segment(text: string): SegmentationResult {
  const { lines, pageOf } = withPages(text)

  const decimal = collect(lines, pageOf, DECIMAL)
  const article = collect(lines, pageOf, ARTICLE)
  const lettered = collect(lines, pageOf, LETTERED)

  // Decimal numbering wins whenever it appears at all, because a document
  // using it uses it throughout; articles are the fallback for forms that
  // number only at the top level. Lettered alone is a bad sign: it means the
  // parser found subclauses without ever finding what they hang off.
  let chosen: NumberedLine[] = []
  let scheme: SegmentationResult['scheme'] = null

  if (decimal.length >= 3) {
    chosen = merge(decimal, article)
    scheme = 'decimal'
  } else if (article.length >= 2) {
    chosen = article
    scheme = 'article'
  } else if (lettered.length >= 3) {
    chosen = lettered
    scheme = 'lettered'
  }

  if (chosen.length === 0) {
    return {
      clauses: [],
      needsManualSegmentation: true,
      reason:
        'No clause numbering the parser recognises. This is normal for scanned paper and for owner-drafted forms that number nothing; the document needs its clauses marked by hand before anything cites it.',
      scheme: null,
    }
  }

  const clauses: ParsedClause[] = []

  // Anything before the first numbered line is the recitals and the signature
  // block boilerplate. Kept, unnumbered, because terms do hide there.
  const preamble = lines.slice(0, chosen[0]!.index).join('\n').trim()
  if (preamble) {
    clauses.push({
      clauseNumber: null,
      heading: null,
      text: preamble,
      page: pageOf(0),
      orderIndex: clauses.length,
    })
  }

  for (let i = 0; i < chosen.length; i += 1) {
    const here = chosen[i]!
    const next = chosen[i + 1]
    const body = lines.slice(here.index, next ? next.index : lines.length).join('\n').trim()
    if (!body) continue
    clauses.push({
      clauseNumber: here.number,
      heading: here.heading,
      text: body,
      page: here.page,
      orderIndex: clauses.length,
    })
  }

  return { clauses, needsManualSegmentation: false, reason: null, scheme }
}

function withPages(text: string): { lines: string[]; pageOf: (lineIndex: number) => number } {
  const pageStarts: number[] = []
  const lines: string[] = []
  let page = 1

  for (const raw of text.split('\n')) {
    PAGE_BREAK.lastIndex = 0
    const explicit = /^\s*Page\s+(\d+)\s+of\s+\d+\s*$/i.exec(raw)
    if (explicit) {
      page = Number(explicit[1])
      // The marker itself is not contract text and must not land in a clause.
      continue
    }
    if (raw.includes('\f')) {
      page += raw.split('\f').length - 1
      const stripped = raw.replace(/\f/g, '').trim()
      pageStarts[lines.length] = page
      lines.push(stripped)
      continue
    }
    pageStarts[lines.length] = page
    lines.push(raw)
  }

  return {
    lines,
    pageOf: (lineIndex: number) => {
      for (let i = Math.min(lineIndex, pageStarts.length - 1); i >= 0; i -= 1) {
        const p = pageStarts[i]
        if (p !== undefined) return p
      }
      return 1
    },
  }
}

function collect(lines: string[], pageOf: (i: number) => number, pattern: RegExp): NumberedLine[] {
  const found: NumberedLine[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const match = pattern.exec(lines[i]!)
    if (!match) continue
    found.push({
      index: i,
      number: match[1]!,
      heading: headingOrNull((match[2] ?? '').trim(), lines[i + 1]),
      page: pageOf(i),
    })
  }
  return found
}

/**
 * Whether the text after a clause number is a heading or the clause itself.
 *
 * "8.1 DEFINITIONS" is a heading. "8.1.1 Unless otherwise provided, Contract
 * Time is the period of time, including" is the first line of a clause that
 * runs on, and calling that a heading puts contract terms in the wrong field
 * and out of the text a citation is checked against. Length alone cannot tell
 * them apart, because the first line of a wrapped paragraph is short too.
 *
 * Two signals that can: a heading shouts (no lowercase), or it stands alone
 * (the next line is blank or starts a new clause).
 */
function headingOrNull(candidate: string, nextLine: string | undefined): string | null {
  if (!candidate || candidate.length > 80) return null
  // Trailing punctuation that promises another clause is coming.
  if (/[,;.]$/.test(candidate)) return null

  const shouts = candidate === candidate.toUpperCase() && /[A-Z]/.test(candidate)
  const next = (nextLine ?? '').trim()
  const standsAlone = next === '' || DECIMAL.test(next) || ARTICLE.test(next) || LETTERED.test(next)

  return shouts || standsAlone ? candidate : null
}

/** Article headings interleaved with their decimal children, in document order. */
function merge(a: NumberedLine[], b: NumberedLine[]): NumberedLine[] {
  const seen = new Set(a.map((x) => x.index))
  return [...a, ...b.filter((x) => !seen.has(x.index))].sort((x, y) => x.index - y.index)
}

/**
 * Whether a quote is actually in the clause.
 *
 * Binary and deterministic, and it is the gate every extracted obligation
 * passes before it reaches the database. Whitespace and the several kinds of
 * quotation mark a PDF produces are normalised, because a citation rejected
 * over a curly apostrophe trains people to turn the check off.
 */
export function quoteAppearsIn(quote: string, clauseText: string): boolean {
  const normalise = (s: string): string =>
    s
      .replace(/[‘’‛′]/g, "'")
      .replace(/[“”″]/g, '"')
      .replace(/[‐-―−]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()

  const needle = normalise(quote)
  if (needle.length < 12) return false // Too short to be evidence of anything.
  return normalise(clauseText).includes(needle)
}
