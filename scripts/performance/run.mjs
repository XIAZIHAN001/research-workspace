import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { checksum, compareResults } from './metrics.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const revision = option('--ref', '2536305d86d520955358d1bcae6aea8fe78bb62b');
const commit = execFileSync('git', ['rev-parse', '--verify', `${revision}^{commit}`], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const output = resolve(option('--out', `/tmp/research-performance-${commit.slice(0, 8)}.json`));
const warmups = Number(option('--warmups', '2'));
const samples = Number(option('--samples', '7'));
if (!Number.isInteger(warmups) || warmups < 0 || !Number.isInteger(samples) || samples < 1)
  throw new Error('Invalid sample counts');
const temporary = mkdtempSync(join(tmpdir(), 'research-performance-'));
try {
  const snapshot = join(temporary, 'source');
  mkdirSync(snapshot);
  const archive = execFileSync('git', ['archive', commit, 'src'], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
  execFileSync('tar', ['-x', '-C', snapshot], { input: archive });
  await build({
    configFile: false,
    root,
    logLevel: 'error',
    resolve: { alias: { '@performance-source': join(snapshot, 'src') } },
    build: {
      ssr: join(root, 'scripts/performance/workloads.mjs'),
      outDir: join(temporary, 'bundle'),
      emptyOutDir: true,
      minify: false,
    },
  });
  const raw = execFileSync(
    process.execPath,
    ['--expose-gc', join(temporary, 'bundle/workloads.js')],
    {
      env: { ...process.env, PERF_WARMUPS: String(warmups), PERF_SAMPLES: String(samples) },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const records = JSON.parse(raw);
  const report = {
    schema: 1,
    harnessChecksum: checksum(
      ['run.mjs', 'workloads.mjs', 'metrics.mjs'].map((name) =>
        readFileSync(join(root, 'scripts/performance', name), 'utf8'),
      ),
    ),
    packageLockChecksum: checksum(readFileSync(join(root, 'package-lock.json'), 'utf8')),
    commit,
    recordedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
    },
    warmups,
    samples,
    memoryNote:
      'Heap deltas are before/after forced GC with output retained; they are noisy whole-process observations, not peak allocation, browser memory, or a leak test. Timings exclude GC and correctness hashing.',
    records,
  };
  const baselineFile = option('--compare', null);
  if (baselineFile) {
    const baseline = JSON.parse(readFileSync(resolve(baselineFile), 'utf8'));
    compareResults(baseline.records, records);
    report.comparedWith = { commit: baseline.commit, exactResultsEqual: true };
  }
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `Commit ${commit}; ${warmups} warmups / ${samples} samples; exact comparison: ${baselineFile ? 'PASS' : 'not requested'}`,
  );
  for (const row of records) {
    console.log(
      `${row.key.padEnd(36)} ${row.mode.padEnd(12)} median ${row.medianMs.toFixed(3)} ms p95 ${row.p95Ms.toFixed(3)} ms checksum ${row.checksum.slice(0, 12)}`,
    );
  }
  console.log(`JSON: ${output}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
