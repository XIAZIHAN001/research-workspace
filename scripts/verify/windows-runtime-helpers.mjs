import { createHash } from 'node:crypto';
import { get as httpGet } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { win32 as path } from 'node:path';

function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}

/** These are platform-provided facts plus explicit workflow opt-in, not a sandbox. */
export function assertHostedRunner(env, platform) {
  requireValue(platform === 'win32', 'WINDOWS_REQUIRED');
  requireValue(
    ['DEBUG', 'PWDEBUG', 'NODE_DEBUG', 'NODE_OPTIONS'].every((key) => !env[key]),
    'DRIVER_DEBUG_CHANNEL_REFUSED',
  );
  requireValue(
    env.GITHUB_ACTIONS === 'true' &&
      env.RUNNER_ENVIRONMENT === 'github-hosted' &&
      env.RUNNER_OS === 'Windows',
    'FRESH_HOSTED_RUNNER_REQUIRED',
  );
  requireValue(env.RW_WINDOWS_FRESH_RUNNER === 'yes', 'WORKFLOW_OPT_IN_REQUIRED');
  for (const key of [
    'RUNNER_TEMP',
    'GITHUB_WORKSPACE',
    'ImageVersion',
    'GITHUB_RUN_ID',
    'GITHUB_RUN_ATTEMPT',
  ]) {
    requireValue(typeof env[key] === 'string' && env[key].length > 0, 'RUNNER_METADATA_REQUIRED');
  }
  // Official runner-images Windows2025_vs2026 maps ImageOS to this exact suffixed value.
  requireValue(
    /^win\d+$/.test(env.ImageOS ?? '') || env.ImageOS === 'win25-vs2026',
    'WINDOWS_IMAGE_REQUIRED',
  );
  requireValue(/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ''), 'COMMIT_REQUIRED');
  requireValue(
    path.isAbsolute(env.RUNNER_TEMP) && path.isAbsolute(env.GITHUB_WORKSPACE),
    'ABSOLUTE_RUNNER_PATH_REQUIRED',
  );
}

export function selectInstaller(artifacts, build, source, env, now = Date.now()) {
  requireValue(source.clean === true, 'CLEAN_SOURCE_REQUIRED');
  requireValue(
    build.commit === source.commit &&
      source.commit === env.GITHUB_SHA &&
      /^[a-f0-9]{40}$/.test(source.commit),
    'COMMIT_MISMATCH',
  );
  requireValue(build.tree === source.tree && /^[a-f0-9]{40}$/.test(source.tree), 'TREE_MISMATCH');
  requireValue(
    build.version === source.version && /^\d+\.\d+\.\d+$/.test(source.version),
    'VERSION_MISMATCH',
  );
  requireValue(
    build.runId === env.GITHUB_RUN_ID && build.runAttempt === env.GITHUB_RUN_ATTEMPT,
    'BUILD_RUN_MISMATCH',
  );
  requireValue(
    Number.isFinite(build.startedAtMs) &&
      build.startedAtMs > 0 &&
      build.startedAtMs <= now &&
      now - build.startedAtMs < 60 * 60_000,
    'BUILD_TIME_INVALID',
  );
  requireValue(artifacts.length === 1, 'EXACTLY_ONE_INSTALLER_REQUIRED');
  const [artifact] = artifacts;
  const expectedName = `Research Workspace_${source.version}_x64-setup.exe`;
  const expectedDir = path.join(
    env.GITHUB_WORKSPACE,
    'src-tauri',
    'target',
    'release',
    'bundle',
    'nsis',
  );
  requireValue(
    path.basename(artifact.path) === expectedName &&
      canonical(path.dirname(artifact.path)) === canonical(expectedDir),
    'INSTALLER_PATH_MISMATCH',
  );
  requireValue(
    artifact.mtimeMs >= build.startedAtMs && artifact.mtimeMs <= now && artifact.size > 0,
    'STALE_OR_EMPTY_INSTALLER',
  );
  return artifact.path;
}

