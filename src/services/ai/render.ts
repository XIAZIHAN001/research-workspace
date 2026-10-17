/**
 * Turning an answer into something that can be rendered without trusting it.
 *
 * Everything the model produced is text. It is never parsed as markup and never reaches the
 * document as HTML — the only structure this module adds is the one the interface needs to make
 * a citation clickable, and the one it needs to set mathematics. The first is added only where a
 * marker matches a citation the service already verified; a `[7]` with nothing behind it stays a
 * `[7]` in the prose. The second is passed to KaTeX, which builds the DOM itself; this module
 * hands it a string and never evaluates anything.
 */

import type { AiCitation } from './types';

export type InlinePiece =
  | { kind: 'text'; text: string }
  | { kind: 'citation'; citation: AiCitation }
  | { kind: 'math'; latex: string; display: boolean };

export interface AnswerParagraph {
  pieces: InlinePiece[];
}

const MARKER = /\[(\d{1,2})\]/g;

/**
 * The math delimiters, longest first so `$$` is never mistaken for two inline `$`.
 *
 * `\(…\)` and `\[…\]` are here because models write them even when asked for dollars, and a
 * formula shown as literal backslashes is worse than one shown badly.
 */
const MATH = [
  { open: '$$', close: '$$', display: true },
  { open: '\\[', close: '\\]', display: true },
  { open: '\\(', close: '\\)', display: false },
  { open: '$', close: '$', display: false },
];

/** True when the character at `index` is preceded by an odd number of backslashes. */
function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/**
 * Splits a block into prose and mathematics.
 *
 * A delimiter only counts when it is closed later in the same block, so an unclosed `$` — a
 * price, a stray dollar sign, a formula the model forgot to finish — stays as the text it is.
 */
function splitMath(text: string): { kind: 'text' | 'math'; text: string; display: boolean }[] {
  const parts: { kind: 'text' | 'math'; text: string; display: boolean }[] = [];
  let cursor = 0;
  let plain = '';

  const flush = (): void => {
    if (plain !== '') parts.push({ kind: 'text', text: plain, display: false });
    plain = '';
  };

  while (cursor < text.length) {
    // Nothing left that could open a formula: the rest is prose, however many backslashes it has.
    if (text.indexOf('$', cursor) < 0 && text.indexOf('\\', cursor) < 0) {
      plain += text.slice(cursor);
      break;
    }

    const delimiter = MATH.find((candidate) => {
      if (!text.startsWith(candidate.open, cursor) || isEscaped(text, cursor)) return false;
      const start = cursor + candidate.open.length;
      const end = text.indexOf(candidate.close, start);
      if (end < 0) return false;
      // An inline pair has to close on the same line: a lone `$` in prose, or a `$` left over
      // from a formula the model never finished, must not swallow the paragraph after it.
      if (!candidate.display && text.slice(start, end).includes('\n')) return false;
      return true;
    });
    if (delimiter === undefined) {
      plain += text[cursor];
      cursor += 1;
      continue;
    }

    const start = cursor + delimiter.open.length;
    const end = text.indexOf(delimiter.close, start);
    const latex = text.slice(start, end);
    // `$$` and `$` share a closing character, so a stray `$$` can pair with the `$` of an
    // inline formula. Empty content or surrounding whitespace means it did not; treat it as text.
    if (latex.trim() === '' || (!delimiter.display && /^\s|\s$/.test(latex))) {
      plain += text[cursor];
      cursor += 1;
      continue;
    }

    flush();
    parts.push({ kind: 'math', text: latex, display: delimiter.display });
    cursor = end + delimiter.close.length;
  }
  flush();
  return parts;
}

/** Splits one run of prose into text and verified citations. */
function citeText(text: string, citations: readonly AiCitation[]): InlinePiece[] {
  const byNumber = new Map(citations.map((citation) => [citation.n, citation]));
  const pieces: InlinePiece[] = [];
  let cursor = 0;
  for (const match of text.matchAll(MARKER)) {
    const at = match.index;
    const citation = byNumber.get(Number(match[1]));
    if (citation === undefined) continue;
    if (at > cursor) pieces.push({ kind: 'text', text: text.slice(cursor, at) });
    pieces.push({ kind: 'citation', citation });
    cursor = at + match[0].length;
  }
  if (cursor < text.length) pieces.push({ kind: 'text', text: text.slice(cursor) });
  return pieces;
}

/** Splits one paragraph into runs of prose, mathematics and verified citations. */
export function segmentParagraph(text: string, citations: readonly AiCitation[]): InlinePiece[] {
  const pieces: InlinePiece[] = [];
  for (const part of splitMath(text)) {
    if (part.kind === 'math') {
      pieces.push({ kind: 'math', latex: part.text, display: part.display });
      continue;
    }
    pieces.push(...citeText(part.text, citations));
  }
  return pieces.filter((piece) => piece.kind !== 'text' || piece.text !== '');
}

/**
 * Paragraphs for rendering. Blank lines separate blocks; nothing else is interpreted.
 *
 * Blocks are split on blank lines rather than every newline so a `$$…$$` formula written across
 * several lines stays one formula. Line breaks inside a block are preserved by the stylesheet.
 */
export function segmentAnswer(answer: string, citations: readonly AiCitation[]): AnswerParagraph[] {
  const blocks = answer.split(/\n\s*\n/);
  const paragraphs: AnswerParagraph[] = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed === '') continue;
    paragraphs.push({ pieces: segmentParagraph(trimmed, citations) });
  }
  return paragraphs;
}

/** The citations the answer actually refers to, in the order they first appear. */
export function citedInOrder(answer: string, citations: readonly AiCitation[]): AiCitation[] {
  const byNumber = new Map(citations.map((citation) => [citation.n, citation]));
  const seen = new Set<number>();
  const ordered: AiCitation[] = [];
  for (const match of answer.matchAll(MARKER)) {
    const number = Number(match[1]);
    if (seen.has(number)) continue;
    const citation = byNumber.get(number);
    if (citation === undefined) continue;
    seen.add(number);
    ordered.push(citation);
  }
  return ordered;
}

/**
 * The LaTeX sources in an answer, in order.
 *
 * Used to state, in one place, that a formula in the answer is the model's own typesetting —
 * not something extracted from the paper and not something the citation check covers.
 */
export function mathIn(answer: string): string[] {
  return segmentAnswer(answer, []).flatMap((paragraph) =>
    paragraph.pieces.flatMap((piece) => (piece.kind === 'math' ? [piece.latex] : [])),
  );
}
