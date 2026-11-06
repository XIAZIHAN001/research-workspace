import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
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

const env = {
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  RUNNER_OS: 'Windows',
  RUNNER_TEMP: 'D:\\a\\_temp',
  GITHUB_WORKSPACE: 'D:\\a\\repo',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1',
  ImageOS: 'win25',
  ImageVersion: '20261101.1.0',
  RW_WINDOWS_FRESH_RUNNER: 'yes',
};

test('accepts only an explicitly opted-in GitHub-hosted Windows runner', () => {
  assert.doesNotThrow(() => assertHostedRunner(env, 'win32'));
  for (const [name, value] of [
    ['RUNNER_ENVIRONMENT', 'self-hosted'],
    ['GITHUB_ACTIONS', 'false'],
    ['RW_WINDOWS_FRESH_RUNNER', ''],
    ['ImageOS', 'ubuntu24'],
    ['RUNNER_TEMP', ''],
  ]) {
    assert.throws(() => assertHostedRunner({ ...env, [name]: value }, 'win32'));
  }
  assert.throws(() => assertHostedRunner(env, 'linux'));
});

const artifact = {
  path: 'D:\\a\\repo\\src-tauri\\target\\release\\bundle\\nsis\\Research Workspace_0.13.2_x64-setup.exe',
  mtimeMs: 2000,
  size: 100,
};
const build = {
  commit: env.GITHUB_SHA,
  tree: 'b'.repeat(40),
  version: '0.13.2',
  startedAtMs: 1000,
  runId: '123',
  runAttempt: '1',
};
const source = { commit: env.GITHUB_SHA, tree: build.tree, version: build.version, clean: true };
test('selects exactly one fresh same-job NSIS artifact from matching clean source', () => {
  assert.equal(selectInstaller([artifact], build, source, env, 3000), artifact.path);
  for (const artifacts of [
    [],
    [artifact, artifact],
    [{ ...artifact, mtimeMs: 999 }],
    [{ ...artifact, size: 0 }],
    [{ ...artifact, path: artifact.path.replace('0.13.2', '0.11.0') }],
  ]) {
    assert.throws(() => selectInstaller(artifacts, build, source, env, 3000));
  }
  for (const marker of [
    { ...build, commit: 'c'.repeat(40) },
    { ...build, tree: 'c'.repeat(40) },
    { ...build, runId: '999' },
    { ...build, startedAtMs: 4000 },
  ]) {
    assert.throws(() => selectInstaller([artifact], marker, source, env, 3000));
  }
  assert.throws(() => selectInstaller([artifact], build, { ...source, clean: false }, env, 3000));
});

test('installed paths never accept absent executable or an outside fallback', () => {
  const root = 'D:\\a\\_temp\\rw-ci\\installed';
  const expected = [
    root + '\\research-workspace.exe',
    root + '\\sidecar\\rw-node.exe',
    root + '\\sidecar\\server\\desktop.mjs',
  ];
  assert.deepEqual(installedPaths(root, expected), {
    exe: expected[0],
    sidecar: expected[1],
    launcher: expected[2],
  });
  assert.throws(() => installedPaths(root, []));
  assert.throws(() => installedPaths(root, [undefined, null]));
  assert.throws(() =>
    installedPaths(root, [expected[0].replace('installed', 'build'), ...expected.slice(1)]),
  );
});

const root = {
  pid: 10,
  parentPid: 1,
  path: 'D:\\installed\\research-workspace.exe',
  startedAt: '2026-11-06T01:00:00.000Z',
};
const child = {
  pid: 11,
  parentPid: 10,
  path: 'D:\\installed\\sidecar\\rw-node.exe',
  startedAt: '2026-11-06T01:00:01.000Z',
};
test('process identity requires PID, canonical path and exact start time', () => {
  assert.equal(sameProcess(root, { ...root, path: root.path.toUpperCase() }), true);
  for (const changed of [{ pid: 99 }, { path: '' }, { startedAt: '2026-11-06T02:00:00.000Z' }]) {
    assert.equal(sameProcess(root, { ...root, ...changed }), false);
  }
  assert.equal(sameProcess(undefined, root), false);
});