const canonical = (value) => path.normalize(value).toLowerCase();

/** Call with verified regular real files, never fall back to build output. */
export function installedPaths(directory, files) {
  requireValue(
    typeof directory === 'string' && path.isAbsolute(directory),
    'INSTALL_DIRECTORY_REQUIRED',
  );
  const expected = {
    exe: path.join(directory, 'research-workspace.exe'),
    sidecar: path.join(directory, 'sidecar', 'rw-node.exe'),
    launcher: path.join(directory, 'sidecar', 'server', 'desktop.mjs'),
  };
  const available = new Set(
    files.filter((value) => typeof value === 'string' && value.length > 0).map(canonical),
  );
  requireValue(
    Object.values(expected).every((value) => available.has(canonical(value))),
    'INSTALLED_RESOURCES_MISSING',
  );
  return expected;
}

/**
 * Tauri CLI 2.12.3 bundle.rs patches only the first UNK marker before NSIS,
 * then restores the build-tree EXE. Derive the exact expected payload in a copy;
 * never normalize installed bytes or exclude any byte from the comparison.
 * https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.3/crates/tauri-bundler/src/bundle.rs
 */
export function verifyResourceHashes(install, resources, cliVersion) {
  const roles = ['exe', 'sidecar', 'launcher'];
  requireValue(
    resources.length === roles.length &&
      resources.every(
        (entry, index) =>
          entry.role === roles[index] &&
          Buffer.isBuffer(entry.buildBytes) &&
          Buffer.isBuffer(entry.installedBytes),
      ),
    'RESOURCE_HASH_INPUT_INVALID',
  );
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  install.tauriCliVersion =
    typeof cliVersion === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(cliVersion)
      ? cliVersion
      : 'unknown';
  install.resourceHashesMatchExpected = false;
  // Preserve every role's raw hashes before a marker/version/comparison can fail.
  install.resourceHashes = resources.map((entry) => {
    const buildSha256 = digest(entry.buildBytes);
    const installedSha256 = digest(entry.installedBytes);
    return {
      role: entry.role,
      buildSha256,
      installedSha256,
      buildSize: entry.buildBytes.length,
      installedSize: entry.installedBytes.length,
      expectedSha256: entry.role === 'exe' ? null : buildSha256,
      method: entry.role === 'exe' ? 'unavailable' : 'verbatim',
      matches:
        entry.role === 'exe'
          ? null
          : entry.installedBytes.length === entry.buildBytes.length &&
            installedSha256 === buildSha256,
    };
  });
  const exe = install.resourceHashes[0];
  if (cliVersion !== '2.12.3') {
    exe.comparisonError = 'TAURI_CLI_HASH_MAPPING_UNSUPPORTED';
    throw new Error(exe.comparisonError);
  }
  exe.method = 'tauri-2.12.3-nsis-first-marker';
  const marker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
  const buildBytes = resources[0].buildBytes;
  const offset = buildBytes.indexOf(marker);
  if (offset < 0) {
    exe.comparisonError = 'TAURI_BUNDLE_MARKER_MISSING';
    throw new Error(exe.comparisonError);
  }
  const expected = Buffer.from(buildBytes);
  Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS').copy(expected, offset);
  exe.expectedSha256 = digest(expected);
  exe.matches = exe.installedSize === expected.length && exe.installedSha256 === exe.expectedSha256;
  requireValue(
    install.resourceHashes.every((entry) => entry.matches === true),
    'INSTALLED_RESOURCE_HASH_MISMATCH',
  );
  install.resourceHashesMatchExpected = true;
}

export function sameProcess(expected, current) {
  return Boolean(
    expected &&
    current &&
    Number.isInteger(expected.pid) &&
    expected.pid > 0 &&
    expected.pid === current.pid &&
    typeof expected.path === 'string' &&
    expected.path.length > 0 &&
    typeof current.path === 'string' &&
    current.path.length > 0 &&
    canonical(expected.path) === canonical(current.path) &&
    Number.isFinite(Date.parse(expected.startedAt)) &&
    expected.startedAt === current.startedAt,
  );
}

