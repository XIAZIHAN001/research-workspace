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
