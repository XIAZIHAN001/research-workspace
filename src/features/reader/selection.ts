import type { NormalizedRect } from '../../domain/annotation';
import {
  buildPageText,
  locateSpanRange,
  matchQuote,
  type AnchorMatch,
  type PageRun,
  type PageTextMap,
  type SpanRange,
} from './anchor';
import { foldForFind } from './findText';

/**
 * Reading a page's rendered text layer, and turning a selection into something that can be
 * found again.
 *
 * Everything here is about *this* rendering: the text runs the browser laid out, the boxes the
 * browser measured. What leaves this module is only ever text and fractions of the page box —
 * no element references — because that is what survives closing the reader.
 */

export interface PageTextLayout {
  runs: PageRun[];
  /** The leaf text spans, in DOM order; index matches `PageRun.span`. */
  leaves: HTMLElement[];
  page: PageTextMap;
}

function isLeafSpan(element: HTMLElement): boolean {
  return element.tagName === 'SPAN' && element.querySelector('span') === null;
}

/**
 * Walks the rendered text layer in document order.
 *
 * Line breaks are kept as runs of their own, exactly where the DOM has them, so the indexed
 * text matches what selecting the same lines produces.
 */
export function readPageText(container: HTMLElement): PageTextLayout {
  const runs: PageRun[] = [];
  const leaves: HTMLElement[] = [];

  const visit = (node: Node, spanIndex: number): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? '';
        if (spanIndex >= 0 && text !== '') runs.push({ kind: 'text', span: spanIndex, text });
        continue;
      }
      if (!(child instanceof HTMLElement)) continue;
      if (child.tagName === 'BR') {
        runs.push({ kind: 'break' });
        continue;
      }
      if (isLeafSpan(child)) {
        leaves.push(child);
        visit(child, leaves.length - 1);
        continue;
      }
      visit(child, spanIndex);
    }
  };

  visit(container, -1);
  return { runs, leaves, page: buildPageText(runs) };
}

/** The leaf spans of a page, in DOM order. */
export function textSpans(pageRoot: HTMLElement): HTMLElement[] {
  return [...pageRoot.querySelectorAll<HTMLElement>('.textLayer span')].filter(isLeafSpan);
}

