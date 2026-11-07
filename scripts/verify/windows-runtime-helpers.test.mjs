import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'vitest';
import * as runtimeHelpers from './windows-runtime-helpers.mjs';
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

const bundleMarker = '__TAURI_BUNDLE_TYPE_VAR_UNK';
const nsisMarker = '__TAURI_BUNDLE_TYPE_VAR_NSS';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function resourceFixture() {
  return [
    {
      role: 'exe',
      buildBytes: Buffer.from(`prefix:${bundleMarker}:suffix`),
      installedBytes: Buffer.from(`prefix:${nsisMarker}:suffix`),
    },
    ...['sidecar', 'launcher'].map((role) => ({
      role,
      buildBytes: Buffer.from(`synthetic-${role}`),
      installedBytes: Buffer.from(`synthetic-${role}`),
    })),
  ];
}
function verifyHashes(install, resources = resourceFixture(), version = '2.12.3') {
  assert.equal(typeof runtimeHelpers.verifyResourceHashes, 'function');
  return runtimeHelpers.verifyResourceHashes(install, resources, version);
}

test('hashes the complete expected NSIS payload without changing either input', () => {
  const resources = resourceFixture();
  const original = resources.map((entry) => [
    Buffer.from(entry.buildBytes),
    Buffer.from(entry.installedBytes),
  ]);
  const install = {};
  verifyHashes(install, resources);
  assert.equal(install.tauriCliVersion, '2.12.3');
  assert.equal(install.resourceHashesMatchExpected, true);
  for (const [index, row] of install.resourceHashes.entries()) {
    assert.equal(row.role, resources[index].role);
    assert.equal(row.buildSha256, sha256(original[index][0]));
    assert.equal(row.expectedSha256, sha256(original[index][1]));
    assert.equal(row.installedSha256, sha256(original[index][1]));
    assert.equal(row.buildSize, original[index][0].length);
    assert.equal(row.installedSize, original[index][1].length);
    assert.equal(row.matches, true);
    assert.equal(row.method, index === 0 ? 'tauri-2.12.3-nsis-first-marker' : 'verbatim');
    assert.deepEqual(resources[index].buildBytes, original[index][0]);
    assert.deepEqual(resources[index].installedBytes, original[index][1]);
  }
  assert.notEqual(install.resourceHashes[0].buildSha256, install.resourceHashes[0].expectedSha256);
});

test('requires the first-marker transformation, without accepting raw EXE equality', () => {
  const resources = resourceFixture();
  resources[0].installedBytes = Buffer.from(resources[0].buildBytes);
  const install = {};
  assert.throws(() => verifyHashes(install, resources), /INSTALLED_RESOURCE_HASH_MISMATCH/);
  assert.equal(install.resourceHashes[0].matches, false);
});

test('matches Tauri first-occurrence semantics rather than replacing every marker', () => {
  const resources = resourceFixture();
  resources[0].buildBytes = Buffer.from(`${bundleMarker}:${bundleMarker}`);
  resources[0].installedBytes = Buffer.from(`${nsisMarker}:${bundleMarker}`);
  verifyHashes({}, resources);
  for (const changed of [`${bundleMarker}:${nsisMarker}`, `${nsisMarker}:${nsisMarker}`]) {
    resources[0].installedBytes = Buffer.from(changed);
    assert.throws(() => verifyHashes({}, resources), /INSTALLED_RESOURCE_HASH_MISMATCH/);
  }
});

test('preserves pre-existing NSS constants before and after the first UNK marker', () => {
  const resources = resourceFixture();
  resources[0].buildBytes = Buffer.from(`${nsisMarker}:${bundleMarker}:${nsisMarker}`);
  resources[0].installedBytes = Buffer.from(`${nsisMarker}:${nsisMarker}:${nsisMarker}`);
  verifyHashes({}, resources);
  assert.equal(resources[0].buildBytes.toString(), `${nsisMarker}:${bundleMarker}:${nsisMarker}`);
});

test('requires all three correctly identified resource buffers before hash verification', () => {
  for (const resources of [
    [],
    resourceFixture().slice(0, 2),
    resourceFixture().reverse(),
    resourceFixture().map((entry) => ({ ...entry, buildBytes: 'not a byte buffer' })),
  ]) {
    assert.throws(() => verifyHashes({}, resources), /RESOURCE_HASH_INPUT_INVALID/);
  }
});

