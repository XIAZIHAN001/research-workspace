import assert from 'node:assert/strict';
import { test } from 'vitest';
import { contextObservation } from './windows-bootstrap-context.mjs';
import {
  bootstrapEnvironment,
  bootstrapOutcome,
  projectNativeOutcome,
} from './windows-bootstrap-helpers.mjs';

const env = {
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  RUNNER_OS: 'Windows',
  RW_WINDOWS_FRESH_RUNNER: 'yes',
  RUNNER_TEMP: 'D:\\a\\_temp',
  GITHUB_WORKSPACE: 'D:\\a\\repo',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1',
  ImageOS: 'win25-vs2026',
  ImageVersion: '20261030.294.1',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  PROGRAMDATA: 'C:\\ProgramData',
  SystemRoot: 'C:\\Windows',
  SystemDrive: 'C:',
  ProgramFiles: 'C:\\Program Files',
  USERPROFILE: 'C:\\Users\\runneradmin',
  APPDATA: 'C:\\Users\\runneradmin\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\runneradmin\\AppData\\Local',
  TEMP: 'D:\\a\\_temp',
  TMP: 'D:\\a\\_temp',
};
const id = 'b'.repeat(32);
const verified = {
  status: 'PASS',
  phase: 'complete',
  code: 'OK',
  win32Error: 0,
  candidateVerified: true,
  childVerified: true,
  atomicJob: true,
  noInheritedHandles: true,
  resumed: true,
  exited: true,
  exitCode: 0,
  activeProcesses: 0,
  cleanupVerified: true,
  forcedTermination: false,
  nativeTests: 12,
};
const runtimeChecks = [
  'ordinary-driver-context',
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
].map((name) => ({ name, status: 'PASS' }));
const child = {
  status: 'PASS',
  complete: true,
  bootstrapId: id,
  ordinaryContext: {
    status: 'PASS',
    elevation: false,
    integrity: 'medium',
    uiAccess: false,
    sandboxInert: false,
    sameUserAndLogon: true,
    exactCreation: true,
    imageMatched: true,
    jobMember: true,
    desktopAvailable: true,
  },
  checkoutReadable: true,
  toolsExecutable: true,
  outputWritable: true,
  fixtureCleanup: true,
};

test('bootstrap environment excludes credentials, proxy/debug channels and wildcard metadata', () => {
  const got = bootstrapEnvironment(
    {
      ...env,
      GITHUB_TOKEN: 'secret',
      ACTIONS_RUNTIME_TOKEN: 'secret',
      HTTPS_PROXY: 'secret',
      PATH: 'C:\\untrusted',
      EXTRA: 'secret',
      NODE_OPTIONS: 'secret',
    },
    id,
    'probe',
  );
  assert.equal(got.GITHUB_SHA, 'a'.repeat(40));
  assert.equal(got.RW_WINDOWS_BOOTSTRAP_ID, id);
  assert.equal(got.RW_WINDOWS_BOOTSTRAP_MODE, 'probe');
  assert.equal(
    got.PATH,
    'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Program Files\\Git\\cmd',
  );
  for (const key of [
    'GITHUB_TOKEN',
    'ACTIONS_RUNTIME_TOKEN',
    'HTTPS_PROXY',
    'EXTRA',
    'NODE_OPTIONS',
  ])
    assert.equal(got[key], undefined);
  assert.equal(got.COMSPEC, 'C:\\Windows\\System32\\cmd.exe');
});

test('environment rejects ambiguous paths, unvalidated metadata and arbitrary launch modes', () => {
  for (const [key, value] of [
    ['GITHUB_RUN_ID', '123\nsecret'],
    ['ImageVersion', 'x;secret'],
    ['SystemRoot', 'relative'],
    ['TEMP', 'C:\\tmp;C:\\evil'],
    ['USERPROFILE', '\\\\remote\\share'],
    ['ProgramFiles', 'C:\\ok\u0000bad'],
  ]) {
    assert.throws(() => bootstrapEnvironment({ ...env, [key]: value }, id, 'probe'));
  }
  assert.throws(() => bootstrapEnvironment(env, 'bad', 'probe'));
  assert.throws(() => bootstrapEnvironment(env, id, 'arbitrary'));
});

