import { useEffect, useState } from 'react';
import { isPaperPdfUsable, type PaperPdf } from '../../domain/pdfFile';
import { PdfStoreError, type PdfBlobStore } from '../../services/pdfStore';
import { openPdfDocument, type OpenedDocument, type PDFDocumentProxy } from './pdfjs';

export type PdfOpenFailure = 'no-file' | 'missing' | 'invalid' | 'unavailable';

export type PdfDocumentState =
  | { status: 'loading' }
  | { status: 'ready'; doc: PDFDocumentProxy; pageCount: number }
  | { status: 'error'; failure: PdfOpenFailure; message: string };

/** What the reader tells the user when it cannot show the file. Never a stack trace. */
export const PDF_FAILURE_MESSAGE: Record<PdfOpenFailure, string> = {
  'no-file': '这篇论文还没有本地 PDF 文件。',
  missing: '本地文件库里没有找到这个 PDF（可能已被清理）。重新导入同一份文件即可恢复。',
  invalid: '这个 PDF 无法打开，文件可能已损坏。重新导入同一份文件即可恢复。',
  unavailable: '当前浏览器环境不支持本地文件库，无法打开 PDF。',
};

const NO_FILE: PdfDocumentState = {
  status: 'error',
  failure: 'no-file',
  message: PDF_FAILURE_MESSAGE['no-file'],
};

const LOADING: PdfDocumentState = { status: 'loading' };

/**
 * Opens the paper's stored PDF and hands back a pdf.js document.
 *
 * The blob is read from IndexedDB every time the reader opens rather than cached across
 * sessions, and the document is released when the reader closes, so a large file does not
 * stay in memory after the user leaves. The state is derived from which file is open, so a
 * change of binding reads as "loading" immediately instead of showing the old document.
 */
export function usePdfDocument(pdf: PaperPdf | undefined, blobs: PdfBlobStore): PdfDocumentState {
  const sha256 = isPaperPdfUsable(pdf) ? pdf.sha256 : null;
  const [opened, setOpened] = useState<{ sha256: string; state: PdfDocumentState } | null>(null);

  useEffect(() => {
    if (sha256 === null) return;

    let cancelled = false;
    let document: OpenedDocument | null = null;

    void (async () => {
      const settle = (state: PdfDocumentState): void => {
        if (!cancelled) setOpened({ sha256, state });
      };
      try {
        const bytes = await blobs.get(sha256);
        if (cancelled) return;
        if (bytes === null) {
          settle({ status: 'error', failure: 'missing', message: PDF_FAILURE_MESSAGE.missing });
          return;
        }
        document = await openPdfDocument(bytes);
        if (cancelled) {
          await document.close();
          return;
        }
        settle({
          status: 'ready',
          doc: document.doc,
          pageCount: document.doc.numPages,
        });
      } catch (error) {
        const failure =
          error instanceof PdfStoreError && error.failure === 'unavailable'
            ? 'unavailable'
            : 'invalid';
        settle({ status: 'error', failure, message: PDF_FAILURE_MESSAGE[failure] });
      }
    })();

    return () => {
      cancelled = true;
      if (document !== null) void document.close();
    };
  }, [sha256, blobs]);

  if (sha256 === null) return NO_FILE;
  if (opened === null || opened.sha256 !== sha256) return LOADING;
  return opened.state;
}