test('only live verified parents admit descendants, never PID reuse or old siblings', () => {
  assert.deepEqual(collectOwned([root, child], [root]), [root, child]);
  assert.deepEqual(
    collectOwned([{ ...root, startedAt: '2026-11-06T02:00:00.000Z' }, child], [root]),
    [root],
  );
  assert.deepEqual(collectOwned([child], [root]), [root]);
  assert.deepEqual(collectOwned([root, { ...child, startedAt: '2025-01-01T00:00:00Z' }], [root]), [
    root,
  ]);
});

test('reports whitelist runtime metadata and never copy token, errors or raw console text', () => {
  const report = makeReport(['install', 'mock']);
  report.checks[0] = { name: 'install', status: 'PASS' };
  const result = finishReport(report, {
    state: 'ready',
    mode: 'mock',
    provider: 'mock',
    model: 'synthetic',
    token: 'bearer-secret',
    error: 'key-secret',
    baseUrl: 'http://127.0.0.1:123',
    credentialConfigured: false,
  });
  assert.equal(result.status, 'NOT RUN');
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal(result.runtime.mode, 'mock');
  report.checks[1].status = 'FAIL';
  assert.equal(finishReport(report).status, 'FAIL');
  report.checks[1].status = 'PASS';
  assert.equal(finishReport(report).status, 'PASS');
  report.terminalError = 'TIMEOUT';
  assert.equal(finishReport(report).status, 'FAIL');
});

test('malformed snapshots never become process ownership', () => {
  for (const changed of [{ pid: '11' }, { pid: -1 }, { startedAt: 'invalid' }, { path: null }]) {
    assert.deepEqual(collectOwned([root, { ...child, ...changed }], [root]), [root]);
  }
});

test('nested descendants require a live ownership chain and preserve already tracked orphans', () => {
  const grandchild = { ...child, pid: 12, parentPid: 11, startedAt: '2026-11-06T01:00:02.000Z' };
  assert.deepEqual(collectOwned([root, child, grandchild], [root]), [root, child, grandchild]);
  assert.deepEqual(collectOwned([child], [root, child]), [root, child]);
  assert.deepEqual(collectOwned([{ ...root, path: 'D:\\stranger.exe' }, child], [root]), [root]);
});

test('report treats blocked capability and any failed cleanup as non-pass', () => {
  const report = makeReport(['preflight', 'cleanup']);
  report.blocked = true;
  report.terminalError = 'WEBVIEW2_MISSING';
  assert.equal(finishReport(report).status, 'NOT RUN');
  report.checks[1].status = 'FAIL';
  assert.equal(finishReport(report).status, 'FAIL');
});

test('actual driver denies missing opt-in before installation and writes a NOT RUN report', () => {
  const result = spawnSync(process.execPath, ['scripts/verify/windows-runtime.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
      DEBUG: '',
      PWDEBUG: '',
      NODE_DEBUG: '',
      NODE_OPTIONS: '',
      RW_WINDOWS_FRESH_RUNNER: '',
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 2, result.stderr);
  const match = /NOT RUN: (.+)\r?\n/.exec(result.stdout);
  assert.ok(match);
  const report = JSON.parse(readFileSync(join(match[1].trim(), 'report.json'), 'utf8'));
  assert.equal(report.status, 'NOT RUN');
  const code = process.platform === 'win32' ? 'WORKFLOW_OPT_IN_REQUIRED' : 'WINDOWS_REQUIRED';
  assert.equal(report.terminalError, code);
  assert.ok(result.stdout.includes(`TERMINAL preflight: ${code}`));
  assert.equal(report.stage, 'runtime');
  assert.ok(
    report.checks
      .filter((check) => check.name !== 'owned-cleanup')
      .every((check) => check.status === 'NOT RUN'),
  );
  assert.ok(report.excluded.every((check) => check.status === 'NOT RUN'));
  assert.equal(report.runtime, null);
});

test('NSIS keeps /D last and unquoted while quoting only the installer argv0', () => {
  const installer = 'D:\\a\\Research Workspace_0.13.2_x64-setup.exe';
  const directory = 'D:\\runner temp\\owned install';
  assert.deepEqual(nsisInvocation(installer, directory), {
    args: ['/S', `/D=${directory}`],
    argv0: `"${installer}"`,
    windowsVerbatimArguments: true,
  });
  assert.throws(() => nsisInvocation(installer, 'relative'));
  assert.throws(() => nsisInvocation(installer, 'D:\\bad"path'));
});

test('rejects driver debug channels before handling any ephemeral credentials', () => {
  for (const name of ['DEBUG', 'PWDEBUG', 'NODE_DEBUG', 'NODE_OPTIONS']) {
    assert.throws(() => assertHostedRunner({ ...env, [name]: '*' }, 'win32'));
  }
});

function fakeSpawnedChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    child.exitCode = 1;
    child.signalCode = signal;
    child.emit('exit', 1, signal);
    return true;
  };
  return child;
}

