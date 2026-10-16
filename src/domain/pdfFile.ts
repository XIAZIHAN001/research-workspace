/**
 * Bytes of a stored file.
 *
 * Pinned to a plain `ArrayBuffer` because that is what the platform APIs we hand these to
 * (`crypto.subtle`, `Blob`, pdf.js) accept; a `SharedArrayBuffer`-backed view would be
 * rejected by TypeScript and is not something a picked file can produce anyway.
 */
export type PdfBytes = Uint8Array<ArrayBuffer>;

/**
 * The local PDF attached to a paper.
 *
 * The bytes never live here: they are kept in IndexedDB under `sha256`, so the same file
 * imported twice occupies storage once. This record is the metadata half of that binding
 * and it lives in LocalStorage with the rest of the paper registry.
 */
export interface PaperPdf {
  /** SHA-256 of the file content, hex, lowercase. Also the blob store key. */
  sha256: string;
  /** Original file name, for display and for the "same file again?" hint. */
  name: string;
  bytes: number;
  /** Page count recorded when the file was parsed on import; null when it was unknown. */
  pageCount: number | null;
  /** Epoch milliseconds. */
  addedAt: number;
}

/**
 * Where the reader left off. Deliberately only a page number: a DOM node or a pixel offset
 * would not survive a zoom change, a re-render or a different window size. Paragraph-level
 * anchors, when they arrive, belong beside `page` and must be derived from the PDF's own
 * text content, not from rendered elements.
 */
export interface PaperReading {
  /** 1-based. */
  page: number;
  /** Epoch milliseconds. */
  updatedAt: number;
}

/** Largest file this app will take. Well above a normal paper, low enough to catch mistakes. */
export const PDF_MAX_BYTES = 200 * 1024 * 1024;

/** Every PDF starts with this signature. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/** Some producers prefix the file with junk; the header is still near the start. */
const MAGIC_SEARCH_WINDOW = 1024;

export type PdfRejection = 'empty' | 'too-large' | 'not-pdf';

export type PdfInspection = { ok: true } | { ok: false; reason: PdfRejection };

function containsPdfMagic(bytes: Uint8Array): boolean {
  const last = Math.min(bytes.length - PDF_MAGIC.length, MAGIC_SEARCH_WINDOW);
  for (let start = 0; start <= last; start += 1) {
    if (PDF_MAGIC.every((byte, offset) => bytes[start + offset] === byte)) return true;
  }
  return false;
}

/** Cheap structural check, done before anything is hashed, parsed or stored. */
export function inspectPdfBytes(
  bytes: Uint8Array,
  maxBytes: number = PDF_MAX_BYTES,
): PdfInspection {
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > maxBytes) return { ok: false, reason: 'too-large' };
  return containsPdfMagic(bytes) ? { ok: true } : { ok: false, reason: 'not-pdf' };
}

/** Human-readable reason for a rejected file. Shown next to the file picker. */
export const PDF_REJECTION_MESSAGE: Record<PdfRejection, string> = {
  empty: '这个文件是空的。',
  'too-large': `文件超过 ${String(Math.round(PDF_MAX_BYTES / 1024 / 1024))} MB，暂不支持导入。`,
  'not-pdf': '这不是一个 PDF 文件（未找到 PDF 文件头）。',
};

/** True when the stored record describes a file we could still open. */
export function isPaperPdfUsable(pdf: PaperPdf | undefined): pdf is PaperPdf {
  return pdf !== undefined && /^[0-9a-f]{64}$/.test(pdf.sha256);
}
