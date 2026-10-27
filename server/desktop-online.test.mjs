/**
 * The desktop online path, exercised as a real child process against a local simulator.
 *
 * Nothing here reaches api.deepseek.com. The simulator speaks the same chat-completions shape,
 * including usage and the failure statuses the provider maps, and the sidecar is started with
 * the loopback-upstream flag the test harness is allowed to use. The production desktop never
 * sets that flag; the release acceptance checks that separately by never issuing a request.
 *
 * What these tests pin:
 *
 * - the key arrives over stdin, not through the environment, and never appears in stderr;
 * - the ready line names the online provider and the model, and the health endpoint agrees;
 * - normal answers, invalid citations and knowledge suggestions all pass through the existing
 *   verification rather than being trusted;
 * - 401, 402, 429, 5xx, timeouts and cancellation become the service's own error vocabulary;
 * - the session budget stops a second call before the simulator sees it.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { validAsk } from './testing.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const launcher = join(here, 'desktop.mjs');
const TOKEN = 'b'.repeat(64);
const INSTANCE = 'desktop-online-test';
const ORIGIN = 'http://tauri.localhost';
const KEY = 'sk-phase11-online-test-key-0123456789';
const SENTINEL = '<<<CITATIONS>>>';

const children = [];
const upstreams = [];

afterEach(async () => {
  while (children.length > 0) {
    const child = children.pop();
    if (child.exitCode === null) {
      child.stdin.end();
      const exited = await Promise.race([
        once(child, 'exit').then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 1500)),
      ]);
      if (!exited) child.kill();
    }
  }
  while (upstreams.length > 0) {
    const server = upstreams.pop();
    await new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    });
  }
});

/** A stand-in for api.deepseek.com that records exactly what the sidecar sent. */
async function startUpstream(handler) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // A non-JSON body is still recorded; the handler sees `undefined`.
      }
      requests.push({ url: request.url, headers: request.headers, body });
      void Promise.resolve(handler(body, request, response, requests.length - 1)).catch((error) => {
        if (!response.headersSent) {
          response.writeHead(500, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: String(error) }));
        }
      });
    });
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  upstreams.push(server);
  const address = server.address();
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
  };
}

function chatResponse(
  content,
  usage = { prompt_tokens: 120, completion_tokens: 30 },
  overrides = {},
) {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'deepseek-flash',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage,
    ...overrides,
  });
}

function startOnlineService(upstreamUrl, extraEnv = {}) {
  const child = spawn(process.execPath, [launcher], {
    env: {
      ...process.env,
      AI_SESSION_TOKEN: TOKEN,
      AI_DESKTOP_INSTANCE: INSTANCE,
      AI_PARENT_PID: String(process.pid),
      AI_PORT: '0',
      AI_DESKTOP_MODE: 'online',
      AI_PROVIDER: 'deepseek',
      AI_ALLOWED_ORIGINS: ORIGIN,
      DEEPSEEK_BASE_URL: upstreamUrl,
      AI_ALLOW_LOOPBACK_UPSTREAM: '1',
      DEEPSEEK_THINKING: 'disabled',
      AI_TIMEOUT_MS: '1000',
      AI_BUDGET_REQUESTS: '20',
      AI_BUDGET_TOKENS_PER_REQUEST: '2048',
      AI_BUDGET_TOKENS_SESSION: '100000',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  const state = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => {
    state.stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    state.stderr += chunk.toString();
  });
  child.stdin.write(`RW_AI_SECRET ${JSON.stringify({ apiKey: KEY })}\n`);
  return { child, state };
}

function waitForReady(child, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => {
      reject(new Error(`desktop service did not become ready: ${buffer} ${stderr}`));
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      if (!line.startsWith('RW_AI_READY ')) return;
      clearTimeout(timer);
      resolve(JSON.parse(line.slice('RW_AI_READY '.length)));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`desktop service exited with ${String(code)}: ${stderr}`));
    });
  });
}

