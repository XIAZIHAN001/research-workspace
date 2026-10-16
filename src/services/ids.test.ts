import { describe, expect, it } from 'vitest';
import { makeId } from './ids';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('makeId', () => {
  it('returns a version 4 UUID string', () => {
    expect(makeId()).toMatch(UUID_V4);
  });

  it('does not repeat across many calls', () => {
    const ids = new Set(Array.from({ length: 1_000 }, () => makeId()));
    expect(ids.size).toBe(1_000);
  });
});
