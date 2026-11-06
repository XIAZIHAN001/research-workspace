import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatCompletionsProvider } from './providers/openaiCompatible.mjs';
import { postJson, startTestService, validAsk } from './testing.mjs';
import { describePrice, estimateCostCny } from './pricing.mjs';

const running = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
});

it('rejects malformed request targets without terminating the unauthenticated sidecar', async () => {
  const fixture = pathToFileURL(resolve('server/testing.mjs')).href;
  const token = 'synthetic-session-token-for-regression';
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {startTestService} from ${JSON.stringify(fixture)}; const service = await startTestService({config:{sessionToken:${JSON.stringify(token)}}}); console.log(service.base);`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const base = await new Promise((resolveBase, reject) => {
      const timer = setTimeout(() => reject(new Error('isolated service startup timed out')), 5000);
      const exit = () => {
        clearTimeout(timer);
        reject(new Error(`isolated service exited: ${stderr}`));
      };
      child.once('exit', exit);
      child.stdout.once('data', (chunk) => {
        clearTimeout(timer);
        child.removeListener('exit', exit);
        resolveBase(chunk.toString().trim());
      });
      child.once('error', reject);
    });
    const address = new URL(base);
    const reply = await new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: Number(address.port) });
      let text = '';
      socket.setTimeout(3000, () => socket.destroy(new Error('raw request timed out')));
      socket.on('error', reject);
      socket.on('data', (bytes) => {
        text += bytes.toString();
      });
      socket.on('end', () => resolve(text));
      socket.on('connect', () =>
        socket.end(
          `GET //[ HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nConnection: close\r\n\r\n`,
        ),
      );
    });
    expect(reply).toMatch(/^HTTP\/1\.1 400 /);
    expect((await fetch(`${base}/api/ai/health`)).status).toBe(401);
    expect(
      (await fetch(`${base}/api/ai/health`, { headers: { Authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(200);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill();
      await exit;
    }
  }
});

describe('untrusted token usage', () => {
  it.each([-10000, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'charges a bounded estimate for invalid usage %s and retains the spending cap',
    async (invalid) => {
      const service = await startTestService({
        provider: {
          name: 'deepseek',
          model: 'deepseek-flash',
          online: true,
          label: 'Synthetic fixture',
          complete: async () => ({
            text: 'ok',
            usage: {
              promptTokens: invalid,
              completionTokens: invalid,
              reasoningTokens: invalid,
              cachedPromptTokens: invalid,
            },
          }),
        },
        config: { budget: { requests: 10, tokensPerRequest: 1024, tokensPerSession: 6000 } },
      });
      running.push(service);
      expect((await postJson(service.base, '/api/ai/ask', validAsk())).status).toBe(200);
      const { usage } = await (await fetch(`${service.base}/api/ai/health`)).json();
      expect(usage.exactTokens).toBe(false);
      expect(usage.estimatedRequests).toBe(1);
      expect(usage.promptTokens).toBeGreaterThan(0);
      expect(usage.completionTokens).toBe(1024);
      expect(usage.reasoningTokens).toBe(0);
      expect(Number.isFinite(usage.totalTokens)).toBe(true);
      let blocked = false;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if ((await postJson(service.base, '/api/ai/ask', validAsk())).status === 429) {
          blocked = true;
          break;
        }
      }
      expect(blocked).toBe(true);
    },
  );

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'normalizes invalid upstream JSON counts %s to unknown',
    async (invalid) => {
      const provider = createChatCompletionsProvider({
        id: 'fixture',
        label: 'Synthetic fixture',
        apiKey: 'fake-fixture-key',
        baseUrl: 'https://example.invalid',
        model: 'fixture',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: 'ok' } }],
              usage: {
                prompt_tokens: invalid,
                completion_tokens: invalid,
                prompt_cache_hit_tokens: invalid,
                completion_tokens_details: { reasoning_tokens: invalid },
              },
            }),
          ),
      });
      const outcome = await provider.complete({ system: 'fixture', messages: [], maxTokens: 32 });
      expect(outcome.usage).toEqual({
        promptTokens: null,
        completionTokens: null,
        reasoningTokens: null,
        cachedPromptTokens: null,
      });
    },
  );
});

it.each(['constructor', 'toString', '__proto__'])(
  'keeps inherited model name %s unpriced rather than emitting a NaN estimate',
  (model) => {
    expect(describePrice(model).known).toBe(false);
    expect(estimateCostCny(model, { promptTokens: 10, completionTokens: 20 })).toBeNull();
  },
);