test('bootstrap PASS requires complete linked child evidence plus positive unforced containment', () => {
  assert.equal(bootstrapOutcome('probe', id, verified, child).status, 'PASS');
  assert.equal(
    bootstrapOutcome('runtime', id, verified, {
      ...child,
      cleanupIncomplete: false,
      syntheticCredentialCleanup: 'verified',
      checks: runtimeChecks,
    }).status,
    'PASS',
  );
  for (const delta of [
    { exited: false },
    { activeProcesses: 1 },
    { cleanupVerified: false },
    { forcedTermination: true },
    { childVerified: false },
    { atomicJob: false },
    { noInheritedHandles: false },
    { exitCode: 1 },
    { resumed: false },
    { status: 'FAIL' },
  ]) {
    assert.notEqual(bootstrapOutcome('probe', id, { ...verified, ...delta }, child).status, 'PASS');
  }
  for (const broken of [
    null,
    { ...child, complete: false },
    { ...child, bootstrapId: 'c'.repeat(32) },
    { ...child, status: 'FAIL' },
    { ...child, ordinaryContext: null },
  ]) {
    assert.notEqual(bootstrapOutcome('probe', id, verified, broken).status, 'PASS');
  }
});

test('job teardown never erases runtime orphan failure or unverified credential cleanup', () => {
  assert.equal(
    bootstrapOutcome('runtime', id, verified, { ...child, cleanupIncomplete: true }).status,
    'FAIL',
  );
  const incomplete = bootstrapOutcome(
    'runtime',
    id,
    { ...verified, forcedTermination: true },
    null,
  );
  assert.equal(incomplete.status, 'FAIL');
  assert.equal(incomplete.credentialCleanup, 'unverified');
  const failed = bootstrapOutcome('runtime', id, verified, {
    ...child,
    status: 'FAIL',
    cleanupIncomplete: false,
    checks: [{ status: 'FAIL' }],
  });
  assert.equal(failed.status, 'FAIL');
});

test('native report projection rejects unknown phases and never relays paths, SIDs or errors', () => {
  const projected = projectNativeOutcome({
    ...verified,
    phase: 'C:\\private\\secret',
    code: 'secret-value',
    sid: 'S-1-private',
    raw: 'secret',
    win32Error: 'secret',
  });
  assert.equal(projected.phase, 'unavailable');
  assert.equal(projected.code, 'NATIVE_FAILURE');
  assert.equal(projected.win32Error, null);
  assert.equal(JSON.stringify(projected).includes('secret'), false);
  assert.equal(JSON.stringify(projected).includes('S-1-'), false);
});

test('contradictory native completion and incomplete probe evidence cannot authorize build', () => {
  for (const delta of [
    { phase: 'unknown' },
    { phase: 'cleanup' },
    { code: 'NATIVE_FAILURE' },
    { win32Error: 5 },
  ]) {
    assert.equal(bootstrapOutcome('probe', id, { ...verified, ...delta }, child).status, 'FAIL');
  }
  for (const key of ['checkoutReadable', 'toolsExecutable', 'outputWritable', 'fixtureCleanup']) {
    assert.equal(
      bootstrapOutcome('probe', id, verified, { ...child, [key]: false }).status,
      'FAIL',
    );
  }
});

test('credential report distinguishes not exercised from positively verified cleanup', () => {
  for (const value of ['not-exercised', 'verified']) {
    const report = {
      ...child,
      syntheticCredentialCleanup: value,
      cleanupIncomplete: false,
      checks: runtimeChecks,
    };
    assert.equal(bootstrapOutcome('runtime', id, verified, report).credentialCleanup, value);
  }
  for (const value of [undefined, 'unknown', 'unverified']) {
    assert.equal(
      bootstrapOutcome('runtime', id, verified, {
        ...child,
        cleanupIncomplete: false,
        syntheticCredentialCleanup: value,
      }).credentialCleanup,
      'unverified',
    );
  }
});

test('truncated, duplicate or unknown runtime checks and missing ordinary proofs fail closed', () => {
  const report = {
    ...child,
    cleanupIncomplete: false,
    syntheticCredentialCleanup: 'verified',
    checks: runtimeChecks,
  };
  for (const checks of [
    [],
    runtimeChecks.slice(1),
    [runtimeChecks[0]],
    [...runtimeChecks, runtimeChecks[0]],
    runtimeChecks.map((item, i) => (i === 0 ? { name: 'unknown', status: 'PASS' } : item)),
  ]) {
    assert.equal(bootstrapOutcome('runtime', id, verified, { ...report, checks }).status, 'FAIL');
  }
  for (const key of [
    'sameUserAndLogon',
    'exactCreation',
    'imageMatched',
    'jobMember',
    'desktopAvailable',
  ]) {
    assert.equal(
      bootstrapOutcome('probe', id, verified, {
        ...child,
        ordinaryContext: { ...child.ordinaryContext, [key]: undefined },
      }).status,
      'FAIL',
    );
  }
});

