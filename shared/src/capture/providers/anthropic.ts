import Anthropic from '@anthropic-ai/sdk'
import { KernelError } from '../../errors.js'
import type { InterpretationProvider, ProviderRequest, ProviderResponse } from '../interpreter.js'

/**
 * The only file in the product that imports a model SDK.
 *
 * Everything above `InterpretationProvider` is vendor-agnostic, which is what
 * lets the whole pipeline be tested against a scripted double with no network
 * and no key. Swapping or adding a vendor is one more file in this directory.
 */

export const DEFAULT_MODEL = 'claude-opus-5'

export interface AnthropicProviderOptions {
  client?: Anthropic
  model?: string
  /**
   * Structured extraction from a short capture does not need deep reasoning,
   * and the field is waiting. Raise this for harder document work.
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export class AnthropicInterpretationProvider implements InterpretationProvider {
  readonly name = 'anthropic'
  private readonly client: Anthropic
  private readonly model: string
  private readonly effort: NonNullable<AnthropicProviderOptions['effort']>

  constructor(options: AnthropicProviderOptions = {}) {
    // Resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or a CLI profile.
    this.client = options.client ?? new Anthropic()
    this.model = options.model ?? DEFAULT_MODEL
    this.effort = options.effort ?? 'medium'
  }

  async interpret(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens,
      // The system prompt holds the type registry and the project roster: the
      // same bytes for every capture on a project, and by far the largest part
      // of the request. Caching it is the difference between paying for the
      // registry once a day and paying for it on every photo.
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: request.userContent }],
      output_config: {
        effort: this.effort,
        format: { type: 'json_schema', schema: request.schema },
      },
    })

    if (response.stop_reason === 'refusal') {
      throw new KernelError('interpreter_refused', 'The interpreter declined to read this capture', 502, {
        category: response.stop_details?.category ?? null,
      })
    }
    if (response.stop_reason === 'max_tokens') {
      throw new KernelError('interpreter_truncated', 'The interpreter ran out of room before finishing', 502)
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')

    let output: unknown
    try {
      output = JSON.parse(text)
    } catch {
      // Structured output makes this close to impossible, which is exactly why
      // it must fail loudly rather than be papered over with a regex.
      throw new KernelError('interpreter_invalid_output', 'The interpreter did not return valid JSON', 502)
    }

    return {
      output,
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
