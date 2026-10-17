import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectPageLayout, measureFragmentation } from './layout';

/**
 * jsdom lays nothing out, so every element reports a zero-sized rectangle. The geometry this
 * module reasons about is therefore supplied by hand: each element carries the box it is
 * pretending to occupy, and the rectangle method reads it back.
 */
const boxes = new WeakMap<Element, { left: number; top: number; width: number; height: number }>();
const original = Element.prototype.getBoundingClientRect;

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element): DOMRect {
    const box = boxes.get(this) ?? { left: 0, top: 0, width: 0, height: 0 };
    return {
      ...box,
      right: box.left + box.width,
      bottom: box.top + box.height,
      x: box.left,
      y: box.top,
      toJSON: () => box,
    } as DOMRect;
  };
});

afterAll(() => {
  Element.prototype.getBoundingClientRect = original;
});

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
  text?: string;
}

function pageWith(page: Box, spans: Box[]): HTMLElement {
  const root = document.createElement('div');
  root.className = 'pdf-page';
  boxes.set(root, page);
  const layer = document.createElement('div');
  layer.className = 'textLayer';
  root.append(layer);
  for (const box of spans) {
    const span = document.createElement('span');
    span.textContent = box.text ?? 'word';
    boxes.set(span, box);
    layer.append(span);
  }
  document.body.append(root);
  return root;
}

const PAGE = { left: 0, top: 0, width: 600, height: 800 };

/** One column of evenly spaced lines. */
function singleColumn(lines: number, x = 50, width = 500): Box[] {
  return Array.from({ length: lines }, (_unused, index) => ({
    left: x,
    top: 100 + index * 20,
    width,
    height: 10,
  }));
}

/** Two columns, listed in reading order: all of column one, then all of column two. */
function twoColumns(lines: number): Box[] {
  const left = Array.from({ length: lines }, (_unused, index) => ({
    left: 40,
    top: 100 + index * 20,
    width: 240,
    height: 10,
  }));
  const right = Array.from({ length: lines }, (_unused, index) => ({
    left: 320,
    top: 100 + index * 20,
    width: 240,
    height: 10,
  }));
  return [...left, ...right];
}

describe('inspectPageLayout', () => {
  it('says nothing about a single-column page', () => {
    const report = inspectPageLayout(pageWith(PAGE, singleColumn(20)));
    expect(report.spans).toBe(20);
    expect(report.lines).toBe(20);
    expect(report.columns).toBe(1);
    expect(report.inversions).toBe(0);
    expect(report.orderSuspect).toBe(false);
    expect(report.notice).toBeNull();
  });

  it('recognises two columns listed in reading order, and reports it without alarm', () => {
    const report = inspectPageLayout(pageWith(PAGE, twoColumns(10)));
    expect(report.columns).toBe(2);
    expect(report.orderSuspect).toBe(false);
    expect(report.notice).toContain('多栏');
    expect(report.notice).not.toContain('不一致');
  });

  it('catches an extraction order that zig-zags between columns', () => {
    const columns = twoColumns(10);
    const interleaved: Box[] = [];
    for (let index = 0; index < 10; index += 1) {
      const left = columns[index];
      const right = columns[index + 10];
      if (left !== undefined) interleaved.push(left);
      if (right !== undefined) interleaved.push(right);
    }
    const report = inspectPageLayout(pageWith(PAGE, interleaved));
    expect(report.inversions).toBeGreaterThan(0);
    expect(report.orderSuspect).toBe(true);
    expect(report.notice).toContain('不一致');
  });

  it('does not mistake a superscript for the start of another column', () => {
    const spans = singleColumn(12);
    // A footnote marker sits a little higher than the line it belongs to.
    const raised = spans[5];
    if (raised !== undefined) raised.top -= 3;
    const report = inspectPageLayout(pageWith(PAGE, spans));
    expect(report.inversions).toBe(0);
    expect(report.orderSuspect).toBe(false);
  });

  it('ignores spans with no text', () => {
    const spans = singleColumn(10);
    spans.push({ left: 0, top: 0, width: 0, height: 0, text: '   ' });
    const report = inspectPageLayout(pageWith(PAGE, spans));
    expect(report.spans).toBe(10);
  });

  it('reports nothing for a page with no text layer at all', () => {
    const report = inspectPageLayout(pageWith(PAGE, []));
    expect(report.spans).toBe(0);
    expect(report.columns).toBe(0);
    expect(report.notice).toBeNull();
    expect(report.orderSuspect).toBe(false);
  });

  it('reports nothing rather than guessing when the page has no measured height', () => {
    const report = inspectPageLayout(
      pageWith({ left: 0, top: 0, width: 0, height: 0 }, singleColumn(10)),
    );
    expect(report.spans).toBe(0);
  });

  it('counts lines by position, not by span count', () => {
    // Four spans sharing two baselines are two lines, not four.
    const spans: Box[] = [
      { left: 40, top: 100, width: 100, height: 10 },
      { left: 160, top: 100, width: 100, height: 10 },
      { left: 40, top: 120, width: 100, height: 10 },
      { left: 160, top: 120, width: 100, height: 10 },
    ];
    expect(inspectPageLayout(pageWith(PAGE, spans)).lines).toBe(2);
  });
});

