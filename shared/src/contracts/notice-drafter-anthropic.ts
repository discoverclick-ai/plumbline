import Anthropic from '@anthropic-ai/sdk'
import { DEFAULT_MODEL } from '../capture/providers/anthropic.js'
import { KernelError } from '../errors.js'
import { quoteAppearsIn } from './segmentation.js'
import {
  legalConclusionIn,
  TemplateNoticeDrafter,
  type DraftedNotice,
  type NoticeDraftProvider,
  type NoticeDraftRequest,
} from './notice-drafter.js'

/**
 * The letter, written.
 *
 * The template drafter already gets the SHAPE right: who, under which clause,
 * within which window, signed by whom. What it cannot write is the paragraph
 * describing what actually happened in the language of the job, and that
 * paragraph is the difference between a letter that reads as machinery and
 * one a project manager is willing to put their name on.
 *
 * So the model writes that paragraph and nothing else. The structure, the
 * quote, the dates and the reservation of rights all come from the template,
 * because none of them is a judgement and all of them are checkable.
 *
 * Two checks run on whatever comes back, and both are enforced rather than
 * requested. The quote must still appear verbatim: a model that "tidied" the
 * clause has produced a misquotation of a contract in a legal document. And
 * the text is scanned for legal conclusions, because "you are in breach" and
 * "you are liable" are findings this product does not make. A draft that
 * fails either check falls back to the template rather than going in front of
 * somebody, since a draft that looks polished is one people edit less.
 */

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['narrative'],
  properties: {
    narrative: {
      type: 'string',
      description:
        'Two to four sentences describing what was observed and why it matters, in the plain language of a construction project. Facts only, drawn entirely from what you were given.',
    },
    missing: {
      type: 'array',
      items: { type: 'string' },
      description: 'Facts a reader of this notice would expect and that you were not given.',
    },
  },
} as const

const SYSTEM = `You write one paragraph of a formal construction notice: the description of the condition.

What you are given is everything the project recorded at the time. Use only that. A fact in this paragraph that is not in what you were given is invented evidence in a legal document, which is the worst thing you can do here.

Write it the way a project manager writes to another project manager. Plain, specific, unembarrassed. Name the location, the date and what was found.

Do NOT:
- draw any legal conclusion. Never "you are in breach", "you are liable", "you have failed to", "this constitutes a default", "we are entitled to". State what happened; the clause is quoted elsewhere in the letter and speaks for itself.
- demand money or time, or name a number. What to claim is a commercial decision somebody else makes.
- characterise the other party's conduct or motives.
- apologise, soften, or pad. A notice that reads as an apology reads as a concession.
- repeat the clause text. It is quoted directly above your paragraph.

If something a reader would expect is missing from what you were given, say so in the missing list rather than filling the gap.`

export interface NoticeDrafterOptions {
  client?: Anthropic
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export class AnthropicNoticeDrafter implements NoticeDraftProvider {
  readonly name = 'anthropic'
  private readonly client: Anthropic
  private readonly model: string
  private readonly effort: NonNullable<NoticeDrafterOptions['effort']>
  private readonly template = new TemplateNoticeDrafter()

  constructor(options: NoticeDrafterOptions = {}) {
    this.client = options.client ?? new Anthropic()
    this.model = options.model ?? DEFAULT_MODEL
    this.effort = options.effort ?? 'medium'
  }

  async draft(request: NoticeDraftRequest): Promise<DraftedNotice> {
    const scaffold = await this.template.draft(request)

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: this.brief(request) }],
      output_config: { effort: this.effort, format: { type: 'json_schema', schema: SCHEMA } },
    })

    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
      // Falls back rather than failing. A notice window is running and a
      // template letter served on time beats a better letter served late.
      return scaffold
    }

    const block = response.content.find((part) => part.type === 'text')
    if (!block || block.type !== 'text') return scaffold

    const parsed = JSON.parse(block.text) as { narrative?: string; missing?: string[] }
    const narrative = (parsed.narrative ?? '').trim()
    if (!narrative) return scaffold

    // Caught here as well as in the service, so the narrative is discarded
    // rather than the whole letter falling back for one bad sentence.
    if (legalConclusionIn(narrative)) {
      return {
        ...scaffold,
        missing: [
          ...scaffold.missing,
          'The drafted description was discarded: it stated a legal conclusion rather than a fact.',
        ],
      }
    }

    const body = this.spliceNarrative(scaffold.body, narrative)

    // The quote must survive intact. A model that tidied the clause has
    // produced a misquotation of a contract inside a legal document.
    if (request.file.citation && !quoteAppearsIn(request.file.citation.quote, body)) {
      throw new KernelError(
        'draft_altered_citation',
        'The drafted notice no longer contains the clause verbatim',
        502,
      )
    }

    return {
      subject: scaffold.subject,
      body,
      missing: [...scaffold.missing, ...(parsed.missing ?? [])],
      model: this.model,
    }
  }

  /**
   * Puts the narrative where the template left a one-line summary.
   *
   * Replacing rather than appending, so the letter has one description of the
   * condition and not two that disagree.
   */
  private spliceNarrative(body: string, narrative: string): string {
    const marker = 'the following was observed on site:'
    const at = body.indexOf(marker)
    if (at < 0) return `${body}\n\n${narrative}`

    const afterMarker = at + marker.length
    // The template writes a blank line, an indented title, then a blank line.
    const restStart = body.indexOf('\n\n', afterMarker + 2)
    if (restStart < 0) return `${body}\n\n${narrative}`
    return `${body.slice(0, afterMarker)}\n\n${narrative}\n${body.slice(restStart)}`
  }

  private brief(request: NoticeDraftRequest): string {
    const { file } = request
    const parts: string[] = [
      `Project: ${file.project.number} — ${file.project.name}`,
      file.clock ? `Condition occurred: ${file.clock.occurredAt}` : '',
      file.trigger ? `What was raised: ${file.trigger.title}` : '',
      '',
    ]

    if (file.evidence.items.length > 0) {
      parts.push('Recorded at the time:')
      for (const item of file.evidence.items) {
        parts.push(
          `- ${item.capturedAt}, ${item.kind} by ${item.capturedBy}` +
            `${item.latitude ? ` at ${item.latitude}, ${item.longitude}` : ''}` +
            `${item.text ? `: ${item.text}` : ''}`,
        )
      }
      parts.push('')
    }

    if (file.scheduleImpact.items.length > 0) {
      parts.push('Scheduled work affected:')
      for (const item of file.scheduleImpact.items) {
        parts.push(
          `- ${item.activityName}, starting ${item.startAt ?? 'unknown'}, ` +
            `${item.totalFloatDays ?? 'unknown'} days of float`,
        )
      }
      parts.push('')
    }

    // The clause is given for CONTEXT and the prompt forbids repeating it.
    // Withholding it would produce a paragraph that does not know what the
    // letter is about.
    if (file.citation) {
      parts.push(`The clause this notice is given under (already quoted in the letter; do not repeat it):`)
      parts.push(file.citation.quote)
    }

    return parts.filter((p) => p !== undefined).join('\n')
  }
}