/** A dead parent's PID alone cannot establish new ownership. Retain already tracked identities. */
export function collectOwned(snapshot, tracked) {
  const result = [...tracked];
  let added;
  do {
    added = false;
    for (const current of snapshot) {
      if (result.some((entry) => sameProcess(entry, current))) continue;
      const parent = result.find(
        (entry) =>
          entry.pid === current.parentPid && snapshot.some((live) => sameProcess(entry, live)),
      );
      if (
        parent &&
        Number.isInteger(current.pid) &&
        current.pid > 0 &&
        typeof current.path === 'string' &&
        current.path.length > 0 &&
        Date.parse(current.startedAt) >= Date.parse(parent.startedAt)
      ) {
        result.push(current);
        added = true;
      }
    }
  } while (added);
  return result;
}

export function makeReport(names) {
  return {
    schema: 1,
    scope: 'Installed Windows application/WebView2 runtime acceptance',
    startedAt: new Date().toISOString(),
    status: 'NOT RUN',
    terminalError: null,
    checks: names.map((name) => ({ name, status: 'NOT RUN' })),
    excluded: [
      'Clean consumer Windows 10/11 prerequisites',
      'Upgrade/uninstall and installer-dialog UX',
      'PDF import/reading UI',
      'Backup export/restore UI',
      'Paid or real upstream calls',
    ].map((name) => ({ name, status: 'NOT RUN' })),
    console: { errors: 0, warnings: 0, pageErrors: 0 },
    screenshots: [],
  };
}

export function finishReport(report, runtime) {
  const failed = report.checks.some((check) => check.status === 'FAIL');
  const incomplete = report.checks.some((check) => check.status !== 'PASS');
  return {
    ...report,
    completedAt: new Date().toISOString(),
    status:
      failed || (report.terminalError && !report.blocked)
        ? 'FAIL'
        : incomplete || report.blocked
          ? 'NOT RUN'
          : 'PASS',
    // Values are classified, not copied from arbitrary IPC strings which might contain secrets.
    runtime: runtime
      ? {
          state: ['ready', 'starting', 'failed', 'stopped'].includes(runtime.state)
            ? runtime.state
            : 'unknown',
          mode: ['mock', 'online'].includes(runtime.mode) ? runtime.mode : 'unknown',
          provider: [
            'mock',
            'deepseek',
            'openai',
            'moonshot',
            'zhipu',
            'dashscope',
            'custom',
          ].includes(runtime.provider)
            ? runtime.provider
            : 'unknown',
          credentialConfigured: runtime.credentialConfigured === true,
        }
      : null,
  };
}

export function nsisInvocation(installer, directory) {
  for (const value of [installer, directory]) {
    requireValue(
      typeof value === 'string' &&
        path.isAbsolute(value) &&
        [...value].every((character) => character !== '"' && character.charCodeAt(0) >= 32),
      'NSIS_ABSOLUTE_SAFE_PATH_REQUIRED',
    );
  }
  // With verbatim arguments, libuv will not quote argv0 either. Quote it explicitly,
  // while leaving NSIS's special final /D tail unquoted as its documentation requires.
  return {
    args: ['/S', `/D=${directory}`],
    argv0: `"${installer}"`,
    windowsVerbatimArguments: true,
  };
}

/** Retain the native child handle synchronously, before any fallible observation. */
export async function spawnObserved({
  spawnProcess,
  launches,
  role,
  executable,
  args,
  options,
  observe,
}) {
  requireValue(['app', 'installer'].includes(role), 'LAUNCH_ROLE_REQUIRED');
  const child = spawnProcess(executable, args, options);
  const launch = { role, child, root: null, observed: false };
  launches.push(launch);
  child.on('error', () => {});
  launch.completion = new Promise((done, reject) => {
    child.once('exit', (code) => done(code));
    child.once('error', () => reject(new Error('PROCESS_START_FAILED')));
  });
  // App callers only await observation; an early spawn error must not be an unhandled rejection.
  launch.completion.catch(() => {});
  launch.root = await observe(child, executable);
  launch.observed = true;
  return launch;
}

