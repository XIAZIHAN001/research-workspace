/**
 * Starts the local AI service.
 *
 * Run it with no configuration and it comes up on the mock provider: nothing leaves the
 * machine and nothing is billed. Reaching a real model requires saying so twice — set
 * `AI_PROVIDER=deepseek` *and* put a key in `DEEPSEEK_API_KEY`. That is on purpose: starting the
 * app should not be able to start spending money.
 *
 *   node server/start.mjs                        # mock, offline
 *   AI_PROVIDER=deepseek DEEPSEEK_API_KEY=… node server/start.mjs
 *
 * Optional: AI_PORT, DEEPSEEK_MODEL, DEEPSEEK_BASE_URL, AI_TIMEOUT_MS, AI_ALLOWED_ORIGINS.
 */

import { LOOPBACK_HOST, configProblems, readConfig } from './config.mjs';
import { createAiServer } from './index.mjs';
import { createLogger } from './log.mjs';

const config = readConfig(process.env);
const problems = configProblems(config);
const log = createLogger({ enabled: true });

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`配置错误：${problem}\n`);
  process.exit(2);
}

const { server, health } = createAiServer({ config, log });

server.listen(config.port, LOOPBACK_HOST, () => {
  log.note(`本地 AI 服务已启动：http://${LOOPBACK_HOST}:${String(config.port)}`);
  log.note(
    health.online
      ? `提供方 ${health.label}：问答会调用在线模型，可能产生费用。`
      : `提供方 ${health.label}：不会发起任何在线调用。`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}