function authHeaders() {
  return { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}` };
}

async function postAsk(base, body = validAsk()) {
  const response = await fetch(`${base}/api/ai/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

describe('desktop online mode', () => {
  it(
    'hands the key to the child over stdin and returns a verified online answer',
    { timeout: 15_000 },
    async () => {
      const upstream = await startUpstream((_body, _request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          chatResponse(
            `这句话说明模型学到的表示不依赖输入顺序。[1]\n\n${SENTINEL}\n{"groundedInText":true,"citations":[{"n":1,"passageId":"selection","quote":"The model learns a representation"}]}`,
          ),
        );
      });

      const { child, state } = startOnlineService(upstream.url);
      const ready = await waitForReady(child);
      expect(ready.provider).toBe('deepseek');
      expect(ready.online).toBe(true);
      expect(ready.model).toBe('deepseek-flash');
      expect(ready.port).not.toBe(8787);

      const base = `http://127.0.0.1:${String(ready.port)}`;
      const health = await (
        await fetch(`${base}/api/ai/health`, { headers: authHeaders() })
      ).json();
      expect(health.online).toBe(true);
      expect(health.provider).toBe('deepseek');
      expect(health.desktopInstance).toBe(INSTANCE);
      expect(health.budget.requests).toBe(20);
      expect(health.pricing.known).toBe(true);

      const { response, body } = await postAsk(base);
      expect(response.status).toBe(200);
      expect(body.status).toBe('valid');
      expect(body.online).toBe(true);
      expect(body.provider).toBe('deepseek');
      expect(body.citations).toHaveLength(1);
      expect(body.citations[0]).toMatchObject({ page: 3, passageId: 'selection' });
      expect(body.usage).toMatchObject({ promptTokens: 120, completionTokens: 30 });

      expect(upstream.requests).toHaveLength(1);
      const sent = upstream.requests[0];
      expect(sent.url).toBe('/chat/completions');
      expect(sent.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(sent.body.model).toBe('deepseek-flash');
      expect(sent.body.thinking).toEqual({ type: 'disabled' });
      expect(sent.body.messages[0].role).toBe('system');

      const after = await (await fetch(`${base}/api/ai/health`, { headers: authHeaders() })).json();
      expect(after.usage.requests).toBe(1);
      expect(after.usage.promptTokens).toBe(120);
      expect(after.usage.completionTokens).toBe(30);
      expect(after.usage.estimatedCostCny).toBeGreaterThan(0);

      // Neither the startup log nor an error path ever contains the key.
      expect(state.stderr).not.toContain(KEY);
      expect(state.stdout).not.toContain(KEY);
    },
  );

  it(
    'drops a citation whose quotation is not in the passage, and says so',
    { timeout: 15_000 },
    async () => {
      const upstream = await startUpstream((_body, _request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          chatResponse(
            `一个看起来合理但引用错误的回答。[1]\n\n${SENTINEL}\n{"groundedInText":true,"citations":[{"n":1,"passageId":"selection","quote":"这句话根本不在原文里"}]}`,
          ),
        );
      });
      const { child } = startOnlineService(upstream.url);
      const ready = await waitForReady(child);
      const base = `http://127.0.0.1:${String(ready.port)}`;
      const { response, body } = await postAsk(base);
      expect(response.status).toBe(200);
      expect(body.citations).toEqual([]);
      expect(body.warnings.join(' ')).toContain('未通过校验');
    },
  );

  it(
    'maps upstream 401, 402, 429 and 5xx to the service vocabulary',
    { timeout: 20_000 },
    async () => {
      const statuses = [401, 402, 429, 503];
      const upstream = await startUpstream((_body, _request, response, index) => {
        const status = statuses[index] ?? 500;
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'simulated upstream failure' } }));
      });
      const { child } = startOnlineService(upstream.url);
      const ready = await waitForReady(child);
      const base = `http://127.0.0.1:${String(ready.port)}`;

      const first = await postAsk(base);
      expect(first.response.status).toBe(502);
      expect(first.body.error).toBe('auth');

      const second = await postAsk(base);
      expect(second.response.status).toBe(502);
      expect(second.body.error).toBe('insufficient-balance');

      const third = await postAsk(base);
      expect(third.response.status).toBe(429);
      expect(third.body.error).toBe('rate-limit');

      const fourth = await postAsk(base);
      expect(fourth.response.status).toBe(502);
      expect(fourth.body.error).toBe('upstream');

      expect(upstream.requests).toHaveLength(4);
      // Every failure was counted; a retry loop would run out of its own budget.
      const health = await (
        await fetch(`${base}/api/ai/health`, { headers: authHeaders() })
      ).json();
      expect(health.usage.requests).toBe(4);
      // Each failure reached the upstream, so it is charged the reserved upper bound and marked
      // as an estimate rather than recorded as zero.
      expect(health.usage.promptTokens).toBeGreaterThan(0);
      expect(health.usage.exactTokens).toBe(false);
      expect(health.usage.estimatedRequests).toBe(4);
    },
  );

  it('turns a stalled upstream into a 504 and stays usable', { timeout: 15_000 }, async () => {
    const upstream = await startUpstream(() => {
      // Never respond. The sidecar's own timeout must fire.
    });
    const { child } = startOnlineService(upstream.url, { AI_TIMEOUT_MS: '1000' });
    const ready = await waitForReady(child);
    const base = `http://127.0.0.1:${String(ready.port)}`;
    const { response, body } = await postAsk(base);
    expect(response.status).toBe(504);
    expect(body.error).toBe('timeout');

    const health = await fetch(`${base}/api/ai/health`, { headers: authHeaders() });
    expect(health.status).toBe(200);
  });

  it('lets the reader cancel a call without killing the service', { timeout: 15_000 }, async () => {
    const upstream = await startUpstream(() => {
      // Deliberately slow; the client will go away first.
    });
    const { child } = startOnlineService(upstream.url, { AI_TIMEOUT_MS: '5000' });
    const ready = await waitForReady(child);
    const base = `http://127.0.0.1:${String(ready.port)}`;

    const controller = new AbortController();
    const pending = fetch(`${base}/api/ai/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(validAsk()),
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    controller.abort();
    await expect(pending).rejects.toThrow();

    const health = await fetch(`${base}/api/ai/health`, { headers: authHeaders() });
    expect(health.status).toBe(200);
    expect(upstream.requests).toHaveLength(1);
  });

  it(
    'stops before the second call when the session request limit is one',
    { timeout: 15_000 },
    async () => {
      const upstream = await startUpstream((_body, _request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(chatResponse(`回答。\n\n${SENTINEL}\n{"groundedInText":true,"citations":[]}`));
      });
      const { child } = startOnlineService(upstream.url, { AI_BUDGET_REQUESTS: '1' });
      const ready = await waitForReady(child);
      const base = `http://127.0.0.1:${String(ready.port)}`;

      const first = await postAsk(base);
      expect(first.response.status).toBe(200);
      const second = await postAsk(base);
      expect(second.response.status).toBe(429);
      expect(second.body.error).toBe('budget-exceeded');
      expect(upstream.requests).toHaveLength(1);
    },
  );

  it(
    'runs the knowledge protocol through the real provider and verifier',
    { timeout: 15_000 },
    async () => {
      const first =
        'A KZG commitment relies on a bilinear pairing over an elliptic curve group. The commitment is a single group element.';
      const second =
        'We define the pairing e: G1 x G2 -> GT as a bilinear map that is non-degenerate and efficiently computable.';
      const suggestion = {
        groundedInText: true,
        concepts: [
          {
            name: 'KZG commitment',
            aliases: ['KZG'],
            summary: 'A commitment scheme built on pairings.',
            support: 'direct',
            evidence: [
              {
                passageId: 'selection',
                quote:
                  'A KZG commitment relies on a bilinear pairing over an elliptic curve group.',
              },
            ],
          },
          {
            name: 'Bilinear pairing',
            aliases: [],
            summary: 'A map linear in each argument.',
            support: 'direct',
            evidence: [
              {
                passageId: 'definition',
                quote: 'the pairing e: G1 x G2 -> GT as a bilinear map',
              },
            ],
          },
        ],
        relations: [
          {
            from: 'KZG commitment',
            to: 'Bilinear pairing',
            kind: 'definition',
            direction: 'from-first',
            support: 'direct',
            explanation: '承诺方案的定义依赖双线性配对。',
            evidence: [
              {
                passageId: 'selection',
                quote: 'A KZG commitment relies on a bilinear pairing',
              },
            ],
          },
        ],
      };
      const upstream = await startUpstream((_body, _request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(chatResponse(JSON.stringify(suggestion)));
      });
      const { child } = startOnlineService(upstream.url);
      const ready = await waitForReady(child);
      const base = `http://127.0.0.1:${String(ready.port)}`;

      const response = await fetch(`${base}/api/ai/knowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          paper: {
            id: 'paper-1',
            title: 'KZG commitments for everyone',
            page: 3,
            pdfSha256: 'a'.repeat(64),
          },
          scope: 'selection',
          focus: '',
          passages: [
            {
              id: 'selection',
              page: 3,
              text: first,
              selection: true,
              role: 'selection',
              label: '',
            },
            {
              id: 'definition',
              page: 5,
              text: second,
              selection: false,
              role: 'definition',
              label: '含定义句式',
            },
          ],
          existingConcepts: [],
          existingRelations: [],
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.online).toBe(true);
      expect(body.status).toBe('valid');
      expect(body.concepts).toHaveLength(2);
      expect(body.relations).toHaveLength(1);
      expect(body.relations[0]).toMatchObject({
        from: 'KZG commitment',
        to: 'Bilinear pairing',
        kind: 'definition',
        direction: 'from-first',
      });
      expect(body.relations[0]).not.toHaveProperty('status');
      expect(body.usage).toMatchObject({ promptTokens: 120, completionTokens: 30 });
    },
  );

  it('refuses a short secret and writes nothing about its value', { timeout: 10_000 }, async () => {
    const upstream = await startUpstream((_body, _request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(chatResponse('unused'));
    });
    const { child, state } = (() => {
      const spawned = spawn(process.execPath, [launcher], {
        env: {
          ...process.env,
          AI_SESSION_TOKEN: TOKEN,
          AI_DESKTOP_INSTANCE: INSTANCE,
          AI_PARENT_PID: String(process.pid),
          AI_PORT: '0',
          AI_DESKTOP_MODE: 'online',
          AI_PROVIDER: 'deepseek',
          AI_ALLOWED_ORIGINS: ORIGIN,
          DEEPSEEK_BASE_URL: upstream.url,
          AI_ALLOW_LOOPBACK_UPSTREAM: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      children.push(spawned);
      const captured = { stdout: '', stderr: '' };
      spawned.stdout.on('data', (chunk) => {
        captured.stdout += chunk.toString();
      });
      spawned.stderr.on('data', (chunk) => {
        captured.stderr += chunk.toString();
      });
      spawned.stdin.write('RW_AI_SECRET {"apiKey":"short"}\n');
      return { child: spawned, state: captured };
    })();

    const [code] = await once(child, 'exit');
    expect(code).toBe(3);
    expect(state.stderr).toContain('凭据');
    expect(state.stderr).not.toContain('short');
    expect(state.stdout).not.toContain('RW_AI_READY');
    expect(upstream.requests).toHaveLength(0);
  });
});
