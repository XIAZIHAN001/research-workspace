/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NARROW_VIEWPORT_QUERY, READER_OVERLAY_QUERY } from './config';

/** Pulls the pixel width out of a `(max-width: 1100px)` style media query. */
function maxWidthOf(query: string): number {
  const match = /max-width:\s*(\d+)px/.exec(query);
  if (match?.[1] === undefined) throw new Error(`not a max-width query: ${query}`);
  return Number(match[1]);
}

function readStyle(name: string): string {
  return readFileSync(join(process.cwd(), 'src', 'styles', name), 'utf8');
}

/**
 * These guards exist because a breakpoint cannot be shared between TypeScript and CSS: a media
 * query cannot read a custom property, so the number has to be written twice. When the two drift
 * apart the failure is silent — the layout folds at one width while the logic that depends on it
 * (hiding the resize handle, choosing the starting panel) acts at another. Reading the stylesheet
 * here turns that into a failing test instead.
 */
describe('responsive breakpoints stay in step with the stylesheet', () => {
  it('the reader overlay query matches the fold in reader.css', () => {
    const css = readStyle('reader.css');
    expect(css).toContain(`@media (max-width: ${String(maxWidthOf(READER_OVERLAY_QUERY))}px)`);
  });

  it('the knowledge panel folds at the same width, so the panels stay consistent', () => {
    const css = readStyle('knowledge-ai.css');
    expect(css).toContain(`@media (max-width: ${String(maxWidthOf(READER_OVERLAY_QUERY))}px)`);
  });

  it('the sidebar overlay is narrower than the reader fold, or it would fold first', () => {
    // The reading column needs to give up its column long before the sidebar does; if this ever
    // inverts, the reader would fold at a width where the rail is still taking its own column.
    expect(maxWidthOf(NARROW_VIEWPORT_QUERY)).toBeLessThan(maxWidthOf(READER_OVERLAY_QUERY));
  });
});
