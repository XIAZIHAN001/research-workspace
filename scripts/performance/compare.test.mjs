import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareReports, validateComparisonProvenance } from './compare.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function report() {
  return {
    schema: 1,
    harnessChecksum: 'a'.repeat(64),
    packageLockChecksum: 'b'.repeat(64),
    commit: 'baseline-commit',
    recordedAt: '2026-11-06T12:00:00.000Z',
    environment: {
      node: 'v24.22.1',
      platform: 'linux',
      arch: 'x64',
      cpu: 'Synthetic CPU',
      logicalCpus: 8,
    },
    warmups: 2,
    samples: 3,
    records: [
      {
        key: 'workspace/warm',
        mode: 'scan-repeat',
        medianMs: 2,
        p95Ms: 3,
        sampleMs: [1, 2, 3],
        retainedHeapDeltaBytes: 1024,
        result: [{ id: 'paper-1', snippet: 'Exact output' }],
      },
      { key: 'pdf/cold', result: [] },
    ],
  };
}

function setField(target, path, value) {
  const keys = path.split('.');
  const field = keys.pop();
  const parent = keys.reduce((object, key) => object[key], target);
  if (value === undefined) delete parent[field];
  else parent[field] = value;
}

const changedProvenance = [
  ['schema', 2],
  ['harnessChecksum', 'c'.repeat(64)],
  ['packageLockChecksum', 'd'.repeat(64)],
  ['environment.node', 'v24.23.0'],
  ['environment.platform', 'darwin'],
  ['environment.arch', 'arm64'],
  ['environment.cpu', 'Another CPU'],
  ['environment.logicalCpus', 16],
  ['warmups', 3],
  ['samples', 15],
];

describe('report provenance', () => {
  it.each(changedProvenance)('rejects different %s', (field, value) => {
    const candidate = report();
    setField(candidate, field, value);
    expect(() => compareReports(report(), candidate)).toThrow(field);
  });

  it.each(changedProvenance)('rejects missing %s even in both reports', (field) => {
    const baseline = report();
    const candidate = report();
    setField(baseline, field, undefined);
    setField(candidate, field, undefined);
    expect(() => compareReports(baseline, candidate)).toThrow(field);
  });

  it.each([
    ['schema', 2],
    ['schema', '1'],
    ['harnessChecksum', null],
    ['harnessChecksum', ''],
    ['packageLockChecksum', 'not-a-sha256'],
    ['environment', null],
    ['environment.node', null],
    ['environment.platform', ''],
    ['environment.arch', 1],
    ['environment.cpu', ' '],
    ['environment.logicalCpus', 0],
    ['environment.logicalCpus', 1.5],
    ['warmups', -1],
    ['warmups', '2'],
    ['samples', 0],
    ['samples', 1.5],
  ])('rejects invalid %s (%s) even in both reports', (field, value) => {
    const baseline = report();
    const candidate = report();
    setField(baseline, field, value);
    setField(candidate, field, value);
    expect(() => compareReports(baseline, candidate)).toThrow(field);
  });

  it('accepts different commits, timestamps, implementation modes and measurements', () => {
    const baseline = report();
    const candidate = report();
    candidate.commit = 'candidate-commit';
    candidate.recordedAt = '2026-11-07T12:00:00.000Z';
    Object.assign(candidate.records[0], {
      mode: 'indexed-warm',
      medianMs: 8,
      p95Ms: 9,
      sampleMs: [7, 8, 9],
      retainedHeapDeltaBytes: -512,
      construction: { medianMs: 1 },
    });
    expect(() => compareReports(baseline, candidate)).not.toThrow();
  });

  it('accepts zero warmups and a single sample', () => {
    const baseline = report();
    const candidate = report();
    for (const value of [baseline, candidate]) {
      value.warmups = 0;
      value.samples = 1;
      value.records[0].sampleMs = [2];
    }
    expect(() => compareReports(baseline, candidate)).not.toThrow();
  });

  it('validates provenance before any measurements are available', () => {
    const baseline = report();
    const candidate = report();
    delete candidate.records;
    expect(() => validateComparisonProvenance(baseline, candidate)).not.toThrow();
    candidate.samples = 5;
    expect(() => validateComparisonProvenance(baseline, candidate)).toThrow('samples');
  });

  it('continues comparing full outputs after validating provenance', () => {
    const candidate = report();
    candidate.records[0].result[0].snippet = 'Changed output';
    expect(() => compareReports(report(), candidate)).toThrow('workspace/warm');
  });

  it('continues requiring the same ordered workloads', () => {
    const candidate = report();
    candidate.records.reverse();
    expect(() => compareReports(report(), candidate)).toThrow();
    candidate.records.pop();
    expect(() => compareReports(report(), candidate)).toThrow();
  });

  it('accepts archived schema-1 reports with complete matching provenance', () => {
    const archived = ['baseline-2536305.json', 'candidate-533b9ff.json'].map((name) =>
      JSON.parse(readFileSync(join(root, 'docs/performance', name), 'utf8')),
    );
    expect(() => compareReports(...archived)).not.toThrow();
  });
});

it('rejects incomparable provenance without writing a CLI report', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'research-comparison-test-'));
  try {
    const baseline = JSON.parse(
      readFileSync(join(root, 'docs/performance/baseline-2536305.json'), 'utf8'),
    );
    baseline.harnessChecksum = '0'.repeat(64);
    const baselinePath = join(temporary, 'baseline.json');
    const outputPath = join(temporary, 'candidate.json');
    writeFileSync(baselinePath, JSON.stringify(baseline));
    const run = spawnSync(
      process.execPath,
      [
        'scripts/performance/run.mjs',
        '--ref',
        // The candidate must resolve even in CI's depth-1 checkout.
        'HEAD',
        '--warmups',
        '0',
        '--samples',
        '1',
        '--compare',
        baselinePath,
        '--out',
        outputPath,
      ],
      { cwd: root, encoding: 'utf8', timeout: 60_000 },
    );
    expect(run.error).toBeUndefined();
    expect(run.signal).toBeNull();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Incomparable benchmark reports: harnessChecksum differs');
    expect(existsSync(outputPath)).toBe(false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}, 65_000);
