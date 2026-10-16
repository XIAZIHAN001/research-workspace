/** Longest project or paper title the layout can show without truncating. */
export const MAX_NAME_LENGTH = 80;

/** Collapses whitespace and enforces the length limit. Returns null when nothing usable is left. */
export function normalizeName(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const name = Array.from(collapsed).slice(0, MAX_NAME_LENGTH).join('').trim();
  return name === '' ? null : name;
}
