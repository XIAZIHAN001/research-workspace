import { afterEach, describe, expect, it } from 'vitest';
import { ProviderError } from './errors.mjs';
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
    // Requests are counted, but an offline answer is not a bill: no token total, no estimate,
    // and no "unpriced model" warning for a model that cannot cost anything.
    expect(health.usage.totalTokens).toBe(0);
    expect(health.usage.estimatedRequests).toBe(0);
    expect(health.usage.exactTokens).toBe(true);
    expect(health.usage.estimatedCostCny).toBe(0);
    expect(health.usage.unknownCostRequests).toBe(0);
  });

  /**
   * A failed request is not evidence that the provider did no work. A connection reset, a
   * timeout or a stream that dies after the headers can all follow a partial generation, so the
   * reserved upper bound is charged and marked as an estimate.
   */
  it.each(['network', 'timeout', 'upstream'])(
    'charges a bounded estimate when a sent request fails (%s) without usage',
    async (code) => {
      const provider = stubProvider({
        complete: async () => {
          throw new ProviderError(code, '模拟的上游失败。', { requestSent: true });
        },
      });
      const { base } = await service(provider, {
        budget: { requests: 5, tokensPerRequest: 1024, tokensPerSession: 100_000 },
      });

      const response = await postJson(base, '/api/ai/ask', validAsk());
      expect(response.status).not.toBe(200);

      const health = await (await fetch(`${base}/api/ai/health`)).json();
      expect(health.usage.requests).toBe(1);
      // The whole reservation (prompt estimate plus the generation ceiling) is charged, never
      // zero, so a failure cannot be a way to spend without moving the session total.
      expect(health.usage.totalTokens).toBeGreaterThan(1024);
      expect(health.usage.completionTokens).toBe(1024);
      expect(health.usage.exactTokens).toBe(false);
      expect(health.usage.estimatedRequests).toBe(1);
    },
  );

  it('releases the reservation when the request provably never reached the provider', async () => {
    const provider = stubProvider({
      complete: async () => {
        throw new ProviderError('network', '请求已取消。', { requestSent: false });
      },
    });
    const { base } = await service(provider, {
      budget: { requests: 5, tokensPerRequest: 1024, tokensPerSession: 100_000 },
    });

    await postJson(base, '/api/ai/ask', validAsk());
    const health = await (await fetch(`${base}/api/ai/health`)).json();
    expect(health.usage.requests).toBe(1);
    expect(health.usage.totalTokens).toBe(0);
    expect(health.usage.estimatedRequests).toBe(0);
    expect(health.usage.exactTokens).toBe(true);
  });

  it('treats an unclassified failure conservatively rather than as free', async () => {
    const provider = stubProvider({
      complete: async () => {
        // A provider implementation that does not classify its failures: unknown means "may
        // have been sent", not "spent nothing".
        throw new Error('unclassified failure');
      },
    });
    const { base } = await service(provider, {
      budget: { requests: 5, tokensPerRequest: 1024, tokensPerSession: 100_000 },
    });
    await postJson(base, '/api/ai/ask', validAsk());
    const health = await (await fetch(`${base}/api/ai/health`)).json();
    expect(health.usage.totalTokens).toBeGreaterThan(1024);
    expect(health.usage.estimatedRequests).toBe(1);
  });

  it('settles a partial usage with the reserved bound instead of zero', async () => {
    const provider = stubProvider({
      complete: async () => ({
        text: '这是一个测试回答。\n<<<CITATIONS>>>\n[]',
        usage: {
          promptTokens: 10,
          completionTokens: null,
          reasoningTokens: null,
          cachedPromptTokens: 0,
        },
        truncated: false,
        finishReason: 'stop',
      }),
    });
    const { base } = await service(provider, {
      budget: { requests: 5, tokensPerRequest: 1024, tokensPerSession: 100_000 },
    });
    const response = await postJson(base, '/api/ai/ask', validAsk());
    expect(response.status).toBe(200);

    const health = await (await fetch(`${base}/api/ai/health`)).json();
    expect(health.usage.promptTokens).toBe(10);
    // The missing half is charged at the generation ceiling, not at zero.
    expect(health.usage.completionTokens).toBe(1024);
    expect(health.usage.exactTokens).toBe(false);
    expect(health.usage.estimatedRequests).toBe(1);
  });

  it('records a successful answer without usage as a bounded estimate', async () => {
    const provider = stubProvider({
      complete: async () => ({
        text: '这是一个测试回答。\n<<<CITATIONS>>>\n[]',
        usage: null,
        truncated: false,
        finishReason: 'stop',
      }),
    });
    const { base } = await service(provider, {
      budget: { requests: 5, tokensPerRequest: 1024, tokensPerSession: 100_000 },
    });
    await postJson(base, '/api/ai/ask', validAsk());
    const health = await (await fetch(`${base}/api/ai/health`)).json();
    expect(health.usage.totalTokens).toBeGreaterThan(1024);
    expect(health.usage.exactTokens).toBe(false);
    expect(health.usage.estimatedRequests).toBe(1);
  });

  /**
   * A failure followed by a retry is exactly the loop the caps exist for. If a failed request
   * were refunded, the session would keep accepting calls whose upstream cost is unknown.
   */
  it('lets a failed request consume the budget so a retry cannot overshoot', async () => {
    const provider = stubProvider({
      complete: async () => {
        throw new ProviderError('upstream', '模拟的上游失败。', { requestSent: true });
      },
    });
    const document = validAsk({
      mode: 'summarize',
      scope: 'document',
      paper: { ...validAsk().paper, page: 1 },
      passages: Array.from({ length: 8 }, (_unused, index) => ({
        id: `p${String(index)}`,
        page: index + 1,
        text: 'a'.repeat(12_000),
        selection: index === 0,
      })),
    });
    const { base } = await service(provider, {
      budget: { requests: 10, tokensPerRequest: 1024, tokensPerSession: 40_000 },
    });

    const first = await postJson(base, '/api/ai/ask', document);
    expect(first.status).not.toBe(200);
    const health = await (await fetch(`${base}/api/ai/health`)).json();
    expect(health.usage.totalTokens).toBeGreaterThan(20_000);

    const second = await postJson(base, '/api/ai/ask', document);
    expect(second.status).toBe(429);
    expect((await second.json()).error).toBe('budget-exceeded');
  });

  it('settles concurrent successes and failures independently', async () => {
    let call = 0;
    const provider = stubProvider({
      complete: async () => {
        const index = call;
        call += 1;
        if (index !== 1) {
          throw new ProviderError('upstream', '模拟的上游失败。', { requestSent: true });
        }
        return {
          text: '这是一个测试回答。\n<<<CITATIONS>>>\n[]',
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
    });
    const { base } = await service(provider, {
      budget: { requests: 10, tokensPerRequest: 1024, tokensPerSession: 100_000 },
    });

    const responses = await Promise.all([
      postJson(base, '/api/ai/ask', validAsk()),
      postJson(base, '/api/ai/ask', validAsk()),
      postJson(base, '/api/ai/ask', validAsk()),
    ]);
    const statuses = responses.map((response) => response.status).sort((one, other) => one - other);
    expect(statuses).toEqual([200, 502, 502]);

    const health = await (await fetch(`${base}/api/ai/health`)).json();
    expect(health.usage.requests).toBe(3);
    // The reported call is exact; the two failed calls are charged their reserved bounds.
    expect(health.usage.completionTokens).toBe(20 + 1024 * 2);
    expect(health.usage.exactTokens).toBe(false);
    expect(health.usage.estimatedRequests).toBe(2);
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
