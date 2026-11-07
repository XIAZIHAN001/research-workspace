import { win32 as path } from 'node:path';

const requireValue = (condition, code) => {
  if (!condition) throw new Error(code);
};
const hasControl = (value) => Array.from(value).some((character) => character.charCodeAt(0) < 32);
const paths = [
  'SystemRoot',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'PROGRAMDATA',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'RUNNER_TEMP',
  'GITHUB_WORKSPACE',
];
const metadata = {
  GITHUB_ACTIONS: /^true$/,
  RUNNER_ENVIRONMENT: /^github-hosted$/,
  RUNNER_OS: /^Windows$/,
  RW_WINDOWS_FRESH_RUNNER: /^yes$/,
  GITHUB_SHA: /^[a-f0-9]{40}$/,
  GITHUB_RUN_ID: /^[1-9]\d{0,19}$/,
  GITHUB_RUN_ATTEMPT: /^[1-9]\d{0,5}$/,
  ImageOS: /^(?:win\d+|win25-vs2026)$/,
  ImageVersion: /^\d{1,12}(?:\.\d{1,12}){1,3}$/,
};

/** A new environment, never a filtered wildcard copy. Every path must be local and unambiguous. */
export function bootstrapEnvironment(input, id, mode) {
  requireValue(/^[a-f0-9]{32}$/.test(id), 'BOOTSTRAP_ID_INVALID');
  requireValue(['probe', 'runtime'].includes(mode), 'BOOTSTRAP_MODE_INVALID');
  const result = {};
  for (const key of paths) {
    const value = input[key];
    requireValue(
      typeof value === 'string' &&
        /^[a-z]:\\/i.test(value) &&
        !/[;"]/.test(value) &&
        !hasControl(value) &&
        path.normalize(value) === value &&
        value.length < 240,
      'BOOTSTRAP_PATH_INVALID',
    );
    result[key] = value;
  }
  for (const [key, pattern] of Object.entries(metadata)) {
    requireValue(
      typeof input[key] === 'string' && pattern.test(input[key]) && !/[\r\n]/.test(input[key]),
      'BOOTSTRAP_METADATA_INVALID',
    );
    result[key] = input[key];
  }
  result.WINDIR = result.SystemRoot;
  result.SystemDrive = path.parse(result.SystemRoot).root.slice(0, 2);
  result.COMSPEC = path.join(result.SystemRoot, 'System32', 'cmd.exe');
  result.PATH = [
    path.join(result.SystemRoot, 'System32'),
    result.SystemRoot,
    path.join(result.SystemRoot, 'System32', 'Wbem'),
    path.join(result.ProgramFiles, 'Git', 'cmd'),
  ].join(';');
  result.RW_WINDOWS_BOOTSTRAP_ID = id;
  result.RW_WINDOWS_BOOTSTRAP_MODE = mode;
  return result;
}

const phases = new Set([
  'input',
  'compilation',
  'self-test',
  'caller-token',
  'safer-level',
  'safer-token',
  'duplicate-token',
  'lower-integrity',
  'validate-token',
  'job-create',
  'job-configure',
  'attributes',
  'create-process',
  'child-identity',
  'child-token',
  'child-job',
  'manifest',
  'resume',
  'wait',
  'job-drain',
  'cleanup',
  'complete',
]);
const codes = new Set([
  'OK',
  'NATIVE_COMPILE_FAILED',
  'BOOTSTRAP_PARENT_EXIT',
  'NATIVE_FAILURE',
  'NATIVE_INPUT_INVALID',
  'NATIVE_SELF_TEST_FAILED',
  'NATIVE_API_FAILED',
  'TOKEN_REJECTED',
  'HANDLE_INHERITANCE_REFUSED',
  'IMAGE_MISMATCH',
  'CREATION_IDENTITY_MISMATCH',
  'JOB_MEMBERSHIP_FAILED',
  'RESUME_COUNT_MISMATCH',
  'CHILD_TIMEOUT',
  'CHILD_EXIT_FAILED',
  'JOB_NOT_EMPTY',
  'CLEANUP_UNVERIFIED',
  'FILE_IDENTITY_FAILED',
]);

const tokenFields = new Set([
  'user',
  'statistics',
  'groups',
  'privileges',
  'type',
  'session',
  'sandbox',
  'elevation',
  'integrity',
  'ui-access',
  'account',
  'identity',
]);
const tokenReasons = new Set([
  'size-query-unexpected-success',
  'size-query-error',
  'buffer-size',
  'read-query-error',
  'scalar-size',
  'scalar-class',
  'sid-invalid',
  'sid-conversion-error',
  'statistics-size',
  'group-buffer-shape',
  'duplicate-group-sid',
  'duplicate-logon-sid',
  'missing-logon-sid',
  'privilege-buffer-shape',
  'privilege-name-error',
  'duplicate-privilege',
  'integrity-attribute',
  'integrity-sid-shape',
  'integrity-subauthorities',
  'facts-missing',
  'primary-required',
  'integrity-below-medium',
  'user-missing',
  'authentication-missing',
  'logon-missing',
  'user-account-shape',
  'authentication-shape',
  'authentication-zero',
  'logon-shape',
  'candidate-facts-missing',
  'user-mismatch',
  'authentication-mismatch',
  'logon-mismatch',
  'session-mismatch',
  'source-primary-required',
  'nonzero-elevation',
  'not-exact-medium',
  'ui-access-not-zero',
  'sandbox-inert-not-zero',
  'source-list-missing',
  'candidate-list-missing',
  'source-deny-only-group-missing',
  'source-deny-only-flag-lost',
  'new-group-not-medium-label',
  'label-source-not-higher',
  'label-candidate-not-medium',
  'label-attributes-unexpected',
  'label-integrity-attribute-missing',
  'group-authority-added',
  'privileged-group-not-deny-only',
  'privileged-group-authority-present',
  'privilege-added',
  'privilege-activation-added',
  'non-traversal-privilege-enabled',
  'privilege-not-allowlisted',
]);

/** Never copy native strings or unknown fields to retained artifacts. */
export function projectNativeOutcome(value) {
  const result = {
    status: value?.status === 'PASS' ? 'PASS' : 'FAIL',
    phase: phases.has(value?.phase) ? value.phase : 'unavailable',
    code: codes.has(value?.code) ? value.code : 'NATIVE_FAILURE',
    tokenFailure:
      tokenFields.has(value?.tokenFailure?.field) && tokenReasons.has(value?.tokenFailure?.reason)
        ? { field: value.tokenFailure.field, reason: value.tokenFailure.reason }
        : null,
    compilerCode: /^CS[0-9]{4}$/.test(value?.compilerCode ?? '') ? value.compilerCode : null,
    win32Error:
      Number.isInteger(value?.win32Error) && value.win32Error >= 0 && value.win32Error <= 0xffffffff
        ? value.win32Error
        : null,
  };
  for (const key of [
    'candidateVerified',
    'childVerified',
    'atomicJob',
    'noInheritedHandles',
    'resumed',
    'exited',
    'cleanupVerified',
    'forcedTermination',
  ])
    result[key] = typeof value?.[key] === 'boolean' ? value[key] : null;
  for (const key of ['exitCode', 'activeProcesses', 'nativeTests'])
    result[key] =
      Number.isInteger(value?.[key]) && value[key] >= 0 && value[key] <= 0xffffffff
        ? value[key]
        : null;
  return result;
}

export const requiredRuntimeChecks = Object.freeze([
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
]);

function ordinaryProven(value) {
  return (
    value?.status === 'PASS' &&
    value.elevation === false &&
    value.integrity === 'medium' &&
    value.uiAccess === false &&
    value.sandboxInert === false &&
    ['sameUserAndLogon', 'exactCreation', 'imageMatched', 'jobMember', 'desktopAvailable'].every(
      (key) => value[key] === true,
    )
  );
}

export function bootstrapOutcome(mode, id, nativeValue, child) {
  const native = projectNativeOutcome(nativeValue);
  const linked = child?.bootstrapId === id && child.complete === true;
  const complete =
    linked &&
    child.status === 'PASS' &&
    ordinaryProven(child.ordinaryContext) &&
    (mode === 'probe'
      ? ['checkoutReadable', 'toolsExecutable', 'outputWritable', 'fixtureCleanup'].every(
          (key) => child[key] === true,
        )
      : child.cleanupIncomplete === false &&
        Array.isArray(child.checks) &&
        child.syntheticCredentialCleanup === 'verified' &&
        child.checks.length === requiredRuntimeChecks.length &&
        child.checks.every(
          (check, index) => check.name === requiredRuntimeChecks[index] && check.status === 'PASS',
        ));
  const contained =
    nativeValue?.tokenFailure == null &&
    native.status === 'PASS' &&
    native.phase === 'complete' &&
    native.code === 'OK' &&
    native.win32Error === 0 &&
    native.candidateVerified &&
    native.childVerified &&
    native.atomicJob &&
    native.noInheritedHandles &&
    native.resumed &&
    native.exited &&
    native.exitCode === 0 &&
    native.activeProcesses === 0 &&
    native.cleanupVerified &&
    native.forcedTermination === false &&
    native.nativeTests > 0;
  return {
    status: complete && contained ? 'PASS' : 'FAIL',
    childReport: linked ? (child.status === 'PASS' ? 'PASS' : 'FAIL') : 'missing-or-incomplete',
    credentialCleanup:
      mode === 'probe'
        ? 'not-exercised'
        : linked &&
            nativeValue?.tokenFailure == null &&
            child.cleanupIncomplete === false &&
            native.cleanupVerified === true &&
            native.activeProcesses === 0 &&
            native.exited &&
            native.forcedTermination === false &&
            ['verified', 'not-exercised'].includes(child.syntheticCredentialCleanup)
          ? child.syntheticCredentialCleanup
          : 'unverified',
    native,
  };
}
