import { describe, expect, it } from 'vitest';
import { ProviderError } from '../errors.mjs';
import { createDeepSeekProvider } from './deepseek.mjs';

/** Captures what the adapter sent and replays a canned reply, so no network is involved. */
function stubFetch(reply) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return reply();
  };
  return { fetchImpl, calls };
}

function okBody(content, extra = {}) {
  return new Response(
    JSON.stringify({
      id: 'chat-1',
      object: 'chat.completion',
      model: 'deepseek-flash',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 },
      ...extra,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

const CONFIG = {
  apiKey: 'sk-not-a-real-key',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  timeoutMs: 5000,
};

describe('createDeepSeekProvider', () => {
  it('refuses to be constructed without a key', () => {
    expect(() => createDeepSeekProvider({ ...CONFIG, apiKey: '' })).toThrow(ProviderError);
  });

  it('posts to the documented endpoint with bearer auth and the configured model', async () => {
    const { fetchImpl, calls } = stubFetch(() => okBody('{"answer":"ok","citations":[]}'));
    const provider = createDeepSeekProvider({ ...CONFIG, fetchImpl });
    await provider.complete({
      system: 'SYS',
      messages: [{ role: 'user', content: 'USER' }],
      maxTokens: 512,
      meta: {},
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.deepseek.com/chat/completions');
    expect(calls[0].options.method).toBe('POST');
    expect(calls[0].options.headers.Authorization).toBe('Bearer sk-not-a-real-key');
    expect(calls[0].body.model).toBe('deepseek-flash');
    expect(calls[0].body.stream).toBe(false);
    expect(calls[0].body.max_tokens).toBe(512);
    // Thinking is on upstream by default at effort `high`, and reasoning tokens come out of the
    // same budget as the answer, so both settings are sent rather than inherited.
    expect(calls[0].body.thinking).toEqual({ type: 'enabled' });
    expect(calls[0].body.reasoning_effort).toBe('low');
    // JSON mode is deliberately *not* requested. The answer is plain text now (see prompt.mjs);
    // asking for json_object would put a LaTeX-heavy answer back inside a JSON string, which is
    // the exact shape that lost a real reply when the model escaped its own protocol into it.
    expect(calls[0].body.response_format).toBeUndefined();
    expect(calls[0].body.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(calls[0].body.messages[1]).toEqual({ role: 'user', content: 'USER' });
  });

  it('reports the model and the token usage it was given', async () => {
    const { fetchImpl } = stubFetch(() => okBody('{"answer":"ok","citations":[]}'));
    const provider = createDeepSeekProvider({ ...CONFIG, fetchImpl });
    const result = await provider.complete({ system: 'S', messages: [], meta: {} });
    expect(result.text).toBe('{"answer":"ok","citations":[]}');
    // Absent fields are reported as absent rather than as zero: "no reasoning was reported" and
    // "no reasoning was used" are different claims, and only the first one is known here.
    expect(result.usage).toEqual({
      promptTokens: 1200,
      completionTokens: 80,
      reasoningTokens: null,
      cachedPromptTokens: null,
    });
    expect(result.truncated).toBe(false);
  });

  it('flags an answer the model ran out of room for', async () => {
    const { fetchImpl } = stubFetch(() =>
      okBody('{"answer":"half', {
        choices: [
          {
            index: 0,
            finish_reason: 'length',
            message: { role: 'assistant', content: '{"answer":"half' },
          },
        ],
      }),
    );
    const provider = createDeepSeekProvider({ ...CONFIG, fetchImpl });
    const result = await provider.complete({ system: 'S', messages: [], meta: {} });
    expect(result.truncated).toBe(true);
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate-limit'],
    // 402 is an empty account, not a busy one: waiting does not fix it, so it says so.
    [402, 'insufficient-balance'],
    // 400/422 mean the parameters we built were rejected — a defect on our side rather than
    // something wrong at the model service.
    [400, 'invalid-request'],
    [422, 'invalid-request'],
    [500, 'upstream'],
    [503, 'upstream'],
  ])('maps HTTP %i to the %s category', async (status, code) => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response(JSON.stringify({ error: { message: 'reflected prompt: SECRET' } }), {
          status,
        }),
    );
    const provider = createDeepSeekProvider({ ...CONFIG, fetchImpl });
    await expect(provider.complete({ system: 'S', messages: [], meta: {} })).rejects.toMatchObject({
      code,
    });
  });

  it('never puts the key or the upstream body into the error it throws', async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response(
          JSON.stringify({ error: { message: 'the text you sent was: PRIVATE PAPER TEXT' } }),
          {
            status: 500,
          },
        ),
    );
    const provider = createDeepSeekProvider({ ...CONFIG, fetchImpl });
    const failure = await provider
      .complete({ system: 'S', messages: [], meta: {} })
      .catch((error) => error);
    expect(failure.message).not.toContain('sk-not-a-real-key');
    expect(failure.message).not.toContain('PRIVATE PAPER TEXT');
    expect(failure.message).toContain('500');
  });

  it('gives up at the timeout instead of hanging', async () => {
    const fetchImpl = (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    const provider = createDeepSeekProvider({ ...CONFIG, timeoutMs: 30, fetchImpl });
    await expect(provider.complete({ system: 'S', messages: [], meta: {} })).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('surfaces a caller cancellation as its own category', async () => {
    const controller = new AbortController();
    const fetchImpl = (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    const provider = createDeepSeekProvider({ ...CONFIG, fetchImpl });
    const promise = provider.complete({
      system: 'S',
      messages: [],
      meta: {},
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'network' });
  });

  it('reports a reply with no usable content rather than returning undefined', async () => {
    const { fetchImpl } = stubFetch(
      () => new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 }),
    );
    const provider = createDeepSeekProvider({ ...CONFIG, fetchImpl });
    await expect(provider.complete({ system: 'S', messages: [], meta: {} })).rejects.toMatchObject({
      code: 'upstream',
    });
  });

  it('reports a non-JSON reply as an upstream failure', async () => {
    const { fetchImpl } = stubFetch(() => new Response('<html>gateway</html>', { status: 200 }));
    const provider = createDeepSeekProvider({ ...CONFIG, fetchImpl });
    await expect(provider.complete({ system: 'S', messages: [], meta: {} })).rejects.toMatchObject({
      code: 'upstream',
    });
  });

  /**
   * Thinking mode spends from the same budget as the answer, so the failure it produces — a long
   * think, no answer, `finish_reason: length` — has to be recognisable on its own instead of
   * looking like a broken service.
   */
  it('names the empty-answer case that thinking mode causes', async () => {
    const { fetchImpl } = stubFetch(() =>
      okBody('', {
        choices: [
          {
            index: 0,
            finish_reason: 'length',
            message: { role: 'assistant', content: '', reasoning_content: 'thinking…' },
          },
        ],
      }),
    );
    const provider = createDeepSeekProvider({ ...CONFIG, fetchImpl });
    const failure = await provider
      .complete({ system: 'S', messages: [], meta: {} })
      .catch((error) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure.code).toBe('incomplete');
    expect(failure.message).toContain('推理');
  });

  it('treats a service-side interruption as an incomplete answer', async () => {
    const { fetchImpl } = stubFetch(() =>
      okBody('partial', {
        choices: [
          {
            index: 0,
            finish_reason: 'insufficient_system_resource',
            message: { role: 'assistant', content: 'partial' },
          },
        ],
      }),
    );
    const provider = createDeepSeekProvider({ ...CONFIG, fetchImpl });
    const result = await provider.complete({ system: 'S', messages: [], meta: {} });
    expect(result.truncated).toBe(true);
    expect(result.stopped).toBe('insufficient_system_resource');
  });

  it('says so when content was filtered away rather than calling it a service error', async () => {
    const { fetchImpl } = stubFetch(() =>
      okBody('', {
        choices: [
          {
            index: 0,
            finish_reason: 'content_filter',
            message: { role: 'assistant', content: '' },
          },
        ],
      }),
    );
    const provider = createDeepSeekProvider({ ...CONFIG, fetchImpl });
    const failure = await provider
      .complete({ system: 'S', messages: [], meta: {} })
      .catch((error) => error);
    expect(failure.code).toBe('upstream');
    expect(failure.message).toContain('内容策略');
  });

  /** `reasoning_content` is the thinking. It is never the reply, under any circumstance. */
  it('never returns the reasoning as if it were the answer', async () => {
    const { fetchImpl } = stubFetch(() =>
      okBody('the answer', {
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'the answer',
              reasoning_content: 'SECRET CHAIN OF THOUGHT',
            },
          },
        ],
      }),
    );
    const provider = createDeepSeekProvider({ ...CONFIG, fetchImpl });
    const result = await provider.complete({ system: 'S', messages: [], meta: {} });
    expect(result.text).toBe('the answer');
    expect(result.text).not.toContain('SECRET');
  });

  it('records the reasoning tokens separately from the answer tokens', async () => {
    const { fetchImpl } = stubFetch(() =>
      okBody('{"answer":"x"}', {
        usage: {
          prompt_tokens: 900,
          completion_tokens: 1500,
          prompt_cache_hit_tokens: 600,
          completion_tokens_details: { reasoning_tokens: 1100 },
        },
      }),
    );
    const provider = createDeepSeekProvider({ ...CONFIG, fetchImpl });
    const result = await provider.complete({ system: 'S', messages: [], meta: {} });
    expect(result.usage).toEqual({
      promptTokens: 900,
      completionTokens: 1500,
      reasoningTokens: 1100,
      cachedPromptTokens: 600,
    });
  });

  it('reports no truncation when the service gives no reason', async () => {
    const { fetchImpl } = stubFetch(() =>
      okBody('{"answer":"x"}', {
        choices: [{ index: 0, message: { role: 'assistant', content: '{"answer":"x"}' } }],
      }),
    );
    const provider = createDeepSeekProvider({ ...CONFIG, fetchImpl });
    const result = await provider.complete({ system: 'S', messages: [], meta: {} });
    expect(result.truncated).toBe(false);
    expect(result.stopped).toBeNull();
  });

  /** A failing billable call is reported once. Asking again is the reader's decision, not ours. */
  it('does not retry a failed request', async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response('{}', { status: 500 }));
    const provider = createDeepSeekProvider({ ...CONFIG, fetchImpl });
    await provider.complete({ system: 'S', messages: [], meta: {} }).catch(() => null);
    expect(calls).toHaveLength(1);
  });
});
