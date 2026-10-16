import { describe, expect, it } from 'vitest';
import {
  clampPage,
  clampScale,
  fitWidthScale,
  MAX_SCALE,
  MIN_SCALE,
  nextScale,
  PAGE_GAP,
  PAGE_GUTTER,
  pageAtOffset,
  pageTops,
  previousScale,
  renderWindow,
  totalHeight,
  ZOOM_STEPS,
} from './readerMath';

describe('clampScale', () => {
  it.each([
    { label: 'below the minimum', input: 0.1, expected: MIN_SCALE },
    { label: 'above the maximum', input: 9, expected: MAX_SCALE },
    { label: 'inside the range', input: 1.25, expected: 1.25 },
    { label: 'not a number', input: Number.NaN, expected: 1 },
  ])('clamps a scale $label', ({ input, expected }) => {
    expect(clampScale(input)).toBe(expected);
  });
});

describe('zoom steps', () => {
  it('moves to the next step up and down', () => {
    expect(nextScale(1)).toBe(1.25);
    expect(previousScale(1)).toBe(0.75);
  });

  it('stops at the ends instead of running away', () => {
    expect(nextScale(MAX_SCALE)).toBe(MAX_SCALE);
    expect(previousScale(MIN_SCALE)).toBe(MIN_SCALE);
    expect(nextScale(100)).toBe(MAX_SCALE);
    expect(previousScale(0.0001)).toBe(MIN_SCALE);
  });

  it('reaches every step from below, in order', () => {
    const visited: number[] = [];
    let scale = MIN_SCALE;
    for (let step = 0; step < ZOOM_STEPS.length; step += 1) {
      visited.push(scale);
      scale = nextScale(scale);
    }
    expect(visited).toStrictEqual([...ZOOM_STEPS]);
  });

  it('treats an off-step scale as if it were on the grid', () => {
    expect(nextScale(1.1)).toBe(1.25);
    expect(previousScale(1.1)).toBe(1);
  });
});

describe('fitWidthScale', () => {
  it('leaves the gutters free', () => {
    expect(fitWidthScale(1000, 500)).toBeCloseTo((1000 - PAGE_GUTTER * 2) / 500);
  });

  it('never goes past the zoom bounds', () => {
    expect(fitWidthScale(10_000, 100)).toBe(MAX_SCALE);
    expect(fitWidthScale(10, 100_000)).toBe(MIN_SCALE);
  });

  it('falls back to 1:1 when the numbers are unusable', () => {
    expect(fitWidthScale(0, 0)).toBe(1);
    expect(fitWidthScale(Number.NaN, 100)).toBe(1);
  });
});

describe('page column layout', () => {
  const heights = [400, 500, 300];

  it('places every page below the previous one', () => {
    expect(pageTops(heights)).toStrictEqual([
      PAGE_GUTTER,
      PAGE_GUTTER + 400 + PAGE_GAP,
      PAGE_GUTTER + 400 + PAGE_GAP + 500 + PAGE_GAP,
    ]);
  });

  it('measures the whole column including both gutters', () => {
    const expected = 400 + 500 + 300 + PAGE_GAP * 2 + PAGE_GUTTER * 2;
    expect(totalHeight(heights)).toBe(expected);
    expect(totalHeight([])).toBe(0);
  });

  it('counts a page as reached when the scroll lands a fraction short', () => {
    const tops = pageTops(heights);
    // What scrollTo(top - PAGE_GAP) can actually leave behind.
    expect(pageAtOffset(tops, (tops[2] ?? 0) - PAGE_GAP - 0.5)).toBe(3);
    expect(pageAtOffset(tops, (tops[1] ?? 0) - PAGE_GAP - 1.5)).toBe(2);
  });

  it('reports the page the viewport is on', () => {
    const tops = pageTops(heights);
    expect(pageAtOffset(tops, 0)).toBe(1);
    expect(pageAtOffset(tops, tops[0] ?? 0)).toBe(1);
    expect(pageAtOffset(tops, tops[1] ?? 0)).toBe(2);
    expect(pageAtOffset(tops, (tops[2] ?? 0) + 250)).toBe(3);
    expect(pageAtOffset(tops, 100_000)).toBe(3);
    expect(pageAtOffset([], 500)).toBe(1);
  });
});

describe('renderWindow', () => {
  it('keeps a bounded band around the current page', () => {
    expect(renderWindow(5, 20)).toStrictEqual({ first: 4, last: 6 });
    expect(renderWindow(5, 20, 2)).toStrictEqual({ first: 3, last: 7 });
  });

  it('never runs past the document', () => {
    expect(renderWindow(1, 3)).toStrictEqual({ first: 1, last: 2 });
    expect(renderWindow(3, 3)).toStrictEqual({ first: 2, last: 3 });
    expect(renderWindow(1, 1)).toStrictEqual({ first: 1, last: 1 });
  });

  it('stays sane for a page number outside the document', () => {
    expect(renderWindow(99, 4)).toStrictEqual({ first: 3, last: 4 });
    expect(renderWindow(-3, 4)).toStrictEqual({ first: 1, last: 2 });
  });
});

describe('clampPage', () => {
  it.each([
    { label: 'too small', input: 0, expected: 1 },
    { label: 'too large', input: 99, expected: 12 },
    { label: 'fractional', input: 3.7, expected: 3 },
    { label: 'not a number', input: Number.NaN, expected: 1 },
    { label: 'inside', input: 5, expected: 5 },
  ])('clamps a $label page to the document', ({ input, expected }) => {
    expect(clampPage(input, 12)).toBe(expected);
  });

  it('falls back to the first page of an empty document', () => {
    expect(clampPage(4, 0)).toBe(1);
  });
});
