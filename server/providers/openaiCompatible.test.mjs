import { describe, expect, it } from 'vitest';
import { ProviderError } from '../errors.mjs';
import { createChatCompletionsProvider } from './openaiCompatible.mjs';

/** Captures what the adapter sent and replays a canned reply, so no network is involved. */
function stubFetch(reply) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return reply();
  };
  return { fetchImpl, calls };
}

function okBody(content) {
  return new Response(
    JSON.stringify({
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

const CONFIG = {
  id: 'openai',
  label: 'OpenAI',
  apiKey: 'sk-not-a-real-key',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
};

/**
 * A response whose headers arrive and whose body then stops.
 *
 * This is the shape the old adapter could not escape: `fetch` had already resolved, its deadline
 * had been cleared, and the reader waited for a chunk the upstream never sent.
 */
function stalledBody(onCancel = () => {}) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"choices":'));
    },
    cancel() {
      onCancel();
    },
  });
}

describe('createChatCompletionsProvider', () => {
  it('posts an ordinary chat-completions request and no DeepSeek-only parameters', async () => {
    const { fetchImpl, calls } = stubFetch(() => okBody('the answer'));
    const provider = createChatCompletionsProvider({ ...CONFIG, fetchImpl });
    await provider.complete({
      system: 'SYS',
      messages: [{ role: 'user', content: 'USER' }],
      maxTokens: 256,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0].options.headers.Authorization).toBe('Bearer sk-not-a-real-key');
    expect(calls[0].body.model).toBe('gpt-4o-mini');
    expect(calls[0].body.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(calls[0].body.stream).toBe(false);
    // Several compatible providers reject unknown fields outright, so the dialect-specific
    // pair must not leak into a generic request.
    expect(calls[0].body.thinking).toBeUndefined();
    expect(calls[0].body.reasoning_effort).toBeUndefined();
    expect(calls[0].body.response_format).toBeUndefined();
    // A 307/308 must not replay the prompt to another endpoint.
    expect(calls[0].options.redirect).toBe('error');
  });

  it('does not call fetch when the signal was already cancelled', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      throw new Error('fetch must not be called');
    };
    const provider = createChatCompletionsProvider({ ...CONFIG, fetchImpl, timeoutMs: 5_000 });
    const controller = new AbortController();
    controller.abort();

    const error = await provider
      .complete({ system: 'S', messages: [], maxTokens: 64, signal: controller.signal })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe('network');
    expect(error.message).toContain('取消');
    // An event registered after the cancellation never fires; the synchronous check is what
    // keeps the paper from leaving the machine.
    expect(calls).toBe(0);
  });

  it('aborts the in-flight fetch when the caller cancels', async () => {
    let calls = 0;
    let upstreamSignal = null;
    const fetchImpl = (_url, options) => {
      calls += 1;
      upstreamSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    };
    const provider = createChatCompletionsProvider({ ...CONFIG, fetchImpl, timeoutMs: 5_000 });
    const controller = new AbortController();
    const pending = provider
      .complete({ system: 'S', messages: [], maxTokens: 64, signal: controller.signal })
      .catch((caught) => caught);

    controller.abort();
    const error = await pending;

    expect(calls).toBe(1);
    expect(upstreamSignal?.aborted).toBe(true);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe('network');
  });

  it('times out a body that never ends after the headers, and cancels it', async () => {
    let cancelled = false;
    const fetchImpl = async () =>
      new Response(
        stalledBody(() => {
          cancelled = true;
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    const provider = createChatCompletionsProvider({ ...CONFIG, fetchImpl, timeoutMs: 80 });
    const started = Date.now();
    const error = await provider
      .complete({ system: 'S', messages: [], maxTokens: 64 })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe('timeout');
    // The reader really was cancelled, not merely abandoned: that is what releases the upstream
    // connection and lets the service's concurrency slot be reused.
    expect(cancelled).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('cancels the body read when the caller aborts after the headers', async () => {
    let cancelled = false;
    const fetchImpl = async () =>
      new Response(
        stalledBody(() => {
          cancelled = true;
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    const provider = createChatCompletionsProvider({ ...CONFIG, fetchImpl, timeoutMs: 5_000 });
    const controller = new AbortController();
    const pending = provider
      .complete({ system: 'S', messages: [], maxTokens: 64, signal: controller.signal })
      .catch((caught) => caught);
    setTimeout(() => {
      controller.abort();
    }, 25);

    const error = await pending;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe('network');
    expect(error.message).toContain('取消');
    expect(cancelled).toBe(true);
  });

  it('rejects a response that exceeds the byte ceiling instead of buffering it', async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response(JSON.stringify({ choices: [], padding: 'x'.repeat(500) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const provider = createChatCompletionsProvider({
      ...CONFIG,
      fetchImpl,
      maxResponseBytes: 64,
    });
    const error = await provider
      .complete({ system: 'S', messages: [], maxTokens: 64 })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toContain('过大');
  });

  it('reports the id the registry chose, and has no thinking switch to describe', async () => {
    const { fetchImpl } = stubFetch(() => okBody('x'));
    const provider = createChatCompletionsProvider({ ...CONFIG, fetchImpl });
    expect(provider.name).toBe('openai');
    expect(provider.model).toBe('gpt-4o-mini');
    expect(provider.label).toBe('OpenAI gpt-4o-mini');
    expect(provider.reasoning).toBeNull();
  });

  it('refuses to be constructed without a key, naming its own provider', () => {
    let failure = null;
    try {
      createChatCompletionsProvider({ ...CONFIG, apiKey: '' });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure.code).toBe('config');
    expect(failure.message).toContain('OpenAI');
  });

  it('accepts a gateway model name with separators', async () => {
    const { fetchImpl, calls } = stubFetch(() => okBody('x'));
    const provider = createChatCompletionsProvider({
      ...CONFIG,
      id: 'custom',
      label: '自定义服务',
      model: 'meta-llama/llama-3.1-8b-instruct:free',
      baseUrl: 'http://127.0.0.1:11434/v1',
      fetchImpl,
    });
    await provider.complete({ system: 'S', messages: [], maxTokens: 64 });
    expect(calls[0].url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(calls[0].body.model).toBe('meta-llama/llama-3.1-8b-instruct:free');
  });
});
