import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { assertFreshBuild } from './preview-gate.mjs';
import { probeProxy } from './offline.mjs';

/**
 * Gate 0: proves the offline acceptance path cannot reach a paid service.
 *
 * The Phase 5 incident was one missing environment variable: the preview server fell back to
 * its default port, a paid service was still listening there, and two questions were answered
 * and billed by it. This script reproduces that exact shape against a decoy that *looks* like a
 * paid service, and then proves two things:
 *
 *   - the guard refuses before a browser is opened, and nothing is sent to the decoy;
 *   - on a correctly started run, business requests go to the offline mock and the decoy keeps
 *     receiving nothing.
 *
 * It also pins the instance id: a mock left over from another run answers just as happily, and
 * would produce results that look like they came from this one.
 */

const ROOT = new URL('../../', import.meta.url);
const VITE_BIN = fileURLToPath(new URL('node_modules/vite/bin/vite.js', ROOT));
const SERVER_ENTRY = fileURLToPath(new URL('server/start.mjs', ROOT));
const REPORT_FILE = new URL('docs/phase6-gate0-report.json', ROOT);

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  process.stdout.write(
    `${passed ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}\n`,
  );
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise((resolve) => {
    server.close(resolve);
  });
  return port;
}

/**
 * A decoy that answers like a paid provider, and remembers everything anyone asks it.
 *
 * It never calls a model: it only has to be indistinguishable from one at the health endpoint,
 * which is all a misrouted preview would look at.
 */
async function startDecoy() {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url ?? '' });
    if (request.url === '/api/ai/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: true,
          instanceId: 'decoy-paid-service',
          provider: 'deepseek',
          label: 'DeepSeek decoy',
          model: 'deepseek-flash',
          online: true,
          reasoning: '思考模式 low',
          limits: {},
        }),
      );
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, decoy: true }));
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    requests,
    business: () => requests.filter((entry) => entry.path.startsWith('/api/ai/ask')),
    stop: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}

async function startPreview(port, aiPort) {
  const child = spawn(
    process.execPath,
    [VITE_BIN, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: fileURLToPath(ROOT),
      // `aiPort === null` reproduces the Phase 5 bug exactly: no AI_PORT at all.
      env: aiPort === null ? { ...process.env } : { ...process.env, AI_PORT: String(aiPort) },
      stdio: 'ignore',
    },
  );
  const origin = `http://127.0.0.1:${String(port)}/`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(origin)).ok) return { child, origin };
    } catch {
      // Not up yet.
    }
    await sleep(250);
  }
  child.kill();
  throw new Error('preview server did not start');
}

