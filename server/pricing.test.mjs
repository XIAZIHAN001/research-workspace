import { describe, expect, it } from 'vitest';
import {
  MODEL_PRICES,
  PRICING_AS_OF,
  PRICING_SOURCE,
  describePrice,
  estimateCostCny,
} from './pricing.mjs';

describe('price configuration', () => {
  it('states where a price came from and when it was read', () => {
    const price = describePrice('deepseek-flash');
    expect(price.known).toBe(true);
    expect(price.asOf).toBe(PRICING_AS_OF);
    expect(price.source).toBe(PRICING_SOURCE);
    expect(price.note).toContain('不是账单');
    expect(price.perMillionUsd).toEqual({
      inputCacheHit: MODEL_PRICES['deepseek-flash'].inputCacheHitPeak,
      inputCacheMiss: MODEL_PRICES['deepseek-flash'].inputCacheMissPeak,
      output: MODEL_PRICES['deepseek-flash'].outputPeak,
    });
  });

  it('refuses to invent a price for a model without a row', () => {
    const price = describePrice('deepseek-v4-pro');
    expect(price.known).toBe(false);
    expect(price.perMillionUsd).toBeUndefined();
    expect(price.note).toContain('不可靠');
    expect(estimateCostCny('deepseek-v4-pro', { promptTokens: 1000, completionTokens: 1000 })).toBe(
      null,
    );
  });

  it('uses the conservative peak cache-miss input and peak output prices', () => {
    const oneMillion = estimateCostCny('deepseek-flash', {
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedPromptTokens: 0,
    });
    expect(oneMillion).toBeCloseTo(0.3 * 8, 6);

    const cached = estimateCostCny('deepseek-flash', {
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedPromptTokens: 1_000_000,
    });
    expect(cached).toBeCloseTo(0.006 * 8, 6);

    const output = estimateCostCny('deepseek-flash', {
      promptTokens: 0,
      completionTokens: 1_000_000,
    });
    expect(output).toBeCloseTo(1.2 * 8, 6);
  });

  it('never treats more cached tokens than were sent as a discount', () => {
    const clamped = estimateCostCny('deepseek-flash', {
      promptTokens: 1000,
      completionTokens: 0,
      cachedPromptTokens: 5000,
    });
    const fullyCached = estimateCostCny('deepseek-flash', {
      promptTokens: 1000,
      completionTokens: 0,
      cachedPromptTokens: 1000,
    });
    expect(clamped).toBeCloseTo(fullyCached, 10);
  });

  it('treats missing token counts as zero rather than NaN', () => {
    expect(estimateCostCny('deepseek-flash', {})).toBe(0);
    expect(
      estimateCostCny('deepseek-flash', { promptTokens: null, completionTokens: undefined }),
    ).toBe(0);
  });
});
