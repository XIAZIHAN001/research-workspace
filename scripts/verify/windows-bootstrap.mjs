/** Fresh hosted Windows only. Fixed probe/runtime children, never an arbitrary command runner. */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertHostedRunner, runnerGuardCode } from './windows-runtime-helpers.mjs';
import { bootstrapEnvironment, bootstrapOutcome } from './windows-bootstrap-helpers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const mode =
  process.argv.length === 3 && ['--probe', '--runtime'].includes(process.argv[2])
    ? process.argv[2].slice(2)
    : 'refused';
const id = randomBytes(16).toString('hex');
const directory = join(ROOT, '.cache', `windows-bootstrap-${mode}`, id);
const report = {
  stage: `ordinary-permission-${mode}`,
  bootstrapId: id,
  status: 'NOT RUN',
  complete: false,
  childReport: 'missing-or-incomplete',
  credentialCleanup: mode === 'probe' ? 'not-exercised' : 'unverified',
};
const save = () =>
  writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
try {
  await mkdir(directory, { recursive: true });
  await save();
  if (mode === 'refused') throw new Error('BOOTSTRAP_MODE_INVALID');
  assertHostedRunner(process.env, process.platform);
  const environment = bootstrapEnvironment(process.env, id, mode);
  if (resolve(environment.GITHUB_WORKSPACE).toLowerCase() !== ROOT.toLowerCase())
    throw new Error('WORKSPACE_MISMATCH');
  const nodePath = await realpath(process.execPath);
  const nodeSha256 = createHash('sha256')
    .update(await readFile(nodePath))
    .digest('hex');
  const powershell = join(environment.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
  for (const file of [
    nodePath,
    powershell,
    join(environment.ProgramFiles, 'Git', 'cmd', 'git.exe'),
  ]) {
    const info = await stat(file);
    if (
      !info.isFile() ||
      info.size === 0 ||
      (await realpath(file)).toLowerCase() !== resolve(file).toLowerCase()
    )
      throw new Error('BOOTSTRAP_TOOL_IDENTITY_FAILED');
  }
  report.source = {
    commit: environment.GITHUB_SHA,
    runId: environment.GITHUB_RUN_ID,
    runAttempt: environment.GITHUB_RUN_ATTEMPT,
  };
  report.nodeSha256 = nodeSha256;
  const native = await new Promise((resolveNative, reject) => {
    const child = execFile(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        join(ROOT, 'scripts/verify/windows-bootstrap-native.ps1'),
      ],
      {
        cwd: ROOT,
        env: environment,
        windowsHide: true,
        timeout: mode === 'probe' ? 90000 : 590000,
        maxBuffer: 65536,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (error?.killed) reject(new Error('BOOTSTRAP_SUPERVISOR_TIMEOUT'));
        else {
          try {
            const value = JSON.parse(stdout);
            if (error && value.status !== 'FAIL') reject(new Error('BOOTSTRAP_NATIVE_FAILED'));
            else resolveNative(value);
          } catch {
            reject(new Error('BOOTSTRAP_NATIVE_REPORT_INVALID'));
          }
        }
      },
    );
    child.stdin.on('error', () => {});
    child.stdin.end(
      JSON.stringify({ action: 'launch', mode, id, nodePath, nodeSha256, environment }),
    );
  });
  let child;
  try {
    child = JSON.parse(
      await readFile(
        mode === 'probe'
          ? join(directory, 'child-report.json')
          : join(ROOT, '.cache', 'windows-runtime', id, 'report.json'),
        'utf8',
      ),
    );
  } catch {
    /* Missing evidence can never become PASS. */
  }
  Object.assign(report, bootstrapOutcome(mode, id, native, child));
} catch (error) {
  report.status = 'FAIL';
  const guard = runnerGuardCode(error);
  const known = new Set([
    'BOOTSTRAP_MODE_INVALID',
    'BOOTSTRAP_ID_INVALID',
    'BOOTSTRAP_PATH_INVALID',
    'BOOTSTRAP_METADATA_INVALID',
    'WORKSPACE_MISMATCH',
    'BOOTSTRAP_TOOL_IDENTITY_FAILED',
    'BOOTSTRAP_SUPERVISOR_TIMEOUT',
    'BOOTSTRAP_NATIVE_FAILED',
    'BOOTSTRAP_NATIVE_REPORT_INVALID',
  ]);
  report.terminalError = known.has(error.message) ? error.message : guard;
} finally {
  report.complete = true;
  await save();
  process.stdout.write(`${report.status}: ordinary-permission-${mode}\n`);
  process.exit(report.status === 'PASS' ? 0 : 1);
}
