import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { projectNativeOutcome } from './windows-bootstrap-helpers.mjs';
import { assertHostedRunner } from './windows-runtime-helpers.mjs';

export async function ordinaryContext(root, mode) {
  assertHostedRunner(process.env, process.platform);
  const id = process.env.RW_WINDOWS_BOOTSTRAP_ID;
  if (!/^[a-f0-9]{32}$/.test(id ?? '') || process.env.RW_WINDOWS_BOOTSTRAP_MODE !== mode)
    throw new Error('ORDINARY_BOOTSTRAP_REQUIRED');
  const manifest = JSON.parse(
    await readFile(join(root, '.cache', `windows-bootstrap-${mode}`, id, 'context.json'), 'utf8'),
  );
  const nodePath = await realpath(process.execPath);
  const nodeSha256 = createHash('sha256')
    .update(await readFile(nodePath))
    .digest('hex');
  if (
    manifest.bootstrapId !== id ||
    manifest.mode !== mode ||
    manifest.pid !== process.pid ||
    manifest.nodeSha256 !== nodeSha256 ||
    !/^[1-9]\d{15,18}$/.test(manifest.created100ns ?? '')
  )
    throw new Error('BOOTSTRAP_CONTEXT_MISMATCH');
  const output = await new Promise((resolve, reject) => {
    const child = execFile(
      join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        join(root, 'scripts/verify/windows-bootstrap-native.ps1'),
      ],
      { cwd: root, windowsHide: true, timeout: 20000, maxBuffer: 65536, encoding: 'utf8' },
      (error, stdout) =>
        error?.killed || (error && !stdout.trim())
          ? reject(new Error('ORDINARY_CONTEXT_UNAVAILABLE'))
          : resolve({ stdout, succeeded: error == null }),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(
      JSON.stringify({
        action: 'inspect',
        pid: process.pid,
        nodePath,
        created100ns: manifest.created100ns,
      }),
    );
  });
  return contextObservation(output.stdout, output.succeeded);
}

/** Native output is evidence only when its producing subprocess also exited successfully. */
export function contextObservation(output, succeeded) {
  const value = JSON.parse(output);
  if (
    succeeded !== true ||
    value.tokenFailure != null ||
    value.status !== 'PASS' ||
    value.phase !== 'complete' ||
    value.code !== 'OK' ||
    value.win32Error !== 0 ||
    ![
      'ordinary',
      'sameIdentity',
      'exactCreation',
      'imageMatched',
      'jobMember',
      'desktopAvailable',
    ].every((key) => value[key] === true)
  ) {
    const projected = projectNativeOutcome(value);
    return {
      status: 'FAIL',
      processExit: succeeded === true ? 'zero' : 'failed-or-unconfirmed',
      native: {
        phase: projected.phase,
        code: projected.code,
        win32Error: projected.win32Error,
        compilerCode: projected.compilerCode,
        tokenFailure: projected.tokenFailure,
      },
    };
  }
  return {
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
  };
}
