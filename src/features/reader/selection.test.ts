import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeSelection, locateAll, locateAnchor, readPageText, textSpans } from './selection';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  // jsdom does not implement Range geometry; the tests add it and this puts it back.
  delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
});

/**
 * A text layer shaped the way pdf.js builds one: spans for text runs, `<br>` where the page
 * breaks a line, and a `markedContent` wrapper around part of it.
 */
function buildPage(markup: string, pageNumber = 1): HTMLElement {
  const page = document.createElement('div');
  page.className = 'pdf-page';
  page.dataset.page = String(pageNumber);
  page.innerHTML = `<div class="textLayer">${markup}</div>`;
  document.body.append(page);
  return page;
}

const TWO_COLUMN = [
  '<span>The left column starts here</span><br>',
  '<span>and continues on the next line</span><br>',
  '<span class="markedContent"><span>of the same column.</span></span>',
].join('');

describe('readPageText', () => {
  it('reads runs in document order and keeps line breaks', () => {
    const page = buildPage(TWO_COLUMN);
    const container = page.querySelector<HTMLElement>('.textLayer');
    if (container === null) throw new Error('no text layer');
    const layout = readPageText(container);

    expect(layout.leaves).toHaveLength(3);
    expect(layout.runs).toStrictEqual([
      { kind: 'text', span: 0, text: 'The left column starts here' },
      { kind: 'break' },
      { kind: 'text', span: 1, text: 'and continues on the next line' },
      { kind: 'break' },
      { kind: 'text', span: 2, text: 'of the same column.' },
    ]);
    expect(layout.page.text).toBe(
      'The left column starts here and continues on the next line of the same column.',
    );
  });

  it('treats a span wrapped in marked content as one run, not two', () => {
    const page = buildPage(TWO_COLUMN);
    const container = page.querySelector<HTMLElement>('.textLayer');
    const layout = readPageText(container as HTMLElement);
    expect(layout.leaves.map((leaf) => leaf.textContent)).toStrictEqual([
      'The left column starts here',
      'and continues on the next line',
      'of the same column.',
    ]);
  });

  it('finds no spans on a page with no text layer content', () => {
    const page = buildPage('');
    expect(textSpans(page)).toStrictEqual([]);
  });
});

