/** Fresh GitHub-hosted Windows VM only. See docs/windows-runtime-acceptance.md. */
/* global window */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import {
  assertHostedRunner,
  runnerGuardCode,
  selectInstaller,
  installedPaths,
  nsisInvocation,
  spawnObserved,
  cleanupUnobservedLaunches,
  recordCleanup,
  sameProcess,
  collectOwned,
  makeReport,
  finishReport,
} from './windows-runtime-helpers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env = process.env;
const reportDirectory = join(
  ROOT,
  '.cache',
  process.argv.includes('--record-build-start')
    ? 'windows-runtime-build'
    : env.RW_WINDOWS_FRESH_RUNNER === 'yes'
      ? 'windows-runtime'
      : 'windows-runtime-refused',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
const names = [
  'hosted-preflight',
  'same-build-installer',
  'install-and-resources',
  'installed-ipc-mock',
  'authentication-and-offline-response',
  'home-and-ai-screenshots',
  'fake-key-save-status',
  'normal-close-no-orphan',
  'credential-restart-persistence',
  'endpoint-binding-rejection',
  'active-key-delete-replaces-sidecar',
  'force-exit-no-orphan',
  'restart-no-resurrection',
  'owned-cleanup',
];
const report = makeReport(names);
report.stage = process.argv.includes('--record-build-start') ? 'build-marker' : 'runtime';
const deadline = Date.now() + 8 * 60_000;
let cleaning = false;
let cleanupDeadline;
let browser;
let page;
let app;
let paths;
let runtime;
let owned = [];
const roots = [];
const launches = [];
let credential;
let currentStep;

class Blocked extends Error {}
function demand(condition, code) {
  if (!condition) throw new Error(code);
}
function remaining(maximum = 30_000) {
  const left = (cleaning ? cleanupDeadline : deadline) - Date.now();
  demand(left > 0, 'GLOBAL_TIMEOUT');
  return Math.max(1, Math.min(left, maximum));
}
async function bounded(work, milliseconds = 30_000) {
  const limit = remaining(milliseconds);
  let timer;
  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('OPERATION_TIMEOUT')), limit);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function command(executable, args, input, milliseconds = 20_000) {
  return bounded(
    () =>
      new Promise((resolveCommand, reject) => {
        const child = execFile(
          executable,
          args,
          {
            cwd: ROOT,
            windowsHide: true,
            encoding: 'utf8',
            timeout: remaining(milliseconds),
            maxBuffer: 2 * 1024 * 1024,
          },
          (error, stdout) => {
            if (error) reject(new Error('SUBPROCESS_FAILED'));
            else resolveCommand(stdout.trim());
          },
        );
        child.stdin?.on('error', () => {});
        child.stdin?.end(input);
      }),
    milliseconds + 1000,
  );
}
async function native(action, data = {}) {
  const executable = join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
  demand(existsSync(executable), 'RUNNER_POWERSHELL_REQUIRED');
  return JSON.parse(
    await command(
      executable,
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        join(ROOT, 'scripts/verify/windows-runtime-native.ps1'),
      ],
      JSON.stringify({ action, ...data }),
    ),
  );
}
async function sourceIdentity() {
  const git = async (...args) => command('git', args);
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const tauri = JSON.parse(await readFile(join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8'));
  demand(pkg.version === tauri.version, 'SOURCE_VERSION_MISMATCH');
  return {
    commit: await git('rev-parse', 'HEAD'),
    tree: await git('rev-parse', 'HEAD^{tree}'),
    version: pkg.version,
    clean: (await git('status', '--porcelain', '--untracked-files=normal')) === '',
  };
}
async function hash(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}
async function regularFile(file) {
  const info = await stat(file);
  demand(
    info.isFile() &&
      info.size > 0 &&
      (await realpath(file)).toLowerCase() === resolve(file).toLowerCase(),
    'REGULAR_REAL_FILE_REQUIRED',
  );
  return info;
}
async function snapshot() {
  const rows = await native('snapshot');
  demand(Array.isArray(rows), 'PROCESS_SNAPSHOT_INVALID');
  owned = collectOwned(rows, owned);
  return rows;
}
async function trackRoot(child, expectedPath) {
  demand(Number.isInteger(child.pid), 'PROCESS_START_FAILED');
  const rows = await snapshot();
  const root = rows.find(
    (entry) => entry.pid === child.pid && entry.path.toLowerCase() === expectedPath.toLowerCase(),
  );
  demand(root && Date.parse(root.startedAt) >= reportStart - 2000, 'PROCESS_OWNERSHIP_UNPROVEN');
  owned.push(root);
  roots.push(root);
  owned = collectOwned(rows, owned);
  return root;
}
async function until(predicate, code, milliseconds = 30_000) {
  const end = Date.now() + remaining(milliseconds);
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await sleep(Math.min(300, remaining()));
  }
  throw new Error(code);
}
async function step(name, work) {
  currentStep = name;
  const item = report.checks.find((entry) => entry.name === name);
  try {
    await work();
    item.status = 'PASS';
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    item.status = error instanceof Blocked ? 'NOT RUN' : 'FAIL';
    throw error;
  }
}

// Tauri responses may carry bearer tokens. Only named projections can cross this boundary.
async function ipc(commandName, args = {}, projection = 'none') {
  return bounded(() =>
    page.evaluate(
      async ({ commandName, args, projection }) => {
        try {
          const value = await window.__TAURI_INTERNALS__.invoke(commandName, args);
          if (projection === 'service')
            return {
              ok: true,
              state: value.state,
              mode: value.mode,
              provider: value.provider,
              credentialConfigured: value.credentialConfigured,
              instanceId: value.instanceId,
              hasToken: typeof value.token === 'string' && value.token.length >= 32,
            };
          if (projection === 'settings')
            return {
              ok: true,
              provider: value.provider,
              baseUrl: value.baseUrl,
              model: value.model,
            };
          if (projection === 'credential')
            return {
              ok: true,
              configured: value.configured,
              hasError: value.error !== null && value.error !== undefined,
            };
          if (projection === 'deletion')
            return { ok: true, keyRemoved: value.keyRemoved, residueCount: value.residues.length };
          return { ok: true };
        } catch {
          return { ok: false };
        }
      },
      { commandName, args, projection },
    ),
  );
}
async function ready(mode = 'mock') {
  runtime = await until(
    async () => {
      const value = await ipc('ai_service_info', {}, 'service');
      demand(value.ok && value.state !== 'failed', 'IPC_SERVICE_FAILED');
      return value.state === 'ready' && value.mode === mode && value.hasToken ? value : null;
    },
    'IPC_READINESS_TIMEOUT',
    45_000,
  );
  return runtime;
}
async function currentSidecar() {
  const rows = await snapshot();
  const matches = rows.filter(
    (entry) =>
      entry.parentPid === app.pid &&
      entry.path.toLowerCase() === paths.sidecar.toLowerCase() &&
      owned.some((tracked) => sameProcess(tracked, entry)),
  );
  demand(matches.length === 1, 'EXACTLY_ONE_INSTALLED_SIDECAR_REQUIRED');
  report.sidecars ??= [];
  const [sidecar] = matches;
  if (
    !report.sidecars.some(
      (entry) => entry.pid === sidecar.pid && entry.startedAt === sidecar.startedAt,
    )
  ) {
    report.sidecars.push({
      pid: sidecar.pid,
      startedAt: sidecar.startedAt,
      installedRelativePath: 'sidecar/rw-node.exe',
    });
  }
  return sidecar;
}
async function gone(identities, code) {
  await until(
    async () => {
      const rows = await snapshot();
      return identities.every((identity) => !rows.some((row) => sameProcess(identity, row)));
    },
    code,
    15_000,
  );
}
async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function launch() {
  const port = await freePort();
  const systemRoot = env.SystemRoot;
  demand(systemRoot && existsSync(systemRoot), 'WINDOWS_ROOT_REQUIRED');
  // No inherited keys, proxies, NODE_OPTIONS, RW_AI_TEST_UPSTREAM or development-tool PATH.
  const launchEnv = Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA']
      .filter((key) => env[key])
      .map((key) => [key, env[key]]),
  );
  launchEnv.PATH = [
    join(systemRoot, 'System32'),
    systemRoot,
    join(systemRoot, 'System32', 'Wbem'),
  ].join(';');
  launchEnv.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`;
  const launched = await spawnObserved({
    spawnProcess: spawn,
    launches,
    role: 'app',
    executable: paths.exe,
    args: [],
    options: { cwd: dirname(paths.exe), env: launchEnv, stdio: 'ignore' },
    observe: trackRoot,
  });
  app = launched.root;
  // Official WebView2 CDP approach; use the real app-configured profile, never APPDATA spoofing.
  const end = Date.now() + remaining(45_000);
  while (Date.now() < end) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: remaining(2500),
      });
      page = browser.contexts()[0]?.pages()[0];
      if (page) break;
      await bounded(() => browser.close(), 3000);
      browser = undefined;
    } catch {
      /* Retry only attachment, never app launch. */
    }
    const live = await snapshot();
    demand(
      live.some((row) => sameProcess(app, row)),
      'INSTALLED_APP_EXITED_BEFORE_WINDOW',
    );
    await sleep(300);
  }
  if (!page) throw new Blocked('WEBVIEW2_CDP_OR_WINDOW_UNAVAILABLE');
  page.setDefaultTimeout(remaining(10_000));
  page.on('console', (message) => {
    if (message.type() === 'error') report.console.errors++;
    if (message.type() === 'warning') report.console.warnings++;
  });
  page.on('pageerror', () => {
    report.console.pageErrors++;
  });
  await bounded(() => page.locator('.app').waitFor({ timeout: remaining(20_000) }));
  await ready();
  await currentSidecar();
}
async function stopNormally() {
  const sidecar = await currentSidecar();
  // Exercise the actual application's close control, not browser.close() or a global kill.
  await page
    .getByRole('button', { name: '关闭窗口', exact: true })
    .click({ timeout: remaining(10_000), noWaitAfter: true })
    .catch(() => {});
  await gone([app, sidecar], 'NORMAL_CLOSE_LEFT_OWNED_ORPHAN');
  await bounded(() => browser?.close().catch(() => {}), 3000);
  browser = page = undefined;
}

const reportStart = Date.now();
try {
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(join(reportDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  try {
    assertHostedRunner(env, process.platform);
  } catch (error) {
    throw new Blocked(runnerGuardCode(error));
  }
  demand(resolve(env.GITHUB_WORKSPACE).toLowerCase() === ROOT.toLowerCase(), 'WORKSPACE_MISMATCH');
  const markerPath = join(env.RUNNER_TEMP, 'rw-windows-build-start.json');
  const bundleDirectory = join(ROOT, 'src-tauri/target/release/bundle/nsis');
  if (process.argv.includes('--record-build-start')) {
    const source = await sourceIdentity();
    demand(source.clean && source.commit === env.GITHUB_SHA, 'CLEAN_EXPECTED_SOURCE_REQUIRED');
    demand(!existsSync(markerPath), 'BUILD_MARKER_ALREADY_EXISTS');
    demand(
      !existsSync(bundleDirectory) ||
        (await readdir(bundleDirectory)).every((name) => !name.endsWith('.exe')),
      'OLD_INSTALLER_PRESENT',
    );
    await writeFile(
      markerPath,
      JSON.stringify({
        ...source,
        runId: env.GITHUB_RUN_ID,
        runAttempt: env.GITHUB_RUN_ATTEMPT,
        startedAtMs: Date.now(),
      }),
      { flag: 'wx' },
    );
    report.blocked = true;
    report.terminalError = 'BUILD_START_RECORDED_RUNTIME_NOT_RUN';
  } else {
    demand(process.argv.length === 2, 'UNKNOWN_ARGUMENT');
    await step('hosted-preflight', async () => {
      const preflight = await native('preflight');
      demand(
        preflight.existingDirectories === 0 &&
          preflight.existingCredentials === 0 &&
          preflight.existingRegistrations === 0,
        'PREEXISTING_APP_STATE_REFUSED',
      );
      if (!preflight.desktop || preflight.webviewVersions.length === 0)
        throw new Blocked('WEBVIEW2_OR_INTERACTIVE_DESKTOP_UNAVAILABLE');
      const processes = await snapshot();
      const driver = processes.find((entry) => entry.pid === process.pid);
      demand(
        driver && (await native('verify-process', { process: driver })).result === 'matched',
        'NATIVE_IDENTITY_JSON_ROUNDTRIP_FAILED',
      );
      demand(
        !processes.some((entry) =>
          /^(research-workspace|rw-node)\.exe$/i.test(basename(entry.path)),
        ),
        'PREEXISTING_APP_PROCESS_REFUSED',
      );
      report.host = {
        image: env.ImageOS,
        imageVersion: env.ImageVersion,
        webviewVersions: preflight.webviewVersions,
        runId: env.GITHUB_RUN_ID,
        runAttempt: env.GITHUB_RUN_ATTEMPT,
      };
    });
    let installer;
    let source;
    await step('same-build-installer', async () => {
      source = await sourceIdentity();
      const marker = JSON.parse(await readFile(markerPath, 'utf8'));
      const files = (await readdir(bundleDirectory)).filter((name) => name.endsWith('.exe'));
      const artifacts = await Promise.all(
        files.map(async (name) => {
          const file = join(bundleDirectory, name);
          const info = await regularFile(file);
          return { path: file, mtimeMs: info.mtimeMs, size: info.size };
        }),
      );
      installer = selectInstaller(artifacts, marker, source, env);
      report.build = {
        commit: source.commit,
        tree: source.tree,
        version: source.version,
        installer: basename(installer),
        installerSha256: await hash(installer),
        startedAt: new Date(marker.startedAtMs).toISOString(),
      };
    });
    await step('install-and-resources', async () => {
      const ownedDirectory = join(
        await realpath(env.RUNNER_TEMP),
        `rw-runtime-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${randomBytes(8).toString('hex')}`,
      );
      demand(!existsSync(ownedDirectory), 'INSTALL_DIRECTORY_EXISTS');
      await mkdir(ownedDirectory);
      const installDirectory = join(ownedDirectory, 'installed');
      // NSIS: /S is case-sensitive, /D is absolute, last and unquoted even with spaces.
      const invocation = nsisInvocation(installer, installDirectory);
      const launched = await spawnObserved({
        spawnProcess: spawn,
        launches,
        role: 'installer',
        executable: installer,
        args: invocation.args,
        options: {
          argv0: invocation.argv0,
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
          stdio: 'ignore',
        },
        observe: trackRoot,
      });
      const exitCode = await bounded(() => launched.completion, 120_000);
      demand(exitCode === 0, 'INSTALLER_EXIT_FAILED');
      const expected = [
        join(installDirectory, 'research-workspace.exe'),
        join(installDirectory, 'sidecar/rw-node.exe'),
        join(installDirectory, 'sidecar/server/desktop.mjs'),
      ];
      await Promise.all(expected.map(regularFile));
      paths = installedPaths(installDirectory, expected);
      const version = await native('version', { path: paths.exe });
      demand(
        version.version === source.version || version.version === `${source.version}.0`,
        'INSTALLED_VERSION_MISMATCH',
      );
      const built = [
        join(ROOT, 'src-tauri/target/release/research-workspace.exe'),
        join(ROOT, 'src-tauri/sidecar/rw-node.exe'),
        join(ROOT, 'src-tauri/sidecar/server/desktop.mjs'),
      ];
      for (let index = 0; index < expected.length; index++)
        demand(
          (await hash(expected[index])) === (await hash(built[index])),
          'INSTALLED_RESOURCE_HASH_MISMATCH',
        );
      report.install = {
        exitCode,
        version: version.version,
        exeSha256: await hash(paths.exe),
        sidecarSha256: await hash(paths.sidecar),
        launcherSha256: await hash(paths.launcher),
        resourceHashesMatchBuild: true,
        strippedDevelopmentPath: true,
      };
    });
    await step('installed-ipc-mock', async () => {
      await launch();
      demand(runtime.provider === 'mock' && !runtime.credentialConfigured, 'INITIAL_MOCK_REQUIRED');
    });
    await step('authentication-and-offline-response', async () => {
      const result = await bounded(() =>
        page.evaluate(async () => {
          const info = await window.__TAURI_INTERNALS__.invoke('ai_service_info');
          const headers = { Authorization: `Bearer ${info.token}` };
          const health = await fetch(`${info.baseUrl}/api/ai/health`, {
            headers,
            signal: AbortSignal.timeout(8000),
          });
          const body = await health.json();
          const unauthenticated = await fetch(`${info.baseUrl}/api/ai/health`, {
            signal: AbortSignal.timeout(8000),
          });
          const answer = await fetch(`${info.baseUrl}/api/ai/ask`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(8000),
            body: JSON.stringify({
              mode: 'ask',
              question: 'What does this synthetic passage say?',
              paper: {
                id: 'windows-ci-synthetic',
                title: 'Synthetic acceptance fixture',
                page: 1,
                pdfSha256: 'a'.repeat(64),
              },
              passages: [
                {
                  id: 'selection',
                  page: 1,
                  text: 'This synthetic model is invariant to the ordering of the input tokens.',
                  selection: true,
                },
              ],
            }),
          });
          const reply = await answer.json();
          return {
            healthStatus: health.status,
            offline: body.provider === 'mock' && body.online === false,
            unauthenticatedStatus: unauthenticated.status,
            answerStatus: answer.status,
            answered: typeof reply.answer === 'string' && reply.answer.length > 0,
          };
        }),
      );
      demand(
        result.healthStatus === 200 &&
          result.offline &&
          [401, 403].includes(result.unauthenticatedStatus) &&
          result.answerStatus === 200 &&
          result.answered,
        'AUTHENTICATED_OFFLINE_ROUNDTRIP_FAILED',
      );
      report.offline = result;
    });
    await step('home-and-ai-screenshots', async () => {
      await page.screenshot({
        path: join(reportDirectory, '01-home.png'),
        timeout: remaining(10_000),
      });
      report.screenshots.push('01-home.png');
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '设置', exact: true });
      await dialog.getByRole('button', { name: 'AI 服务', exact: true }).click();
      demand(
        (await dialog.getByRole('button', { name: /离线模拟/ }).getAttribute('aria-pressed')) ===
          'true',
        'CURRENT_AI_SETTINGS_NOT_MOCK',
      );
      await page.screenshot({
        path: join(reportDirectory, '02-ai-settings-mock.png'),
        timeout: remaining(10_000),
      });
      report.screenshots.push('02-ai-settings-mock.png');
      await page.keyboard.press('Escape');
    });
    const baseUrl = 'https://windows-smoke.invalid/v1';
    await step('fake-key-save-status', async () => {
      const settings = await ipc('get_ai_settings', {}, 'settings');
      demand(
        settings.ok &&
          /^(deepseek|openai|moonshot|zhipu|dashscope|custom)$/.test(settings.provider),
        'CURRENT_PROVIDER_UNRECOGNIZED',
      );
      const key = `rw-ci-fake-${randomBytes(32).toString('hex')}`;
      // Hash proves this exact fake atomic record belongs to the test, even after an IPC timeout.
      credential = {
        target: `ResearchWorkspace/Provider/${settings.provider}`,
        provider: settings.provider,
        expectedHash: createHash('sha256')
          .update(`\x1eRWK2\x1f${new URL(baseUrl).origin}\x1f${key}`)
          .digest('hex'),
      };
      demand(
        (await ipc('set_ai_api_key', { provider: settings.provider, key, baseUrl })).ok,
        'SYNTHETIC_KEY_SAVE_FAILED',
      );
      const proof = await native('credential', { ...credential, delete: false });
      demand(proof.result === 'owned' && proof.remaining === 1, 'SYNTHETIC_KEY_OWNERSHIP_FAILED');
      const status = await ipc(
        'ai_credentials_status',
        { provider: credential.provider },
        'credential',
      );
      demand(status.ok && status.configured && !status.hasError, 'SYNTHETIC_KEY_STATUS_FAILED');
      demand(
        (
          await ipc('update_ai_settings', {
            patch: { provider: credential.provider, baseUrl, model: 'synthetic-ci-model' },
          })
        ).ok,
        'SYNTHETIC_SETTINGS_FAILED',
      );
      await ready();
      await currentSidecar();
    });
    await step('normal-close-no-orphan', stopNormally);
    await step('credential-restart-persistence', async () => {
      await launch();
      const status = await ipc(
        'ai_credentials_status',
        { provider: credential.provider },
        'credential',
      );
      const settings = await ipc('get_ai_settings', {}, 'settings');
      demand(
        status.configured &&
          settings.baseUrl === baseUrl &&
          settings.provider === credential.provider &&
          runtime.mode === 'mock',
        'CREDENTIAL_OR_PREFERENCES_NOT_PERSISTED',
      );
      demand((await ipc('set_ai_mode', { mode: 'online' })).ok, 'SYNTHETIC_ONLINE_START_FAILED');
      await ready('online');
      await currentSidecar();
      // Starting online does not issue a model request. No real or fake paid call is made.
    });
    await step('endpoint-binding-rejection', async () => {
      const before = runtime.instanceId;
      const rejected = await ipc('update_ai_settings', {
        patch: { baseUrl: 'https://different-windows-smoke.invalid/v1' },
      });
      demand(!rejected.ok, 'BOUND_KEY_ENDPOINT_CHANGE_ACCEPTED');
      const settings = await ipc('get_ai_settings', {}, 'settings');
      await ready('online');
      demand(
        settings.baseUrl === baseUrl && runtime.instanceId === before,
        'REJECTED_CHANGE_MUTATED_ACTIVE_SERVICE',
      );
    });
    await step('active-key-delete-replaces-sidecar', async () => {
      const previous = await currentSidecar();
      const previousInstance = runtime.instanceId;
      const proof = await native('credential', { ...credential, delete: false });
      demand(
        proof.result === 'owned' && proof.remaining === 1,
        'CREDENTIAL_DELETE_OWNERSHIP_UNPROVEN',
      );
      const deletion = await ipc(
        'delete_ai_api_key',
        { provider: credential.provider },
        'deletion',
      );
      demand(
        deletion.ok && deletion.keyRemoved && deletion.residueCount === 0,
        'ACTIVE_KEY_DELETE_FAILED',
      );
      await ready();
      const replacement = await currentSidecar();
      demand(
        runtime.instanceId !== previousInstance &&
          !sameProcess(previous, replacement) &&
          !runtime.credentialConfigured,
        'DELETION_DID_NOT_REPLACE_WITH_MOCK',
      );
      await gone([previous], 'DELETED_KEY_SIDECAR_STILL_RUNNING');
      demand(
        (await native('credential', { ...credential, delete: false })).remaining === 0,
        'CREDENTIAL_RESIDUE_AFTER_DELETE',
      );
    });
    await step('force-exit-no-orphan', async () => {
      const sidecar = await currentSidecar();
      demand(
        (await native('stop', { process: app })).result === 'stopped',
        'OWNED_FORCE_EXIT_FAILED',
      );
      // Do not kill the sidecar here: its natural exit is the condition under test.
      await gone([app, sidecar], 'FORCED_EXIT_LEFT_OWNED_ORPHAN');
      await bounded(() => browser?.close().catch(() => {}), 3000);
      browser = page = undefined;
    });
    await step('restart-no-resurrection', async () => {
      await launch();
      const status = await ipc(
        'ai_credentials_status',
        { provider: credential.provider },
        'credential',
      );
      demand(
        status.ok && !status.configured && !runtime.credentialConfigured && runtime.mode === 'mock',
        'DELETED_CREDENTIAL_RESURRECTED',
      );
      demand(!(await ipc('set_ai_mode', { mode: 'online' })).ok, 'ONLINE_ACCEPTED_WITHOUT_KEY');
      await ready();
      await stopNormally();
      demand(report.console.pageErrors === 0, 'UNCAUGHT_WEBVIEW_ERROR');
    });
  }
} catch (error) {
  report.blocked = error instanceof Blocked;
  // Only our short error codes leave the driver, never Playwright call logs or raw IPC errors.
  report.terminalError = /^[A-Z][A-Z0-9_]{1,100}$/.test(error.message ?? '')
    ? error.message
    : 'ACCEPTANCE_OPERATION_FAILED';
  report.terminalStep = currentStep ?? 'preflight';
} finally {
  cleaning = true;
  const cleanupFailures = [];
  // Capture uncertainty before cleanup does anything fallible; it must never disappear on error.
  let unverifiedLaunches = launches
    .filter((entry) => !entry.observed)
    .map((entry) => ({
      role: entry.role,
      rootStop: 'not-attempted',
      descendants: 'unverified',
    }));
  // Each phase is attempted even if another fails. Reserve time for exact-hash credential cleanup.
  const cleanupPhase = async (name, milliseconds, work) => {
    cleanupDeadline = Date.now() + milliseconds;
    try {
      await work();
    } catch {
      cleanupFailures.push(name);
    }
  };
  await cleanupPhase('processes', 20_000, async () => {
    unverifiedLaunches = await cleanupUnobservedLaunches(launches, process.platform, (completion) =>
      bounded(() => completion, 2000),
    );
    if (owned.length === 0) return;
    const live = await snapshot();
    // Stop app/installer roots first, so pending IPC cannot recreate a credential during cleanup.
    const order = [
      ...roots,
      ...owned.filter((entry) => !roots.some((root) => sameProcess(root, entry))).reverse(),
    ];
    for (const identity of order) {
      if (live.some((row) => sameProcess(identity, row))) {
        try {
          const stopped = await native('stop', { process: identity });
          demand(['stopped', 'absent'].includes(stopped.result), 'OWNED_CLEANUP_IDENTITY_CHANGED');
        } catch {
          cleanupFailures.push('process-stop');
        }
      }
    }
    await gone(owned, 'OWNED_CLEANUP_ORPHAN');
  });
  await cleanupPhase('credential', 15_000, async () => {
    if (!credential) return;
    const removed = await native('credential', { ...credential, delete: true });
    demand(
      ['deleted', 'absent'].includes(removed.result) && removed.remaining === 0,
      'SYNTHETIC_CREDENTIAL_CLEANUP_REFUSED',
    );
  });
  await cleanupPhase('disconnect', 5_000, async () => {
    await bounded(() => browser?.close().catch(() => {}), 3000);
  });
  recordCleanup(report, cleanupFailures, unverifiedLaunches);
  // Synthetic installation/profile is left for VM disposal, never recursively removed.
  const final = finishReport(report, runtime);
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(join(reportDirectory, 'report.json'), `${JSON.stringify(final, null, 2)}\n`);
  process.stdout.write(`${final.status}: ${reportDirectory}\n`);
  if (final.terminalError)
    process.stdout.write(`TERMINAL ${final.terminalStep ?? final.stage}: ${final.terminalError}\n`);
  const exitCode =
    report.terminalError === 'BUILD_START_RECORDED_RUNTIME_NOT_RUN'
      ? 0
      : final.status === 'PASS'
        ? 0
        : final.status === 'NOT RUN'
          ? 2
          : 1;
  // Report is written before exit. Failed cleanup must not leave Node waiting on child/CDP handles.
  process.exit(exitCode);
}
