import { describe, expect, it } from 'vitest';
import { buildPageText, locateSpanRange, matchQuote, type PageRun } from './anchor';

/** Three spans with a line break between the first two, like a rendered page. */
const RUNS: PageRun[] = [
  { kind: 'text', span: 0, text: 'The left column starts here' },
  { kind: 'break' },
  { kind: 'text', span: 1, text: 'and continues on the next line' },
  { kind: 'break' },
  { kind: 'text', span: 2, text: 'of the same column.' },
];

const QUOTE = {
  quote: 'continues on the next line',
  prefix: 'left column starts here and ',
  suffix: ' of the same column.',
};

describe('buildPageText', () => {
  it('joins runs with a space where the page breaks a line', () => {
    const page = buildPageText(RUNS);
    expect(page.text).toBe(
      'The left column starts here and continues on the next line of the same column.',
    );
  });

  it('collapses runs of whitespace inside a run', () => {
    const page = buildPageText([{ kind: 'text', span: 0, text: 'a   b\n c' }]);
    expect(page.text).toBe('a b c');
  });

  it('remembers where every character came from', () => {
    const page = buildPageText(RUNS);
    const index = page.text.indexOf('continues');
    // "and continues ..." — the word starts four characters into its own span.
    expect(page.origin[index]).toStrictEqual({ span: 1, offset: 4 });
    const last = page.text.indexOf('column.');
    expect(page.origin[last]).toStrictEqual({ span: 2, offset: 12 });
  });

  it('does not start a page with the space a leading break would add', () => {
    const page = buildPageText([{ kind: 'break' }, { kind: 'text', span: 0, text: 'text' }]);
    expect(page.text).toBe('text');
  });
});

describe('matchQuote', () => {
  const page = buildPageText(RUNS);

  it('finds a quote that occurs once', () => {
    expect(matchQuote(page, QUOTE)).toStrictEqual({
      kind: 'found',
      start: page.text.indexOf('continues'),
      end: page.text.indexOf('continues') + 'continues on the next line'.length,
      score: QUOTE.prefix.length + QUOTE.suffix.length,
      occurrences: 1,
    });
  });

  it('reports a quote that is not on the page', () => {
    expect(matchQuote(page, { quote: 'nothing like this', prefix: '', suffix: '' })).toStrictEqual({
      kind: 'missing',
    });
  });

  it('reports an empty quote as missing rather than matching everything', () => {
    expect(matchQuote(page, { quote: '   ', prefix: '', suffix: '' })).toStrictEqual({
      kind: 'missing',
    });
  });

  it('matches a quote that spans a line break', () => {
    const match = matchQuote(page, { quote: 'here and continues', prefix: '', suffix: '' });
    expect(match.kind).toBe('found');
  });

  it('uses the surrounding text to choose between repeated sentences', () => {
    const repeated = buildPageText([
      { kind: 'text', span: 0, text: 'Intro. THE SENTENCE appears here.' },
      { kind: 'text', span: 1, text: 'Middle part. THE SENTENCE appears again.' },
    ]);
    const match = matchQuote(repeated, {
      quote: 'THE SENTENCE',
      prefix: 'Middle part. ',
      suffix: ' appears again.',
    });
    expect(match).toStrictEqual({
      kind: 'found',
      start: repeated.text.indexOf('THE SENTENCE', 10),
      end: repeated.text.indexOf('THE SENTENCE', 10) + 'THE SENTENCE'.length,
      score: 'Middle part. '.length + ' appears again.'.length,
      occurrences: 2,
    });
  });

  it('refuses to choose when the repeated text has no context to tell them apart', () => {
    const repeated = buildPageText([
      { kind: 'text', span: 0, text: 'THE SENTENCE' },
      { kind: 'text', span: 1, text: 'THE SENTENCE' },
    ]);
    expect(matchQuote(repeated, { quote: 'THE SENTENCE', prefix: '', suffix: '' })).toStrictEqual({
      kind: 'ambiguous',
      occurrences: 2,
    });
  });

  it('refuses to choose when two occurrences have equally good context', () => {
    const repeated = buildPageText([{ kind: 'text', span: 0, text: 'see X here. see X here.' }]);
    expect(matchQuote(repeated, { quote: 'X', prefix: 'see ', suffix: ' here.' }).kind).toBe(
      'ambiguous',
    );
  });

  it('is not confused by a prefix that runs off the start of the page', () => {
    const match = matchQuote(page, { quote: 'The left column', prefix: 'gone', suffix: '' });
    expect(match.kind).toBe('found');
  });
});

describe('locateSpanRange', () => {
  const page = buildPageText(RUNS);
  const spanTexts = [
    'The left column starts here',
    'and continues on the next line',
    'of the same column.',
  ];

  it('maps a range inside one span', () => {
    const start = page.text.indexOf('left');
    const range = locateSpanRange(page, start, start + 'left'.length, spanTexts);
    expect(range).toStrictEqual({ startSpan: 0, startOffset: 4, endSpan: 0, endOffset: 8 });
  });

  it('maps a range across a line break onto the two spans', () => {
    const start = page.text.indexOf('here and');
    const end = page.text.indexOf('continues') + 'continues'.length;
    const range = locateSpanRange(page, start, end, spanTexts);
    // "here and" starts 23 characters into the first span; "continues" ends 13 into the second.
    expect(range).toStrictEqual({
      startSpan: 0,
      startOffset: 23,
      endSpan: 1,
      endOffset: 13,
    });
  });

  it('never asks for an offset past the end of a span', () => {
    const range = locateSpanRange(page, page.text.length - 1, page.text.length, spanTexts);
    expect(range?.endOffset).toBe(spanTexts[2]?.length);
  });

  it('returns null for offsets outside the page', () => {
    expect(locateSpanRange(page, 10_000, 10_001, spanTexts)).toBeNull();
  });
});
