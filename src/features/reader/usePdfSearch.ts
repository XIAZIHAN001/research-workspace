import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createFindIndex,
  findIndexedMatches,
  nextHitIndex,
  type FindHit,
  type FindIndex,
} from './findText';
import { readSharedPageText, MAX_SHARED_TEXT_PAGES, MAX_SHARED_TEXT_CHARS } from './sharedPageText';
import type { PDFDocumentProxy } from './pdfjs';

export type FindStatus = 'idle' | 'indexing' | 'ready';

export interface PdfSearchApi {
  query: string;
  setQuery: (value: string) => void;
  hits: readonly FindHit[];
  /** Index into `hits`; -1 when there is no current result. */
  active: number;
  status: FindStatus;
  /** The current query is still being looked up (typing debounce or a fresh index). */
  searching: boolean;
  scanned: number;
  total: number;
  next: () => void;
  prev: () => void;
  reset: () => void;
}

/** Typing is debounced; the index itself is built once per document. */
const QUERY_DEBOUNCE_MS = 180;
/** Pages between event-loop yields, so a long paper does not freeze the reader. */
const PAGES_PER_YIELD = 8;

const NO_HITS: readonly FindHit[] = [];

interface SearchProgress {
  doc: PDFDocumentProxy;
  scanned: number;
  total: number;
}

interface SearchResult {
  query: string;
  pages: FindIndex;
  hits: readonly FindHit[];
}

/**
 * The page texts of a document, kept by document identity.
 *
 * `usePdfDocument` hands out one stable proxy per file, so after the first search opening the
 * bounded index is available immediately on later openings. Oversized indexes live only in
 * the mounted hook. Weak keys do not keep a closed document alive.
 */
const indexCache = new WeakMap<PDFDocumentProxy, FindIndex>();

/**
 * Builds a searchable index of the open paper and finds the query in it.
 *
 * Indexing only starts when the search bar is open: most reading sessions never search, and
 * asking pdf.js for every page's text on open would delay the first page for everyone.
 */
export function usePdfSearch(doc: PDFDocumentProxy | null, enabled: boolean): PdfSearchApi {
  const [query, setQueryState] = useState('');
  const [progress, setProgress] = useState<SearchProgress | null>(null);
  const [built, setBuilt] = useState<{ doc: PDFDocumentProxy; index: FindIndex } | null>(null);
  const retained = useRef<{ doc: PDFDocumentProxy; complete: boolean } | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [active, setActive] = useState(-1);

  const pages =
    !enabled || doc === null
      ? null
      : built?.doc === doc
        ? built.index
        : (indexCache.get(doc) ?? null);

  const setQuery = useCallback((value: string) => {
    setQueryState(value);
  }, []);

  useEffect(() => {
    if (
      !enabled ||
      doc === null ||
      indexCache.has(doc) ||
      (retained.current?.doc === doc && retained.current.complete)
    )
      return;
    let cancelled = false;
    const pageCount = doc.numPages;

    void (async () => {
      const collected: string[] = [];
      let failed = false;
      for (let page = 1; page <= pageCount; page += 1) {
        if (cancelled) return;
        const extracted = await readSharedPageText(doc, page);
        const text = extracted?.search ?? '';
        if (extracted === null) failed = true;
        if (cancelled) return;
        collected.push(text);
        if (page % PAGES_PER_YIELD === 0 || page === pageCount) {
          setProgress({ doc, scanned: collected.length, total: pageCount });
          // Let the reader paint and handle input between batches of pages.
          await new Promise((resolve) => {
            window.setTimeout(resolve, 0);
          });
        }
      }
      if (cancelled) return;
      const index = createFindIndex(collected);
      if (
        !failed &&
        collected.length <= MAX_SHARED_TEXT_PAGES &&
        collected.reduce((sum, text) => sum + text.length, 0) <= MAX_SHARED_TEXT_CHARS
      )
        indexCache.set(doc, index);
      retained.current = { doc, complete: !failed };
      setBuilt({ doc, index });
    })();

    return () => {
      cancelled = true;
    };
  }, [doc, enabled]);

  useEffect(() => {
    if (!enabled || pages === null || query.trim() === '') return;
    const timer = window.setTimeout(() => {
      const found = findIndexedMatches(pages, query);
      setResult({ query, pages, hits: found });
      setActive(found.length > 0 ? 0 : -1);
    }, QUERY_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [pages, query, enabled]);

  // Results belong to one query over one index. Anything else is stale and must not be shown —
  // in particular, typing a new query hides the old hits at once instead of pointing at them
  // for another debounce interval.
  const current =
    enabled &&
    pages !== null &&
    result !== null &&
    result.query === query &&
    result.pages === pages;
  const hits = current ? result.hits : NO_HITS;
  const activeIndex = hits.length === 0 ? -1 : active >= 0 && active < hits.length ? active : 0;
  const searching = enabled && pages !== null && query.trim() !== '' && !current;

  const next = useCallback(() => {
    setActive((value) => nextHitIndex(value, hits.length, 1));
  }, [hits.length]);

  const prev = useCallback(() => {
    setActive((value) => nextHitIndex(value, hits.length, -1));
  }, [hits.length]);

  const reset = useCallback(() => {
    setQueryState('');
    setResult(null);
    setActive(-1);
  }, []);

  const currentProgress =
    progress !== null && doc !== null && progress.doc === doc ? progress : null;

  return {
    query,
    setQuery,
    hits,
    active: activeIndex,
    status: !enabled ? 'idle' : pages === null ? 'indexing' : 'ready',
    searching,
    scanned: currentProgress?.scanned ?? 0,
    total: currentProgress?.total ?? doc?.numPages ?? 0,
    next,
    prev,
    reset,
  };
}