test('fixed bootstrap entrypoint refuses arbitrary commands with sanitized persisted evidence', async () => {
  const { spawnSync } = await import('node:child_process');
  const { readdir, readFile } = await import('node:fs/promises');
  const { resolve, join } = await import('node:path');
  const root = resolve(import.meta.dirname, '../..');
  const reports = join(root, '.cache/windows-bootstrap-refused');
  const previous = new Set(await readdir(reports).catch(() => []));
  const result = spawnSync(
    process.execPath,
    ['scripts/verify/windows-bootstrap.mjs', '--exec', 'secret-command'],
    {
      cwd: root,
      env: { ...process.env, GITHUB_TOKEN: 'private-secret-marker' },
      timeout: 5000,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'FAIL: ordinary-permission-refused\n');
  assert.equal(result.stderr, '');
  const added = (await readdir(reports)).filter((name) => !previous.has(name));
  assert.equal(added.length, 1);
  const raw = await readFile(join(reports, added[0], 'report.json'), 'utf8');
  const report = JSON.parse(raw);
  assert.equal(report.complete, true);
  assert.equal(report.status, 'FAIL');
  assert.equal(report.terminalError, 'BOOTSTRAP_MODE_INVALID');
  assert.equal(raw.includes('secret'), false);
});

test('missing forced-termination proof cannot authorize success or credential verification', () => {
  const { forcedTermination: omitted, ...withoutProof } = verified;
  assert.equal(omitted, false);
  const report = {
    ...child,
    cleanupIncomplete: false,
    syntheticCredentialCleanup: 'verified',
    checks: runtimeChecks,
  };
  for (const value of [
    withoutProof,
    { ...verified, forcedTermination: null },
    { ...verified, forcedTermination: 0 },
  ]) {
    const outcome = bootstrapOutcome('runtime', id, value, report);
    assert.equal(outcome.status, 'FAIL');
    assert.equal(outcome.credentialCleanup, 'unverified');
  }
});

test('ordinary context rejects successful-looking JSON from a failed inspect process', () => {
  const value = {
    status: 'PASS',
    phase: 'complete',
    code: 'OK',
    win32Error: 0,
    ordinary: true,
    sameIdentity: true,
    exactCreation: true,
    imageMatched: true,
    jobMember: true,
    desktopAvailable: true,
  };
  assert.equal(contextObservation(JSON.stringify(value), true).status, 'PASS');
  for (const succeeded of [false, undefined, null]) {
    assert.equal(contextObservation(JSON.stringify(value), succeeded).status, 'FAIL');
  }
  const failure = contextObservation(
    JSON.stringify({
      status: 'FAIL',
      phase: 'compilation',
      code: 'NATIVE_COMPILE_FAILED',
      compilerCode: 'CS1001',
      win32Error: 0,
    }),
    false,
  );
  assert.equal(failure.native.code, 'NATIVE_COMPILE_FAILED');
  assert.equal(failure.native.compilerCode, 'CS1001');
});

test('credential verification requires closed application work and positive process teardown', () => {
  const report = {
    ...child,
    status: 'FAIL',
    cleanupIncomplete: false,
    syntheticCredentialCleanup: 'verified',
    checks: runtimeChecks,
  };
  assert.equal(
    bootstrapOutcome('runtime', id, { ...verified, status: 'FAIL', exitCode: 1 }, report)
      .credentialCleanup,
    'verified',
  );
  for (const [native, runtime] of [
    [verified, { ...report, cleanupIncomplete: true }],
    [verified, { ...report, cleanupIncomplete: undefined }],
    [{ ...verified, cleanupVerified: false }, report],
    [{ ...verified, activeProcesses: 1 }, report],
    [{ ...verified, activeProcesses: null }, report],
  ]) {
    assert.equal(bootstrapOutcome('runtime', id, native, runtime).credentialCleanup, 'unverified');
  }
});

test('token failure diagnostics retain fixed query/predicate classes without sensitive values', () => {
  const result = projectNativeOutcome({
    status: 'FAIL',
    phase: 'caller-token',
    code: 'TOKEN_REJECTED',
    win32Error: 5,
    tokenFailure: {
      field: 'groups',
      reason: 'size-query-error',
      sid: 'S-1-5-private',
      luid: 'private-logon',
      value: 'private-buffer',
    },
  });
  assert.deepEqual(result.tokenFailure, { field: 'groups', reason: 'size-query-error' });
  assert.equal(result.win32Error, 5);
  assert.equal(JSON.stringify(result).includes('private'), false);
  const context = contextObservation(
    JSON.stringify({
      status: 'FAIL',
      phase: 'child-token',
      code: 'TOKEN_REJECTED',
      win32Error: 0,
      tokenFailure: { field: 'account', reason: 'user-account-shape' },
    }),
    true,
  );
  assert.deepEqual(context.native.tokenFailure, { field: 'account', reason: 'user-account-shape' });
});

test('unknown or absent token diagnostic fields never become raw report text', () => {
  for (const tokenFailure of [
    null,
    undefined,
    { field: 'private-sid', reason: 'missing-logon-sid' },
    { field: 'groups', reason: 'private-secret' },
    { field: {}, reason: [] },
  ]) {
    const result = projectNativeOutcome({ ...verified, tokenFailure });
    assert.equal(result.tokenFailure, null);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('token-failure evidence cannot coexist with bootstrap or context PASS', () => {
  const runtime = {
    ...child,
    cleanupIncomplete: false,
    syntheticCredentialCleanup: 'verified',
    checks: runtimeChecks,
  };
  const context = {
    status: 'PASS',
    phase: 'complete',
    code: 'OK',
    win32Error: 0,
    ordinary: true,
    sameIdentity: true,
    exactCreation: true,
    imageMatched: true,
    jobMember: true,
    desktopAvailable: true,
  };
  for (const tokenFailure of [
    { field: 'groups', reason: 'missing-logon-sid' },
    { field: 'private-value', reason: 'private-secret' },
  ]) {
    const outcome = bootstrapOutcome('runtime', id, { ...verified, tokenFailure }, runtime);
    assert.equal(outcome.status, 'FAIL');
    assert.equal(outcome.credentialCleanup, 'unverified');
    const observation = contextObservation(JSON.stringify({ ...context, tokenFailure }), true);
    assert.equal(observation.status, 'FAIL');
    assert.equal(JSON.stringify(outcome).includes('private'), false);
    assert.equal(JSON.stringify(observation).includes('private'), false);
  }
});

test('fixed scalar diagnostics retain unsupported-class refusal without widening error24 acceptance', () => {
  const observed = {
    ...verified,
    status: 'FAIL',
    phase: 'caller-token',
    code: 'TOKEN_REJECTED',
    win32Error: 24,
    nativeTests: 57,
    candidateVerified: false,
    childVerified: false,
    atomicJob: false,
    noInheritedHandles: false,
    resumed: false,
    exited: false,
    cleanupVerified: false,
    exitCode: null,
    activeProcesses: null,
    tokenFailure: { field: 'elevation', reason: 'size-query-error' },
  };
  const outcome = bootstrapOutcome('probe', id, observed, null);
  assert.equal(outcome.status, 'FAIL');
  assert.equal(outcome.native.win32Error, 24);
  assert.deepEqual(outcome.native.tokenFailure, { field: 'elevation', reason: 'size-query-error' });
  assert.deepEqual(
    projectNativeOutcome({
      ...observed,
      tokenFailure: { field: 'integrity', reason: 'scalar-class' },
    }).tokenFailure,
    { field: 'integrity', reason: 'scalar-class' },
  );
});

test('candidate policy diagnostics identify the fixed requirement without revealing token data', () => {
  for (const [field, reason] of [
    ['identity', 'user-mismatch'],
    ['identity', 'authentication-mismatch'],
    ['identity', 'logon-mismatch'],
    ['identity', 'session-mismatch'],
    ['type', 'primary-required'],
    ['elevation', 'nonzero-elevation'],
    ['integrity', 'not-exact-medium'],
    ['ui-access', 'ui-access-not-zero'],
    ['sandbox', 'sandbox-inert-not-zero'],
    ['groups', 'source-deny-only-group-missing'],
    ['groups', 'source-deny-only-flag-lost'],
    ['groups', 'new-group-not-medium-label'],
    ['groups', 'group-authority-added'],
    ['groups', 'privileged-group-not-deny-only'],
    ['privileges', 'privilege-added'],
    ['privileges', 'privilege-activation-added'],
    ['privileges', 'non-traversal-privilege-enabled'],
    ['privileges', 'privilege-not-allowlisted'],
  ]) {
    const value = {
      ...verified,
      status: 'FAIL',
      phase: 'validate-token',
      code: 'TOKEN_REJECTED',
      tokenFailure: {
        field,
        reason,
        sid: 'private-identity',
        privilege: 'private-privilege',
        attributes: 'private-attributes',
      },
    };
    const projected = projectNativeOutcome(value);
    assert.deepEqual(projected.tokenFailure, { field, reason });
    assert.equal(JSON.stringify(projected).includes('private'), false);
    assert.equal(bootstrapOutcome('probe', id, value, child).status, 'FAIL');
  }
  assert.equal(
    projectNativeOutcome({
      ...verified,
      tokenFailure: { field: 'identity', reason: 'private-unknown-reason' },
    }).tokenFailure,
    null,
  );
});
