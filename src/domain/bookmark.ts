/**
 * A saved place in a paper, distinct from the session's navigation history.
 *
 * A bookmark is the reader's own signpost — "the method section starts here" — so it has a
 * name and survives closing the paper. The reading history in the reader is scratch work and
 * is deliberately not persisted.
 */
export interface Bookmark {
  id: string;
  paperId: string;
  /** 1-based page in the paper's current PDF. */
  page: number;
  /** The reader's own name. Empty is allowed: the panel then shows the page number. */
  label: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

export const BOOKMARK_LABEL_MAX = 80;

/** What a bookmark without a name is called. */
export function defaultBookmarkLabel(page: number): string {
  return `第 ${page} 页`;
}

/** The label as stored: trimmed and bounded. Empty stays empty, meaning "use the page". */
export function cleanBookmarkLabel(raw: string): string {
  return raw.trim().slice(0, BOOKMARK_LABEL_MAX);
}

/** Creates a bookmark for a page. Null for a page that cannot exist or a missing paper. */
export function createBookmark(
  input: { paperId: string; page: number; label?: string },
  makeId: () => string,
  now: number,
): Bookmark | null {
  if (input.paperId === '') return null;
  if (!Number.isInteger(input.page) || input.page < 1) return null;
  return {
    id: makeId(),
    paperId: input.paperId,
    page: input.page,
    label: cleanBookmarkLabel(input.label ?? ''),
    createdAt: now,
  };
}

/** Bookmarks in reading order; two on one page keep the order they were made in. */
export function sortBookmarks(bookmarks: readonly Bookmark[]): Bookmark[] {
  return [...bookmarks].sort(
    (one, other) => one.page - other.page || one.createdAt - other.createdAt,
  );
}