describe('describeSelection', () => {
  function selectFirstTwoLines(page: HTMLElement): Range {
    const spans = textSpans(page);
    const range = document.createRange();
    range.setStart(spans[1]?.firstChild ?? page, 4);
    // Ending after "of" keeps the quote whole words, which is what these assertions check.
    range.setEnd(spans[2]?.firstChild ?? page, 2);
    return range;
  }

  it('describes a selection that crosses a line break', () => {
    const page = buildPage(TWO_COLUMN);
    const described = describeSelection(page, 1, selectFirstTwoLines(page));
    if ('reason' in described) throw new Error(described.message);

    expect(described.page).toBe(1);
    expect(described.quote).toBe('continues on the next line of');
    expect(described.prefix).toBe('The left column starts here and ');
    expect(described.suffix).toBe(' the same column.');
  });

  it('stops at the end of a span when the selection ends there', () => {
    // Dragging to the end of a line names an offset one past its last character.
    const page = buildPage(TWO_COLUMN);
    const spans = textSpans(page);
    const range = document.createRange();
    range.setStart(spans[0]?.firstChild ?? page, 0);
    range.setEnd(spans[1]?.firstChild ?? page, (spans[1]?.textContent ?? '').length);

    const described = describeSelection(page, 1, range);
    if ('reason' in described) throw new Error(described.message);
    expect(described.quote).toBe('The left column starts here and continues on the next line');
    expect(described.suffix).toBe(' of the same column.');
  });

  it('says so when the page has no text layer to anchor to', () => {
    // A page whose text layer is not rendered (an inactive page, or one still loading).
    const page = document.createElement('div');
    page.className = 'pdf-page';
    page.dataset.page = '1';
    document.body.append(page);
    const range = document.createRange();
    range.selectNodeContents(page);
    const described = describeSelection(page, 1, range);
    expect('reason' in described && described.reason).toBe('no-text');
  });

  it('says so when the selection is not inside this page’s text', () => {
    const page = buildPage(TWO_COLUMN);
    const outside = document.createElement('p');
    outside.textContent = 'somewhere else entirely';
    document.body.append(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    const described = describeSelection(page, 1, range);
    expect('reason' in described && described.reason).toBe('not-in-page');
  });

  it('says so when the selection is empty', () => {
    const page = buildPage(TWO_COLUMN);
    const range = selectFirstTwoLines(page);
    range.setEnd(range.startContainer, range.startOffset);
    const described = describeSelection(page, 1, range);
    expect('reason' in described && described.reason).toBe('reversed');
  });

  it('reports geometry as fractions of the page when the browser has layout', () => {
    // jsdom has no layout, so this is the empty case: the browser run checks real boxes.
    const page = buildPage(TWO_COLUMN);
    const described = describeSelection(page, 1, selectFirstTwoLines(page));
    if ('reason' in described) throw new Error(described.message);
    expect(described.rects).toStrictEqual([]);
  });
});

describe('locateAnchor', () => {
  const anchor = {
    quote: 'continues on the next line',
    prefix: 'The left column starts here and ',
    suffix: ' of the same column.',
  };

  it('finds the stored text and hands back a range over exactly that text', () => {
    const page = buildPage(TWO_COLUMN);
    const located = locateAnchor(page, anchor);
    expect(located.match.kind).toBe('found');
    expect(located.range?.toString()).toBe('continues on the next line');
  });

  it('reports a quote that is no longer on the page', () => {
    const page = buildPage(TWO_COLUMN);
    expect(
      locateAnchor(page, { quote: 'never written here', prefix: '', suffix: '' }).match,
    ).toStrictEqual({ kind: 'missing' });
  });

  it('refuses to choose between two identical passages with no context to separate them', () => {
    const page = buildPage('<span>THE SENTENCE</span><br><span>THE SENTENCE</span>');
    const located = locateAnchor(page, { quote: 'THE SENTENCE', prefix: '', suffix: '' });
    expect(located.match).toStrictEqual({ kind: 'ambiguous', occurrences: 2 });
    expect(located.range).toBeNull();
  });

  it('uses the stored context to pick the right one of two identical passages', () => {
    const page = buildPage(
      '<span>Intro. THE SENTENCE</span><br><span>Later. THE SENTENCE again</span>',
    );
    const located = locateAnchor(page, {
      quote: 'THE SENTENCE',
      prefix: 'Later. ',
      suffix: ' again',
    });
    expect(located.match.kind).toBe('found');
    expect(located.range?.toString()).toBe('THE SENTENCE');
    // The range it found is the one inside the second span, the one the context points at.
    expect(located.range?.startContainer.parentElement?.textContent).toContain('Later');
  });

  it('reports a page with no text layer as missing rather than throwing', () => {
    const page = buildPage('');
    expect(locateAnchor(page, anchor).match).toStrictEqual({ kind: 'missing' });
  });
});

describe('locateAll', () => {
  /** jsdom has no layout, so the page box and the range boxes are supplied explicitly. */
  function withLayout(
    page: HTMLElement,
    boxes: { left: number; top: number; width: number; height: number }[],
  ): void {
    vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 200,
      width: 100,
      height: 200,
      toJSON: () => ({}),
    });
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      writable: true,
      value: () =>
        boxes.map((box) => ({
          ...box,
          x: box.left,
          y: box.top,
          right: box.left + box.width,
          bottom: box.top + box.height,
          toJSON: () => ({}),
        })) as unknown as DOMRectList,
    });
  }

  it('returns boxes for every occurrence on the page, in reading order', () => {
    const page = buildPage('<span>machine learning</span> and <span>machine vision</span>');
    withLayout(page, [{ left: 10, top: 20, width: 30, height: 8 }]);

    const hits = locateAll(page, 'machine');
    expect(hits).toHaveLength(2);
    expect(hits[0]?.rects[0]).toStrictEqual({ x: 0.1, y: 0.1, width: 0.3, height: 0.04 });
  });

  it('marks a hit that crosses a line break with more than one box', () => {
    const page = buildPage('<span>continues on the next</span><br><span>line</span>');
    withLayout(page, [
      { left: 10, top: 20, width: 80, height: 8 },
      { left: 10, top: 32, width: 30, height: 8 },
    ]);

    const hits = locateAll(page, 'next line');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.rects).toHaveLength(2);
  });

  it('matches Chinese text that the text layer spaced out', () => {
    const page = buildPage('<span>机 器 学 习 的 方 法</span>');
    withLayout(page, [{ left: 0, top: 0, width: 20, height: 10 }]);

    expect(locateAll(page, '机器学习')).toHaveLength(1);
  });

  it('returns nothing when the page has no text layer', () => {
    const page = document.createElement('div');
    page.className = 'pdf-page';
    document.body.append(page);
    expect(locateAll(page, 'machine')).toEqual([]);
  });
});
