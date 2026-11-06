import { describe, expect, it } from 'vitest';
import { summarize, checksum, compareResults } from './metrics.mjs';

describe('performance result verification', () => {
  it('computes nearest-rank p95 and conventional median without changing input', () => {
    const values = [4, 1, 3, 2];
    expect(summarize(values)).toEqual({ medianMs: 2.5, p95Ms: 4 });
    expect(values).toEqual([4, 1, 3, 2]);
  });
  it('rejects missing workloads and exact output changes, not timing changes', () => {
    const record = { key: 'case', result: [{ start: 1 }], medianMs: 2 };
    expect(() => compareResults([record], [{ ...record, medianMs: 9 }])).not.toThrow();
    expect(() => compareResults([record], [])).toThrow();
    expect(() => compareResults([record], [{ ...record, result: [{ start: 2 }] }])).toThrow();
    expect(checksum(record.result)).toBe(checksum([{ start: 1 }]));
    expect(checksum(record.result)).not.toBe(checksum([{ start: 2 }]));
  });
});
