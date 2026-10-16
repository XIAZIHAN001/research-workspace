import { describe, expect, it } from 'vitest';
import { daysBetween } from './time';

// Local-time constructor, so the cases hold in any time zone.
const at = (year: number, month: number, day: number, hour = 0, minute = 0): number =>
  new Date(year, month - 1, day, hour, minute).getTime();

describe('daysBetween', () => {
  it('is 0 within one calendar day, even 23 hours apart', () => {
    expect(daysBetween(at(2026, 3, 10, 0, 5), at(2026, 3, 10, 23, 55))).toBe(0);
  });

  it('counts calendar days, not blocks of 24 hours', () => {
    expect(daysBetween(at(2026, 3, 9, 23, 59), at(2026, 3, 10, 0, 1))).toBe(1);
  });

  it('spans month and year boundaries', () => {
    expect(daysBetween(at(2025, 12, 31, 12), at(2026, 1, 1, 12))).toBe(1);
    expect(daysBetween(at(2026, 2, 27), at(2026, 3, 1))).toBe(2);
  });

  it('counts a leap day', () => {
    expect(daysBetween(at(2028, 2, 28), at(2028, 3, 1))).toBe(2);
    expect(daysBetween(at(2026, 2, 28), at(2026, 3, 1))).toBe(1);
  });

  it('never goes negative when the clock is behind the timestamp', () => {
    expect(daysBetween(at(2026, 3, 11), at(2026, 3, 10))).toBe(0);
  });
});