for (const role of ['app', 'installer']) {
  for (const failure of ['SUBPROCESS_FAILED', 'OPERATION_TIMEOUT', 'PROCESS_OWNERSHIP_UNPROVEN']) {
    test(`${role} launch is retained before first observation rejects with ${failure}`, async () => {
      const launches = [];
      const child = fakeSpawnedChild();
      await assert.rejects(
        spawnObserved({
          spawnProcess: () => child,
          launches,
          role,
          executable: 'D:\\owned.exe',
          args: [],
          options: {},
          observe: async () => {
            throw new Error(failure);
          },
        }),
        { message: failure },
      );
      assert.equal(launches.length, 1);
      assert.equal(launches[0].child, child);
      assert.equal(launches[0].observed, false);
    });
  }
}

for (const role of ['app', 'installer']) {
  test(`${role} snapshot failure cannot claim cleanup PASS after terminating only the root`, async () => {
    const launches = [];
    const child = fakeSpawnedChild();
    await assert.rejects(
      spawnObserved({
        spawnProcess: () => child,
        launches,
        role,
        executable: 'D:\\owned.exe',
        args: [],
        options: {},
        observe: async () => {
          throw new Error('SUBPROCESS_FAILED');
        },
      }),
    );
    const uncertain = await cleanupUnobservedLaunches(
      launches,
      'win32',
      async (completion) => completion,
    );
    const report = recordCleanup(makeReport(['owned-cleanup']), [], uncertain);
    assert.equal(report.checks[0].status, 'FAIL');
    assert.equal(report.cleanupIncomplete, true);
    assert.ok(report.cleanupFailures.includes(`unverified-${role}-descendants`));
    assert.deepEqual(child.killCalls, ['SIGKILL']);
    assert.deepEqual(report.unverifiedLaunches, [
      { role, rootStop: 'confirmed', descendants: 'unverified' },
    ]);
    assert.equal(finishReport(report).status, 'FAIL');
  });
}

test('an unobserved already-exited root keeps descendant cleanup incomplete without any PID kill', async () => {
  const child = fakeSpawnedChild();
  child.exitCode = 0;
  const uncertain = await cleanupUnobservedLaunches(
    [{ role: 'installer', observed: false, child }],
    'win32',
    async () => {},
  );
  const report = recordCleanup(makeReport(['owned-cleanup']), [], uncertain);
  assert.equal(report.cleanupIncomplete, true);
  assert.deepEqual(child.killCalls, []);
  assert.equal(report.unverifiedLaunches[0].rootStop, 'already-exited');
});

test('unverified root cleanup never uses child killing on non-Windows platforms', async () => {
  const child = fakeSpawnedChild();
  const uncertain = await cleanupUnobservedLaunches(
    [{ role: 'app', observed: false, child }],
    'linux',
    async () => {},
  );
  assert.deepEqual(child.killCalls, []);
  assert.equal(recordCleanup(makeReport(['owned-cleanup']), [], uncertain).cleanupIncomplete, true);
});

