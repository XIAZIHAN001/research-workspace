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
 * - it is always offline. `--offline` semantics are applied unconditionally, so a
 *   `DEEPSEEK_API_KEY` that happens to be exported in the parent environment cannot turn a
 *   desktop launch into a paid call;
 * - it exits when the shell goes away, either because its stdin pipe closes or because the
 *   parent process disappears. A window that closes is not evidence that the service died,
 *   so the service watches for the actual condition.
 *
 * It prints exactly one line on stdout: `RW_AI_READY {json}`. The shell parses that and
 * nothing else; all further logging is disabled so no request data can reach the pipe.
 */

import { LOOPBACK_HOST, configProblems, readConfig } from './config.mjs';
import { createAiServer } from './index.mjs';
import { createLogger } from './log.mjs';

const READY_PREFIX = 'RW_AI_READY ';

const token = (process.env.AI_SESSION_TOKEN ?? '').trim();
const instance = (process.env.AI_DESKTOP_INSTANCE ?? '').trim();
const parentPid = Number(process.env.AI_PARENT_PID);

if (token.length < 32) {
  process.stderr.write('桌面 AI 服务需要至少 32 个字符的 AI_SESSION_TOKEN。\n');
  process.exit(2);
}

const config = readConfig(
  { ...process.env, AI_PROVIDER: 'mock', DEEPSEEK_API_KEY: '' },
  { forceOffline: true, allowEphemeralPort: true },
);

const problems = configProblems(config);
if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`配置错误：${problem}\n`);
  process.exit(2);
}

const { server, health } = createAiServer({
  config: { ...config, sessionToken: token, desktopInstance: instance },
  // stdout belongs to the ready handshake. Request logging stays off; an error that matters is
  // written to stderr, which the shell keeps for its status message.
  log: createLogger({ enabled: false }),
});

let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  // Keep-alive sockets would otherwise hold `close` for as long as the request timeout.
  server.closeAllConnections?.();
  server.close(() => {
    process.exit(exitCode);
  });
  setTimeout(() => {
    process.exit(exitCode);
  }, 1500).unref();
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
      online: health.online,
    })}\n`,
  );
});

// The shell holds the write end of this pipe for as long as it lives. EOF is therefore the
// most reliable cross-platform "the parent is gone" signal, including when it crashes.
process.stdin.resume();
process.stdin.on('end', () => {
  stop(0);
});
process.stdin.on('close', () => {
  stop(0);
});

if (Number.isInteger(parentPid) && parentPid > 0) {
  // Belt and braces: some Windows shells hand the child a console pipe that outlives the
  // process object. Polling the PID catches that case as well.
  const watchdog = setInterval(() => {
    if (!parentIsAlive(parentPid)) stop(0);
  }, 4000);
  watchdog.unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stop(0);
  });
}
