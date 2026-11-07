import { ok, strictEqual } from 'node:assert';
import { compareResults } from './metrics.mjs';

const nonemptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const sha256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positiveInteger = (value) => Number.isInteger(value) && value > 0;
const provenanceFields = [
  ['schema', (value) => value === 1],
  ['harnessChecksum', sha256],
  ['packageLockChecksum', sha256],
  ['environment.node', nonemptyString],
  ['environment.platform', nonemptyString],
  ['environment.arch', nonemptyString],
  ['environment.cpu', nonemptyString],
  ['environment.logicalCpus', positiveInteger],
  ['warmups', (value) => Number.isInteger(value) && value >= 0],
  ['samples', positiveInteger],
];

export function validateComparisonProvenance(baseline, candidate) {
  for (const [field, valid] of provenanceFields) {
    const read = (report) => field.split('.').reduce((value, key) => value?.[key], report);
    const expected = read(baseline);
    const actual = read(candidate);
    ok(valid(expected), `Invalid baseline report provenance: ${field}; regenerate the report.`);
    ok(valid(actual), `Invalid candidate report provenance: ${field}; regenerate the report.`);
    strictEqual(
      actual,
      expected,
      `Incomparable benchmark reports: ${field} differs; rerun with matching provenance.`,
    );
  }
}

export function compareReports(baseline, candidate) {
  validateComparisonProvenance(baseline, candidate);
  compareResults(baseline.records, candidate.records);
}
