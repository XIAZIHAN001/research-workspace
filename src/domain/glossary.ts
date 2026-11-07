/**
 * A paper's own vocabulary: the terms a reader chose to define once and look up while reading.
 *
 * Like annotations and bookmarks, an entry belongs to a paper, not to a project — the same PDF
 * is the same paper whichever project opened it, and "what did KZG stand for again?" has the
 * same answer in both.
 */

export interface GlossaryEntry {
  id: string;
  /** The paper whose reading the term belongs to. */
  paperId: string;
  /** The term as it appears in the paper, e.g. "KZG" or "多项式承诺". */
  term: string;
  /** What it means here, in the reader's own words. */
  definition: string;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
}

export const MAX_TERM_LENGTH = 80;
export const MAX_DEFINITION_LENGTH = 600;

export interface GlossaryInput {
  paperId: string;
  term: string;
  definition?: string;
}

/** How long a hover card will wait for the reader to settle on a word. */
export const GLOSSARY_HOVER_DELAY = 260;

/** Case-insensitive for ASCII, which is what abbreviations are; CJK has no case to fold. */
export function normalizeTerm(term: string): string {
  return term.trim().replace(/\s+/g, ' ').slice(0, MAX_TERM_LENGTH);
}

/**
 * Builds an entry. Returns null for a blank term or a paper that is not a paper: a term that
 * cannot be looked up again by its name is worse than not recording it.
 */
export function createGlossaryEntry(
  input: GlossaryInput,
  makeId: () => string,
  now: number,
): GlossaryEntry | null {
  const term = normalizeTerm(input.term);
  if (term === '' || input.paperId === '') return null;
  return {
    id: makeId(),
    paperId: input.paperId,
    term,
    definition: (input.definition ?? '').trim().slice(0, MAX_DEFINITION_LENGTH),
    createdAt: now,
    updatedAt: now,
  };
}

/** What an edit may touch: the meaning, never which paper the term belongs to. */
export interface GlossaryEdit {
  term?: string;
  definition?: string;
}

export function applyGlossaryEdit(
  entry: GlossaryEntry,
  edit: GlossaryEdit,
  now: number,
): GlossaryEntry | null {
  const term = edit.term === undefined ? entry.term : normalizeTerm(edit.term);
  if (term === '') return null;
  const definition =
    edit.definition === undefined
      ? entry.definition
      : edit.definition.trim().slice(0, MAX_DEFINITION_LENGTH);
  if (term === entry.term && definition === entry.definition) return entry;
  return { ...entry, term, definition, updatedAt: now };
}

/** Alphabetical, the order a lookup list wants; ties break by creation time. */
export function sortGlossary(entries: readonly GlossaryEntry[]): GlossaryEntry[] {
  return [...entries].sort(
    (one, other) =>
      one.term.localeCompare(other.term, 'zh-Hans-CN') || one.createdAt - other.createdAt,
  );
}

function isWordChar(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/.test(character);
}

/**
 * ASCII words have boundaries; CJK does not.
 *
 * Without this, the term `AI` matched inside `PAIR` or `said`, and a two-letter abbreviation
 * opened its card while the pointer was on an unrelated word. Chinese terms keep substring
 * matching, which is what a CJK reader expects from a glossary.
 */
function atWordBoundary(haystack: string, at: number, needle: string): boolean {
  const before = haystack[at - 1];
  const after = haystack[at + needle.length];
  if (isWordChar(before) && isWordChar(needle[0])) return false;
  if (isWordChar(after) && isWordChar(needle[needle.length - 1])) return false;
  return true;
}

/**
 * The entry whose occurrence covers a caret offset in the span text, if any.
 *
 * This is the hover's precision rule: the card follows the *character under the pointer*, not
 * the whole span — a sentence that merely mentions a term somewhere does not open its card.
 * Longer terms win at the same position, mirroring `matchGlossary`.
 */
export function matchGlossaryAt(
  entries: readonly GlossaryEntry[],
  spanText: string,
  offset: number,
): GlossaryEntry | null {
  const haystack = spanText.toLowerCase();
  let best: GlossaryEntry | null = null;
  for (const entry of entries) {
    if (entry.term.length < 2) continue;
    const needle = entry.term.toLowerCase();
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      if (
        offset >= at &&
        offset < at + needle.length &&
        atWordBoundary(haystack, at, needle) &&
        (best === null || entry.term.length > best.term.length)
      ) {
        best = entry;
        break;
      }
      from = at + 1;
    }
  }
  return best;
}

/**
 * The entry a hover should show for a piece of page text, if any.
 *
 * PDF text layers split a line into spans, and a term that straddles a span boundary will not
 * be found inside any single one. Rather than splice spans together (that way lies re-layout
 * of the reader), the match is honest about what it can see: a term wholly inside the hovered
 * span. Abbreviations — the terms glossaries exist for — almost always fit.
 */
export function matchGlossary(
  entries: readonly GlossaryEntry[],
  spanText: string,
): GlossaryEntry | null {
  const haystack = spanText.toLowerCase();
  let best: GlossaryEntry | null = null;
  for (const entry of entries) {
    if (entry.term.length < 2) continue;
    const needle = entry.term.toLowerCase();
    let from = 0;
    let found = false;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      if (atWordBoundary(haystack, at, needle)) {
        found = true;
        break;
      }
      from = at + 1;
    }
    if (!found) continue;
    if (best === null || entry.term.length > best.term.length) best = entry;
  }
  return best;
}
