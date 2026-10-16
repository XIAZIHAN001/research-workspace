import { collapseWhitespace, normalizeQuote } from '../../domain/annotation';

/**
 * Locating a saved highlight in a freshly rendered page.
 *
 * The page's text is indexed exactly the way the browser hands it to the reader — text runs in
 * DOM order, with a line break between the runs that the text layer separates — so a quote the
 * user selected and the same quote in the index are compared under identical rules. Matching is
 * deliberately conservative: a quote that occurs more than once is only accepted when its
 * surrounding text says which one it is, and otherwise reported as ambiguous rather than
 * guessed at.
 */

/** One piece of a page's text: a run from a span, or the break between two lines. */
export type PageRun = { kind: 'text'; span: number; text: string } | { kind: 'break' };

/**
 * Origin offset given to the character a line break contributes. A break is not a character of
 * any span, so it is marked with an offset no real character can have; scanning a span's
 * characters then never mistakes a break for one of them.
 */
export const BREAK_ORIGIN = -1;

export interface PageTextMap {
  /** The page's text with whitespace collapsed, the same way a stored quote is normalized. */
  text: string;
  /** Where each character of `text` came from. A line break carries `BREAK_ORIGIN`. */
  origin: { span: number; offset: number }[];
}

/**
 * Builds the page index. Whitespace inside a run collapses to a single space (as it does in a
 * stored quote), and a line break becomes a space for the same reason.
 */
export function buildPageText(runs: readonly PageRun[]): PageTextMap {
  let text = '';
  const origin: { span: number; offset: number }[] = [];
  let lastSpan = 0;

  for (const run of runs) {
    if (run.kind === 'break') {
      if (text !== '' && !text.endsWith(' ')) {
        text += ' ';
        origin.push({ span: lastSpan, offset: BREAK_ORIGIN });
      }
      continue;
    }
    lastSpan = run.span;
    let previousWasSpace = false;
    for (let offset = 0; offset < run.text.length; offset += 1) {
      const character = run.text[offset] ?? '';
      if (/\s/.test(character)) {
        if (previousWasSpace) continue;
        previousWasSpace = true;
        text += ' ';
      } else {
        previousWasSpace = false;
        text += character;
      }
      origin.push({ span: run.span, offset });
    }
  }

  return { text, origin };
}

export type AnchorMatch =
  /** Exactly one place matched, with the given context score. */
  | { kind: 'found'; start: number; end: number; score: number; occurrences: number }
  /** Several places matched equally well: the caller must say so instead of picking one. */
  | { kind: 'ambiguous'; occurrences: number }
  /** The quote is not on this page at all. */
  | { kind: 'missing' };

function commonSuffixLength(one: string, other: string): number {
  let count = 0;
  while (count < one.length && count < other.length) {
    if (one[one.length - 1 - count] !== other[other.length - 1 - count]) break;
    count += 1;
  }
  return count;
}

function commonPrefixLength(one: string, other: string): number {
  let count = 0;
  while (count < one.length && count < other.length) {
    if (one[count] !== other[count]) break;
    count += 1;
  }
  return count;
}

/**
 * Finds the stored quote on a page.
 *
 * Occurrences are ranked by how much of the stored surrounding text they reproduce. A clear
 * winner is accepted; a tie means the page contains the same passage more than once and nothing
 * in the record says which one it was, which is reported as `ambiguous` — highlighting the
 * wrong paragraph would be worse than not highlighting at all.
 */
export function matchQuote(
  page: PageTextMap,
  anchor: { quote: string; prefix: string; suffix: string },
): AnchorMatch {
  const quote = normalizeQuote(anchor.quote);
  if (quote === '') return { kind: 'missing' };

  // Collapsed but not trimmed: the boundary spaces are part of what lines up with the page.
  const prefix = collapseWhitespace(anchor.prefix);
  const suffix = collapseWhitespace(anchor.suffix);
  const scores: { start: number; end: number; score: number }[] = [];

  let from = page.text.indexOf(quote);
  while (from !== -1) {
    const end = from + quote.length;
    scores.push({
      start: from,
      end,
      score:
        commonSuffixLength(page.text.slice(0, from), prefix) +
        commonPrefixLength(page.text.slice(end), suffix),
    });
    from = page.text.indexOf(quote, from + 1);
  }

  if (scores.length === 0) return { kind: 'missing' };

  const ranked = [...scores].sort((one, other) => other.score - one.score);
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (best === undefined) return { kind: 'missing' };
  if (runnerUp !== undefined && runnerUp.score === best.score) {
    return { kind: 'ambiguous', occurrences: scores.length };
  }
  return {
    kind: 'found',
    start: best.start,
    end: best.end,
    score: best.score,
    occurrences: scores.length,
  };
}

/** Walks from `index` in `direction` until it finds a character that belongs to a span. */
function firstCharacterAt(
  page: PageTextMap,
  index: number,
  direction: 1 | -1,
): { span: number; offset: number } | undefined {
  for (let cursor = index; cursor >= 0 && cursor < page.origin.length; cursor += direction) {
    const entry = page.origin[cursor];
    if (entry !== undefined && entry.offset >= 0) return entry;
  }
  return undefined;
}

/** The span indices and character offsets a page-text range covers. */
export interface SpanRange {
  startSpan: number;
  startOffset: number;
  endSpan: number;
  endOffset: number;
}

/**
 * Maps a range of the page text back onto spans, so a DOM range can be built for it. The end
 * offset is exclusive, matching `Range.setEnd`.
 */
export function locateSpanRange(
  page: PageTextMap,
  start: number,
  end: number,
  spanTexts: readonly string[],
): SpanRange | null {
  const first = firstCharacterAt(page, start, 1);
  const last = firstCharacterAt(page, Math.max(start, end - 1), -1);
  if (first === undefined || last === undefined) return null;
  const lastText = spanTexts[last.span] ?? '';
  return {
    startSpan: first.span,
    startOffset: Math.min(first.offset, (spanTexts[first.span] ?? '').length),
    endSpan: last.span,
    endOffset: Math.min(last.offset + 1, lastText.length),
  };
}
