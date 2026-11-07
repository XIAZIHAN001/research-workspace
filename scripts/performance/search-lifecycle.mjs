import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { summarize } from './metrics.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const repetitions = Number(option('--repetitions', '5'));
const cycles = Number(option('--cycles', '3'));
const sizes = option('--sizes', '1000,10000').split(',').map(Number);
if (!Number.isInteger(repetitions) || repetitions < 1 || !Number.isInteger(cycles) || cycles < 1)
  throw new Error('Invalid sample counts');
if (sizes.some((size) => !Number.isInteger(size) || size < 4 || size % 4 !== 0))
  throw new Error('Invalid sizes');
const hash = (data) => createHash('sha256').update(data).digest('hex');
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const revisions = ['baseline', 'candidate'].map((label) => {
  const requested = option(`--${label}`, null);
  if (!requested) throw new Error(`--${label} must name a fixed commit`);
  return { label, commit: git('rev-parse', '--verify', `${requested}^{commit}`).trim() };
});
const packageLockChecksum = hash(readFileSync(join(root, 'package-lock.json')));
for (const revision of revisions) {
  if (hash(git('show', `${revision.commit}:package-lock.json`)) !== packageLockChecksum)
    throw new Error(`Package-lock mismatch for ${revision.label}`);
}
const temporary = mkdtempSync(join(tmpdir(), 'search-lifecycle-'));
const records = [];
try {
  for (const revision of revisions) {
    const snapshot = join(temporary, revision.label, 'source');
    mkdirSync(snapshot, { recursive: true });
    const archive = execFileSync('git', ['archive', revision.commit, 'src'], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    execFileSync('tar', ['-x', '-C', snapshot], { input: archive });
    const outDir = join(temporary, revision.label, 'bundle');
    await build({
      root,
      configFile: false,
      logLevel: 'error',
      resolve: { alias: { '@lifecycle-source': join(snapshot, 'src') } },
      build: {
        ssr: join(directory, 'search-lifecycle-workload.mjs'),
        outDir,
        emptyOutDir: true,
        minify: false,
      },
    });
    revision.bundle = join(outDir, 'search-lifecycle-workload.js');
    revision.sourceBlob = git(
      'rev-parse',
      `${revision.commit}:src/features/search/searchWorkspace.ts`,
    ).trim();
  }
  for (const size of sizes)
    for (let repetition = 0; repetition < repetitions; repetition++) {
      const order = repetition % 2 === 0 ? revisions : [...revisions].reverse();
      for (const revision of order) {
        const output = execFileSync(process.execPath, ['--expose-gc', revision.bundle], {
          env: { ...process.env, LIFECYCLE_SIZE: String(size), LIFECYCLE_CYCLES: String(cycles) },
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
        });
        records.push({
          label: revision.label,
          commit: revision.commit,
          repetition: repetition + 1,
          ...JSON.parse(output),
        });
      }
    }
  for (const size of sizes) {
    const checksums = new Set(
      records
        .filter((record) => record.size === size)
        .flatMap((record) => record.records.map((cycle) => cycle.resultChecksum)),
    );
    if (checksums.size !== 1) throw new Error(`Full-result checksums differ at size ${size}`);
  }
  const report = {
    schema: 1,
    recordedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      v8: process.versions.v8,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
    },
    revisions: revisions.map(({ label, commit, sourceBlob }) => ({ label, commit, sourceBlob })),
    scriptChecksum: hash(
      JSON.stringify(
        ['search-lifecycle.mjs', 'search-lifecycle-workload.mjs', 'metrics.mjs'].map((name) => ({
          name,
          source: readFileSync(join(directory, name), 'utf8'),
        })),
      ),
    ),
    packageLockChecksum,
    repetitions,
    cycles,
    sizes,
    method:
      'Alternating fresh processes; three 1k-record warmup lifecycles; source retained globally; each recorded phase follows an event-loop boundary and three forced GCs. All four groups are materialized by a single unlimited search; returned arrays and hashing intermediates are released. A WeakRef records whether collection is observed after release; lack of an observation alone does not prove a strong reference or leak.',
    caveats:
      'Whole-process retained JS heap, not peak allocation, RSS, DOM, browser memory, or a general leak proof. Source string flattening, JIT/code caches and small measurement objects can leave residuals or negative deltas. No elapsed times are measured or claimed.',
    exactFullResultsEqual: true,
    records,
  };
  const output = resolve(option('--out', '/tmp/research-workspace-search-lifecycle.json'));
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  for (const size of sizes)
    for (const label of ['baseline', 'candidate']) {
      const samples = records.filter((record) => record.size === size && record.label === label);
      console.log(
        JSON.stringify({
          size,
          label,
          firstCycleMedianBytes: Object.fromEntries(
            ['builtDeltaBytes', 'fullyMaterializedDeltaBytes', 'releasedDeltaBytes'].map((key) => [
              key,
              summarize(samples.map((sample) => sample.records[0][key])).medianMs,
            ]),
          ),
          allIndexesCollected: samples.every((sample) =>
            sample.records.every((cycle) => cycle.indexCollected),
          ),
        }),
      );
    }
  console.log(`JSON: ${output}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