/**
 * Windows ChildProcess.kill uses libuv's retained process handle, not a PID lookup.
 * It can stop a root whose CIM observation failed, but proves nothing about descendants.
 * Never use process.kill(pid), taskkill, or a native PID lookup as this fallback.
 */
export async function cleanupUnobservedLaunches(launches, platform, waitForExit) {
  const uncertain = [];
  for (const launch of launches.filter((entry) => !entry.observed)) {
    const result = { role: launch.role, rootStop: 'not-attempted', descendants: 'unverified' };
    uncertain.push(result);
    const child = launch.child;
    if (child.exitCode !== null || child.signalCode !== null) {
      result.rootStop = 'already-exited';
    } else if (platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
      result.rootStop = 'unconfirmed';
      try {
        if (child.kill('SIGKILL')) {
          await waitForExit(launch.completion);
          if (child.exitCode !== null || child.signalCode !== null) result.rootStop = 'confirmed';
        }
      } catch {
        /* Preserve uncertainty and attempt any other retained launch handles. */
      }
    }
  }
  return uncertain;
}

/** Unobserved descendants permanently fail cleanup, even if the root was stopped. */
export function recordCleanup(report, failures, unverifiedLaunches = []) {
  const combined = [
    ...failures,
    ...unverifiedLaunches.map((entry) => `unverified-${entry.role}-descendants`),
  ];
  report.checks.find((entry) => entry.name === 'owned-cleanup').status = combined.length
    ? 'FAIL'
    : 'PASS';
  if (unverifiedLaunches.length > 0) report.unverifiedLaunches = unverifiedLaunches;
  if (combined.length > 0) {
    report.terminalError ??= 'OWNED_CLEANUP_FAILED';
    report.cleanupIncomplete = true;
    report.cleanupFailures = [...new Set(combined)];
  }
  return report;
}

/** Only our known guard classifications may reach reports; never echo arbitrary error text. */
export function runnerGuardCode(error) {
  const codes = new Set([
    'WINDOWS_REQUIRED',
    'DRIVER_DEBUG_CHANNEL_REFUSED',
    'FRESH_HOSTED_RUNNER_REQUIRED',
    'WORKFLOW_OPT_IN_REQUIRED',
    'RUNNER_METADATA_REQUIRED',
    'WINDOWS_IMAGE_REQUIRED',
    'COMMIT_REQUIRED',
    'ABSOLUTE_RUNNER_PATH_REQUIRED',
  ]);
  return codes.has(error?.message) ? error.message : 'FRESH_GITHUB_HOSTED_WINDOWS_REQUIRED';
}

/** Classifications only: Playwright errors can contain URLs and protocol payloads. */
export function classifyCdpError(error) {
  if (error?.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(error?.message ?? '')) return 'refused';
  if (error?.name === 'TimeoutError' || error?.message === 'CDP_TIMEOUT') return 'timeout';
  if (/^(?:browserType\.connectOverCDP: )?Protocol error\b/.test(error?.message ?? ''))
    return 'protocol-error';
  return 'unavailable';
}

