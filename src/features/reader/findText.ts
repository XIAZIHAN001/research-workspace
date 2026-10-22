import { collapseWhitespace } from '../../domain/annotation';

/**
 * Finding words across a whole paper.
 *
 * The index and the query are folded the same way before they meet: lower case, one space for
 * any run of whitespace, and no space at all between two Chinese characters. That last rule is
 * what makes "机器学习" match a page whose text layer broke the phrase into "机 器 学 习" with
 * spaces between the glyphs, which pdf.js does often.
 *
 * Folding keeps a map back to the page's own text, so a result can quote the original casing
 * and punctuation instead of the folded copy it was found through.
 */

export interface FoldedText {
  text: string;
  /** For each character of `text`, the offset of the character it came from. */
  map: number[];
}

/**
 * Reads a pdf.js text content's items into one string.
 *
 * Items are concatenated in the order pdf.js gives them, with a space only where the item says
 * the line ended — never one inserted from geometry. Geometry-based spacing is what puts false
 * spaces inside CJK phrases: neighbouring glyphs sit apart on the page for typographic reasons,
 * not because a word ended.
 */
export function pageTextFromItems(items: readonly unknown[]): string {
  let text = '';
  for (const item of items) {
    if (typeof item !== 'object' || item === null || !('str' in item)) continue;
    const record = item as { str: unknown; hasEOL?: unknown };
    if (typeof record.str !== 'string' || record.str === '') continue;
    text += record.str;
    if (record.hasEOL === true && !/\s$/.test(text)) text += ' ';
  }
  return collapseWhitespace(text);
}

/**
 * Chinese characters and the punctuation that belongs to them.
 *
 * Adjacent characters from these ranges are written without spaces, so a space between them in
 * extracted text is an artefact of extraction and must not stop a phrase from matching.
 */
function isCjk(character: string | undefined): boolean {
  return (
    character !== undefined &&
    /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(character)
  );
}

export function foldForFind(text: string): FoldedText {
  const units: { character: string; source: number }[] = [];
  let pendingSpace: number | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (/\s/.test(character)) {
      if (pendingSpace === null) pendingSpace = index;
      continue;
    }
    if (pendingSpace !== null) {
      units.push({ character: ' ', source: pendingSpace });
      pendingSpace = null;
    }
    for (const lowered of character.toLowerCase()) {
      units.push({ character: lowered, source: index });
    }
  }

  // The ends are not part of a phrase: a leading or trailing break in the page text would
  // otherwise make every query miss by one character.
  while (units[0]?.character === ' ') units.shift();
  while (units.at(-1)?.character === ' ') units.pop();

  const kept = units.filter(
    (unit, index) =>
      !(
        unit.character === ' ' &&
        isCjk(units[index - 1]?.character) &&
        isCjk(units[index + 1]?.character)
      ),
  );

  return {
    text: kept.map((unit) => unit.character).join(''),
    map: kept.map((unit) => unit.source),
  };
}

export interface FindHit {
  /** 1-based page number. */
  page: number;
  /** Offsets in the page's own text, so callers can quote the original casing. */
  start: number;
  end: number;
  /** The matched words as the page spells them. */
  snippet: string;
  /** Which occurrence this is on its page, in reading order. */
  ordinal: number;
}

/**
 * Finds every occurrence of `query`, page by page and in reading order.
 *
 * `limit` bounds the result rather than the scan: a one-letter query on a long paper should
 * still report the first few hundred matches promptly instead of building tens of thousands of
 * records nothing will display.
 */
export function findMatches(pages: readonly string[], query: string, limit = 300): FindHit[] {
  const needle = foldForFind(query).text;
  if (needle === '' || limit <= 0) return [];

  const hits: FindHit[] = [];
  pages.forEach((pageText, index) => {
    if (hits.length >= limit) return;
    const folded = foldForFind(pageText);
    if (folded.text === '') return;

    let ordinal = 0;
    let from = 0;
    for (;;) {
      if (hits.length >= limit) break;
      const at = folded.text.indexOf(needle, from);
      if (at === -1) break;
      const start = folded.map[at];
      const last = folded.map[at + needle.length - 1];
      if (start !== undefined && last !== undefined) {
        hits.push({
          page: index + 1,
          start,
          end: last + 1,
          snippet: pageText.slice(start, last + 1),
          ordinal,
        });
        ordinal += 1;
      }
      from = at + needle.length;
    }
  });
  return hits;
}

/** Moves through results with wrap-around, so Enter at the last one starts again. */
export function nextHitIndex(current: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}
