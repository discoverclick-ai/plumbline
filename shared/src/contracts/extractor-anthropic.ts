import Anthropic from '@anthropic-ai/sdk'
import { DEFAULT_MODEL } from '../capture/providers/anthropic.js'
import { KernelError } from '../errors.js'
import type {
  ClauseForScreening,
  ExtractedObligation,
  ExtractionRequest,
  ObligationExtractionProvider,
  ScreenVerdict,
} from './extraction.js'

/**
 * Reading a contract, in two passes, and the third and last file here that
 * imports a model SDK.
 *
 * Both prompts are written against the same asymmetry the rest of this
 * subsystem is built on. Screening is tuned for recall because a clause
 * screened out is a deadline nobody ever hears about and no screen in the
 * product would show its absence. Extraction is tuned for restraint because
 * an invented obligation mis-times a legal deadline somebody then relies on.
 *
 * Neither prompt is allowed to be the safeguard. The quote gate discards any
 * row whose citation is not verbatim in its clause, whatever the model said
 * about it, and a proposed obligation starts no clocks until a person accepts
 * it. Prompts move the numbers; the schema and the gate are what make the
 * failure mode survivable.
 */

const SCREEN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'candidate'],
        properties: {
          ref: { type: 'integer', description: 'The number printed before the clause in the input.' },
          candidate: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const

const OBLIGATION_TYPES = [
  'notice_of_delay',
  'notice_of_change',
  'notice_of_claim',
  'differing_site_conditions',
  'weather_day',
  'cure_period',
  'submittal_turnaround',
  'rfi_response_time',
  'payment_application_window',
  'payment_due',
  'retainage_release',
  'substantial_completion',
  'liquidated_damages',
  'insurance_certificate',
  'safety_reporting',
  'closeout_submission',
] as const

const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['obligations'],
  properties: {
    obligations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'obligationType',
          'obligorParty',
          'obligeeParty',
          'quote',
          'triggerDescription',
          'durationValue',
          'durationUnit',
          'deadlineBasis',
        ],
        properties: {
          obligationType: { type: 'string', enum: [...OBLIGATION_TYPES] },
          obligorParty: { type: 'string', enum: ['our_org', 'counterparty', 'either'] },
          obligeeParty: { type: 'string', enum: ['our_org', 'counterparty', 'either'] },
          quote: {
            type: 'string',
            description:
              'The words in this clause that impose the deadline, copied exactly, character for character. A paraphrase is discarded.',
          },
          triggerDescription: {
            type: 'string',
            description: 'The event that starts the clock, in one sentence a superintendent would recognise.',
          },
          triggerMatch: {
            type: 'object',
            additionalProperties: true,
            description:
              'Optional. {"type_key": "<a record type from the list given>", "event": "record.created"} when this clock plainly starts on a record of that kind. Omit entirely rather than guessing a type key.',
          },
          durationValue: { type: 'integer', minimum: 0 },
          durationUnit: { type: 'string', enum: ['days', 'business_days', 'weeks', 'months'] },
          deadlineBasis: {
            type: 'string',
            enum: ['from_occurrence', 'from_awareness', 'from_written_notice', 'from_receipt'],
          },
          countsStartDay: {
            type: 'boolean',
            description: 'True only where the clause expressly counts the day of the event. Silence means false.',
          },
          rollsForward: {
            type: 'boolean',
            description:
              'True only where the clause expressly moves a deadline off a non-working day. Silence means false.',
          },
          consequence: {
            type: 'string',
            enum: ['waiver_of_claim', 'liquidated_damages', 'payment_withheld', 'default', 'none_stated'],
          },
          formRequirements: { type: 'object', additionalProperties: true },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          rationale: { type: 'string' },
        },
      },
    },
  },
} as const

const SCREEN_SYSTEM = `You are shown numbered clauses from a construction contract. For each one, say whether it plausibly puts a TIME LIMIT on somebody.

Say yes to: notice periods, claim windows, cure periods, response and turnaround times, payment application windows and payment due dates, retainage release, completion dates, insurance certificate deadlines, reporting deadlines, closeout deadlines, and anything that says a right is lost by delay.

Say no to: definitions, scope of work, indemnity, insurance coverage amounts, governing law, dispute forum, and anything with no time limit in it.

This pass is a filter, not a reading. Be GENEROUS. A clause you pass through costs a reviewer thirty seconds. A clause you filter out is a deadline nobody in the company will ever hear about, and there is no screen anywhere that would show them it is missing. When you are unsure, say yes.`

const EXTRACT_SYSTEM = `You read one clause of a construction contract and extract every timed obligation it creates.

A timed obligation has all of: somebody who must act, something they must do, and a period after some event within which they must do it.

Rules, in order of how much it costs to break them.

Quote exactly. The quote must appear in the clause verbatim, character for character. A quote that is not found is discarded before it is stored, so a paraphrase is a wasted line and a smoothed-over quote is a wasted line.

Never invent a term. If the clause does not say whether the day of the event counts, leave countsStartDay false. If it does not say a deadline moves off a Saturday, leave rollsForward false. If it states no consequence, say none_stated. Absent is not the same as zero and it is not the same as the usual practice.

Extract only what THIS clause says. A cross-reference to another article is not this clause's obligation; that article will be read on its own.

Return an empty list when the clause creates no timed obligation. Most clauses do not. An empty list is a correct and common answer.

Duration: give the number and the unit as the clause states them. Spelled-out numbers become integers. "Ten (10) days" is 10 days. Where a clause says "business days" or "working days", the unit is business_days.

Basis: from_awareness when the clause measures from becoming aware, discovering, or first observing. from_occurrence when it measures from the event itself. from_receipt when it measures from receiving something.`

