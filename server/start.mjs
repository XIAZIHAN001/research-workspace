/**
 * Starts the local AI service.
 *
 * Run it with no configuration and it comes up on the mock provider: nothing leaves the
 * machine and nothing is billed. Reaching a real model requires saying so twice — set
 * `AI_PROVIDER` to a provider id *and* put a key in `AI_API_KEY`. That is on purpose: starting the
 * app should not be able to start spending money.
 *
 *   npm run ai:serve:offline     # mock, always — the environment cannot change that
 *   npm run ai:serve             # whatever AI_PROVIDER says; mock when unset
 *   npm run ai:serve:online      # refuses to start unless a key and a provider are set
 *
 * To reach a real model (PowerShell — `VAR=value command` is bash syntax and PowerShell
 * rejects it):
 *   $env:AI_PROVIDER='deepseek'; $env:AI_API_KEY='…'; npm run ai:serve
 *
 * Optional: AI_PORT, AI_BASE_URL, AI_MODEL, AI_TIMEOUT_MS, AI_MAX_OUTPUT_TOKENS,
 * AI_THINKING, AI_REASONING_EFFORT, AI_ALLOWED_ORIGINS. The older `DEEPSEEK_*` spellings of
 * the endpoint, model and key are still read.
 *
 * Two things this file refuses to do, because both have already gone wrong once:
 *
 * - It never falls back to another port. If the one it was told to use is taken, it exits. A
 *   process that quietly moved would leave the verify scripts talking to a *different* service
 *   on the expected port — which is exactly how an offline "dry run" reached the paid API.
 * - `--offline` ignores `AI_PROVIDER` and the key entirely, so a machine with a key exported
 *   into its environment still cannot make this process spend anything.
 */

import { LOOPBACK_HOST, configProblems, readConfig } from './config.mjs';
import { createAiServer } from './index.mjs';
import { createLogger } from './log.mjs';

const argv = new Set(process.argv.slice(2));
const offline = argv.has('--offline');
const online = argv.has('--online');
const log = createLogger({ enabled: true });

if (offline && online) {
  process.stderr.write('--offline 与 --online 不能同时使用。\n');
  process.exit(2);
}

const config = readConfig(process.env, { forceOffline: offline });

if (online) {
  const problems = [];
  if (config.provider === 'mock') {
    problems.push('--online 需要在环境里指定一个模型提供方（AI_PROVIDER）。');
  }
  if (config.apiKey === '') {
    problems.push('--online 需要 AI_API_KEY（只从环境变量读取，不写进任何文件）。');
  }
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`配置错误：${problem}\n`);
    process.stderr.write('没有启动任何服务，也没有发出任何调用。\n');
    process.exit(3);
  }
}

const problems = configProblems(config);
if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`配置错误：${problem}\n`);
  process.exit(2);
}

const { server, health } = createAiServer({ config, log });

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    process.stderr.write(
      `端口 ${String(config.port)} 已经被占用：这次启动中止。\n` +
        '这里不会改用别的端口，也不会去连接那个已经存在的服务——它可能是另一套配置，' +
        '也可能正在调用付费模型。请先确认那个进程是什么，或换一个 AI_PORT。\n',
    );
    process.exit(3);
  }
  process.stderr.write(`本地 AI 服务启动失败：${error.message}\n`);
  process.exit(1);
});

server.listen(config.port, LOOPBACK_HOST, () => {
  log.note(`本地 AI 服务已启动：http://${LOOPBACK_HOST}:${String(config.port)}`);
  log.note(
    health.online
      ? `提供方 ${health.label}：问答会调用在线模型，可能产生费用。`
      : `提供方 ${health.label}：不会发起任何在线调用。`,
  );
  if (offline) log.note('本次启动使用了 --offline：环境里的 AI_PROVIDER 与密钥都被忽略。');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}
