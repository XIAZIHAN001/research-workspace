import { Fragment, useEffect, useRef, useState } from 'react';
import type { Annotation, NormalizedRect } from '../../domain/annotation';
import { paperBackground, recolorImageDataAsync, type PaperPalette } from './paperTheme';
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
  /**
   * Called once per page, when its real size is known.
   *
   * Most pages in a paper are the same size, so the reader estimates the column from page 1.
   * Mixed-height documents (a tall figure page, a landscape appendix) would drift under that
   * estimate: scroll offsets, page jumps and the virtualization window all need real numbers.
   * The reader only re-measures when this fires; it is safe to fire on every scale change.
   */
  onMeasure?: (pageNumber: number, size: { width: number; height: number }) => void;
  /** Highlights made on this page, on this file. Their boxes are fractions of the page. */
  annotations?: readonly Annotation[];
  /** The annotation to draw attention to, right after the reader jumped to it. */
  flashId?: string | null;
  /**
   * Boxes to mark right now, without saving anything.
   *
   * Used when the reader follows a citation: the place the model referred to is shown, briefly,
   * and is not a highlight anyone made. It is drawn in its own layer so it can never be
   * mistaken for — or confused with — a saved annotation.
   */
  spotlight?: readonly NormalizedRect[] | null;
  /** How the page itself is drawn: original colours, warm paper, or dark paper. */
  palette?: PaperPalette;
  /**
   * Difficulty markers on this page.
   *
   * Each is a dashed underline at the foot of a located quotation — deliberately not a fill, so
   * it cannot be mistaken for the reader's own highlight and cannot cover the words it marks.
   * Only suggestions whose quotation was found exactly once on the page get here at all.
   */
  suggestions?: readonly { id: string; title: string; rects: readonly NormalizedRect[] }[];
  onSuggestionClick?: (id: string, spot: { x: number; y: number }) => void;
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
  spotlight = null,
  palette = 'original',
  suggestions = [],
  onSuggestionClick,
  onMeasure,
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
  /**
   * Set when the page was left in its original colours because recolouring it would have meant
   * rewriting a picture. Quiet, but present: the reader should be able to find out why this one
   * page looks different from the rest.
   */
  const [keptOriginal, setKeptOriginal] = useState(false);

  // Measure first: the column needs the page's real height even when it is not rendered.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const next = { width: viewport.width, height: viewport.height };
        setSize(next);
        // One synchronous report per measurement. The reader is the only listener; it knows
        // what to do with a real number and can drop the page-1 estimate for this page.
        onMeasure?.(pageNumber, next);
      } catch {
        // A page that cannot be measured keeps the placeholder size; rendering reports it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber, scale, onMeasure]);

  useEffect(() => {
    const host = hostRef.current;
    if (!active || size === null || host === null) return;

    let cancelled = false;
    let renderTask: { cancel: () => void } | null = null;
    let textLayer: { cancel: () => void } | null = null;
    // The recolour is a multi-batch loop, so it needs a signal of its own: `cancelled` is only
    // read at await points, and stopping mid-page is exactly where the long work is.
    const alive = new AbortController();
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
        // A white page behind the PDF's own drawing. Without it the canvas keeps transparent
        // pixels wherever the page does not paint, and recolouring would treat "no ink" as
        // black — so the background is laid down first and then becomes the paper colour.
        background: '#ffffff',
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      renderTask = task;
      await task.promise;
      if (cancelled) return;

      if (palette !== 'original') {
        // The recolour reads and writes every pixel, so it is done on a working canvas that was
        // created for exactly that (`willReadFrequently`), then blitted back. Reading the visible
        // canvas directly is slower and makes Chromium warn on every page.
        const work = document.createElement('canvas');
        work.width = canvas.width;
        work.height = canvas.height;
        const workContext = work.getContext('2d', { willReadFrequently: true });
        const visible = canvas.getContext('2d');
        if (workContext !== null && visible !== null) {
          workContext.drawImage(canvas, 0, 0);
          const image = workContext.getImageData(0, 0, work.width, work.height);
          const report = await recolorImageDataAsync(image.data, palette, alive.signal);
          if (cancelled) return;
          if (report.outcome === 'recoloured') {
            workContext.putImageData(image, 0, 0);
            visible.clearRect(0, 0, canvas.width, canvas.height);
            visible.drawImage(work, 0, 0);
          }
          setKeptOriginal(report.outcome === 'image-heavy');
        }
      } else {
        setKeptOriginal(false);
      }
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
      alive.abort();
      renderTask?.cancel();
      textLayer?.cancel();
      host.replaceChildren();
    };
  }, [doc, pageNumber, scale, active, size, palette]);

  const { width, height } = size ?? placeholder;

  return (
    <div
      className="pdf-page"
      data-page={pageNumber}
      data-paper={palette}
      style={{ width: `${width}px`, height: `${height}px`, background: paperBackground(palette) }}
    >
      <div ref={hostRef} className="pdf-host" />
      {(spotlight !== null && spotlight.length > 0) || annotations.length > 0 ? (
        <div className="annotation-layer">
          {spotlight?.map((rect, index) => (
            <div
              // The boxes of one spotlight are a position list; the index is their identity.
              key={`spotlight-${String(index)}`}
              className="pdf-highlight"
              data-spotlight="true"
              style={{
                left: `${String(rect.x * 100)}%`,
                top: `${String(rect.y * 100)}%`,
                width: `${String(rect.width * 100)}%`,
                height: `${String(rect.height * 100)}%`,
              }}
            />
          ))}
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
      ) : null}
      {suggestions.length > 0 && (
        <div className="suggestion-layer">
          {suggestions.map((suggestion) =>
            suggestion.rects.map((rect, index) => (
              <button
                // Boxes have no identity of their own; the suggestion and their order do.
                key={`${suggestion.id}-${String(index)}`}
                type="button"
                className="pdf-suggestion"
                data-suggestion={suggestion.id}
                title={suggestion.title}
                aria-label={`难点：${suggestion.title}`}
                style={{
                  left: `${String(rect.x * 100)}%`,
                  top: `${String((rect.y + rect.height) * 100)}%`,
                  width: `${String(rect.width * 100)}%`,
                }}
                onClick={(event) => {
                  // The page underneath treats mouseup as a selection; a marker is not one.
                  event.stopPropagation();
                  onSuggestionClick?.(suggestion.id, { x: event.clientX, y: event.clientY });
                }}
              />
            )),
          )}
        </div>
      )}
      {hasNoText && !failed && (
        <p className="pdf-page-hint">
          这一页没有可提取的文字（可能是扫描件），暂时无法高亮或记笔记。
        </p>
      )}
      {keptOriginal && !failed && (
        <p className="pdf-page-note" title="这一页的深色像素太多，重着色会把图像本身改掉">
          图像较多，按原始颜色显示
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
