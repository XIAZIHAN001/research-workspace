/** Zoom bounds and steps. Kept here so the reader, the tests and the UI agree on one scale. */
export const MIN_SCALE = 0.5;
export const MAX_SCALE = 3;
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3] as const;

/** Blank space around the page column, in CSS pixels. */
export const PAGE_GUTTER = 24;
/** Vertical space between two pages. */
export const PAGE_GAP = 16;
/** Pages this far from the visible one are kept rendered, so scrolling does not flash. */
export const RENDER_RADIUS = 1;

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** The next zoom step above `scale`, or the current scale when already at the top. */
export function nextScale(scale: number): number {
  const current = clampScale(scale);
  return ZOOM_STEPS.find((step) => step > current + 0.001) ?? MAX_SCALE;
}

/** The next zoom step below `scale`, or the current scale when already at the bottom. */
export function previousScale(scale: number): number {
  const current = clampScale(scale);
  const below = ZOOM_STEPS.filter((step) => step < current - 0.001);
  return below.at(-1) ?? MIN_SCALE;
}

/**
 * Scale at which a page of `pageWidth` (at scale 1) fills the container width, leaving the
 * gutters free. Never below the minimum zoom, so a very narrow window still shows a page.
 */
export function fitWidthScale(containerWidth: number, pageWidth: number): number {
  if (!Number.isFinite(containerWidth) || !Number.isFinite(pageWidth) || pageWidth <= 0) return 1;
  const available = containerWidth - PAGE_GUTTER * 2;
  if (available <= 0) return MIN_SCALE;
  return clampScale(available / pageWidth);
}

/** Top offset of every page in the scroll column. Pages may have different heights. */
export function pageTops(heights: readonly number[], gap: number = PAGE_GAP): number[] {
  const tops: number[] = [];
  let offset = PAGE_GUTTER;
  for (const height of heights) {
    tops.push(offset);
    offset += height + gap;
  }
  return tops;
}

export function totalHeight(heights: readonly number[], gap: number = PAGE_GAP): number {
  if (heights.length === 0) return 0;
  const sum = heights.reduce((total, height) => total + height, 0);
  return sum + gap * (heights.length - 1) + PAGE_GUTTER * 2;
}

/** Scroll positions are fractional; a page counts as reached within this many pixels. */
const REACHED_TOLERANCE = 2;

/**
 * The 1-based page whose top is closest to `scrollTop` without being below it — the page the
 * reader is actually looking at. Falls back to the first page above the column.
 *
 * The tolerance matters: `scrollTo` may land a fraction of a pixel short of a page top, and
 * without it the reader would report the previous page whenever it jumped to a page itself.
 */
export function pageAtOffset(tops: readonly number[], scrollTop: number): number {
  let page = 1;
  const anchor = scrollTop + PAGE_GAP + REACHED_TOLERANCE;
  tops.forEach((top, index) => {
    if (top <= anchor) page = index + 1;
  });
  return page;
}

/** The range of pages to keep rendered around `current`, clamped to the document. */
export function renderWindow(
  current: number,
  pageCount: number,
  radius: number = RENDER_RADIUS,
): { first: number; last: number } {
  return {
    first: Math.max(1, Math.min(current, pageCount) - radius),
    last: Math.min(pageCount, Math.max(current, 1) + radius),
  };
}

/** Clamps a page number coming from stored data or user input. */
export function clampPage(page: number, pageCount: number): number {
  if (pageCount <= 0) return 1;
  if (!Number.isFinite(page)) return 1;
  return Math.min(pageCount, Math.max(1, Math.floor(page)));
}
