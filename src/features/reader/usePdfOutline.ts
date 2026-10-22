import { useEffect, useState } from 'react';
import type { PDFDocumentProxy } from './pdfjs';

/**
 * One entry in a PDF's own table of contents.
 *
 * `page` is 1-based, matching the reader, and is null when the entry points nowhere we can
 * follow — a URL-only bookmark, or a destination whose page object could not be resolved.
 * Such an entry is still shown, because hiding it would make the outline disagree with the PDF.
 */
export interface OutlineEntry {
  id: string;
  title: string;
  page: number | null;
  children: OutlineEntry[];
}

export type OutlineStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PdfOutlineState {
  status: OutlineStatus;
  items: OutlineEntry[];
}

/** pdf.js's outline node shape, reduced to what this module reads. */
interface RawOutlineNode {
  title?: unknown;
  dest?: string | unknown[] | null;
  items?: RawOutlineNode[];
}

const IDLE: PdfOutlineState = { status: 'idle', items: [] };
const LOADING: PdfOutlineState = { status: 'loading', items: [] };

/** Guards against a malformed, deeply nested outline turning into thousands of rows. */
const MAX_DEPTH = 8;

/**
 * Reads the document's outline and resolves every destination to a page number.
 *
 * A destination is either a named string (resolved through `getDestination`) or an explicit
 * array whose first element is the page reference. Both end at `getPageIndex`, which is the
 * only thing that can turn a PDF object reference into a page the reader can scroll to.
 */
export function usePdfOutline(doc: PDFDocumentProxy | null): PdfOutlineState {
  const [loaded, setLoaded] = useState<{ doc: PDFDocumentProxy; state: PdfOutlineState } | null>(
    null,
  );

  useEffect(() => {
    if (doc === null) return;
    let cancelled = false;

    void (async () => {
      try {
        const raw = (await doc.getOutline()) as RawOutlineNode[] | null;
        const items = await mapNodes(doc, raw ?? [], '', 0);
        if (cancelled) return;
        setLoaded({ doc, state: { status: 'ready', items } });
      } catch {
        if (cancelled) return;
        setLoaded({ doc, state: { status: 'error', items: [] } });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [doc]);

  if (doc === null) return IDLE;
  if (loaded === null || loaded.doc !== doc) return LOADING;
  return loaded.state;
}

async function mapNodes(
  doc: PDFDocumentProxy,
  nodes: readonly RawOutlineNode[],
  prefix: string,
  depth: number,
): Promise<OutlineEntry[]> {
  if (depth >= MAX_DEPTH || nodes.length === 0) return [];
  return Promise.all(
    nodes.map(async (node, index): Promise<OutlineEntry> => {
      const id = `${prefix}${String(index)}`;
      const title =
        typeof node.title === 'string' && node.title.trim() !== ''
          ? node.title.replace(/\s+/g, ' ').trim()
          : '未命名条目';
      const page = await pageOfDestination(doc, node.dest ?? null);
      const children = Array.isArray(node.items)
        ? await mapNodes(doc, node.items, `${id}.`, depth + 1)
        : [];
      return { id, title, page, children };
    }),
  );
}

async function pageOfDestination(
  doc: PDFDocumentProxy,
  dest: string | readonly unknown[] | null,
): Promise<number | null> {
  if (dest === null) return null;
  try {
    const explicit: unknown = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const first = explicit[0] as Parameters<PDFDocumentProxy['getPageIndex']>[0] | null;
    // A number here is not a page reference; pdf.js normalises destinations to references and
    // guessing at a numeric index would send the reader to an arbitrary page.
    if (first === null || typeof first !== 'object') return null;
    const index = await doc.getPageIndex(first);
    if (!Number.isInteger(index) || index < 0 || index >= doc.numPages) return null;
    return index + 1;
  } catch {
    return null;
  }
}

/** The outline entry whose page is the last one at or before `page`, depth-first. */
export function activeOutlineId(items: readonly OutlineEntry[], page: number): string | null {
  let active: { id: string; page: number } | null = null;
  const walk = (nodes: readonly OutlineEntry[]): void => {
    for (const node of nodes) {
      if (node.page !== null && node.page <= page && (active === null || node.page > active.page)) {
        active = { id: node.id, page: node.page };
      }
      walk(node.children);
    }
  };
  walk(items);
  return active === null ? null : (active as { id: string; page: number }).id;
}

export function countOutlineEntries(items: readonly OutlineEntry[]): number {
  let count = 0;
  const walk = (nodes: readonly OutlineEntry[]): void => {
    for (const node of nodes) {
      count += 1;
      walk(node.children);
    }
  };
  walk(items);
  return count;
}
