/**
 * Turning an answer into something that can be rendered without trusting it.
 *
 * Everything the model produced is text. It is never parsed as markup and never reaches the
 * document as HTML — the only structure this module adds is the one thing the interface needs
 * to make a citation clickable, and it adds that only where a marker matches a citation the
 * service already verified. A `[7]` with nothing behind it stays a `[7]` in the prose, which is
 * exactly what the reader should see.
 */

import type { AiCitation } from './types';

export type InlinePiece =
  { kind: 'text'; text: string } | { kind: 'citation'; citation: AiCitation };

export interface AnswerParagraph {
  pieces: InlinePiece[];
}

const MARKER = /\[(\d{1,2})\]/g;

/** Splits one paragraph into runs of prose with verified citations pulled out of them. */
export function segmentParagraph(text: string, citations: readonly AiCitation[]): InlinePiece[] {
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
  return pieces.filter((piece) => piece.kind !== 'text' || piece.text !== '');
}

/** Paragraphs for rendering. Blank lines separate blocks; nothing else is interpreted. */
export function segmentAnswer(answer: string, citations: readonly AiCitation[]): AnswerParagraph[] {
  const blocks = answer.split(/\n\s*\n|\n/);
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
