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
    // JSON mode is only useful if the prompt asks for JSON too, which the system message does.
    expect(calls[0].body.response_format).toEqual({ type: 'json_object' });
    expect(calls[0].body.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(calls[0].body.messages[1]).toEqual({ role: 'user', content: 'USER' });
  });

  it('reports the model and the token usage it was given', async () => {
    const { fetchImpl } = stubFetch(() => okBody('{"answer":"ok","citations":[]}'));
    const provider = createDeepSeekProvider({ ...CONFIG, fetchImpl });
    const result = await provider.complete({ system: 'S', messages: [], meta: {} });
    expect(result.text).toBe('{"answer":"ok","citations":[]}');
    expect(result.usage).toEqual({ promptTokens: 1200, completionTokens: 80 });
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
    [402, 'rate-limit'],
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
});