/**
 * How broken up the selection is, measured before anything is sent.
 *
 * The measurement exists because a typeset formula is not a string in a PDF: the text layer
 * often stores each glyph as its own span. The reader selects `R(u) := log P1(u)`; the model is
 * handed the same characters one span at a time, and this is how the panel learns to say so.
 */
describe('measureFragmentation', () => {
  const layerOf = (texts: string[]): HTMLElement =>
    pageWith(
      PAGE,
      texts.map((text, index) => ({
        left: 40 + index * 20,
        top: 100,
        width: 18,
        height: 12,
        text,
      })),
    );

  const wholeOf = (texts: string[]): { start: number; end: number; quote: string } => {
    const quote = texts.join('');
    return { start: 0, end: quote.length, quote };
  };

  it('says nothing about an ordinary sentence', () => {
    const texts = ['The ', 'attention ', 'weights ', 'are ', 'normalised.'];
    expect(measureFragmentation(layerOf(texts), wholeOf(texts))).toMatchObject({
      fragmented: false,
      notice: null,
    });
  });

  it('flags a formula the text layer split into single glyphs', () => {
    const texts = ['R', '(', 'u', ')', ' := ', 'log', 'P', '1', '(', 'u', ')'];
    const result = measureFragmentation(layerOf(texts), wholeOf(texts));
    expect(result.fragmented).toBe(true);
    expect(result.spans).toBe(11);
    expect(result.singleCharSpans).toBe(9);
    // The sentence has to be about what the model is given, not about what the reader sees.
    expect(result.notice).toContain('碎片');
    expect(result.notice).toContain('9');
  });

  it('is not fooled by the empty spans a text layer is full of', () => {
    // pdf.js emits spans with no text between the visible ones. Counting those would let a
    // blank span per glyph drag the ratio below the threshold and hide a broken formula.
    const glyphs = ['R', '(', 'u', ')', ':=', 'log', 'P', '1', '(', 'u', ')'];
    const texts = glyphs.flatMap((glyph) => [glyph, '']);
    const result = measureFragmentation(layerOf(texts), wholeOf(glyphs));
    expect(result.fragmented).toBe(true);
    expect(result.spans).toBe(11);
    expect(result.singleCharSpans).toBe(9);
  });

  it('counts only the spans the selection touches', () => {
    // A long prose page with a short italic run of single characters in the middle: selecting
    // the prose must not inherit the formula's shape.
    const texts = ['Ordinary ', 'prose ', 'here ', 'and ', 'then ', 'x', 'y', 'z', ' again prose.'];
    const quote = texts.slice(0, 5).join('');
    const result = measureFragmentation(layerOf(texts), {
      start: 0,
      end: quote.length,
      quote,
    });
    expect(result.spans).toBe(5);
    expect(result.fragmented).toBe(false);
  });

  it('reports nothing when there is no text layer to measure', () => {
    const root = document.createElement('div');
    root.className = 'pdf-page';
    expect(measureFragmentation(root, { start: 0, end: 3, quote: 'abc' })).toMatchObject({
      spans: 0,
      fragmented: false,
    });
  });
});
