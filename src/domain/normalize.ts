/** Longest project name the layout can show without truncating. */
export const MAX_NAME_LENGTH = 80;

/**
 * Longest paper title we keep.
 *
 * A title is not a label: the reader searches, sorts, cites and exports by it, and real titles
 * run well past eighty characters ("… with a Focus on Zero-Knowledge Proofs" was being cut to
 * "… for Zero-Knowledg"). The lists ellipsize long titles visually; storing the whole string
 * keeps tooltips, search and exports honest.
 */
export const MAX_TITLE_LENGTH = 200;

function normalize(raw: string, max: number): string | null {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const name = Array.from(collapsed).slice(0, max).join('').trim();
  return name === '' ? null : name;
}

/** Collapses whitespace and enforces the name limit. Returns null when nothing usable is left. */
export function normalizeName(raw: string): string | null {
  return normalize(raw, MAX_NAME_LENGTH);
}

/** Collapses whitespace and enforces the title limit. Returns null when nothing usable is left. */
export function normalizeTitle(raw: string): string | null {
  return normalize(raw, MAX_TITLE_LENGTH);
}
