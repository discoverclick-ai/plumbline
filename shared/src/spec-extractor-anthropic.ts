import Anthropic from '@anthropic-ai/sdk'
import { KernelError } from './errors.js'
import { DEFAULT_MODEL } from './capture/providers/anthropic.js'
import {
  SUBMITTAL_TYPES,
  type ExtractedRequirement,
  type RequirementExtractionProvider,
  type RequirementExtractionRequest,
} from './specifications.js'

/**
 * The second file in the product that imports a model SDK, and the last one
 * that should.
 *
 * Extraction here is harder work than reading a voice note: the model is being
 * asked to find every submittal a section requires and miss none, over legal
 * prose written to be unambiguous rather than readable. So the effort is
 * higher by default, and the schema does the arguing.
 */

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['requirements'],
  properties: {
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['submittalType', 'description', 'quote'],
        properties: {
          submittalType: { type: 'string', enum: [...SUBMITTAL_TYPES] },
          description: { type: 'string' },
          // Named and described so the model treats it as evidence rather
          // than as a summary. The service checks it against the section
          // regardless, but a schema that asks for the right thing means
          // fewer rows get thrown away.
          quote: {
            type: 'string',
            description:
              'The sentence from the section that requires this submittal, copied exactly, character for character.',
          },
          paragraph: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
} as const

const SYSTEM = `You read one section of a construction specification and list every submittal it requires the contractor to provide.

What counts as a submittal: product data, shop drawings, samples, mock-ups, certificates, test reports. A submittal is something the contractor hands over for review before or during the work.

What does not: the work itself, quality assurance requirements about who may perform it, warranty periods, and anything the OWNER or DESIGNER provides. A qualification requirement ("the fabricator shall be certified") is not a submittal unless the section also asks for evidence of it.

Rules:
- Quote exactly. The quote must appear in the section verbatim; anything that does not is discarded, so a paraphrase is a wasted line.
- One requirement per submittal, even where a paragraph lists several.
- Miss nothing. A missed submittal becomes material that arrives unapproved, and that is the failure this exists to prevent. An extra line a human rejects costs ten seconds.
- Never invent. If the section requires no submittals, return an empty list.`

export interface SpecExtractorOptions {
  client?: Anthropic
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export class AnthropicRequirementExtractor implements RequirementExtractionProvider {
  readonly name = 'anthropic'
  private readonly client: Anthropic
  private readonly model: string
  private readonly effort: NonNullable<SpecExtractorOptions['effort']>

  constructor(options: SpecExtractorOptions = {}) {
    this.client = options.client ?? new Anthropic()
    this.model = options.model ?? DEFAULT_MODEL
    // Higher than the capture interpreter by default. Nobody is waiting on
    // this, it runs once per section per job, and a missed line is expensive
    // in a way a slow extraction is not.
    this.effort = options.effort ?? 'high'
  }

  async extract(
    request: RequirementExtractionRequest,
  ): Promise<{ requirements: ExtractedRequirement[]; model: string }> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      // Cached: the instructions are identical for every section in the book,
      // and a spec book is hundreds of sections.
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: `Section ${request.sectionNumber} — ${request.sectionTitle}\n\n${request.body}`,
        },
      ],
      output_config: {
        effort: this.effort,
        format: { type: 'json_schema', schema: SCHEMA },
      },
    })

    if (response.stop_reason === 'refusal') {
      throw new KernelError('extractor_refused', 'The extractor declined to read this section', 502)
    }
    if (response.stop_reason === 'max_tokens') {
      // Silently returning a partial list would be the worst possible failure
      // here: a register that looks complete and is not.
      throw new KernelError('extractor_truncated', 'The extractor ran out of room before finishing', 502)
    }

    const block = response.content.find((part) => part.type === 'text')
    if (!block || block.type !== 'text') {
      throw new KernelError('extractor_empty', 'The extractor returned nothing', 502)
    }

    const parsed = JSON.parse(block.text) as { requirements?: ExtractedRequirement[] }
    return { requirements: parsed.requirements ?? [], model: this.model }
  }
}
