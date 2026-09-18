/**
 * What a model call cost, in millionths of a dollar.
 *
 * Integers, because a call that costs $0.0043 rounds to zero cents and a
 * million of those does not. Rates are per million tokens, as published.
 *
 * This exists so the product can eventually be priced on outcomes rather than
 * on the customer's annual construction volume. You cannot charge for an
 * accepted record without knowing what producing it cost.
 */

export interface ModelRates {
  /** Micro-dollars per million input tokens. */
  inputPerMTok: number
  outputPerMTok: number
  cacheReadPerMTok: number
  cacheWritePerMTok: number
}

/**
 * Cache reads are a tenth of input; cache writes are 1.25x. Both are derived
 * from the input rate rather than hard-coded, so a price change is one number.
 */
function rates(inputDollarsPerMTok: number, outputDollarsPerMTok: number): ModelRates {
  const input = inputDollarsPerMTok * 1_000_000
  return {
    inputPerMTok: input,
    outputPerMTok: outputDollarsPerMTok * 1_000_000,
    cacheReadPerMTok: input * 0.1,
    cacheWritePerMTok: input * 1.25,
  }
}

export const MODEL_RATES: Record<string, ModelRates> = {
  'claude-opus-5': rates(5, 25),
  'claude-sonnet-5': rates(2, 10),
  'claude-haiku-4-5': rates(1, 5),
}

export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface CostEstimate {
  costMicros: number
  /**
   * False when the model is not in the rate table. The call still happened and
   * the tokens are still recorded; the cost lands as zero and this flag is how
   * anyone notices, rather than the number silently being wrong.
   */
  priced: boolean
}

export function estimateCostMicros(model: string, tokens: TokenCounts): CostEstimate {
  const rate = MODEL_RATES[model]
  if (!rate) return { costMicros: 0, priced: false }

  const micros =
    (tokens.inputTokens * rate.inputPerMTok +
      tokens.outputTokens * rate.outputPerMTok +
      tokens.cacheReadTokens * rate.cacheReadPerMTok +
      tokens.cacheWriteTokens * rate.cacheWritePerMTok) /
    1_000_000

  return { costMicros: Math.round(micros), priced: true }
}

/** For display: micro-dollars to a dollar string. */
export function formatMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`
}
