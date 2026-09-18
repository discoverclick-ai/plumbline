import type {
  InterpretationProvider,
  ProviderRequest,
  ProviderResponse,
} from '../../src/capture/interpreter.js'

/**
 * A scripted interpreter.
 *
 * The pipeline is tested end to end with no network and no key: queue what the
 * model would have said, then assert on what the system did with it. It also
 * records every request, which is how the tests check that the grounding sent
 * to the model is confined to the project the capture belongs to.
 */
export class ScriptedProvider implements InterpretationProvider {
  readonly name = 'scripted'
  readonly requests: ProviderRequest[] = []
  private readonly queue: (unknown | Error)[] = []

  constructor(private readonly model = 'claude-opus-5') {}

  /** Queue the next output, or an error to simulate a provider failure. */
  push(output: unknown | Error): this {
    this.queue.push(output)
    return this
  }

  async interpret(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request)
    const next = this.queue.shift()
    if (next === undefined) throw new Error('ScriptedProvider ran out of queued outputs')
    if (next instanceof Error) throw next

    return {
      output: next,
      model: this.model,
      usage: { inputTokens: 1_200, outputTokens: 180, cacheReadTokens: 900, cacheWriteTokens: 0 },
    }
  }
}
