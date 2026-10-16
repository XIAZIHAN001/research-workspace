import { afterEach, describe, expect, it } from 'vitest';
import { postJson, rawRequest, startTestService, validAsk } from './testing.mjs';

/** Every test gets its own service, so rate limits and concurrency never leak between them. */
const running = [];
async function service(deps) {
  const started = await startTestService(deps);
  running.push(started);
  return started;
}

afterEach(async () => {
  while (running.length > 0) await running.pop().stop();
});

describe('GET /api/ai/health', () => {
  it('says which provider is answering and whether it costs money', async () => {
    const { base } = await service();
    const response = await fetch(`${base}/api/ai/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.provider).toBe('mock');
    expect(body.online).toBe(false);
    expect(body.label).toContain('模拟');
  });
});

describe('POST /api/ai/ask', () => {
  it('answers with verified citations that carry the page from our own record', async () => {
    const { base } = await service();
    const response = await postJson(base, '/api/ai/ask', validAsk({ mode: 'explain' }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.answer).not.toBe('');
    expect(body.citations.length).toBeGreaterThan(0);
    expect(body.citations[0].page).toBe(3);
    expect(body.citations[0].passageId).toBe('selection');
    expect(body.online).toBe(false);
    expect(body.warnings).toEqual([]);
  });

  it('refuses a body that is not JSON', async () => {
    const { base } = await service();
    const response = await postJson(base, '/api/ai/ask', 'not json at all');
    expect(response.status).toBe(400);
  });

  it('drops the citations the model got wrong and says so', async () => {
    const { base } = await service();
    const response = await postJson(
      base,
      '/api/ai/ask',
      validAsk({ mode: 'ask', question: '这是什么？[[mock:bad-citation]]' }),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.citations).toHaveLength(1);
    expect(body.citations[0].n).toBe(3);
    expect(body.warnings.join(' ')).toContain('未通过校验');
  });

  it('degrades to plain text when the model ignores the JSON contract', async () => {
    const { base } = await service();
    const response = await postJson(
      base,
      '/api/ai/ask',
      validAsk({ mode: 'ask', question: '说明一下[[mock:plain-text]]' }),
    );
    const body = await response.json();
    expect(body.citations).toEqual([]);
    expect(body.groundedInText).toBeNull();
    expect(body.warnings.join(' ')).toContain('JSON');
  });

  it('passes an ungrounded answer through with the flag set', async () => {
    const { base } = await service();
    const response = await postJson(
      base,
      '/api/ai/ask',
      validAsk({ mode: 'ask', question: '能推断出结论吗[[mock:ungrounded]]' }),
    );
    const body = await response.json();
    expect(body.groundedInText).toBe(false);
  });

  it('reports a provider failure as a status the interface can act on', async () => {
    const { base } = await service();
    const response = await postJson(
      base,
      '/api/ai/ask',
      validAsk({ mode: 'ask', question: '出个错看看[[mock:error]]' }),
    );
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe('upstream');
    expect(body.message).not.toContain('sk-');
  });

  it('refuses a request that would carry more than the context budget', async () => {
    const { base } = await service();
    const response = await postJson(
      base,
      '/api/ai/ask',
      validAsk({
        passages: [{ id: 'selection', page: 1, text: 'x'.repeat(5000), selection: true }],
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('bad-request');
  });

  it('refuses a body that exceeds the size cap', async () => {
    const { base } = await service();
    const response = await postJson(base, '/api/ai/ask', 'x'.repeat(300 * 1024));
    expect(response.status).toBe(413);
  });
});

describe('the service as a whole', () => {
  it('has no path that forwards anywhere else', async () => {
    const { base } = await service();
    for (const path of ['/', '/api/ai/ask/../../elsewhere', '/v1/chat/completions']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(404);
    }
  });

  it('refuses a foreign Host, which is what DNS rebinding would need', async () => {
    const { base } = await service();
    const response = await rawRequest(base, '/api/ai/health', {
      headers: { Host: 'evil.example' },
    });
    expect(response.status).toBe(403);
    // …and accepts its own, so the guard is not simply refusing everything.
    const local = await rawRequest(base, '/api/ai/health', { headers: { Host: '127.0.0.1' } });
    expect(local.status).toBe(200);
  });

  it('refuses a foreign Origin', async () => {
    const { base } = await service();
    const response = await postJson(base, '/api/ai/ask', validAsk(), {
      Origin: 'https://evil.example',
    });
    expect(response.status).toBe(403);
  });

  it('answers a preflight only for an allowed origin', async () => {
    const { base } = await service();
    const allowed = await fetch(`${base}/api/ai/ask`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://127.0.0.1:1420' },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:1420');

    const denied = await fetch(`${base}/api/ai/ask`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    });
    expect(denied.status).toBe(403);
  });

  it('refuses the wrong method', async () => {
    const { base } = await service();
    expect((await fetch(`${base}/api/ai/ask`)).status).toBe(405);
    expect((await postJson(base, '/api/ai/health', {})).status).toBe(405);
  });

  it('stops after the per-minute request budget', async () => {
    const { base } = await service();
    const statuses = [];
    for (let index = 0; index < 32; index += 1) {
      const response = await postJson(base, '/api/ai/ask', validAsk());
      statuses.push(response.status);
    }
    expect(statuses.filter((status) => status === 200).length).toBe(30);
    expect(statuses.at(-1)).toBe(429);
  });

  it('refuses to run more than the concurrent limit at once', async () => {
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const provider = {
      name: 'mock',
      model: 'blocking',
      label: '阻塞用',
      complete: async () => {
        entered += 1;
        await blocked;
        return { text: '{"answer":"ok","citations":[]}', usage: null, truncated: false };
      },
    };
    const { base } = await service({ provider });

    // Hold the limit open, then knock once more: the extra call must bounce, not queue.
    const held = Array.from({ length: 4 }, () => postJson(base, '/api/ai/ask', validAsk()));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const extra = await postJson(base, '/api/ai/ask', validAsk());
    expect(extra.status).toBe(429);
    expect((await extra.json()).error).toBe('busy');

    release();
    for (const response of await Promise.all(held)) expect(response.status).toBe(200);
    expect(entered).toBe(4);
  });

  it('survives the caller cancelling while the model is still working', async () => {
    let entered;
    const enteredPromise = new Promise((resolve) => {
      entered = resolve;
    });
    let upstreamAborted = false;
    const provider = {
      name: 'mock',
      model: 'blocking',
      label: '阻塞用',
      complete: ({ signal }) =>
        new Promise((_resolve, reject) => {
          entered();
          signal.addEventListener('abort', () => {
            upstreamAborted = true;
            reject(new Error('aborted'));
          });
        }),
    };
    const { base } = await service({ provider });
    const controller = new AbortController();
    const promise = fetch(`${base}/api/ai/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validAsk()),
      signal: controller.signal,
    }).catch(() => null);

    await enteredPromise;
    controller.abort();
    await promise;
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Cancelling from the page cancels the upstream call rather than leaving it running.
    expect(upstreamAborted).toBe(true);
    const health = await fetch(`${base}/api/ai/health`);
    expect(health.status).toBe(200);
  });
});