test('rejects every one-byte payload mutation and appended or removed bytes', () => {
  const resources = resourceFixture();
  const expected = Buffer.from(resources[0].installedBytes);
  for (let index = 0; index < expected.length; index++) {
    resources[0].installedBytes = Buffer.from(expected);
    resources[0].installedBytes[index] ^= 1;
    assert.throws(() => verifyHashes({}, resources), /INSTALLED_RESOURCE_HASH_MISMATCH/);
  }
  for (const changed of [Buffer.concat([expected, Buffer.from([0])]), expected.subarray(1)]) {
    resources[0].installedBytes = changed;
    assert.throws(() => verifyHashes({}, resources), /INSTALLED_RESOURCE_HASH_MISMATCH/);
  }
});

test('never applies the executable transformation to sidecar or launcher resources', () => {
  for (const index of [1, 2]) {
    const resources = resourceFixture();
    resources[index].buildBytes = Buffer.from(bundleMarker);
    resources[index].installedBytes = Buffer.from(nsisMarker);
    const install = {};
    assert.throws(() => verifyHashes(install, resources), /INSTALLED_RESOURCE_HASH_MISMATCH/);
    assert.equal(install.resourceHashes[index].method, 'verbatim');
    assert.equal(install.resourceHashes[index].expectedSha256, sha256(resources[index].buildBytes));
  }
});

test('missing or already-patched build markers fail closed with raw hash diagnostics', () => {
  for (const marker of ['', nsisMarker]) {
    const resources = resourceFixture();
    resources[0].buildBytes = Buffer.from(`prefix:${marker}:suffix`);
    const install = {};
    assert.throws(() => verifyHashes(install, resources), /TAURI_BUNDLE_MARKER_MISSING/);
    assert.equal(install.resourceHashes.length, 3);
    assert.equal(install.resourceHashes[0].buildSha256, sha256(resources[0].buildBytes));
    assert.equal(install.resourceHashes[0].installedSha256, sha256(resources[0].installedBytes));
    assert.equal(install.resourceHashes[0].expectedSha256, null);
    assert.equal(install.resourceHashesMatchExpected, false);
  }
});

test('unsupported actual CLI versions fail closed and never echo arbitrary package text', () => {
  for (const version of [
    '2.12.2',
    '2.12.4',
    undefined,
    '2.12.3-secret-payload',
    ['2.12.3'],
    { version: 'secret-payload' },
  ]) {
    const install = {};
    assert.throws(
      () => verifyHashes(install, resourceFixture(), version ?? null),
      /TAURI_CLI_HASH_MAPPING_UNSUPPORTED/,
    );
    assert.equal(install.resourceHashes.length, 3);
    assert.equal(install.resourceHashes[0].expectedSha256, null);
    assert.equal(install.resourceHashesMatchExpected, false);
    assert.ok(!JSON.stringify(install).includes('secret-payload'));
    assert.equal(
      install.tauriCliVersion,
      typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version : 'unknown',
    );
  }
});

