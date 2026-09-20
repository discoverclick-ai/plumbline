import Anthropic from '@anthropic-ai/sdk'
import { KernelError } from '../../errors.js'
import {
  transcriptionInstruction,
  type TranscriptionProvider,
  type TranscriptionRequest,
  type TranscriptionResult,
} from '../transcription.js'

/**
 * Reading images and PDFs, and admitting it cannot hear.
 *
 * `handles` returns false for audio, and that is the point of this file
 * rather than an omission from it. A vision model asked to transcribe a voice
 * memo has nothing to work from, and the failure mode is not an error: it is
 * a fluent, plausible paragraph about a jobsite. That paragraph would become
 * the text of a capture, then the body of a record, then evidence in a claim,
 * and nothing downstream would ever mark it as invented.
 *
 * So audio needs a provider that can actually hear, and until one is wired in
 * the product says so. A voice memo sits in the inbox with its recording
 * intact and a plain message, which is recoverable. The alternative is not.
 */

export const DEFAULT_TRANSCRIPTION_MODEL = 'claude-opus-5'

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

export interface AnthropicTranscriptionOptions {
  client?: Anthropic
  model?: string
  maxTokens?: number
}

export class AnthropicTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'anthropic-vision'
  private readonly client: Anthropic
  private readonly model: string
  private readonly maxTokens: number

  constructor(options: AnthropicTranscriptionOptions = {}) {
    this.client = options.client ?? new Anthropic()
    this.model = options.model ?? DEFAULT_TRANSCRIPTION_MODEL
    // Generous, because a scanned field ticket is dense and a transcript cut
    // off mid-line is a transcript that quietly loses the last item on the
    // list — which on a T&M ticket is frequently the expensive one.
    this.maxTokens = options.maxTokens ?? 8192
  }

  handles(contentType: string): boolean {
    return IMAGE_TYPES.has(contentType) || contentType === 'application/pdf'
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    if (!this.handles(request.contentType)) {
      throw new KernelError(
        'transcription_unsupported',
        `${this.name} cannot read ${request.contentType}`,
        422,
      )
    }

    const source =
      request.contentType === 'application/pdf'
        ? ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: request.bytes.toString('base64') } } as const)
        : ({ type: 'image', source: { type: 'base64', media_type: request.contentType as 'image/jpeg', data: request.bytes.toString('base64') } } as const)

    const content: Anthropic.ContentBlockParam[] = [
      source as unknown as Anthropic.ContentBlockParam,
      {
        type: 'text',
        text: request.hint
          ? // The typed note goes in as CONTEXT, never as something to repeat
            // back. Without that distinction a model handed "Bay 4 rebar" and
            // a photograph returns "Bay 4 rebar" and the transcript is just
            // the note again, which reads as confirmation and is nothing.
            `${transcriptionInstruction(request.kind)}\n\nThe person who filed this typed the following alongside it. Use it only to get names and numbers right; do not repeat it back and do not treat it as a description of what is here.\n\n${request.hint}`
          : transcriptionInstruction(request.kind),
      },
    ]

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [{ role: 'user', content }],
    })

    if (response.stop_reason === 'refusal') {
      throw new KernelError('transcription_refused', 'The reader declined to read this file', 502, {
        category: response.stop_details?.category ?? null,
      })
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim()

    if (!text) {
      // An empty transcript that lands in the database looks identical to a
      // file nobody has got to yet, and the capture quietly stops being work
      // anybody does.
      throw new KernelError('transcription_empty', 'Nothing could be read from this file', 502)
    }

    return {
      text,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
    }
  }
}
