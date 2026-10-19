/**
 * Price information for the one paid provider this build talks to.
 *
 * This module exists so that a cost shown in the interface has a stated basis. Two rules:
 *
 * - A price is a dated observation, not a constant. The table below records the day it was read
 *   and the page it came from; the interface says both, and says that the bill is computed by
 *   the provider, not here.
 * - A model without a row is `known: false`. The interface then says the estimate is not
 *   reliable instead of inventing a number or silently reusing another model's price.
 *
 * The estimate deliberately uses the *peak, cache-miss* input price and the peak output price.
 * That makes it an upper bound for the models in the table, which is the useful direction for a
 * spending warning: it can overstate a cheap call, but it does not understate an expensive one.
 */

/** The day the prices below were read from the official page. */
export const PRICING_AS_OF = '2026-10-18';

export const PRICING_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing';

/**
 * A conservative conversion used only to show an approximate CNY figure. The provider bills in
 * USD; the multiplier is round-up-ish on purpose and is not an exchange-rate service.
 */
export const USD_CNY = 8.0;

/**
 * USD per million tokens, from the official page as of `PRICING_AS_OF`.
 *
 * `inputCacheMissPeak` and `outputPeak` are the peak-period prices. `inputCacheHitPeak` is kept
 * for completeness; the estimate applies it to the cached part of the prompt when the provider
 * reports one.
 */
export const MODEL_PRICES = {
  'deepseek-flash': {
    inputCacheHitPeak: 0.006,
    inputCacheMissPeak: 0.3,
    outputPeak: 1.2,
  },
};

/**
 * What the interface needs to state the basis of an estimate, including when there is none.
 *
 * `known: false` is not an error: a model can be valid and simply not have a price row yet.
 */
export function describePrice(model) {
  const row = MODEL_PRICES[model];
  if (row === undefined) {
    return {
      model,
      known: false,
      currency: 'CNY',
      asOf: PRICING_AS_OF,
      source: PRICING_SOURCE,
      note: '没有这个模型的可用价格配置，费用估算不可靠；实际用量由模型服务结算。',
    };
  }
  return {
    model,
    known: true,
    currency: 'CNY',
    asOf: PRICING_AS_OF,
    source: PRICING_SOURCE,
    basis: '按官方峰值价格、输入按缓存未命中保守估算',
    usdCny: USD_CNY,
    perMillionUsd: {
      inputCacheHit: row.inputCacheHitPeak,
      inputCacheMiss: row.inputCacheMissPeak,
      output: row.outputPeak,
    },
    note: `价格读取于 ${PRICING_AS_OF}，可能已经变化；这里是估算，不是账单。`,
  };
}

/**
 * An estimate in CNY for one call, using the provider's reported token counts.
 *
 * `cachedPromptTokens` is subtracted from the prompt before applying the cache-miss price. If it
 * is unknown, every prompt token is treated as a miss — the conservative direction.
 */
export function estimateCostCny(
  model,
  { promptTokens, completionTokens, cachedPromptTokens } = {},
) {
  const row = MODEL_PRICES[model];
  if (row === undefined) return null;
  const prompt = Number.isFinite(promptTokens) ? Math.max(0, promptTokens) : 0;
  const completion = Number.isFinite(completionTokens) ? Math.max(0, completionTokens) : 0;
  const cached = Number.isFinite(cachedPromptTokens)
    ? Math.min(prompt, Math.max(0, cachedPromptTokens))
    : 0;
  const uncached = prompt - cached;
  const usd =
    (uncached * row.inputCacheMissPeak +
      cached * row.inputCacheHitPeak +
      completion * row.outputPeak) /
    1_000_000;
  return usd * USD_CNY;
}
