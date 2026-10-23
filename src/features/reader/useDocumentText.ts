import { useEffect, useState } from 'react';
import type { DocumentPageText } from '../../services/ai/context';
import type { PDFDocumentProxy } from './pdfjs';
import { extractPageText } from './paperRetrieval';

/**
 * Extracted text is kept for the life of the window, per file.
 *
 * Re-opening the same paper should not pay the extraction cost again, and the text is small
 * enough (tens of kilobytes for a paper) that a Map is the whole cache. Keyed by SHA-256, so a
 * re-imported copy of the same bytes shares the entry.
 */
const cache = new Map<string, readonly DocumentPageText[]>();

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
  const [result, setResult] = useState<{ key: string; pages: readonly DocumentPageText[] } | null>(
    null,
  );
  const cached = key === null || key === '' ? undefined : cache.get(key);

  useEffect(() => {
    if (doc === null || key === null || key === '' || cache.has(key)) return;

    let cancelled = false;
    void (async () => {
      const pages: DocumentPageText[] = [];
      for (let page = 1; page <= doc.numPages; page += 1) {
        const extracted = await extractPageText(doc, page);
        if (cancelled) return;
        if (extracted !== null && extracted.text.trim() !== '') {
          pages.push({ page, text: extracted.text });
        }
      }
      if (cancelled) return;
      cache.set(key, pages);
      setResult({ key, pages });
    })();

    return () => {
      cancelled = true;
    };
  }, [doc, key]);

  if (doc === null || key === null || key === '') return { pages: [], ready: false };
  if (cached !== undefined) return { pages: cached, ready: true };
  if (result === null || result.key !== key) return { pages: [], ready: false };
  return { pages: result.pages, ready: true };
}
