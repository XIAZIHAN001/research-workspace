import {
  inspectPdfBytes,
  PDF_REJECTION_MESSAGE,
  type PaperPdf,
  type PdfBytes,
  type PdfRejection,
} from '../../domain/pdfFile';
import type { Paper } from '../../domain/papers';
import { sha256Hex } from '../../services/hash';
import { PdfStoreError, type PdfBlobStore } from '../../services/pdfStore';

/** Parses the bytes far enough to prove they are a PDF we can render. Throws when it cannot. */
export type ProbePdf = (bytes: PdfBytes) => Promise<{ pageCount: number }>;

export interface ImportDeps {
  blobs: PdfBlobStore;
  /** Defaults to `File.arrayBuffer()`; injected in tests. */
  readBytes?: (file: File) => Promise<PdfBytes>;
  hash?: (bytes: PdfBytes) => Promise<string>;
}

export type ImportFailureReason =
  | 'unreadable-file'
  | 'unreadable-pdf'
  | PdfRejection
  | 'storage-unavailable'
  | 'storage-quota'
  | 'storage-failed';

export interface PreparedImport {
  /** Metadata to record on the paper. The bytes are already durably stored. */
  pdf: PaperPdf;
  /**
   * A paper that already carries this exact file, if any. The caller must ask the user what
   * to do: the same file is not the same paper, so this is never resolved automatically.
   */
  duplicateOf: Paper | null;
}

export type PrepareResult =
  | { status: 'ready'; prepared: PreparedImport }
  | { status: 'failed'; reason: ImportFailureReason; message: string };

async function defaultReadBytes(file: File): Promise<PdfBytes> {
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * Reads, checks, hashes and stores a PDF file, then reports what should be written to the
 * paper registry.
 *
 * The order matters and is the whole point of this function: the bytes reach IndexedDB
 * *before* the caller is allowed to write a reference to them into LocalStorage. The two
 * stores share no transaction, so this direction leaves at worst an unreferenced blob,
 * never a paper pointing at a file that was never saved.
 */
export async function preparePdfImport(
  deps: ImportDeps,
  file: File,
  opts: { probe: ProbePdf; papers: Record<string, Paper>; attachedTo?: string | null },
): Promise<PrepareResult> {
  const readBytes = deps.readBytes ?? defaultReadBytes;
  const hash = deps.hash ?? sha256Hex;

  let bytes: PdfBytes;
  try {
    bytes = await readBytes(file);
  } catch {
    return {
      status: 'failed',
      reason: 'unreadable-file',
      message: '无法读取所选文件，请重新选择。',
    };
  }

  const inspection = inspectPdfBytes(bytes);
  if (!inspection.ok) {
    return {
      status: 'failed',
      reason: inspection.reason,
      message: PDF_REJECTION_MESSAGE[inspection.reason],
    };
  }

  const sha256 = await hash(bytes);

  let pageCount: number | null;
  try {
    // Structural checks only prove the header; parsing proves the file is readable, and
    // gives the page count the reader will show.
    pageCount = (await opts.probe(bytes)).pageCount;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      reason: 'unreadable-pdf',
      message: `无法解析这个 PDF（${detail}）。文件可能已损坏，或者使用了不支持的加密方式。`,
    };
  }

  const pdf: PaperPdf = {
    sha256,
    name: file.name,
    bytes: bytes.length,
    pageCount,
    addedAt: Date.now(),
  };

  try {
    // Content-addressed: storing the same file again is harmless and costs no extra space.
    if (!(await deps.blobs.has(sha256))) await deps.blobs.put(sha256, bytes);
  } catch (error) {
    const failure = error instanceof PdfStoreError ? error.failure : 'unknown';
    return {
      status: 'failed',
      reason:
        failure === 'unavailable'
          ? 'storage-unavailable'
          : failure === 'quota'
            ? 'storage-quota'
            : 'storage-failed',
      message: error instanceof Error ? error.message : '文件保存失败。',
    };
  }

  const duplicate = Object.values(opts.papers).find(
    (paper) => paper.pdf?.sha256 === sha256 && paper.id !== opts.attachedTo,
  );

  return { status: 'ready', prepared: { pdf, duplicateOf: duplicate ?? null } };
}