/** The character offset inside a span for a DOM position, or null when it is outside it. */
function offsetInSpan(span: HTMLElement, node: Node, offset: number): number | null {
  if (node === span) {
    const child = span.childNodes[offset] ?? null;
    if (child === null) return span.textContent?.length ?? null;
    let position = 0;
    for (const candidate of span.childNodes) {
      if (candidate === child) return position;
      position += candidate.textContent?.length ?? 0;
    }
    return null;
  }
  if (node.nodeType === Node.TEXT_NODE && node.parentNode === span) return offset;
  for (const child of span.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    const found = offsetInSpan(span, child, offset);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Index into the page text for a DOM position, so a selection can be measured in text terms.
 *
 * `edge` matters at the ends of a span. A range that ends exactly at the end of a span — which
 * is what dragging to the end of a line does — names an offset one past the last character,
 * and there is no page-text character with that offset. Read as an end, it means "just after
 * the last character this span contributed"; read as a start, it means the same position, and
 * the range is then empty.
 */
function pageOffsetOf(
  layout: PageTextLayout,
  node: Node,
  offset: number,
  edge: 'start' | 'end',
): number | null {
  const span = (
    node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement)
  )?.closest('span');
  if (span === null || span === undefined) return null;
  const spanIndex = layout.leaves.indexOf(span);
  if (spanIndex < 0) return null;
  const raw = offsetInSpan(span, node, offset);
  if (raw === null) return null;

  const origin = layout.page.origin;
  const isCharacter = (entry: { span: number; offset: number }): boolean =>
    entry.span === spanIndex && entry.offset >= 0;
  if (edge === 'start') {
    const found = origin.findIndex((entry) => isCharacter(entry) && entry.offset >= raw);
    if (found >= 0) return found;
    // Past the last character of this span: the position after it.
    return lastPositionAfter(origin, spanIndex);
  }

  let before = -1;
  origin.forEach((entry, index) => {
    if (isCharacter(entry) && entry.offset < raw) before = index;
  });
  if (before >= 0) return before + 1;
  // Before this span's first character: the position where it starts.
  const first = origin.findIndex(isCharacter);
  return first < 0 ? null : first;
}

/** The page-text index just past everything a span contributed. */
function lastPositionAfter(origin: PageTextMap['origin'], spanIndex: number): number | null {
  let last = -1;
  origin.forEach((entry, index) => {
    if (entry.span === spanIndex && entry.offset >= 0) last = index;
  });
  return last < 0 ? null : last + 1;
}

export interface SelectionAnchor {
  page: number;
  quote: string;
  prefix: string;
  suffix: string;
  rects: NormalizedRect[];
  /** Where the quote sits in the page's own text, so context can be taken from around it. */
  start: number;
  end: number;
}

/** The selection's boxes on the page, as fractions of the page box. */
export function normalizedRects(range: Range, pageRoot: HTMLElement): NormalizedRect[] {
  const box = pageRoot.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return [];
  return [...range.getClientRects()]
    .filter((rect) => rect.width > 0.5 && rect.height > 0.5)
    .map((rect) => ({
      x: (rect.left - box.left) / box.width,
      y: (rect.top - box.top) / box.height,
      width: rect.width / box.width,
      height: rect.height / box.height,
    }));
}

export interface SelectionFailure {
  reason: 'no-text' | 'not-in-page' | 'reversed';
  message: string;
}

/**
 * Describes what the reader selected, in terms that can be stored and matched later.
 *
 * The quote, prefix and suffix are taken from the page's own indexed text rather than from the
 * DOM string, so the three pieces are guaranteed to be consistent with each other and with the
 * text that matching will later search. The boxes come from the browser's own geometry.
 */
export function describeSelection(
  pageRoot: HTMLElement,
  pageNumber: number,
  range: Range,
): SelectionAnchor | SelectionFailure {
  const container = pageRoot.querySelector<HTMLElement>('.textLayer');
  if (container === null) {
    return { reason: 'no-text', message: '这一页没有可提取的文字，无法高亮。' };
  }
  const layout = readPageText(container);
  const start = pageOffsetOf(layout, range.startContainer, range.startOffset, 'start');
  const end = pageOffsetOf(layout, range.endContainer, range.endOffset, 'end');
  if (start === null || end === null) {
    return { reason: 'not-in-page', message: '这段选择不在同一页的可选文字里，暂时无法保存。' };
  }
  if (end <= start) return { reason: 'reversed', message: '这段选择是空的。' };

  const quote = layout.page.text.slice(start, end);
  return {
    page: pageNumber,
    quote,
    prefix: layout.page.text.slice(Math.max(0, start - 40), start),
    suffix: layout.page.text.slice(end, end + 40),
    rects: normalizedRects(range, pageRoot),
    start,
    end,
  };
}

export interface LocateResult {
  match: AnchorMatch;
  range: Range | null;
  rects: NormalizedRect[];
}

/**
 * Finds a stored anchor in the page as it is rendered now.
 *
 * The boxes come from the browser's geometry for the matched text, so a highlight lands exactly
 * on the words — but only when the match is unambiguous. An ambiguous or missing match returns
 * no range at all, and the caller decides what to tell the reader.
 */
export function locateAnchor(
  pageRoot: HTMLElement,
  anchor: { quote: string; prefix: string; suffix: string },
): LocateResult {
  const container = pageRoot.querySelector<HTMLElement>('.textLayer');
  if (container === null) return { match: { kind: 'missing' }, range: null, rects: [] };

  const layout = readPageText(container);
  const match = matchQuote(layout.page, anchor);
  if (match.kind !== 'found') return { match, range: null, rects: [] };

  const located = locateSpanRange(
    layout.page,
    match.start,
    match.end,
    layout.leaves.map((leaf) => leaf.textContent ?? ''),
  );
  if (located === null) return { match: { kind: 'missing' }, range: null, rects: [] };

  const range = rangeFor(located, layout.leaves);
  if (range === null) return { match: { kind: 'missing' }, range: null, rects: [] };
  return { match, range, rects: normalizedRects(range, pageRoot) };
}

/** Builds a DOM range for a span range, or null when it cannot be represented. */
function rangeFor(located: SpanRange, leaves: readonly HTMLElement[]): Range | null {
  const startSpan = leaves[located.startSpan];
  const endSpan = leaves[located.endSpan];
  if (startSpan === undefined || endSpan === undefined) return null;
  const range = document.createRange();
  try {
    const startPoint = pointInSpan(startSpan, located.startOffset);
    const endPoint = pointInSpan(endSpan, located.endOffset);
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
  } catch {
    return null;
  }
  return range;
}

/** One occurrence of the query on a rendered page, with boxes to draw it on the paper. */
export interface PageFindHit {
  /** Offsets in the page's indexed text. */
  start: number;
  end: number;
  rects: NormalizedRect[];
}

/**
 * Finds every occurrence of `query` on one rendered page.
 *
 * Used only for the page the reader is looking at: the column renders a window of pages, and
 * the other hits are represented by the count and by jumping. A match that cannot be turned
 * into boxes (a broken text run, a detached page) is skipped rather than drawn somewhere
 * approximate.
 */
export function locateAll(pageRoot: HTMLElement, query: string): PageFindHit[] {
  const container = pageRoot.querySelector<HTMLElement>('.textLayer');
  if (container === null) return [];
  const layout = readPageText(container);
  const folded = foldForFind(layout.page.text);
  const needle = foldForFind(query).text;
  if (needle === '') return [];

  const spanTexts = layout.leaves.map((leaf) => leaf.textContent ?? '');
  const found: PageFindHit[] = [];
  let from = 0;
  for (;;) {
    const at = folded.text.indexOf(needle, from);
    if (at === -1) break;
    const start = folded.map[at];
    const last = folded.map[at + needle.length - 1];
    if (start !== undefined && last !== undefined) {
      const located = locateSpanRange(layout.page, start, last + 1, spanTexts);
      const range = located === null ? null : rangeFor(located, layout.leaves);
      if (range !== null) {
        const rects = normalizedRects(range, pageRoot);
        if (rects.length > 0) found.push({ start, end: last + 1, rects });
      }
    }
    from = at + needle.length;
  }
  return found;
}

function pointInSpan(span: HTMLElement, offset: number): { node: Node; offset: number } {
  let remaining = offset;
  for (const node of span.childNodes) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) return { node, offset: Math.max(0, remaining) };
    remaining -= length;
  }
  const last = span.lastChild;
  return last === null
    ? { node: span, offset: 0 }
    : { node: last, offset: last.textContent?.length ?? 0 };
}

/** The page element a DOM node belongs to, or null when it is not inside a rendered page. */
export function pageElementOf(node: Node | null): HTMLElement | null {
  const element =
    node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement | null);
  return element?.closest('.pdf-page') ?? null;
}

/** The 1-based page number of a page element, or null when it does not carry one. */
export function pageNumberOf(page: HTMLElement): number | null {
  const raw = page.dataset.page;
  if (raw === undefined) return null;
  const number = Number(raw);
  return Number.isInteger(number) && number >= 1 ? number : null;
}
