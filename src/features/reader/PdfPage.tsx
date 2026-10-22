import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
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
  /**
   * Every find hit on this page, right now.
   *
   * Only the page the reader is looking at receives boxes: the column renders a small window
   * and the other pages have no text layer to measure. They are fractions of the page, so a
   * zoom change moves them with the words.
   */
  findRects?: readonly NormalizedRect[] | null;
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
  findRects = null,
  palette = 'original',
  suggestions = [],
  onSuggestionClick,
  onMeasure,
}: PdfPageProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** The page's own size at scale 1 — what the reader stores and multiplies by the zoom. */
  const [intrinsic, setIntrinsic] = useState<{ width: number; height: number } | null>(null);
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
  const reportedRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;
        // The page's *unscaled* size. The reader stores it and applies the zoom itself; a size
        // measured at the current scale would carry the zoom into the column a second time, and
        // the layout would only be right while every page happened to measure at exactly 100% —
        // at 75% the slots closed to 3/4 of the page height and the pages overlapped.
        const viewport = page.getViewport({ scale: 1 });
        const next = { width: viewport.width, height: viewport.height };
        // One report per real change. The intrinsic size does not vary with the zoom, so this
        // stays quiet across zoom changes instead of churning the reader's height map.
        const key = `${String(next.width)}x${String(next.height)}`;
        if (reportedRef.current !== key) {
          reportedRef.current = key;
          onMeasure?.(pageNumber, next);
        }
        setIntrinsic(next);
      } catch {
        // A page that cannot be measured keeps the placeholder size; rendering reports it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber, onMeasure]);

  // The page box at the current zoom. Memoised on purpose: the render effect below lists `size`
  // in its dependencies, so a fresh object every render would rebuild the canvas forever.
  const size = useMemo(
    () =>
      intrinsic === null
        ? null
        : { width: intrinsic.width * scale, height: intrinsic.height * scale },
    [intrinsic, scale],
  );

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

      // Our own 2d context, handed to pdf.js through `canvasContext` (which it only honours
      // when `canvas` is not passed). Two things ride on this:
      //
      // - pdf.js asks for the context itself with `alpha: false`, which makes Chromium
      //   anti-alias text per subpixel. On white paper those red/blue fringe pixels are
      //   invisible, but they carry real chroma, so the recolour protects them as "colour"
      //   and every glyph kept a rainbow edge on dark paper. Our context keeps the default
      //   `alpha: true`, where text is anti-aliased in greyscale: edges arrive as black ink
      //   at partial alpha and the recolour maps them to the palette ink at the same alpha —
      //   crisp, fringe-free text on any paper.
      // - `willReadFrequently` lets the recolour read the pixels back without a warning or a
      //   GPU round-trip, so no separate working canvas is needed.
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context === null) {
        setFailed(true);
        return;
      }

      const task = page.render({
        // `canvas` must be null for pdf.js to honour `canvasContext`.
        canvas: null,
        canvasContext: context,
        viewport,
        // Original mode paints the page white. The recoloured modes must NOT: the paper comes
        // from the page element's own background (exactly the palette paper, so no seam can
        // show), and pdf.js fills `background || '#ffffff'` — the string 'transparent' is a
        // valid fillStyle that fills nothing, which is how the fill is declined.
        background: palette === 'original' ? '#ffffff' : 'transparent',
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      renderTask = task;
      await task.promise;
      if (cancelled) return;

      if (palette !== 'original') {
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const report = await recolorImageDataAsync(image.data, palette, alive.signal);
        if (cancelled) return;
        if (report.outcome === 'recoloured') {
          context.putImageData(image, 0, 0);
        }
        setKeptOriginal(report.outcome === 'image-heavy');
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
      style={{
        width: `${width}px`,
        height: `${height}px`,
        // An image-heavy page keeps its original drawing — including black ink — so it must
        // sit on white, not on the palette paper; the note below says why this page differs.
        background: keptOriginal ? '#ffffff' : paperBackground(palette),
      }}
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
      {findRects !== null && findRects.length > 0 && (
        <div className="pdf-find-layer" aria-hidden="true">
          {findRects.map((rect, index) => (
            <div
              // The boxes of one search are a position list; their order is their identity.
              key={`find-${String(index)}`}
              className="pdf-find"
              style={{
                left: `${String(rect.x * 100)}%`,
                top: `${String(rect.y * 100)}%`,
                width: `${String(rect.width * 100)}%`,
                height: `${String(rect.height * 100)}%`,
              }}
            />
          ))}
        </div>
      )}
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
