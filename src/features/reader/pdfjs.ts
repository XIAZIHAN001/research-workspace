import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { PdfBytes } from '../../domain/pdfFile';

export type { PDFDocumentProxy, PDFPageProxy };

async function importPdfjs() {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

type PdfjsModule = Awaited<ReturnType<typeof importPdfjs>>;

let loading: Promise<PdfjsModule> | null = null;

/**
 * Loads pdf.js on first use and points it at the worker that ships with the package.
 *
 * Both the library and the worker are bundled by Vite and served from the app's own origin
 * (`?url` emits the worker file as an asset) — nothing is fetched from a CDN, so the reader
 * works offline and inside a packaged desktop build.
 */
export function loadPdfjs(): Promise<PdfjsModule> {
  loading ??= importPdfjs();
  return loading;
}

/**
 * Where the optional pdf.js data files are served from. The vite config copies them out of
 * the installed package, so a PDF that uses a non-embedded standard font or a CJK encoding
 * still renders — locally, with nothing fetched from a CDN.
 */
const PDFJS_DATA_BASE = '/pdfjs';

function documentParams(bytes: PdfBytes) {
  return {
    data: bytes,
    cMapUrl: `${PDFJS_DATA_BASE}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_DATA_BASE}/standard_fonts/`,
  };
}

/**
 * Parses the bytes far enough to prove the file is readable, and reports its page count.
 *
 * pdf.js takes ownership of the buffer it is handed (it transfers it to the worker), so
 * callers must pass bytes they do not need afterwards.
 */
export async function probePdf(bytes: PdfBytes): Promise<{ pageCount: number }> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument(documentParams(bytes));
  try {
    const document = await task.promise;
    return { pageCount: document.numPages };
  } finally {
    // Releases the worker-side document whether or not it parsed.
    await task.destroy();
  }
}

export interface OpenedDocument {
  doc: PDFDocumentProxy;
  /**
   * Releases the document and everything the worker holds for it. `PDFDocumentProxy` has no
   * destroy of its own in pdf.js 6 — the loading task is what owns the resources.
   */
  close: () => Promise<void>;
}

/** Opens a document for reading. The caller must `close()` it when the reader closes. */
export async function openPdfDocument(bytes: PdfBytes): Promise<OpenedDocument> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument(documentParams(bytes));
  const doc = await task.promise;
  return {
    doc,
    close: async () => {
      await task.destroy();
    },
  };
}

/** True for the error pdf.js raises when a render is cancelled on purpose. */
export function isRenderCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'RenderingCancelledException';
}
