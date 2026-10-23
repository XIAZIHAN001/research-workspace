/**
 * The desktop entry point of the local AI service.
 *
 * The Tauri shell starts this file instead of `start.mjs`. The differences are deliberate:
 *
 * - it binds an ephemeral loopback port and prints the chosen port as one machine-readable
 *   line, so two desktop instances (or a stale developer service on 8787) can never be
 *   mistaken for each other;
 * - it requires a per-launch bearer token from the shell and refuses every real request
 *   without it;
 * - it runs in exactly one of two modes. `mock` can never reach a network. `online` talks to the
 *   provider named by `AI_PROVIDER`, at the endpoint named by `AI_BASE_URL`, and does not start
 *   serving until the shell has handed it a key;
 * - the key never arrives through the command line or the environment. The shell writes one
 *   `RW_AI_SECRET {json}` line to this process's stdin after spawning it. The line is read,
 *   the key is kept in memory for the provider, and nothing about it is printed. This also
 *   means the environment inherited by the process can never contain the key;
 * - it exits when the shell goes away, either because its stdin pipe closes or because the
 *   parent process disappears. A window that closes is not evidence that the service died,
 *   so the service watches for the actual condition.
 *
 * It prints exactly one line on stdout: `RW_AI_READY {json}`. The shell parses that and
 * nothing else; all further logging is disabled so no request data can reach the pipe.
 */

import { createInterface } from 'node:readline';
import { LOOPBACK_HOST, configProblems, readConfig } from './config.mjs';
import { createAiServer } from './index.mjs';
import { createLogger } from './log.mjs';

const READY_PREFIX = 'RW_AI_READY ';
const SECRET_PREFIX = 'RW_AI_SECRET ';
/** Long enough for a loaded machine to start the child; short enough to fail visibly. */
const SECRET_TIMEOUT_MS = 20_000;

const token = (process.env.AI_SESSION_TOKEN ?? '').trim();
const instance = (process.env.AI_DESKTOP_INSTANCE ?? '').trim();
const parentPid = Number(process.env.AI_PARENT_PID);
const mode = process.env.AI_DESKTOP_MODE === 'online' ? 'online' : 'mock';

if (token.length < 32) {
  process.stderr.write('桌面 AI 服务需要至少 32 个字符的 AI_SESSION_TOKEN。\n');
  process.exit(2);
}

const config = readConfig(
  {
    ...process.env,
    // The desktop never lets an inherited key turn this process into a paid call. A key arrives
    // later, over stdin, and only in online mode. The provider and the endpoint, by contrast,
    // are the reader's saved settings, which the shell passes in deliberately.
    AI_API_KEY: '',
    DEEPSEEK_API_KEY: '',
  },
  {
    // `mock` is not a suggestion here; it is the wall the previous phase established.
    forceOffline: mode === 'mock',
    allowEphemeralPort: true,
    deferredKey: mode === 'online',
  },
);

const problems = configProblems(config);
if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`配置错误：${problem}\n`);
  process.exit(2);
}

/**
 * Reads stdin for the one secret line and for EOF.
 *
 * The same pipe serves both purposes: the shell holds the write end open for its lifetime, so
 * EOF is the cross-platform "the parent is gone" signal. The secret is consumed once; later
 * lines are ignored and never stored or echoed.
 */
let apiKey = '';
let secretReceived = mode === 'mock';
let resolveSecret = null;
const secretPromise = new Promise((resolve) => {
  resolveSecret = resolve;
});

let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  // Keep-alive sockets would otherwise hold `close` for as long as the request timeout.
  server?.closeAllConnections?.();
  server?.close(() => {
    process.exit(exitCode);
  });
  setTimeout(() => {
    process.exit(exitCode);
  }, 1500).unref();
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (secretReceived || !line.startsWith(SECRET_PREFIX)) return;
  let payload;
  try {
    payload = JSON.parse(line.slice(SECRET_PREFIX.length));
  } catch {
    process.stderr.write('桌面 AI 服务收到的凭据格式不正确。\n');
    process.exit(3);
  }
  const candidate = typeof payload?.apiKey === 'string' ? payload.apiKey.trim() : '';
  // A key is a printable token. Rejecting anything else keeps the value out of headers and
  // logs even if the shell side is ever wrong.
  if (candidate.length < 8 || candidate.length > 1024 || !/^[\x21-\x7e]+$/.test(candidate)) {
    process.stderr.write('桌面 AI 服务收到的凭据长度或字符不合法。\n');
    process.exit(3);
  }
  apiKey = candidate;
  secretReceived = true;
  resolveSecret?.();
});
lines.on('close', () => {
  // EOF from the shell. Even a service that is still waiting for its key must exit.
  stop(0);
});

// The shell holds the write end of this pipe for as long as it lives. EOF is therefore the
// most reliable cross-platform "the parent is gone" signal, including when it crashes.
process.stdin.on('error', () => {
  stop(0);
});

let server = null;

async function start() {
  if (mode === 'online' && !secretReceived) {
    const timedOut = await Promise.race([
      secretPromise.then(() => false),
      new Promise((resolve) => {
        setTimeout(() => {
          resolve(true);
        }, SECRET_TIMEOUT_MS).unref();
      }),
    ]);
    if (timedOut) {
      process.stderr.write('桌面 AI 服务没有在限定时间内收到 API Key，已停止在线模式。\n');
      process.exit(4);
    }
  }

  const effective = { ...config, sessionToken: token, desktopInstance: instance };
  if (mode === 'online') effective.apiKey = apiKey;

  const created = createAiServer({
    config: effective,
    // stdout belongs to the ready handshake. Request logging stays off; an error that matters is
    // written to stderr, which the shell keeps for its status message.
    log: createLogger({ enabled: false }),
  });
  server = created.server;
  const health = created.health;

  // The provider has its own copy of the key; drop the extra reference this module held.
  if (mode === 'online') {
    apiKey = '';
    delete effective.apiKey;
  }

  server.on('error', (error) => {
    process.stderr.write(`桌面 AI 服务启动失败：${error.message}\n`);
    process.exit(1);
  });

  server.listen(0, LOOPBACK_HOST, () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    process.stdout.write(
      `${READY_PREFIX}${JSON.stringify({
        port,
        instanceId: health.instanceId,
        desktopInstance: instance,
        provider: health.provider,
        model: health.model,
        online: health.online,
      })}\n`,
    );
  });
}

if (Number.isInteger(parentPid) && parentPid > 0) {
  // Belt and braces: some Windows shells hand the child a console pipe that outlives the
  // process object. Polling the PID catches that case as well.
  const watchdog = setInterval(() => {
    if (!parentIsAlive(parentPid)) stop(0);
  }, 4000);
  watchdog.unref();
}

function parentIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else, which still counts as alive.
    return error?.code === 'EPERM';
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stop(0);
  });
}

void start();