async function startMock(port, env = {}) {
  const child = spawn(process.execPath, [SERVER_ENTRY, '--offline'], {
    cwd: fileURLToPath(ROOT),
    env: { ...process.env, ...env, AI_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The service logs one structured line per request; counting them is how "no implicit retry"
  // is proven rather than assumed.
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  const askCount = () => (output.match(/"path":"\/api\/ai\/ask"/g) ?? []).length;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/ai/health`);
      if (response.ok) return { child, health: await response.json(), askCount };
    } catch {
      // Not up yet.
    }
    await sleep(200);
  }
  child.kill();
  throw new Error('offline service did not start');
}

/** Runs `requireOfflineProxy` in a child process and reports how it ended. */
async function runGuardInChild(origin, expectedInstance) {
  const script = new URL('.cache/guard-child.mjs', ROOT);
  await mkdir(new URL('.cache/', ROOT), { recursive: true });
  await writeFile(
    script,
    [
      `import { requireOfflineProxy } from ${JSON.stringify(new URL('./offline.mjs', import.meta.url).href)};`,
      'const health = await requireOfflineProxy(process.argv[2], {',
      '  expectedInstance: process.argv[3],',
      "  label: '子进程验收',",
      '});',
      'process.stdout.write(JSON.stringify(health));',
      '',
    ].join('\n'),
  );
  const child = spawn(process.execPath, [fileURLToPath(script), origin, expectedInstance], {
    cwd: fileURLToPath(ROOT),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stderr.on('data', (chunk) => {
    err += String(chunk);
  });
  child.stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  const code = await new Promise((resolve) => {
    child.on('exit', resolve);
  });
  return { code, out, err };
}

const VALID_ASK = {
  mode: 'ask',
  question: '这是一次端口走向检查。',
  paper: { id: 'gate-0', title: 'Gate 0', page: 1, pdfSha256: 'a'.repeat(64) },
  passages: [
    { id: 'selection', page: 1, text: 'The model learns a representation.', selection: true },
  ],
};

async function main() {
  const decoy = await startDecoy();
  const mockPort = await freePort();
  const previewPort = await freePort();
  const mock = await startMock(mockPort);
  check(
    'mock: the offline service starts as a mock with its own instance id',
    mock.health.provider === 'mock' &&
      mock.health.online === false &&
      typeof mock.health.instanceId === 'string' &&
      mock.health.instanceId !== 'decoy-paid-service',
    `instance ${String(mock.health.instanceId).slice(0, 8)}`,
  );

  let preview = null;
  try {
    // ---- Case A: the proxy points at the decoy, exactly like the incident ------------
    assertFreshBuild(import.meta.url);
    preview = await startPreview(previewPort, decoy.port);
    const refused = await probeProxy(preview.origin);
    check(
      'guard: a preview pointing at a paid service is refused, with the reason named',
      refused.ok === false && refused.reason === 'online-provider',
      `reason ${String(refused.reason)}`,
    );
    const child = await runGuardInChild(preview.origin, mock.health.instanceId);
    check(
      'guard: the refusal ends the process with the documented exit code',
      child.code === 4,
      `exit ${String(child.code)}${child.code === 4 ? '' : ` · ${child.err.slice(0, 80)}`}`,
    );
    check(
      'guard: nothing but the health probe ever reached the paid service',
      decoy.business().length === 0,
      `${String(decoy.requests.length)} requests, ${String(decoy.business().length)} business`,
    );
    preview.child.kill();
    preview = null;

    // ---- Case B: no AI_PORT at all (the actual Phase 5 bug) --------------------------
    const secondPort = await freePort();
    const fallback = await startPreview(secondPort, null);
    const viaDefault = await probeProxy(fallback.origin);
    check(
      'guard: a preview started without AI_PORT is refused before any browser opens',
      viaDefault.ok === false,
      `reason ${String(viaDefault.reason)}`,
    );
    fallback.child.kill();

    // ---- Case C: a correctly started run --------------------------------------------
    const thirdPort = await freePort();
    const good = await startPreview(thirdPort, mockPort);
    const health = await probeProxy(good.origin);
    check(
      'guard: a correctly wired preview reports the offline mock this run started',
      health.ok === true && health.health.instanceId === mock.health.instanceId,
      `instance ${String(health.health?.instanceId ?? '').slice(0, 8)}`,
    );

    const before = decoy.requests.length;
    const asksBefore = mock.askCount();
    const response = await fetch(`${good.origin}api/ai/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_ASK),
    });
    const body = await response.json();
    check(
      'traffic: a business request through the preview is answered by the offline mock',
      response.status === 200 && body.provider === 'mock' && body.online === false,
      `${String(response.status)} · ${String(body.provider)}`,
    );
    check(
      'traffic: the paid service received nothing while that request was made',
      decoy.requests.length === before,
      `${String(decoy.requests.length - before)} new requests at the decoy`,
    );
    await sleep(200);
    check(
      'traffic: exactly one upstream call, so no implicit retry happened',
      mock.askCount() - asksBefore === 1,
      `${String(mock.askCount() - asksBefore)} call(s) at the mock`,
    );

    const wrongInstance = await runGuardInChild(good.origin, 'some-other-run');
    check(
      'guard: a mock from a different run is refused even though it is a mock',
      wrongInstance.code === 4,
      `exit ${String(wrongInstance.code)}`,
    );

    good.child.kill();
  } finally {
    preview?.child.kill();
    mock.child.kill();
    await decoy.stop();
  }

  const passed = results.filter((entry) => entry.passed).length;
  const failed = results.length - passed;
  await writeFile(
    REPORT_FILE,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        decoyPort: decoy.port,
        mockPort,
        passed,
        failed,
        results,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`\n${String(passed)} passed, ${String(failed)} failed.\n`);
  if (failed > 0) process.exitCode = 1;
}

await main();
