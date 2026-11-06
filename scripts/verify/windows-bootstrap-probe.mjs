/** Harmless fixed child. This does not run the app, installer, credentials, or CDP. */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ordinaryContext } from './windows-bootstrap-context.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const id = process.env.RW_WINDOWS_BOOTSTRAP_ID;
const report = {
  stage: 'ordinary-permission-probe-child',
  status: 'NOT RUN',
  complete: false,
  bootstrapId: id,
  ordinaryContext: null,
  checkoutReadable: false,
  toolsExecutable: false,
  outputWritable: false,
  fixtureCleanup: false,
};
if (!/^[a-f0-9]{32}$/.test(id ?? '') || process.env.RW_WINDOWS_BOOTSTRAP_MODE !== 'probe')
  process.exit(2);
const directory = join(ROOT, '.cache', 'windows-bootstrap-probe', id);
const fixture = join(directory, 'disposable-access-probe.txt');
const tempFixture = join(process.env.RUNNER_TEMP, `rw-ordinary-probe-${id}.txt`);
const created = [];
try {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'child-report.json'), JSON.stringify(report));
  report.ordinaryContext = await ordinaryContext(ROOT, 'probe');
  if (report.ordinaryContext.status !== 'PASS') throw new Error('ORDINARY_CONTEXT_UNVERIFIED');
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  await readFile(join(ROOT, 'node_modules/playwright-core/package.json'));
  if (pkg.name !== 'research-workspace') throw new Error('CHECKOUT_UNEXPECTED');
  report.checkoutReadable = true;
  const git = join(process.env.ProgramFiles, 'Git', 'cmd', 'git.exe');
  const result = await new Promise((resolveCommand, reject) => {
    execFile(
      git,
      ['rev-parse', 'HEAD'],
      { cwd: ROOT, windowsHide: true, timeout: 5000, maxBuffer: 1024, encoding: 'utf8' },
      (error, stdout) =>
        error ? reject(new Error('TOOL_ACCESS_FAILED')) : resolveCommand(stdout.trim()),
    );
  });
  if (result !== process.env.GITHUB_SHA) throw new Error('SOURCE_COMMIT_MISMATCH');
  report.toolsExecutable = true;
  for (const file of [fixture, tempFixture]) {
    await writeFile(file, 'ordinary-permission-probe\n', { flag: 'wx' });
    created.push(file);
    if ((await readFile(file, 'utf8')) !== 'ordinary-permission-probe\n')
      throw new Error('OUTPUT_PROBE_FAILED');
  }
  report.outputWritable = true;
  report.status = 'PASS';
} catch (error) {
  const known = new Set([
    'ORDINARY_BOOTSTRAP_REQUIRED',
    'BOOTSTRAP_CONTEXT_MISMATCH',
    'ORDINARY_CONTEXT_UNAVAILABLE',
    'ORDINARY_CONTEXT_UNVERIFIED',
    'CHECKOUT_UNEXPECTED',
    'TOOL_ACCESS_FAILED',
    'SOURCE_COMMIT_MISMATCH',
    'OUTPUT_PROBE_FAILED',
  ]);
  report.terminalError = known.has(error.message) ? error.message : 'PROBE_ACCESS_FAILED';
  report.status = 'FAIL';
} finally {
  try {
    for (const file of created) await unlink(file);
    report.fixtureCleanup = true;
  } catch {
    report.status = 'FAIL';
  }
  report.complete = true;
  await writeFile(join(directory, 'child-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.status === 'PASS' ? 0 : 1);
}