/** Fixed loopback discovery only. No redirects, proxy, response retention or arbitrary URLs. */
export async function probeCdp(port, timeoutMs) {
  requireValue(Number.isInteger(port) && port > 0 && port < 65536, 'CDP_PORT_INVALID');
  return new Promise((resolveProbe) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProbe(result);
    };
    const request = httpGet(
      { hostname: '127.0.0.1', port, path: '/json/version/', agent: false },
      (response) => {
        const httpStatus = response.statusCode;
        if (httpStatus !== 200) {
          finish({ result: 'http-status', httpStatus });
          response.destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 64 * 1024) {
            finish({ result: 'oversize', httpStatus });
            response.destroy();
          } else chunks.push(chunk);
        });
        response.on('error', () => finish({ result: 'unavailable', httpStatus }));
        response.on('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (typeof value?.webSocketDebuggerUrl !== 'string') {
              finish({ result: 'missing-endpoint', httpStatus });
              return;
            }
            const endpoint = new URL(value.webSocketDebuggerUrl);
            const valid =
              endpoint.protocol === 'ws:' &&
              ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) &&
              endpoint.port === String(port) &&
              !endpoint.username &&
              !endpoint.password &&
              endpoint.pathname.startsWith('/devtools/browser/');
            finish({ result: valid ? 'ready' : 'unsafe-endpoint', httpStatus });
          } catch {
            finish({ result: 'invalid-response', httpStatus });
          }
        });
      },
    );
    request.on('error', (error) => finish({ result: classifyCdpError(error) }));
    timer = setTimeout(
      () => {
        finish({ result: 'timeout' });
        request.destroy();
      },
      Math.max(1, timeoutMs),
    );
  });
}

