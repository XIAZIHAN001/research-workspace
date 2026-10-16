import { daysBetween } from '../domain/time';

/** Coarse on purpose, for dense lists: 今天 / 昨天 / 3 天前 / 2 周前 / 4 个月前 / 1 年前. */
export function formatRelativeDay(then: number, now: number): string {
  const days = daysBetween(then, now);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

const UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/** File size for a dense row: "820 KB". Never more than one decimal place. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${String(rounded)} ${UNITS[unit] ?? 'B'}`;
}
