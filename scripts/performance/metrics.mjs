import { createHash } from 'node:crypto';
import { deepStrictEqual } from 'node:assert';

export function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

export function checksum(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function compareResults(baseline, candidate) {
  deepStrictEqual(
    candidate.map((row) => row.key),
    baseline.map((row) => row.key),
  );
  for (let i = 0; i < baseline.length; i++) {
    deepStrictEqual(candidate[i].result, baseline[i].result, baseline[i].key);
  }
}