test('a refused root stop is recorded and cannot short-circuit another pending launch', async () => {
  const first = fakeSpawnedChild();
  first.kill = () => {
    throw new Error('stop refused');
  };
  const second = fakeSpawnedChild();
  const uncertain = await cleanupUnobservedLaunches(
    [
      { role: 'app', observed: false, child: first },
      { role: 'installer', observed: false, child: second, completion: Promise.resolve(1) },
    ],
    'win32',
    async (completion) => completion,
  );
  assert.equal(uncertain.length, 2);
  assert.equal(uncertain[0].rootStop, 'unconfirmed');
  assert.deepEqual(second.killCalls, ['SIGKILL']);
});

test('accepts only the documented win25-vs2026 suffix without weakening host guards', () => {
  assert.doesNotThrow(() => assertHostedRunner({ ...env, ImageOS: 'win25-vs2026' }, 'win32'));
  for (const ImageOS of [
    'win25-vs2027',
    'win25-custom',
    'win25-vs2026-extra',
    'win25-vs2026\n',
    'windows-2025-vs2026',
  ]) {
    assert.throws(() => assertHostedRunner({ ...env, ImageOS }, 'win32'), {
      message: 'WINDOWS_IMAGE_REQUIRED',
    });
  }
  assert.throws(() =>
    assertHostedRunner(
      { ...env, ImageOS: 'win25-vs2026', RUNNER_ENVIRONMENT: 'self-hosted' },
      'win32',
    ),
  );
  assert.throws(() =>
    assertHostedRunner({ ...env, ImageOS: 'win25-vs2026', RW_WINDOWS_FRESH_RUNNER: '' }, 'win32'),
  );
});

test('preserves each classified hosted guard refusal without exposing arbitrary error text', () => {
  const cases = [
    [{}, 'linux', 'WINDOWS_REQUIRED'],
    [{ DEBUG: 'secret-debug-value' }, 'win32', 'DRIVER_DEBUG_CHANNEL_REFUSED'],
    [{ RUNNER_ENVIRONMENT: 'self-hosted' }, 'win32', 'FRESH_HOSTED_RUNNER_REQUIRED'],
    [{ RW_WINDOWS_FRESH_RUNNER: '' }, 'win32', 'WORKFLOW_OPT_IN_REQUIRED'],
    [{ ImageVersion: '' }, 'win32', 'RUNNER_METADATA_REQUIRED'],
    [{ ImageOS: 'unknown' }, 'win32', 'WINDOWS_IMAGE_REQUIRED'],
    [{ GITHUB_SHA: 'invalid' }, 'win32', 'COMMIT_REQUIRED'],
    [{ RUNNER_TEMP: 'relative' }, 'win32', 'ABSOLUTE_RUNNER_PATH_REQUIRED'],
  ];
  for (const [patch, platform, code] of cases) {
    assert.throws(
      () => assertHostedRunner({ ...env, ...patch }, platform),
      (error) => runnerGuardCode(error) === code,
    );
  }
  for (const error of [
    new Error('SECRET_PAYLOAD'),
    new Error('Bearer secret'),
    undefined,
    'WINDOWS_IMAGE_REQUIRED',
  ]) {
    assert.equal(runnerGuardCode(error), 'FRESH_GITHUB_HOSTED_WINDOWS_REQUIRED');
  }
});

test('refused build-marker mode preserves a precise code in a separate NOT RUN report', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/verify/windows-runtime.mjs', '--record-build-start'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
        DEBUG: '',
        PWDEBUG: '',
        NODE_DEBUG: '',
        NODE_OPTIONS: '',
        RW_WINDOWS_FRESH_RUNNER: '',
      },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 2, result.stderr);
  const match = /NOT RUN: (.+)\r?\n/.exec(result.stdout);
  assert.ok(match);
  const directory = match[1].trim();
  assert.ok(directory.includes('windows-runtime-build'));
  const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
  const code = process.platform === 'win32' ? 'WORKFLOW_OPT_IN_REQUIRED' : 'WINDOWS_REQUIRED';
  assert.equal(report.stage, 'build-marker');
  assert.equal(report.status, 'NOT RUN');
  assert.equal(report.terminalError, code);
  assert.ok(result.stdout.includes(`TERMINAL preflight: ${code}`));
  assert.ok(
    report.checks
      .filter((entry) => entry.name !== 'owned-cleanup')
      .every((entry) => entry.status === 'NOT RUN'),
  );
});
