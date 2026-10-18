/**
 * The check that makes an "offline" acceptance run actually offline.
 *
 * Phase 5 shipped a script that started the preview server without `AI_PORT`; the proxy fell
 * back to its default port, where a paid service was still listening, and two questions were
 * answered — and billed — by it. Every guard that existed at the time asked the *service this
 * script started* what it was. None of them asked what the page would actually talk to.
 *
 * So the rule is now: before a browser is opened, fetch the service health **through the same
 * origin the page will use**, and require
 *
 *   1. it answers at all,
 *   2. it says `provider: "mock"` and `online: false`,
 *   3. it carries the instance id of the process this run started.
 *
 * Anything else ends the run before a single question is asked.
 */

/** The exit code every verification script uses when it refuses to run. */
export const OFFLINE_REFUSAL_EXIT = 4;

/**
 * Reads the health of whatever is behind `origin`.
 *
 * Returns a value rather than exiting, so the same function can be used by a test that needs to
 * assert the refusal as well as by scripts that act on it.
 */
export async function probeProxy(origin, { allowedProviders = ['mock'] } = {}) {
  let response;
  try {
    response = await fetch(`${origin}api/ai/health`);
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (!response.ok) return { ok: false, reason: 'status', status: response.status };

  let health;
  try {
    health = await response.json();
  } catch {
    return { ok: false, reason: 'not-json' };
  }
  if (typeof health !== 'object' || health === null) return { ok: false, reason: 'not-json' };
  if (!allowedProviders.includes(health.provider) || health.online !== false) {
    return { ok: false, reason: 'online-provider', health };
  }
  if (typeof health.instanceId !== 'string' || health.instanceId === '') {
    // A service that cannot say which process it is cannot be pinned to this run.
    return { ok: false, reason: 'no-instance-id', health };
  }
  return { ok: true, health };
}

/**
 * Refuses to continue unless the page's own origin is served by the offline mock this run
 * started. `expectedInstance` is the id reported by the service process the script spawned.
 */
export async function requireOfflineProxy(
  origin,
  { expectedInstance, label = '验收', allowedProviders = ['mock'] } = {},
) {
  const probe = await probeProxy(origin, { allowedProviders });
  if (!probe.ok) {
    process.stderr.write(
      `${label}在浏览器打开之前中止：预览地址 ${origin} 后面的服务不是本次启动的离线提供方。\n` +
        `  原因：${describe(probe)}\n` +
        '  这可能是端口上另有服务（包括付费服务），也可能是预览代理没有指向 AI_PORT。\n',
    );
    process.exit(OFFLINE_REFUSAL_EXIT);
  }
  if (expectedInstance !== undefined && probe.health.instanceId !== expectedInstance) {
    process.stderr.write(
      `${label}在浏览器打开之前中止：端口上应答的 mock 不是本次启动的那个进程。\n` +
        `  期望实例 ${String(expectedInstance)}，实际 ${String(probe.health.instanceId)}\n` +
        '  另一个测试留下的 mock 同样会产生「看起来通过」的结果。\n',
    );
    process.exit(OFFLINE_REFUSAL_EXIT);
  }
  return probe.health;
}

function describe(probe) {
  if (probe.reason === 'online-provider') {
    return `provider=${String(probe.health?.provider)} online=${String(probe.health?.online)}`;
  }
  if (probe.reason === 'status') return `HTTP ${String(probe.status)}`;
  return probe.reason;
}

/**
 * Ends the run when the service this script spawned cannot be reached at all.
 *
 * Separate from the proxy check on purpose: "my service did not start" and "the page is talking
 * to something else" are different failures and deserve different messages.
 */
export function requireServiceStarted(health, label = '验收') {
  if (health === undefined || health === null) {
    process.stderr.write(`${label}中止：本次启动的离线服务没有起来。\n`);
    process.exit(OFFLINE_REFUSAL_EXIT);
  }
  return health;
}
