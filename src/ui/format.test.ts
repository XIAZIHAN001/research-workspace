import { describe, expect, it } from 'vitest';
import { formatBytes, formatRelativeDay } from './format';

const DAY = 86_400_000;
// Noon keeps every case away from midnight and from a daylight-saving hour shift.
const now = new Date(2026, 5, 15, 12).getTime();
const daysAgo = (days: number): number => now - days * DAY;

describe('formatRelativeDay', () => {
  it.each([
    { days: 0, expected: '今天' },
    { days: 1, expected: '昨天' },
    { days: 2, expected: '2 天前' },
    { days: 6, expected: '6 天前' },
    { days: 7, expected: '1 周前' },
    { days: 13, expected: '1 周前' },
    { days: 14, expected: '2 周前' },
    { days: 29, expected: '4 周前' },
    { days: 30, expected: '1 个月前' },
    { days: 59, expected: '1 个月前' },
    { days: 60, expected: '2 个月前' },
    { days: 364, expected: '12 个月前' },
    { days: 365, expected: '1 年前' },
    { days: 729, expected: '1 年前' },
    { days: 730, expected: '2 年前' },
  ])('formats $days days ago as "$expected"', ({ days, expected }) => {
    expect(formatRelativeDay(daysAgo(days), now)).toBe(expected);
  });

  it('treats a timestamp in the future as today', () => {
    expect(formatRelativeDay(now + 3 * DAY, now)).toBe('今天');
  });

  it('measures from the calendar day, so late last night is yesterday', () => {
    const lastNight = new Date(2026, 5, 14, 23, 59).getTime();
    const earlyMorning = new Date(2026, 5, 15, 0, 1).getTime();
    expect(formatRelativeDay(lastNight, earlyMorning)).toBe('昨天');
  });
});

describe('formatBytes', () => {
  it.each([
    { label: 'bytes', bytes: 512, expected: '512 B' },
    { label: 'zero', bytes: 0, expected: '0 B' },
    { label: 'kilobytes', bytes: 2048, expected: '2 KB' },
    { label: 'a rounded kilobyte', bytes: 1638, expected: '1.6 KB' },
    { label: 'megabytes', bytes: 5 * 1024 * 1024, expected: '5 MB' },
    { label: 'gigabytes', bytes: 3 * 1024 * 1024 * 1024, expected: '3 GB' },
  ])('formats $label', ({ bytes, expected }) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it('does not invent a size for a number it cannot trust', () => {
    expect(formatBytes(Number.NaN)).toBe('未知大小');
    expect(formatBytes(-1)).toBe('未知大小');
  });
});
