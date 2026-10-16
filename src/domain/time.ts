const DAY_MS = 86_400_000;

const startOfDay = (timestamp: number): number => new Date(timestamp).setHours(0, 0, 0, 0);

/** Whole calendar days between two instants (local time). Never negative. */
export function daysBetween(then: number, now: number): number {
  return Math.max(0, Math.round((startOfDay(now) - startOfDay(then)) / DAY_MS));
}
