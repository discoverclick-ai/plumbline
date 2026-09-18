/**
 * A mechanical stand-in for the model.
 *
 * IT IS NOT A QUALITY SIGNAL. It exists so the harness itself can be exercised
 * — in CI, with no key and no spend — and so a broken runner fails loudly
 * rather than silently scoring nothing. Its output comes from keyword rules
 * that a real model would beat easily on some cases and lose to on others.
 *
 * Every score it produces is stamped `selftest-stub`, the runner refuses to
 * write a baseline from it, and the run state carries `synthetic: true`, so a
 * number from this provider cannot be mistaken for a number from a model.
 */

const RULES = [
  { typeKey: 'daily_log', words: ['logging out', 'log for', 'workers on site', 'guys on site', 'weather', 'manpower', 'crews worked'] },
  { typeKey: 'submittal', words: ['submittal', 'shop drawing', 'product data', 'cut sheet', 'sample', 'transmittal', 'for review'] },
  { typeKey: 'punch_item', words: ['touch up', 'punch', 'come back', 'does not latch', 'scuffed', 'loose', 'rework'] },
  { typeKey: 'rfi', words: ['which one governs', 'can someone confirm', 'do we need', 'governs', '?'] },
  { typeKey: 'observation', words: ['guardrail', 'housekeeping', 'staining', 'efflorescence', 'flagged', 'no guardrail'] },
]

const FIELD_BY_TYPE = {
  rfi: 'question',
  submittal: 'description',
  punch_item: 'description',
  observation: 'description',
  daily_log: 'work_performed',
}

function firstSentence(text) {
  const body = text.split('\n').filter((line) => !/^(from|subject):/i.test(line.trim())).join(' ')
  const match = body.match(/[^.!?]{12,}[.!?]/)
  return (match ? match[0] : body).trim().slice(0, 240)
}

export class SelfTestProvider {
  name = 'selftest'

  async interpret(request) {
    const text = request.userContent
    const lower = text.toLowerCase()

    let typeKey = 'observation'
    let hits = 0
    for (const rule of RULES) {
      const score = rule.words.filter((word) => lower.includes(word)).length
      if (score > hits) {
        hits = score
        typeKey = rule.typeKey
      }
    }

    const fields = []
    const primary = FIELD_BY_TYPE[typeKey]
    const sentence = firstSentence(text)
    // Below a couple of keyword hits there is nothing to go on, which is the
    // path that should produce an incomplete draft rather than an invention.
    if (hits > 0 && sentence.length > 20) fields.push({ key: primary, value: sentence })

    if (typeKey === 'daily_log') {
      const date = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/)
      if (date) fields.push({ key: 'log_date', value: date[1] })
      const workers = text.match(/\b(\d{1,3})\s+(?:workers|guys|men)\b/i)
      if (workers) fields.push({ key: 'manpower_count', value: workers[1] })
    }

    return {
      output: {
        typeKey,
        title: sentence.slice(0, 80) || 'Untitled capture',
        fields,
        participants: [],
        confidence: Math.min(0.95, 0.3 + hits * 0.15),
        rationale: `Keyword stub matched ${hits} term(s) for ${typeKey}.`,
      },
      model: 'selftest-stub',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }
  }
}
