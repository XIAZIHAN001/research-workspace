import { describe, expect, it } from 'vitest';
import {
  BOOKMARK_LABEL_MAX,
  cleanBookmarkLabel,
  createBookmark,
  defaultBookmarkLabel,
  sortBookmarks,
  type Bookmark,
} from './bookmark';

function sequentialIds(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `bookmark-${next}`;
  };
}

describe('createBookmark', () => {
  it('saves the page with a trimmed label', () => {
    const bookmark = createBookmark(
      { paperId: 'p1', page: 3, label: '  Method  ' },
      sequentialIds(),
      7,
    );
    expect(bookmark).toStrictEqual({
      id: 'bookmark-1',
      paperId: 'p1',
      page: 3,
      label: 'Method',
      createdAt: 7,
    });
  });

  it('allows an empty label, which the panel shows as the page number', () => {
    const bookmark = createBookmark({ paperId: 'p1', page: 2 }, sequentialIds(), 7);
    expect(bookmark?.label).toBe('');
  });

  it('bounds an over-long label', () => {
    const bookmark = createBookmark(
      { paperId: 'p1', page: 1, label: 'x'.repeat(500) },
      sequentialIds(),
      7,
    );
    expect(bookmark?.label).toHaveLength(BOOKMARK_LABEL_MAX);
  });

  it.each([
    { label: 'a missing paper', input: { paperId: '', page: 1 } },
    { label: 'page zero', input: { paperId: 'p1', page: 0 } },
    { label: 'a negative page', input: { paperId: 'p1', page: -2 } },
    { label: 'a fractional page', input: { paperId: 'p1', page: 1.5 } },
  ])('refuses $label', ({ input }) => {
    expect(createBookmark(input, sequentialIds(), 7)).toBeNull();
  });
});

describe('cleanBookmarkLabel', () => {
  it('trims and leaves room for the panel', () => {
    expect(cleanBookmarkLabel('  Discussion  ')).toBe('Discussion');
  });

  it('keeps an empty label empty rather than inventing one', () => {
    expect(cleanBookmarkLabel('   ')).toBe('');
  });
});

describe('defaultBookmarkLabel', () => {
  it('names the page', () => {
    expect(defaultBookmarkLabel(12)).toBe('第 12 页');
  });
});

describe('sortBookmarks', () => {
  const bookmark = (id: string, page: number, createdAt: number): Bookmark => ({
    id,
    paperId: 'p1',
    page,
    label: '',
    createdAt,
  });

  it('orders by page and keeps same-page bookmarks in creation order', () => {
    const sorted = sortBookmarks([
      bookmark('c', 9, 30),
      bookmark('b', 3, 20),
      bookmark('a', 3, 10),
    ]);
    expect(sorted.map((entry) => entry.id)).toStrictEqual(['a', 'b', 'c']);
  });

  it('does not reorder the array it is given', () => {
    const input = [bookmark('c', 9, 30), bookmark('a', 1, 10)];
    sortBookmarks(input);
    expect(input.map((entry) => entry.id)).toStrictEqual(['c', 'a']);
  });
});
