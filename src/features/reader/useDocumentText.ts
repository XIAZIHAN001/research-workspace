import { useEffect, useState } from 'react';
import type { DocumentPageText } from '../../services/ai/context';
import type { PDFDocumentProxy } from './pdfjs';
import { extractPageText } from './paperRetrieval';

/** Validated SHA keys allow the same bytes reopened through a new proxy to reuse a transcript. */
const cache = new Map<string, readonly DocumentPageText[]>();
const MAX_TRANSCRIPTS = 4;
const MAX_TRANSCRIPT_CHARS = 2_000_000;
const MAX_TRANSCRIPT_PAGES = 2048;
let cachedChars = 0;

function remember(key: string, pages: readonly DocumentPageText[]): void {
  const size = pages.reduce((total, page) => total + page.text.length, 0);
  if (pages.length > MAX_TRANSCRIPT_PAGES || size > MAX_TRANSCRIPT_CHARS) return;
  const previous = cache.get(key);
  if (previous !== undefined) {
    cachedChars -= previous.reduce((total, page) => total + page.text.length, 0);
    cache.delete(key);
  }
  while (cache.size >= MAX_TRANSCRIPTS || cachedChars + size > MAX_TRANSCRIPT_CHARS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cachedChars -= cache.get(oldest)?.reduce((total, page) => total + page.text.length, 0) ?? 0;
    cache.delete(oldest);
  }
  cache.set(key, pages);
  cachedChars += size;
}

export interface DocumentTextState {
  /** Pages in reading order. Empty until the first extraction finishes. */
  pages: readonly DocumentPageText[];
  /** True once every readable page has been collected. */
  ready: boolean;
}

/**
 * Reads the paper's own text layer, all of it, without rendering anything.
 *
 * This exists so an AI question about one chapter can be answered against the whole argument.
 * It runs in the background as soon as the document is open: the pages are already being parsed
 * for display, and extraction yields between pages, so a typical paper is ready before the reader
 * has finished the first one. Pages without a text layer (scanned plates) are skipped.
 */
export function useDocumentText(
  doc: PDFDocumentProxy | null,
  key: string | null,
): DocumentTextState {
  const [result, setResult] = useState<{
    doc: PDFDocumentProxy;
    key: string;
    pages: readonly DocumentPageText[];
  } | null>(null);

  const cached = key === null || key === '' ? undefined : cache.get(key);

  useEffect(() => {
    if (doc === null || key === null || key === '' || cache.has(key)) return;

    let cancelled = false;
    void (async () => {
      const pages: DocumentPageText[] = [];
      let failed = false;
      for (let page = 1; page <= doc.numPages; page += 1) {
        const extracted = await extractPageText(doc, page);
        if (cancelled) return;
        if (extracted === null) failed = true;
        if (extracted !== null && extracted.text.trim() !== '') {
          pages.push({ page, text: extracted.text });
        }
      }
      if (cancelled) return;
      if (!failed) remember(key, pages);
      setResult({ doc, key, pages });
    })();

    return () => {
      cancelled = true;
    };
  }, [doc, key]);

  if (doc === null || key === null || key === '') return { pages: [], ready: false };
  if (cached !== undefined) return { pages: cached, ready: true };
  if (result === null || result.key !== key || result.doc !== doc)
    return { pages: [], ready: false };
  return { pages: result.pages, ready: true };
}
