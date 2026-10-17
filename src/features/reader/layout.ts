import { locateSpanRange } from './anchor';
import { readPageText, textSpans } from './selection';

/**
 * What the page's own geometry says about the text that was extracted from it.
 *
 * A PDF has no notion of reading order: the text layer is a sequence of positioned spans, and
 * anything that reflows them — this app, the model, a person reading the context block — is
 * relying on that sequence being the order a human would read. For a single-column page it
 * almost always is. For a two-column paper it depends on how the producer wrote the content
 * stream, and occasionally the columns interleave.
 *
 * So this module measures the thing that actually matters: **is the rendered span order the same
 * order a person would read the page in?** It reconstructs that order from geometry — which
 * column, which line down the column, then across the line — and counts how often two spans
 * that sit next to each other in the extraction disagree with it. Nothing readable does that;
 * a sequence that does has crossed into another column or another block, and it is reported
 * rather than silently sent.
 */

export interface PageLayoutReport {
  /** Leaf spans with usable geometry. */
  spans: number;
  /** Distinct text lines, by vertical position. */
  lines: number;
  /** 1, or 2 and up when a clear horizontal gap splits the lines into columns. */
  columns: number;
  /** Adjacent pairs, in extraction order, that disagree with the order a person would read. */
  inversions: number;
  transitions: number;
  /** True when enough of the order is wrong that it cannot be reading order. */
  orderSuspect: boolean;
  /** A sentence for the reader and for the model, or null when there is nothing to say. */
  notice: string | null;
}

const EMPTY: PageLayoutReport = {
  spans: 0,
  lines: 0,
  columns: 0,
  inversions: 0,
  transitions: 0,
  orderSuspect: false,
  notice: null,
};

interface Box {
  left: number;
  right: number;
  top: number;
  height: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((one, other) => one - other);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

/**
 * Groups spans into lines by vertical position.
 *
 * Clustering rather than rounding: a superscript sits a couple of points above its baseline and
 * belongs to the same line, and rounding to a fixed grid would split it off about half the time.
 */
function clusterLines(
  boxes: readonly Box[],
  tolerance: number,
): { top: number; members: number[] }[] {
  const order = boxes
    .map((box, index) => ({ box, index }))
    .sort((one, other) => one.box.top - other.box.top);
  const lines: { top: number; members: number[] }[] = [];
  for (const { box, index } of order) {
    const last = lines.at(-1);
    if (last !== undefined && box.top - last.top <= tolerance) {
      last.members.push(index);
      continue;
    }
    lines.push({ top: box.top, members: [index] });
  }
  return lines;
}

/** Where the lines split into columns, as an x coordinate, or null for a single column. */
function columnSplit(centres: readonly number[], pageWidth: number): number | null {
  if (centres.length < 6 || pageWidth <= 0) return null;
  const sorted = [...centres].sort((one, other) => one - other);
  let best = { gap: 0, at: -1 };
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = (sorted[index] ?? 0) - (sorted[index - 1] ?? 0);
    if (gap > best.gap) best = { gap, at: index };
  }
  if (best.gap < pageWidth * 0.2 || best.at < 3 || sorted.length - best.at < 3) return null;
  return ((sorted[best.at - 1] ?? 0) + (sorted[best.at] ?? 0)) / 2;
}