export interface ContractExtractorOptions {
  client?: Anthropic
  model?: string
  screenEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  extractEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Clauses per screening call. Larger is cheaper and worse. */
  screenBatchSize?: number
}

export class AnthropicObligationExtractor implements ObligationExtractionProvider {
  readonly name = 'anthropic'
  private readonly client: Anthropic
  private readonly model: string
  private readonly screenEffort: NonNullable<ContractExtractorOptions['screenEffort']>
  private readonly extractEffort: NonNullable<ContractExtractorOptions['extractEffort']>
  private readonly batchSize: number

  constructor(options: ContractExtractorOptions = {}) {
    this.client = options.client ?? new Anthropic()
    this.model = options.model ?? DEFAULT_MODEL
    this.screenEffort = options.screenEffort ?? 'low'
    // The highest effort in the product. This runs once per contract, nobody
    // is waiting on it, and the output is a legal deadline somebody will act
    // on. A slow extraction costs minutes; a wrong one costs a claim.
    this.extractEffort = options.extractEffort ?? 'high'
    this.batchSize = options.screenBatchSize ?? 25
  }

  async screen(clauses: ClauseForScreening[]): Promise<{ verdicts: ScreenVerdict[]; model: string }> {
    const verdicts: ScreenVerdict[] = []

    for (let start = 0; start < clauses.length; start += this.batchSize) {
      const batch = clauses.slice(start, start + this.batchSize)
      const rendered = batch
        .map(
          (clause, index) =>
            `[${index}] ${clause.clauseNumber ?? '(unnumbered)'} ${clause.heading ?? ''}\n${truncate(clause.text)}`,
        )
        .join('\n\n')

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2048,
        system: [{ type: 'text', text: SCREEN_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: rendered }],
        output_config: { effort: this.screenEffort, format: { type: 'json_schema', schema: SCREEN_SCHEMA } },
      })

      const parsed = this.parse<{ verdicts?: { ref: number; candidate: boolean; reason?: string }[] }>(response)
      const byRef = new Map((parsed.verdicts ?? []).map((v) => [v.ref, v]))

      for (const [index, clause] of batch.entries()) {
        const verdict = byRef.get(index)
        verdicts.push({
          clauseId: clause.id,
          // A clause the screener did not mention is a CANDIDATE, not a
          // discard. Silence is the failure mode this pass is most likely to
          // have, and reading a clause nobody needed is the cheap half of the
          // asymmetry.
          candidate: verdict ? verdict.candidate : true,
          ...(verdict?.reason ? { reason: verdict.reason } : verdict ? {} : { reason: 'Not returned by the screener' }),
        })
      }
    }

    return { verdicts, model: this.model }
  }

  async extract(request: ExtractionRequest): Promise<{ obligations: ExtractedObligation[]; model: string }> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: [{ type: 'text', text: EXTRACT_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            `Instrument: ${request.documentKind}`,
            `Record types available for triggerMatch: ${request.availableTypeKeys.join(', ')}`,
            '',
            `Clause ${request.clause.clauseNumber ?? '(unnumbered)'} ${request.clause.heading ?? ''}`,
            '',
            request.clause.text,
          ].join('\n'),
        },
      ],
      output_config: { effort: this.extractEffort, format: { type: 'json_schema', schema: EXTRACT_SCHEMA } },
    })

    const parsed = this.parse<{ obligations?: ExtractedObligation[] }>(response)
    const obligations = (parsed.obligations ?? []).filter((o) => {
      // A trigger naming a record type this deployment does not have would
      // match nothing forever, which is a clock that silently never fires.
      // Dropping the trigger keeps the obligation, which a person can still
      // fire by hand.
      const typeKey = o.triggerMatch?.['type_key']
      if (typeof typeKey === 'string' && !request.availableTypeKeys.includes(typeKey)) {
        delete o.triggerMatch
      }
      return true
    })

    return { obligations, model: this.model }
  }

  private parse<T>(response: Anthropic.Message): T {
    if (response.stop_reason === 'refusal') {
      throw new KernelError('extractor_refused', 'The extractor declined to read this clause', 502)
    }
    if (response.stop_reason === 'max_tokens') {
      // A partial list that looks complete is the worst outcome available
      // here, because the missing half is invisible.
      throw new KernelError('extractor_truncated', 'The extractor ran out of room before finishing', 502)
    }
    const block = response.content.find((part) => part.type === 'text')
    if (!block || block.type !== 'text') {
      throw new KernelError('extractor_empty', 'The extractor returned nothing', 502)
    }
    return JSON.parse(block.text) as T
  }
}

/** Long clauses are rare and a screening pass does not need all of one. */
function truncate(text: string, limit = 1200): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}
