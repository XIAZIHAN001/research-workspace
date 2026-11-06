import type { PDFDocumentProxy } from './pdfjs';
import type { ExtractedPage } from './paperRetrieval';
import { pageTextFromItems } from './findText';

export const MAX_SHARED_TEXT_PAGES = 128;
export const MAX_SHARED_TEXT_CHARS = 2_000_000;

export interface SharedPageText {
  readonly analysis: ExtractedPage;
  readonly search: string;
}
interface DocumentCache {
  pages: Map<number, SharedPageText>;
  pending: Map<number, Promise<SharedPageText | null>>;
  chars: number;
}
const documents = new WeakMap<PDFDocumentProxy, DocumentCache>();

/**
 * Only compact derived strings/statistics survive extraction, never raw TextContent or pages.
 * Consumer cancellation stops its own loop/writes, not another consumer's shared PDF.js call.
 * In-flight getTextContent cannot be aborted here; it finishes and then releases its promise.
 * Failed pages are not retained. Weak document identity isolates replacement/closed readers.
 */
export function readSharedPageText(
  doc: PDFDocumentProxy,
  pageNumber: number,
): Promise<SharedPageText | null> {
  let cache = documents.get(doc);
  if (cache === undefined) {
    cache = { pages: new Map(), pending: new Map(), chars: 0 };
    documents.set(doc, cache);
  }
  const cached = cache.pages.get(pageNumber);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = cache.pending.get(pageNumber);
  if (pending !== undefined) return pending;
  const owner = cache;
  const work = extract(doc, pageNumber).then((result) => {
    owner.pending.delete(pageNumber);
    if (result !== null) {
      const size = result.search.length + result.analysis.text.length;
      // Stable admission prevents repeated full scans from evicting every reusable page.
      if (owner.pages.size < MAX_SHARED_TEXT_PAGES && owner.chars + size <= MAX_SHARED_TEXT_CHARS) {
        owner.pages.set(pageNumber, result);
        owner.chars += size;
      }
    }
    return result;
  });
  cache.pending.set(pageNumber, work);
  return work;
}

async function extract(doc: PDFDocumentProxy, pageNumber: number): Promise<SharedPageText | null> {
  try {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const parts: string[] = [];
    let itemCount = 0;
    let singleCharItems = 0;
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const raw = item.str ?? '';
      if (raw.trim() === '') continue;
      itemCount += 1;
      if (raw.trim().length === 1) singleCharItems += 1;
      parts.push(raw);
      parts.push('hasEOL' in item && item.hasEOL === true ? '\n' : ' ');
    }
    const text = parts.join('').replace(/\s+/g, ' ').trim();
    const fragmented = itemCount >= 8 && singleCharItems / itemCount >= 0.45;
    return {
      analysis: { page: pageNumber, text, itemCount, singleCharItems, fragmented },
      search: pageTextFromItems(content.items),
    };
  } catch {
    return null;
  }
}