test('failure reports retain all role hashes and installation evidence before throwing', () => {
  for (const index of [0, 1, 2]) {
    const resources = resourceFixture();
    resources[index].installedBytes = Buffer.from('different synthetic bytes');
    const report = makeReport(['install-and-resources', 'installed-ipc-mock']);
    report.install = { exitCode: 0, version: '0.13.2.0' };
    try {
      verifyHashes(report.install, resources);
      assert.fail('Changed resource must fail');
    } catch (error) {
      assert.equal(error.message, 'INSTALLED_RESOURCE_HASH_MISMATCH');
      report.terminalError = error.message;
      report.checks[0].status = 'FAIL';
    }
    const result = finishReport(report);
    assert.equal(result.status, 'FAIL');
    assert.equal(result.checks[1].status, 'NOT RUN');
    assert.equal(result.install.exitCode, 0);
    assert.equal(result.install.version, '0.13.2.0');
    assert.equal(result.install.resourceHashesMatchExpected, false);
    assert.equal(result.install.resourceHashes.length, 3);
    for (const [roleIndex, row] of result.install.resourceHashes.entries()) {
      assert.equal(row.installedSha256, sha256(resources[roleIndex].installedBytes));
      assert.match(row.buildSha256, /^[a-f0-9]{64}$/);
      assert.match(row.expectedSha256, /^[a-f0-9]{64}$/);
      assert.equal(row.matches, roleIndex !== index);
    }
    assert.ok(!JSON.stringify(result).includes('synthetic bytes'));
  }
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

// Exercise the attachment orchestrator without launching a Windows process.
function fakeWebView(pageDelay = 0) {
  const page = { synthetic: true };
  let pageReady = pageDelay === 0;
  let closed = false;
  const context = {
    pages: () => (pageReady ? [page] : []),
    waitForEvent: async (event) => {
      assert.equal(event, 'page');
      await new Promise((resolve) => setTimeout(resolve, pageDelay));
      pageReady = true;
      assert.equal(closed, false, 'The connection must survive until its page arrives');
      return page;
    },
  };
  return {
    page,
    browser: {
      contexts: () => [context],
      close: async () => {
        closed = true;
      },
    },
    isClosed: () => closed,
  };
}

test('CDP attachment keeps an established connection while waiting for its delayed page', async () => {
  assert.equal(typeof runtimeHelpers.connectWebView, 'function');
  const fixture = fakeWebView(25);
  const evidence = {};
  const result = await runtimeHelpers.connectWebView({
    evidence,
    budgetMs: 200,
    discover: async () => ({ result: 'ready', httpStatus: 200 }),
    connect: async () => fixture.browser,
    checkAlive: async () => true,
  });
  assert.equal(result.page, fixture.page);
  assert.equal(fixture.isClosed(), false);
  assert.equal(evidence.attempts[0].page, 'ready');
  assert.equal(evidence.attemptCount, 1);
});

test('CDP budget bounds a hanging attach and closes its eventual late connection', async () => {
  const evidence = {};
  const fixture = fakeWebView();
  const start = Date.now();
  const result = await runtimeHelpers.connectWebView({
    evidence,
    budgetMs: 35,
    discover: async () => ({ result: 'ready' }),
    connect: async () => {
      await new Promise((resolve) => setTimeout(resolve, 90));
      return fixture.browser;
    },
    checkAlive: async () => true,
  });
  assert.equal(result, null);
  assert.ok(Date.now() - start < 150);
  assert.equal(evidence.attempts[0].attach, 'timeout');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fixture.isClosed(), true);
});

test('CDP errors and discovery records retain classifications, never arbitrary text', async () => {
  assert.equal(
    runtimeHelpers.classifyCdpError({ code: 'ECONNREFUSED', message: 'secret' }),
    'refused',
  );
  assert.equal(
    runtimeHelpers.classifyCdpError({ name: 'TimeoutError', message: 'secret' }),
    'timeout',
  );
  assert.equal(
    runtimeHelpers.classifyCdpError(new Error('Protocol error secret')),
    'protocol-error',
  );
  assert.equal(
    runtimeHelpers.classifyCdpError(
      new Error('browserType.connectOverCDP: Protocol error (Browser.getVersion): secret'),
    ),
    'protocol-error',
  );
  assert.equal(runtimeHelpers.classifyCdpError(new Error('secret')), 'unavailable');
  const evidence = {};
  await runtimeHelpers.connectWebView({
    evidence,
    budgetMs: 30,
    discover: async () => ({ result: 'ready', httpStatus: 200, body: 'secret' }),
    connect: async () => {
      throw new Error('secret');
    },
    checkAlive: async () => true,
  });
  assert.equal(evidence.attempts[0].attach, 'unavailable');
  assert.ok(!JSON.stringify(evidence).includes('secret'));
});

test('CDP page wait consumes the same total budget and closes an empty connection', async () => {
  const evidence = {};
  const fixture = fakeWebView(100);
  // A disconnected page arrival is irrelevant and must never become an accepted page.
  fixture.browser.contexts = () => [{ pages: () => [], waitForEvent: () => new Promise(() => {}) }];
  const start = Date.now();
  const result = await runtimeHelpers.connectWebView({
    evidence,
    budgetMs: 40,
    discover: async () => ({ result: 'ready' }),
    connect: async () => fixture.browser,
    checkAlive: async () => true,
  });
  assert.equal(result, null);
  assert.ok(Date.now() - start < 150);
  assert.equal(evidence.attempts[0].page, 'timeout');
  assert.equal(fixture.isClosed(), true);
});

test('CDP never attaches after refused discovery and never hides a dead app', async () => {
  let connections = 0;
  const evidence = {};
  await assert.rejects(
    runtimeHelpers.connectWebView({
      evidence,
      budgetMs: 100,
      discover: async () => ({ result: 'refused' }),
      connect: async () => {
        connections++;
      },
      checkAlive: async () => false,
    }),
    /INSTALLED_APP_EXITED_BEFORE_WINDOW/,
  );
  assert.equal(connections, 0);
  assert.equal(evidence.attempts[0].discovery.result, 'refused');
});

const stoppedProcess = {
  result: 'stopped',
  phase: 'complete',
  win32Error: 0,
  identity: 'matched',
  exitState: 'signaled',
};
test('cleanup accepts only kernel absence or a verified signaled process handle', () => {
  assert.equal(runtimeHelpers.confirmedProcessExit(stoppedProcess), true);
  assert.equal(
    runtimeHelpers.confirmedProcessExit({
      ...stoppedProcess,
      result: 'exited',
      phase: 'terminate',
      win32Error: 5,
    }),
    true,
  );
  assert.equal(
    runtimeHelpers.confirmedProcessExit({
      result: 'absent',
      phase: 'open',
      win32Error: 87,
      identity: 'unavailable',
      exitState: 'absent',
    }),
    true,
  );
  for (const changed of [
    { result: 'failed', phase: 'terminate', win32Error: 5, exitState: 'nonsignaled' },
    { identity: 'mismatch' },
    { exitState: 'unavailable' },
    { result: 'matched', exitState: 'nonsignaled' },
    {
      result: 'absent',
      phase: 'open',
      win32Error: 5,
      identity: 'unavailable',
      exitState: 'absent',
    },
    { win32Error: 'unavailable' },
    { result: 'absent', phase: 'open', win32Error: 87, identity: 'mismatch', exitState: 'absent' },
  ])
    assert.equal(runtimeHelpers.confirmedProcessExit({ ...stoppedProcess, ...changed }), false);
});

test('loopback CDP discovery bounds and classifies real HTTP without retaining response data', async () => {
  let reply;
  let requests = 0;
  const server = createHttpServer((request, response) => {
    requests++;
    reply(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const cases = [
      {
        code: 200,
        body: JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/synthetic`,
          secret: 'secret-payload',
        }),
        expected: 'ready',
      },
      {
        code: 200,
        body: JSON.stringify({
          webSocketDebuggerUrl: 'ws://other.invalid/devtools/browser/secret-payload',
        }),
        expected: 'unsafe-endpoint',
      },
      { code: 200, body: '{secret-payload', expected: 'invalid-response' },
      { code: 200, body: '{"secret":"secret-payload"}', expected: 'missing-endpoint' },
      { code: 200, body: 'secret-payload'.repeat(6000), expected: 'oversize' },
      { code: 302, body: '', expected: 'http-status' },
    ];
    for (const fixture of cases) {
      const before = requests;
      reply = (_, response) => {
        response.writeHead(fixture.code, {
          Location: `http://127.0.0.1:${port}/should-not-follow`,
        });
        response.end(fixture.body);
      };
      const result = await runtimeHelpers.probeCdp(port, 1000);
      assert.equal(result.result, fixture.expected);
      assert.equal(result.httpStatus, fixture.code);
      assert.equal(requests, before + 1);
      assert.ok(!JSON.stringify(result).includes('secret-payload'));
    }
    reply = () => {};
    assert.deepEqual(await runtimeHelpers.probeCdp(port, 30), { result: 'timeout' });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal((await runtimeHelpers.probeCdp(port, 500)).result, 'refused');
});

test('native process and window projections remove unknown fields and invalid values', () => {
  const result = runtimeHelpers.projectProcessOutcome({
    ...stoppedProcess,
    path: 'secret',
    message: 'secret',
  });
  assert.deepEqual(result, stoppedProcess);
  assert.ok(
    !JSON.stringify(
      runtimeHelpers.projectProcessOutcome({
        result: 'secret',
        phase: 'secret',
        win32Error: 'secret',
        identity: 'secret',
        exitState: 'secret',
      }),
    ).includes('secret'),
  );
  const counts = runtimeHelpers.projectWindowCounts({
    result: 'observed',
    identity: 'matched',
    exitState: 'nonsignaled',
    phase: 'complete',
    win32Error: 0,
    windows: { total: 2, visible: 1, minimized: 0, withArea: 2 },
    title: 'secret',
  });
  assert.equal(counts.windows.visible, 1);
  assert.ok(!JSON.stringify(counts).includes('secret'));
  assert.equal(
    runtimeHelpers.projectWindowCounts({ ...counts, identity: 'mismatch' }).windows,
    null,
  );
});

test('owned process counts omit paths and never admit a reused PID or unrelated process', () => {
  const appPath = root.path;
  const counts = runtimeHelpers.ownedProcessCounts(
    [root, child, { ...child, pid: 99 }],
    [root, child],
    { exe: appPath, sidecar: child.path },
    [root],
  );
  assert.equal(counts.app, 1);
  assert.equal(counts.sidecar, 1);
  assert.equal(
    Object.values(counts).reduce((sum, value) => sum + value, 0),
    2,
  );
  assert.ok(!JSON.stringify(counts).includes('installed'));
  assert.equal(
    runtimeHelpers.ownedProcessCounts(
      [{ ...root, startedAt: '2027-01-01T00:00:00Z' }],
      [root],
      { exe: appPath },
      [root],
    ).app,
    0,
  );
});

const exitOnly = {
  result: 'exited',
  phase: 'query-image',
  win32Error: 31,
  identity: 'creation-time',
  exitState: 'signaled',
  imageFailureExit: { creationTime: 'matched', timeError: 0, exitState: 'signaled', waitError: 0 },
};
test('image failure accepts only explicit exact-time same-handle exit proof', () => {
  assert.equal(runtimeHelpers.confirmedProcessExit(exitOnly), true);
  assert.deepEqual(runtimeHelpers.projectProcessOutcome(exitOnly), exitOnly);
  for (const patch of [
    { result: 'stopped' },
    { result: 'failed' },
    { phase: 'identity' },
    { win32Error: 0 },
    { identity: 'unavailable' },
    { exitState: 'nonsignaled' },
    { imageFailureExit: undefined },
    ...[
      { creationTime: 'mismatch' },
      { creationTime: 'unavailable' },
      { timeError: 5 },
      { timeError: null },
      { exitState: 'nonsignaled' },
      { exitState: 'unavailable' },
      { waitError: 6 },
      { waitError: null },
    ].map((nested) => ({ imageFailureExit: { ...exitOnly.imageFailureExit, ...nested } })),
  ])
    assert.equal(runtimeHelpers.confirmedProcessExit({ ...exitOnly, ...patch }), false);
  // Neither the Windows error nor signaled alone establishes tracked ownership.
  assert.equal(runtimeHelpers.confirmedProcessExit({ ...exitOnly, identity: 'mismatch' }), false);
});

test('exit-only diagnostic projection preserves failures but excludes raw native data', () => {
  const result = runtimeHelpers.projectProcessOutcome({
    ...exitOnly,
    rawTime: 'secret',
    path: 'secret',
    imageFailureExit: { ...exitOnly.imageFailureExit, token: 'secret', creationTime: 'secret' },
  });
  assert.equal(result.imageFailureExit.creationTime, 'unavailable');
  assert.equal(runtimeHelpers.confirmedProcessExit(result), false);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

const observedProcess = {
  result: 'observed',
  phase: 'complete',
  win32Error: 0,
  identity: 'matched',
  exitState: 'nonsignaled',
};
test('token projection emits only verified elevation and integrity classes', () => {
  const result = runtimeHelpers.projectTokenObservation({
    ...observedProcess,
    elevation: true,
    integrity: 'high',
    token: 'secret',
    sid: 'secret',
  });
  assert.deepEqual(result, { ...observedProcess, elevation: true, integrity: 'high' });
  for (const patch of [
    { identity: 'creation-time' },
    { exitState: 'signaled' },
    { result: 'failed' },
    { win32Error: 5 },
    { elevation: 'secret' },
    { integrity: 'secret' },
  ]) {
    const unavailable = runtimeHelpers.projectTokenObservation({ ...result, ...patch });
    assert.equal(unavailable.elevation, null);
    assert.equal(unavailable.integrity, 'unavailable');
    assert.ok(!JSON.stringify(unavailable).includes('secret'));
  }
});

test('debug flag projection keeps fixed classifications and never treats unreadable as absent', () => {
  const flags = {
    processType: 'browser-candidate',
    port: 'expected',
    portCount: 1,
    address: 'loopback',
    addressCount: 1,
    pipe: false,
  };
  const result = runtimeHelpers.projectDebugObservation({
    ...observedProcess,
    flags,
    argv: 'secret',
  });
  assert.deepEqual(result, { ...observedProcess, flags });
  const classified = runtimeHelpers.projectDebugObservation({
    ...observedProcess,
    flags: {
      ...flags,
      port: 'duplicate',
      portCount: 2,
      address: 'absent',
      addressCount: 0,
      pipe: true,
    },
  });
  assert.equal(classified.flags.port, 'duplicate');
  assert.equal(classified.flags.address, 'absent');
  for (const patch of [
    { result: 'unavailable' },
    { identity: 'mismatch' },
    { exitState: 'signaled' },
    { flags: null },
    { flags: { ...flags, port: 'secret' } },
    { flags: { ...flags, processType: 'secret' } },
    { flags: { ...flags, portCount: -1 } },
    { flags: { ...flags, portCount: '1' } },
    { flags: { ...flags, pipe: 'secret' } },
    { flags: { ...flags, portCount: 2 } },
  ]) {
    const unavailable = runtimeHelpers.projectDebugObservation({
      ...observedProcess,
      flags,
      ...patch,
    });
    assert.equal(unavailable.flags, null);
    assert.ok(!JSON.stringify(unavailable).includes('secret'));
  }
});

test('process diagnostics bound native calls and project only tracked ordered results', async () => {
  const evidence = {};
  await runtimeHelpers.captureProcessDiagnostics({
    evidence,
    app: root,
    webviews: [{ ordinal: 3, identity: child }],
    budgetMs: 1000,
    inspectToken: async (identity, timeout) => {
      assert.equal(identity, root);
      assert.ok(timeout > 0 && timeout <= 1000);
      return { ...observedProcess, elevation: true, integrity: 'high', token: 'secret' };
    },
    inspectFlags: async (identities, timeout) => {
      assert.deepEqual(identities, [child]);
      assert.ok(timeout > 0 && timeout <= 1000);
      return [
        {
          ...observedProcess,
          flags: {
            processType: 'browser-candidate',
            port: 'absent',
            portCount: 0,
            address: 'absent',
            addressCount: 0,
            pipe: false,
          },
          argv: 'secret',
        },
      ];
    },
  });
  assert.equal(evidence.token.elevation, true);
  assert.equal(evidence.debugArguments.processes[0].ordinal, 3);
  assert.equal(evidence.debugArguments.processes[0].flags.port, 'absent');
  assert.ok(!JSON.stringify(evidence).includes('secret'));
  assert.ok(!JSON.stringify(evidence).includes('installed'));
});

test('process diagnostics preserve unavailable on exceptions, missing rows or exhausted budget', async () => {
  for (const malformed of [null, [], [{}, {}]]) {
    const evidence = {};
    await runtimeHelpers.captureProcessDiagnostics({
      evidence,
      app: root,
      webviews: [{ ordinal: 3, identity: child }],
      budgetMs: 100,
      inspectToken: async () => {
        throw new Error('secret');
      },
      inspectFlags: async () => malformed,
    });
    assert.equal(evidence.token.elevation, null);
    assert.equal(evidence.debugArguments.observation, 'unavailable');
    assert.ok(!JSON.stringify(evidence).includes('secret'));
  }
  const evidence = {};
  await runtimeHelpers.captureProcessDiagnostics({
    evidence,
    app: root,
    webviews: [{ ordinal: 3, identity: child }],
    budgetMs: 1,
    inspectToken: async () => new Promise((resolve) => setTimeout(() => resolve(null), 10)),
    inspectFlags: async () => assert.fail('native flags must not start after the budget'),
  });
  assert.equal(evidence.debugArguments.observation, 'unavailable');
});
