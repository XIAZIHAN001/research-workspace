import { describe, expect, it, vi } from 'vitest';
import { askAi, DEFAULT_TIMEOUT_MS, fetchAiHealth } from './client';
import type { AiAnswer, AiAskRequest } from './types';

const REQUEST: AiAskRequest = {
  mode: 'explain',
  question: '',
  paper: { id: 'p1', title: 'A Paper', page: 2, pdfSha256: 'a'.repeat(64) },
  passages: [{ id: 'selection', page: 2, text: 'some text', selection: true }],
};

const ANSWER: AiAnswer = {
  provider: 'mock',
  providerLabel: '本地模拟（未连接在线模型）',
  model: 'mock-1',
  online: false,
  mode: 'explain',
  answer: '解释 [1]',
  groundedInText: true,
  citations: [{ n: 1, passageId: 'selection', page: 2, quote: 'some text', selection: true }],
  warnings: [],
  usage: null,
};

function reply(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  ) as unknown as typeof fetch;
}

describe('askAi', () => {
  it('returns the answer on success', async () => {
    const outcome = await askAi(REQUEST, { fetchImpl: reply(200, ANSWER) });
    expect(outcome).toEqual({ ok: true, answer: ANSWER });
  });

  it('sends no credential of any kind', async () => {
    const fetchImpl = reply(200, ANSWER);
    await askAi(REQUEST, { fetchImpl });
    const calls = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    const [url, init] = calls[0] ?? ['', {}];
    expect(url).toBe('/api/ai/ask');
    const headers = (init.headers ?? {}) as Record<string, string>;
    // The key lives in the service process; nothing here should ever carry one.
    expect(Object.keys(headers).map((name) => name.toLowerCase())).toEqual(['content-type']);
    expect(JSON.stringify(init)).not.toMatch(/sk-|api[_-]?key|authorization|bearer/i);
  });

  it('posts the structured request unchanged', async () => {
    const fetchImpl = reply(200, ANSWER);
    await askAi(REQUEST, { fetchImpl });
    const calls = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    expect(JSON.parse(String(calls[0]?.[1].body))).toEqual(REQUEST);
  });

  it.each([
    [400, { error: 'bad-request', message: 'x' }, 'bad-request'],
    [413, { error: 'bad-request', message: 'x' }, 'bad-request'],
    [429, { error: 'rate-limit', message: 'x' }, 'rate-limit'],
    [429, { error: 'busy', message: 'x' }, 'busy'],
    [502, { error: 'auth', message: 'x' }, 'auth'],
    [502, { error: 'upstream', message: 'x' }, 'upstream'],
    [504, { error: 'timeout', message: 'x' }, 'timeout'],
  ])('maps HTTP %i/%s to a failure the interface can act on', async (status, body, kind) => {
    const outcome = await askAi(REQUEST, { fetchImpl: reply(status, body) });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.failure.kind).toBe(kind);
    expect(outcome.ok === false && outcome.failure.message).not.toBe('');
  });

  it('treats an unreachable service as offline rather than as a model error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const outcome = await askAi(REQUEST, { fetchImpl });
    expect(outcome.ok === false && outcome.failure.kind).toBe('offline');
    expect(outcome.ok === false && outcome.failure.message).toContain('ai:serve');
  });

  it('reports a reply that is not JSON at all', async () => {
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(new Response('<html>', { status: 200 })),
    ) as unknown as typeof fetch;
    const outcome = await askAi(REQUEST, { fetchImpl });
    expect(outcome.ok === false && outcome.failure.kind).toBe('upstream');
  });

  it('reports a JSON reply that is not an answer', async () => {
    const outcome = await askAi(REQUEST, { fetchImpl: reply(200, { hello: 'world' }) });
    expect(outcome.ok === false && outcome.failure.kind).toBe('upstream');
  });

  it('gives up at its own deadline', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    ) as unknown as typeof fetch;
    const outcome = await askAi(REQUEST, { fetchImpl, timeoutMs: 20 });
    expect(outcome.ok === false && outcome.failure.kind).toBe('timeout');
  });

  it('reports a reader cancellation as cancelled, not as a failure of the model', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    ) as unknown as typeof fetch;
    const promise = askAi(REQUEST, { fetchImpl, signal: controller.signal, timeoutMs: 5000 });
    controller.abort();
    const outcome = await promise;
    expect(outcome.ok === false && outcome.failure.kind).toBe('cancelled');
  });

  it('has a default deadline, so no call can run forever', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(300_000);
  });
});

describe('fetchAiHealth', () => {
  it('reports what the service is', async () => {
    const health = await fetchAiHealth({
      fetchImpl: reply(200, {
        provider: 'mock',
        label: '本地模拟',
        model: 'mock-1',
        online: false,
      }),
    });
    expect(health?.provider).toBe('mock');
    expect(health?.online).toBe(false);
  });

  it('returns null when the service is not running, which is not an error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await fetchAiHealth({ fetchImpl })).toBeNull();
  });

  it('returns null for a reply that does not describe a service', async () => {
    expect(await fetchAiHealth({ fetchImpl: reply(200, { nothing: true }) })).toBeNull();
    expect(await fetchAiHealth({ fetchImpl: reply(500, {}) })).toBeNull();
  });
});