export function inspectPageLayout(pageRoot: HTMLElement): PageLayoutReport {
  const pageBox = pageRoot.getBoundingClientRect();
  if (pageBox.width <= 0 || pageBox.height <= 0) return EMPTY;

  const boxes: Box[] = [];
  for (const span of textSpans(pageRoot)) {
    if ((span.textContent ?? '').trim() === '') continue;
    const box = span.getBoundingClientRect();
    if (box.height <= 0 || box.width <= 0) continue;
    boxes.push({ left: box.left, right: box.right, top: box.top, height: box.height });
  }
  if (boxes.length === 0) return EMPTY;

  const lineHeight = median(boxes.map((box) => box.height)) || 1;

  // Columns are found from the spans themselves, not from lines: on a two-column page a line
  // as tall as both columns has its centre in the gutter, which says nothing about anything.
  const centres = boxes.map((box) => (box.left + box.right) / 2 - pageBox.left);
  const split = columnSplit(centres, pageBox.width);
  const columnOf = (index: number): number =>
    split === null || (centres[index] ?? 0) <= split ? 0 : 1;

  /** Reading order as a key: which column, which line down it, then where across the line. */
  const key: [number, number, number][] = new Array(boxes.length).fill([0, 0, 0]);
  let lineCount = 0;
  for (const column of split === null ? [0] : [0, 1]) {
    const members = boxes
      .map((box, index) => ({ box, index }))
      .filter(({ index }) => columnOf(index) === column);
    const lines = clusterLines(
      members.map(({ box }) => box),
      lineHeight * 0.5,
    );
    for (const line of lines) {
      for (const position of line.members) {
        const member = members[position];
        if (member !== undefined) key[member.index] = [column, lineCount, member.box.left];
      }
      lineCount += 1;
    }
  }

  let inversions = 0;
  for (let index = 1; index < key.length; index += 1) {
    const previous = key[index - 1];
    const current = key[index];
    if (previous === undefined || current === undefined) continue;
    if (
      current[0] < previous[0] ||
      (current[0] === previous[0] &&
        (current[1] < previous[1] || (current[1] === previous[1] && current[2] < previous[2])))
    ) {
      inversions += 1;
    }
  }
  const transitions = boxes.length - 1;
  const orderSuspect = transitions > 0 && inversions / transitions > 0.1;

  let notice: string | null = null;
  if (orderSuspect) {
    notice =
      '这一页的文字提取顺序与版面顺序不一致（很可能是多栏排版），' +
      '下面提供的上下文顺序可能与阅读顺序不同。';
  } else if (split !== null) {
    notice = '这一页是多栏排版；提取顺序与版面顺序一致。';
  }

  return {
    spans: boxes.length,
    lines: lineCount,
    columns: split === null ? 1 : 2,
    inversions,
    transitions,
    orderSuspect,
    notice,
  };
}

/**
 * How broken up the selected text is in the PDF's own text layer.
 *
 * A typeset formula is not a string in a PDF: it is a handful of positioned glyphs, and the text
 * layer often stores each symbol as its own span, or splits a fraction into numerator, bar and
 * denominator. The reader sees `R(u) := log P1(u)/P0(u)`; what gets selected and sent may be
 * `R ( u ) := log P 1 ( u ) P 0 ( u )` or worse. This is measured here, before anything leaves
 * the machine, so the panel can say what the model is really being given.
 *
 * The measurement is deliberately crude and stated as a count rather than a verdict: the share
 * of the selection's spans that hold a single character. Prose almost never does that; a broken
 * formula almost always does.
 */
export interface SelectionFragmentation {
  /** Spans the selection touches. */
  spans: number;
  /** Of those, the ones holding exactly one non-space character. */
  singleCharSpans: number;
  /** Characters in the selected text. */
  chars: number;
  /** True when the selection is mostly one glyph per span. */
  fragmented: boolean;
  notice: string | null;
}

const NOT_FRAGMENTED: SelectionFragmentation = {
  spans: 0,
  singleCharSpans: 0,
  chars: 0,
  fragmented: false,
  notice: null,
};

export function measureFragmentation(
  pageRoot: HTMLElement,
  selection: { start: number; end: number; quote: string },
): SelectionFragmentation {
  const layer = pageRoot.querySelector<HTMLElement>('.textLayer');
  if (layer === null) return NOT_FRAGMENTED;
  const layout = readPageText(layer);
  const located = locateSpanRange(
    layout.page,
    selection.start,
    selection.end,
    layout.leaves.map((leaf) => leaf.textContent ?? ''),
  );
  if (located === null) return NOT_FRAGMENTED;

  // Empty spans carry no text and say nothing about fragmentation; a text layer is full of
  // them. Counting them would let one blank span per glyph halve the ratio into a false pass.
  const touched = layout.leaves
    .slice(located.startSpan, located.endSpan + 1)
    .filter((span) => (span.textContent ?? '').trim() !== '');
  const singleCharSpans = touched.filter((span) => {
    const text = (span.textContent ?? '').trim();
    return text.length === 1;
  }).length;

  // A threshold rather than a judgement: half the spans holding one glyph each, over at least
  // six spans. Below that, the sentence is just long words.
  const fragmented = touched.length >= 6 && singleCharSpans / touched.length >= 0.5;

  return {
    spans: touched.length,
    singleCharSpans,
    chars: selection.quote.length,
    fragmented,
    notice: fragmented
      ? `选中的这段原文在 PDF 文字层里是碎的：${String(touched.length)} 个片段里有 ${String(singleCharSpans)} 个只有一个字符，公式或符号很可能被拆成了单字。模型拿到的就是这些碎片，不是排版好的公式。`
      : null,
  };
}
