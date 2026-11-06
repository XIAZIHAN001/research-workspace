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
  requireValue(/^win\d+$/.test(env.ImageOS ?? ''), 'WINDOWS_IMAGE_REQUIRED');
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
