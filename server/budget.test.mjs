import { afterEach, describe, expect, it } from 'vitest';
import { estimatePromptTokens } from './index.mjs';
import { postJson, startTestService, validAsk } from './testing.mjs';

/**
 * Spending caps, exercised through the real HTTP surface.
 *
 * The provider is a stub with `online: true`, so these tests never reach a network. What they
 * assert is the service's own decision: when a call is refused, and what the health endpoint
 * then reports about the session.
 */

const running = [];
async function service(provider, config = {}) {
  const started = await startTestService({ provider, config });
  running.push(started);
  return started;
}

afterEach(async () => {
  while (running.length > 0) await running.pop().stop();
});

function stubProvider(overrides = {}) {
  const calls = [];
  return {
    calls,
    name: 'deepseek',
    label: 'DeepSeek test stub',
    model: 'deepseek-flash',
    online: true,
    reasoning: '思考模式 low',
    complete: async (request) => {
      calls.push(request);
      return {
        text: '这是一个测试回答。\n[[CITATIONS]]\n[]',
        usage: {
          promptTokens: 10,
          completionTokens: 20,
          reasoningTokens: null,
          cachedPromptTokens: 0,
        },
        truncated: false,
        finishReason: 'stop',
      };
    },
    ...overrides,
  };
}

describe('prompt token estimate', () => {
  it('charges CJK per character and Latin per three and a half', () => {
    expect(estimatePromptTokens('')).toBe(400);
    // 3500 CJK characters are about 3500 tokens; 3500 Latin characters about 1000.
    expect(estimatePromptTokens('中'.repeat(3500))).toBe(3900);
    expect(estimatePromptTokens('a'.repeat(3500))).toBe(1400);
  });
});

describe('session spending caps', () => {
  it('allows a long document summary to be regenerated while the session has room', async () => {
    const provider = stubProvider();
    provider.complete = async (request) => {
      provider.calls.push(request);
      return {
        text: '摘要\n<<<CITATIONS>>>\n[]',
        usage: {
          promptTokens: 90_000,
          completionTokens: 1_000,
          reasoningTokens: null,
          cachedPromptTokens: 0,
        },
        truncated: false,
        finishReason: 'stop',
      };
    };
    const { base } = await service(provider, {
      budget: { requests: 10, tokensPerRequest: 8192, tokensPerSession: 200_000 },
    });
    const document = validAsk({
      mode: 'summarize',
      scope: 'document',
      paper: { ...validAsk().paper, page: 1 },
      passages: Array.from({ length: 26 }, (_unused, index) => ({
        id: `p${String(index)}`,
        page: index + 1,
        text: 'a'.repeat(12_000),
        selection: index === 0,
      })),
    });

    const first = await postJson(base, '/api/ai/ask', document);
    expect(first.status).toBe(200);
    // The first summary settles at 91k tokens. The second one's honest upper bound is about
    // 97k, so 188k of the 200k session is enough; the old character-halving estimate reserved
    // 165k and refused it even though the request itself would have fitted.
    const second = await postJson(base, '/api/ai/ask', document);
    expect(second.status).toBe(200);
    expect(provider.calls).toHaveLength(2);
  });

  it('stops before the call when the request limit is reached', async () => {
    const provider = stubProvider();
    const { base } = await service(provider, {
      budget: { requests: 1, tokensPerRequest: 1024, tokensPerSession: 100_000 },
    });

    const first = await postJson(base, '/api/ai/ask', validAsk());
    expect(first.status).toBe(200);
    expect(provider.calls).toHaveLength(1);

    const second = await postJson(base, '/api/ai/ask', validAsk());
    expect(second.status).toBe(429);
    const body = await second.json();
    expect(body.error).toBe('budget-exceeded');
    expect(body.message).toContain('请求次数');
    // Refused means refused: the provider was not called a second time.
    expect(provider.calls).toHaveLength(1);

    const health = await (await fetch(`${base}/api/ai/health`)).json();
    expect(health.usage.requests).toBe(1);
    expect(health.usage.promptTokens).toBe(10);
    expect(health.usage.completionTokens).toBe(20);
    expect(health.budget.requests).toBe(1);
  });

  it('stops when the next upper bound would exceed the session token limit', async () => {
    const provider = stubProvider({
      complete: async () => ({
        text: '这是一个测试回答。\n<<<CITATIONS>>>\n[]',
        usage: {
          promptTokens: 5000,
          completionTokens: 3000,
          reasoningTokens: null,
          cachedPromptTokens: 0,
        },
        truncated: false,
        finishReason: 'stop',
      }),
    });
    const { base } = await service(provider, {
      budget: { requests: 50, tokensPerRequest: 1000, tokensPerSession: 9000 },
    });

    const first = await postJson(base, '/api/ai/ask', validAsk());
    expect(first.status).toBe(200);

    // 8000 tokens are already recorded; the next call's upper bound cannot fit in 9000.
    const second = await postJson(base, '/api/ai/ask', validAsk());
    expect(second.status).toBe(429);
    expect((await second.json()).error).toBe('budget-exceeded');
  });

  it('counts a failed attempt, so a retry loop still hits the wall', async () => {
    const provider = stubProvider({
      complete: async () => {
        throw new Error('upstream failure');
      },
    });
    const { base } = await service(provider, {
      budget: { requests: 1, tokensPerRequest: 1024, tokensPerSession: 100_000 },
    });

    const first = await postJson(base, '/api/ai/ask', validAsk());
    expect(first.status).toBe(502);
    const second = await postJson(base, '/api/ai/ask', validAsk());
    expect(second.status).toBe(429);
    expect((await second.json()).error).toBe('budget-exceeded');
  });

  it('does not apply paid caps to the offline mock, which cannot spend', async () => {
    const { base } = await service(undefined, {
      budget: { requests: 1, tokensPerRequest: 512, tokensPerSession: 256 },
    });
    for (let index = 0; index < 3; index += 1) {
      const response = await postJson(base, '/api/ai/ask', validAsk());
      expect(response.status).toBe(200);
    }
    const health = await (await fetch(`${base}/api/ai/health`)).json();
    expect(health.usage.requests).toBe(3);
  });

  it('says the cost estimate is unreliable for an unpriced model', async () => {
    const provider = stubProvider({ model: 'some-new-model' });
    const { base } = await service(provider, {
      budget: { requests: 5, tokensPerRequest: 1024, tokensPerSession: 100_000 },
    });
    await postJson(base, '/api/ai/ask', validAsk());
    const health = await (await fetch(`${base}/api/ai/health`)).json();
    expect(health.pricing.known).toBe(false);
    expect(health.usage.costKnown).toBe(false);
    expect(health.usage.unknownCostRequests).toBe(1);
  });

  it('estimates the cost from the reported tokens for a priced model', async () => {
    const provider = stubProvider();
    const { base } = await service(provider, {
      budget: { requests: 5, tokensPerRequest: 1024, tokensPerSession: 100_000 },
    });
    await postJson(base, '/api/ai/ask', validAsk());
    const health = await (await fetch(`${base}/api/ai/health`)).json();
    expect(health.pricing.known).toBe(true);
    // 10 prompt tokens (cache-miss peak) + 20 output tokens, at 8 CNY/USD.
    const expected = ((10 * 0.3 + 20 * 1.2) / 1_000_000) * 8;
    expect(health.usage.estimatedCostCny).toBeCloseTo(expected, 4);
    expect(health.usage.costKnown).toBe(true);
    expect(health.usage.exactTokens).toBe(true);
  });
});
