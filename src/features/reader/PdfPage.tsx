import { Fragment, useEffect, useRef, useState } from 'react';
import type { Annotation } from '../../domain/annotation';
import { isRenderCancelled, loadPdfjs, type PDFDocumentProxy } from './pdfjs';

interface PdfPageProps {
  doc: PDFDocumentProxy;
  /** 1-based page number. */
  pageNumber: number;
  scale: number;
  /** Pages outside the render window keep their space but release their canvas and text. */
  active: boolean;
  /** Size to reserve while the page has not measured itself yet. */
  placeholder: { width: number; height: number };
  /** Highlights made on this page, on this file. Their boxes are fractions of the page. */
  annotations?: readonly Annotation[];
  /** The annotation to draw attention to, right after the reader jumped to it. */
  flashId?: string | null;
}

/** Above this the canvas stops growing: more pixels cost memory without being visible. */
const MAX_DEVICE_PIXEL_RATIO = 2;

/**
 * One page of the document: a canvas with the rendered page and a text layer on top of it.
 *
 * The canvas and the text layer are built by the effect rather than rendered by React, so a
 * re-render always starts from a fresh element — pdf.js refuses to reuse a canvas that still
 * has a render in flight, which is exactly what a double-invoked effect looks like.
 *
 * The text layer is pdf.js's own, so selecting and copying behaves like any other web page.
 * It is positioned from the page's text content, never from where the canvas happens to sit,
 * so the same page lays out correctly at another zoom level or in another window.
 */
export function PdfPage({
  doc,
  pageNumber,
  scale,
  active,
  placeholder,
  annotations = [],
  flashId = null,
}: PdfPageProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  /**
   * A page can render perfectly and still have nothing to select — a scan, or an image of a
   * page. Saying so is the honest answer: without a text layer there is nothing to anchor a
   * highlight to, and the user should not have to guess why selection does not work.
   */
  const [hasNoText, setHasNoText] = useState(false);

  // Measure first: the column needs the page's real height even when it is not rendered.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        setSize({ width: viewport.width, height: viewport.height });
      } catch {
        // A page that cannot be measured keeps the placeholder size; rendering reports it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber, scale]);

  useEffect(() => {
    const host = hostRef.current;
    if (!active || size === null || host === null) return;

    let cancelled = false;
    let renderTask: { cancel: () => void } | null = null;
    let textLayer: { cancel: () => void } | null = null;
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.setAttribute('aria-label', `第 ${pageNumber} 页`);
    canvas.setAttribute('role', 'img');
    const textContainer = document.createElement('div');
    textContainer.className = 'textLayer';
    host.replaceChildren(canvas, textContainer);

    void (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const ratio = Math.min(globalThis.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);

      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const task = page.render({
        canvas,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      renderTask = task;
      await task.promise;
      if (cancelled) return;

      // pdf.js sizes its text layer from these custom properties.
      textContainer.style.setProperty('--total-scale-factor', String(viewport.scale));
      textContainer.style.setProperty('--scale-round-x', '1px');
      textContainer.style.setProperty('--scale-round-y', '1px');
      const pdfjs = await loadPdfjs();
      const layer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
        container: textContainer,
        viewport,
      });
      textLayer = layer;
      await layer.render();
      setHasNoText((textContainer.textContent ?? '').trim() === '');
      setFailed(false);
    })().catch((error: unknown) => {
      if (cancelled || isRenderCancelled(error)) return;
      // One page failing must not take the reader down: the rest stays usable.
      setFailed(true);
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      host.replaceChildren();
    };
  }, [doc, pageNumber, scale, active, size]);

  const { width, height } = size ?? placeholder;

  return (
    <div
      className="pdf-page"
      data-page={pageNumber}
      style={{ width: `${width}px`, height: `${height}px` }}
    >
      <div ref={hostRef} className="pdf-host" />
      {annotations.length > 0 && (
        <div className="annotation-layer">
          {annotations.map((annotation) => (
            <Fragment key={annotation.id}>
              {annotation.rects.map((rect, index) => (
                <div
                  // Boxes have no identity of their own; the annotation and their order do.
                  key={`${annotation.id}-${String(index)}`}
                  className="pdf-highlight"
                  data-annotation={annotation.id}
                  data-kind={annotation.kind}
                  data-flash={annotation.id === flashId ? 'true' : undefined}
                  style={{
                    left: `${String(rect.x * 100)}%`,
                    top: `${String(rect.y * 100)}%`,
                    width: `${String(rect.width * 100)}%`,
                    height: `${String(rect.height * 100)}%`,
                  }}
                />
              ))}
            </Fragment>
          ))}
        </div>
      )}
      {hasNoText && !failed && (
        <p className="pdf-page-hint">
          这一页没有可提取的文字（可能是扫描件），暂时无法高亮或记笔记。
        </p>
      )}
      {failed && (
        <p className="pdf-page-error" role="status">
          第 {pageNumber} 页渲染失败。
        </p>
      )}
    </div>
  );
}
