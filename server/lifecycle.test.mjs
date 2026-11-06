import { afterEach, describe, expect, it } from 'vitest';
import { ProviderError } from './errors.mjs';
import { postJson, startTestService, validAsk } from './testing.mjs';

const ask = validAsk();
const endpoints = [
  ['ask', ask],
  ['difficulties', { paper: ask.paper, pageText: ask.passages[0].text }],
  [
    'knowledge',
    {
      paper: ask.paper,
      scope: 'selection',
      passages: ask.passages,
      existingConcepts: [],
      existingRelations: [],
    },
  ],
];
const outcome = {
  text: '{"answer":"ok","suggestions":[],"concepts":[],"relations":[],"citations":[]}',
  usage: { promptTokens: 10, completionTokens: 20 },
  truncated: false,
};
const running = [];
async function service(complete, options = {}) {
  const started = await startTestService({
    provider: {
      name: 'openai',
      model: 'gpt-4o-mini',
      label: 'Local test only',
      online: true,
      complete,
    },
    ...options,
  });
  running.push(started);
  return started;
}
afterEach(async () => {
  while (running.length > 0) await running.pop().stop();
});
async function usage(base) {
  return (await (await fetch(`${base}/api/ai/health`)).json()).usage;
}

describe.each(endpoints)('%s request lifecycle', (endpoint, body) => {
  const path = `/api/ai/${endpoint}`;

  it('settles reported usage once but records cancellation if the provider finishes after disconnect', async () => {
    const entered = Promise.withResolvers();
    const disconnected = Promise.withResolvers();
    const finished = Promise.withResolvers();
    const logged = Promise.withResolvers();
    let calls = 0;
    const { base } = await service(
      ({ signal }) => {
        calls += 1;
        if (calls > 1) return outcome;
        signal.addEventListener('abort', () => disconnected.resolve(), { once: true });
        entered.resolve();
        return finished.promise;
      },
      { log: { request: (entry) => logged.resolve(entry) } },
    );
    const controller = new AbortController();
    const pending = fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).catch(() => null);
    await entered.promise;
    controller.abort();
    await pending;
    await disconnected.promise;
    finished.resolve(outcome);
    expect((await logged.promise).status).toBe(499);
    expect(await usage(base)).toMatchObject({ requests: 1, totalTokens: 30, estimatedRequests: 0 });
    expect((await postJson(base, path, body)).status).toBe(200);
    expect(await usage(base)).toMatchObject({ requests: 2, totalTokens: 60 });
  });

  it('charges a cancelled timeout once and releases all occupied slots', async () => {
    const entered = Promise.withResolvers();
    const disconnected = Promise.withResolvers();
    const timeout = Promise.withResolvers();
    const logged = Promise.withResolvers();
    let calls = 0;
    let aborted = 0;
    const records = [];
    const { base } = await service(
      ({ signal }) => {
        calls += 1;
        if (calls > 4) return outcome;
        signal.addEventListener(
          'abort',
          () => {
            aborted += 1;
            if (aborted === 4) disconnected.resolve();
          },
          { once: true },
        );
        if (calls === 4) entered.resolve();
        return timeout.promise;
      },
      {
        config: { budget: { requests: 10, tokensPerRequest: 1024, tokensPerSession: 100_000 } },
        log: {
          request: (entry) => {
            records.push(entry);
            if (records.length === 4) logged.resolve();
          },
        },
      },
    );
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const pending = controllers.map((controller) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).catch(() => null),
    );
    await entered.promise;
    for (const controller of controllers) controller.abort();
    await Promise.all(pending);
    await disconnected.promise;
    timeout.reject(new ProviderError('timeout', 'Safe timeout.', { requestSent: true }));
    await logged.promise;
    expect(records.map(({ status }) => status)).toEqual([499, 499, 499, 499]);
    expect(await usage(base)).toMatchObject({
      requests: 4,
      completionTokens: 4096,
      estimatedRequests: 4,
    });
    expect((await postJson(base, path, body)).status).toBe(200);
    expect(await usage(base)).toMatchObject({
      requests: 5,
      completionTokens: 4116,
      estimatedRequests: 4,
    });
  });

  it.each([
    ['timeout', 504, true],
    ['auth', 502, false],
    ['rate-limit', 429, true],
    ['network', 502, false],
  ])(
    'releases concurrency and preserves accounting on %s (%s)',
    async (code, status, requestSent) => {
      let fail = true;
      const { base } = await service(
        async () => {
          if (fail) throw new ProviderError(code, 'Safe provider message.', { requestSent });
          return outcome;
        },
        { config: { budget: { requests: 10, tokensPerRequest: 1024, tokensPerSession: 100_000 } } },
      );
      const responses = await Promise.all(
        Array.from({ length: 4 }, () => postJson(base, path, body)),
      );
      expect(responses.map((response) => response.status)).toEqual(Array(4).fill(status));
      const accounted = await usage(base);
      expect(accounted.requests).toBe(4);
      expect(accounted.completionTokens).toBe(requestSent ? 4096 : 0);
      expect(accounted.estimatedRequests).toBe(requestSent ? 4 : 0);
      fail = false;
      expect((await postJson(base, path, body)).status).toBe(200);
      expect((await usage(base)).completionTokens).toBe(accounted.completionTokens + 20);
    },
  );

  it('refuses invalid bodies without budget charges and releases every concurrency slot', async () => {
    let calls = 0;
    const { base } = await service(async () => {
      calls += 1;
      return outcome;
    });
    const rejected = await Promise.all(Array.from({ length: 4 }, () => postJson(base, path, '{')));
    expect(rejected.map((response) => response.status)).toEqual([400, 400, 400, 400]);
    expect(calls).toBe(0);
    expect(await usage(base)).toMatchObject({ requests: 0, totalTokens: 0 });
    expect((await postJson(base, path, body)).status).toBe(200);
  });

  it('does not expose unclassified provider errors, paper text or credentials', async () => {
    const privateText = 'sk-fixture-secret-THIS-IS-NOT-A-REAL-KEY paper-body-private';
    const { base } = await service(async () => {
      throw new Error(privateText);
    });
    const response = await postJson(base, path, body);
    expect(response.status).toBe(502);
    const result = await response.text();
    expect(result).not.toContain(privateText);
    expect(JSON.parse(result).error).toBe('upstream');
    expect((await usage(base)).estimatedRequests).toBe(1);
  });
});