/** One total deadline; retain an attached connection while its first page is created. */
export async function connectWebView({ evidence, budgetMs, discover, connect, checkAlive }) {
  const started = Date.now();
  const end = started + budgetMs;
  Object.assign(evidence, { attemptCount: 0, droppedAttempts: 0, attempts: [], elapsedMs: 0 });
  const timeLeft = () => Math.max(0, end - Date.now());
  // Also pass this timeout to each real API. The guard handles broken/late adapters without
  // forgetting an eventually acquired connection. Late CDP successes are always disconnected.
  const call = async (work, maximum, lateSuccess) => {
    const timeout = Math.max(1, Math.min(timeLeft(), maximum));
    let expired = false;
    let timer;
    const pending = Promise.resolve().then(() => work(timeout));
    pending.then(
      (value) => {
        if (expired) lateSuccess?.(value);
      },
      () => {},
    );
    try {
      return await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(new Error('CDP_TIMEOUT'));
          }, timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const close = (browser) =>
    Promise.resolve()
      .then(() => browser?.close())
      .catch(() => {});
  try {
    while (timeLeft() > 0) {
      const attempt = {
        ordinal: ++evidence.attemptCount,
        discovery: { result: 'unavailable' },
        attach: 'not-run',
        page: 'not-run',
      };
      evidence.attempts.push(attempt);
      if (evidence.attempts.length > 32) {
        evidence.attempts.shift();
        evidence.droppedAttempts++;
      }
      let browser;
      let accepted = false;
      try {
        let discovery;
        try {
          discovery = await call(discover, 1500);
        } catch (error) {
          discovery = { result: classifyCdpError(error) };
        }
        const known = [
          'ready',
          'refused',
          'timeout',
          'http-status',
          'oversize',
          'missing-endpoint',
          'unsafe-endpoint',
          'invalid-response',
          'unavailable',
        ];
        attempt.discovery = {
          result: known.includes(discovery?.result) ? discovery.result : 'unavailable',
        };
        if (
          Number.isInteger(discovery?.httpStatus) &&
          discovery.httpStatus >= 100 &&
          discovery.httpStatus <= 599
        )
          attempt.discovery.httpStatus = discovery.httpStatus;
        if (attempt.discovery.result === 'ready' && timeLeft() > 0) {
          try {
            browser = await call(connect, 8000, close);
            attempt.attach = 'connected';
            const contexts = browser.contexts();
            attempt.contextCount = contexts.length;
            const context = contexts[0];
            if (!context) attempt.page = 'no-context';
            else {
              attempt.pageCount = context.pages().length;
              let page = context.pages()[0];
              if (!page && timeLeft() > 0) {
                try {
                  page = await call((timeout) => context.waitForEvent('page', { timeout }), 8000);
                } catch (error) {
                  attempt.page = classifyCdpError(error);
                }
              }
              if (page) {
                attempt.page = 'ready';
                attempt.pageCount = context.pages().length;
                accepted = true;
                return { browser, page };
              }
            }
          } catch (error) {
            attempt.attach = classifyCdpError(error);
          }
        }
      } finally {
        if (browser && !accepted) {
          // Closing CDP disconnects the transport, not the application. The owned-process
          // cleanup remains responsible for the application even if disconnect times out.
          await call(() => close(browser), 1000).catch(() => {});
        }
      }
      if (timeLeft() <= 0) break;
      requireValue(await call(checkAlive, 3000), 'INSTALLED_APP_EXITED_BEFORE_WINDOW');
      await delay(Math.min(300, timeLeft()));
    }
    return null;
  } finally {
    evidence.elapsedMs = Date.now() - started;
  }
}

export function projectProcessOutcome(value) {
  const select = (key, allowed, fallback) =>
    allowed.includes(value?.[key]) ? value[key] : fallback;
  return {
    result: select(
      'result',
      ['matched', 'stopped', 'exited', 'absent', 'mismatch', 'failed', 'observed', 'unavailable'],
      'unavailable',
    ),
    phase: select(
      'phase',
      [
        'open',
        'query-image',
        'query-time',
        'identity',
        'wait-before',
        'terminate',
        'wait-after',
        'enum-windows',
        'window-process',
        'window-rect',
        'wait-window-after',
        'complete',
        'bridge',
        'timeout',
      ],
      'bridge',
    ),
    win32Error:
      Number.isInteger(value?.win32Error) && value.win32Error >= 0 && value.win32Error <= 0xffffffff
        ? value.win32Error
        : null,
    identity: select('identity', ['matched', 'mismatch', 'unavailable'], 'unavailable'),
    exitState: select(
      'exitState',
      ['signaled', 'nonsignaled', 'unavailable', 'absent'],
      'unavailable',
    ),
  };
}

export function confirmedProcessExit(value) {
  const outcome = projectProcessOutcome(value);
  return (
    (['stopped', 'exited'].includes(outcome.result) &&
      outcome.identity === 'matched' &&
      outcome.exitState === 'signaled' &&
      Number.isInteger(outcome.win32Error) &&
      (outcome.result !== 'stopped' || outcome.win32Error === 0)) ||
    (outcome.result === 'absent' &&
      outcome.phase === 'open' &&
      outcome.win32Error === 87 &&
      outcome.identity === 'unavailable' &&
      outcome.exitState === 'absent')
  );
}

export function projectWindowCounts(value) {
  const projected = { ...projectProcessOutcome(value), windows: null };
  const keys = ['total', 'visible', 'minimized', 'withArea'];
  if (
    projected.result === 'observed' &&
    projected.identity === 'matched' &&
    projected.exitState === 'nonsignaled' &&
    keys.every(
      (key) =>
        Number.isInteger(value?.windows?.[key]) &&
        value.windows[key] >= 0 &&
        value.windows[key] <= 100000,
    )
  ) {
    projected.windows = Object.fromEntries(keys.map((key) => [key, value.windows[key]]));
  }
  return projected;
}

export function ownedProcessRole(identity, paths, roots) {
  if (paths?.exe && canonical(identity.path) === canonical(paths.exe)) return 'app';
  if (paths?.sidecar && canonical(identity.path) === canonical(paths.sidecar)) return 'sidecar';
  if (roots.some((root) => sameProcess(root, identity))) return 'installer';
  if (path.basename(identity.path).toLowerCase() === 'msedgewebview2.exe') return 'webview2';
  return 'otherOwned';
}

export function ownedProcessCounts(live, owned, paths, roots) {
  const counts = { app: 0, installer: 0, sidecar: 0, webview2: 0, otherOwned: 0 };
  for (const identity of owned) {
    if (live.some((row) => sameProcess(identity, row)))
      counts[ownedProcessRole(identity, paths, roots)]++;
  }
  return counts;
}
