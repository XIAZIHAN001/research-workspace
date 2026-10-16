import { afterEach, describe, expect, it } from 'vitest';
import { describeSelection, locateAnchor, readPageText, textSpans } from './selection';

afterEach(() => {
  document.body.innerHTML = '';
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
