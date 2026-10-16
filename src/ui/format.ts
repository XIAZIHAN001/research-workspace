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
