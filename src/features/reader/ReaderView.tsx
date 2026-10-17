import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  PanelRightOpen,
  Sparkles,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Annotation,
  AnnotationEdit,
  AnnotationKind,
  NormalizedRect,
} from '../../domain/annotation';
import type { Paper } from '../../domain/papers';
import type { PdfBlobStore } from '../../services/pdfStore';
import { fetchAiHealth } from '../../services/ai/client';
import type { AiCitation, AiHealth, AiMode } from '../../services/ai/types';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { AiPanel } from './AiPanel';
import { AnnotationToolbar } from './AnnotationToolbar';
import { inspectPageLayout, measureFragmentation } from './layout';
import { NotesPanel } from './NotesPanel';
import { PdfPage } from './PdfPage';
import {
  describeSelection,
  locateAnchor,
  pageElementOf,
  pageNumberOf,
  readPageText,
  type SelectionAnchor,
} from './selection';
import {
  clampPage,
  fitWidthScale,
  nextScale,
  PAGE_GAP,
  pageAtOffset,
  pageTops,
  previousScale,
  renderWindow,
  totalHeight,
} from './readerMath';
import { PDF_FAILURE_MESSAGE, usePdfDocument } from './usePdfDocument';
import { useAiReading, type AiClient, type AiTurn } from './useAiReading';

interface ReaderViewProps {
  paper: Paper;
  blobs: PdfBlobStore;
  onClose: () => void;
  /** Called with the page the reader is on; the caller decides how often to persist it. */
  onReadingPosition: (page: number) => void;
  /** Offered when the stored file cannot be opened any more. */
  onReplaceFile: () => void;
  /** Every highlight on this paper, on any of its files. */
  annotations: readonly Annotation[];
  onCreateAnnotation: (
    anchor: SelectionAnchor,
    draft: { kind: AnnotationKind; note: string },
  ) => void;
  /** Saves an assistant's answer as a note in the reader's own list, marked as such. */
  onSaveAiNote: (anchor: SelectionAnchor, draft: { note: string; sourceLabel: string }) => void;
  onEditAnnotation: (id: string, edit: AnnotationEdit) => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
  /** Injectable so tests and the browser checks can supply a deterministic assistant. */
  aiClient?: AiClient;
}

/** Below this width the notes panel covers part of the page instead of taking a column. */
const NOTES_OVERLAY_QUERY = '(max-width: 1100px)';

/** How long to wait for a page the reader jumped to to finish rendering its text layer. */
const RENDER_WAIT_MS = 2500;

/**
 * Waits until a page has a usable text layer, then returns its element.
 *
 * A jump sets the current page immediately, but the page only builds its canvas and text layer
 * once it enters the render window — and that happens a frame or two later. Asking the page
 * about its text before that would answer "there is no such text here", which is a different
 * and much more alarming statement than "it is not ready yet". Returns null on timeout, so the
 * caller can say nothing rather than something wrong.
 */
async function waitForRenderedPage(
  root: HTMLElement | null,
  page: number,
  timeoutMs = RENDER_WAIT_MS,
): Promise<HTMLElement | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const element =
      root?.querySelector<HTMLElement>(`.pdf-page[data-page="${String(page)}"]`) ?? null;
    const layer = element?.querySelector<HTMLElement>('.textLayer') ?? null;
    if (element !== null && layer !== null && (layer.textContent ?? '') !== '') return element;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => {
      window.setTimeout(resolve, 100);
    });
  }
}

/**
 * The reading surface: a scrolling column of pages, with navigation and zoom.
 *
 * Only the pages near the visible one render (`renderWindow`), so opening a 300-page paper
 * costs one page's worth of canvas rather than three hundred; leaving the window releases
 * the canvas and the text layer again. The position is remembered as a page number, which
 * survives zoom changes, window resizes and reloads.
 */
export function ReaderView({
  paper,
  blobs,
  onClose,
  onReadingPosition,
  onReplaceFile,
  annotations,
  onCreateAnnotation,
  onSaveAiNote,
  onEditAnnotation,
  onDeleteAnnotation,
  aiClient,
}: ReaderViewProps) {
  const state = usePdfDocument(paper.pdf, blobs);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [manualScale, setManualScale] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const [currentPage, setCurrentPage] = useState(() => paper.reading?.page ?? 1);
  const [containerWidth, setContainerWidth] = useState(0);
  const [baseSize, setBaseSize] = useState<{ width: number; height: number } | null>(null);
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const restored = useRef(false);
  /** Set while a jump is being scrolled to, so interim positions are ignored. */
  const jumping = useRef<{ page: number; until: number } | null>(null);

  const [pendingSelection, setPendingSelection] = useState<{
    anchor: SelectionAnchor;
    spot: { x: number; y: number };
  } | null>(null);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Annotation | null>(null);
  /** Which of the two side panels is showing, if either. */
  const [panel, setPanel] = useState<'notes' | 'ai' | null>(() =>
    typeof window.matchMedia === 'function' && !window.matchMedia(NOTES_OVERLAY_QUERY).matches
      ? 'notes'
      : null,
  );
  /** Boxes shown briefly when the reader follows a citation. Never saved, never a highlight. */
  const [spotlight, setSpotlight] = useState<{ page: number; rects: NormalizedRect[] } | null>(
    null,
  );
  const [health, setHealth] = useState<AiHealth | null>(null);
  const ai = useAiReading(aiClient);

  const pdfSha256 = paper.pdf?.sha256 ?? null;
  const here = useMemo(
    () => annotations.filter((annotation) => annotation.pdfSha256 === pdfSha256),
    [annotations, pdfSha256],
  );
  const byPage = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    for (const annotation of here) {
      const list = map.get(annotation.page) ?? [];
      list.push(annotation);
      map.set(annotation.page, list);
    }
    return map;
  }, [here]);

  const pageCount = state.status === 'ready' ? state.pageCount : 0;
  const scale =
    fitWidth && baseSize !== null && containerWidth > 0
      ? fitWidthScale(containerWidth, baseSize.width)
      : manualScale;

  const heights = useMemo(
    () =>
      baseSize === null ? [] : Array.from({ length: pageCount }, () => baseSize.height * scale),
    [baseSize, pageCount, scale],
  );
  const tops = useMemo(() => pageTops(heights), [heights]);
  // Read by the scroll handler, which needs the current column rather than the one from
  // the render it was attached in.
  const topsRef = useRef(tops);
  useEffect(() => {
    topsRef.current = tops;
  }, [tops]);

  // The scroll container decides how wide a page may be in fit-width mode.
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const measure = (): void => {
      setContainerWidth(element.clientWidth);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [state.status]);

  // Measure the first page once: pages in a paper are nearly always the same size, and a
  // wrong estimate only costs a little empty space before a page renders.
  useEffect(() => {
    if (state.status !== 'ready' || baseSize !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await state.doc.getPage(1);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: 1 });
        setBaseSize({ width: viewport.width, height: viewport.height });
      } catch {
        setBaseSize({ width: 600, height: 800 });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state, baseSize]);

  const scrollToPage = useCallback(
    (page: number, behavior: ScrollBehavior = 'smooth') => {
      const target = clampPage(page, pageCount);
      setCurrentPage(target);
      // A smooth scroll passes through the pages in between; without this the indicator
      // would flicker back to them and the position could be saved mid-flight.
      jumping.current = { page: target, until: Date.now() + 1500 };
      const container = scrollRef.current;
      const top = topsRef.current[target - 1];
      if (container === null || top === undefined) return;
      container.scrollTo({ top: Math.max(0, top - PAGE_GAP), behavior });
    },
    [pageCount],
  );

  // Restore the stored position once the column has its final measurements. In fit-width
  // mode that means waiting for the container to be measured: restoring against a guessed
  // scale would scroll to the right offset for the wrong layout.
  const measurable =
    state.status === 'ready' && heights.length > 0 && (!fitWidth || containerWidth > 0);
  useEffect(() => {
    if (!measurable || restored.current) return;
    restored.current = true;
    const container = scrollRef.current;
    const stored = clampPage(paper.reading?.page ?? 1, state.pageCount);
    setCurrentPage(stored);
    const top = topsRef.current[stored - 1];
    if (container !== null && top !== undefined) container.scrollTop = Math.max(0, top - PAGE_GAP);
  }, [state, measurable, paper.reading?.page]);

  // Report the page the reader is on. The caller decides whether it is worth persisting.
  useEffect(() => {
    if (state.status !== 'ready' || !restored.current) return;
    onReadingPosition(clampPage(currentPage, pageCount));
  }, [currentPage, pageCount, state.status, onReadingPosition]);

  const windowRange = renderWindow(currentPage, pageCount);

  const zoom = (direction: 'in' | 'out'): void => {
    setFitWidth(false);
    setManualScale(direction === 'in' ? nextScale(scale) : previousScale(scale));
  };

  const commitPageDraft = (): void => {
    if (pageDraft !== null && pageDraft.trim() !== '') scrollToPage(Number(pageDraft));
    setPageDraft(null);
  };

  const clearSelection = (): void => {
    window.getSelection()?.removeAllRanges();
    setPendingSelection(null);
  };

  /**
   * Reads what the reader selected and offers to save it.
   *
   * A selection that cannot be anchored — it spans pages, or the page has no text layer, or it
   * is outside the rendered text — is refused here with a reason, rather than stored and found
   * missing later.
   */
  const readSelection = (): void => {
    const selection = window.getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return;

    const range = selection.getRangeAt(0);
    const page = pageElementOf(range.commonAncestorContainer);
    const pageNumber = page === null ? null : pageNumberOf(page);
    if (page === null || pageNumber === null) {
      setPendingSelection(null);
      setSelectionNotice('这段选择跨了页，暂时只能逐页保存高亮。');
      return;
    }
    const described = describeSelection(page, pageNumber, range);
    if ('reason' in described) {
      setPendingSelection(null);
      setSelectionNotice(described.message);
      return;
    }
    const box = range.getBoundingClientRect();
    setSelectionNotice(null);
    setPendingSelection({ anchor: described, spot: { x: box.left + box.width / 2, y: box.top } });
  };

  const saveAnnotation = (draft: { kind: AnnotationKind; note: string }): void => {
    if (pendingSelection === null) return;
    onCreateAnnotation(pendingSelection.anchor, draft);
    clearSelection();
  };

  /**
   * Goes back to a saved highlight, and says so when the text no longer lines up with it.
   *
   * The boxes stored with the annotation are what gets drawn — they were measured on this very
   * file. The text match is a check on top of that: when it is ambiguous or fails, the reader is
   * told, because silently pretending the highlight is on the right sentence is the one thing
   * worse than saying it is not sure.
   */
  const jumpToAnnotation = (annotation: Annotation): void => {
    setActiveAnnotationId(annotation.id);
    scrollToPage(annotation.page);
    void (async () => {
      const page = await waitForRenderedPage(scrollRef.current, annotation.page);
      if (page === null) {
        // The page never finished rendering. The highlight is still drawn from its stored
        // boxes; there is simply nothing to check the text against, and nothing to claim.
        setSelectionNotice(null);
        return;
      }
      const located = locateAnchor(page, annotation);
      if (located.match.kind === 'ambiguous') {
        setSelectionNotice(
          '这段原文在这一页出现了多次，无法确定是哪一处；高亮仍按保存时的位置显示。',
        );
      } else if (located.match.kind === 'missing') {
        setSelectionNotice('这段原文没有在这一页的文字里找到；高亮仍按保存时的位置显示。');
      } else {
        setSelectionNotice(null);
      }
    })();
    setFlashId(annotation.id);
    window.setTimeout(() => {
      setFlashId((current) => (current === annotation.id ? null : current));
    }, 1600);
  };

  /**
   * Follows a citation back to the page it came from.
   *
   * The citation was verified against the passages the service sent, so its page is a fact and
   * jumping there is always right. Where on the page it points, though, is found by matching the
   * quoted text — and when that is ambiguous or fails, the reader is told, exactly as they are
   * for a saved highlight. Nothing is highlighted on a guess.
   */
  const jumpToCitation = (citation: AiCitation): void => {
    scrollToPage(citation.page);
    setFlashId(null);
    setSpotlight(null);
    void (async () => {
      const page = await waitForRenderedPage(scrollRef.current, citation.page);
      if (page === null) {
        setSelectionNotice('这一页还没有渲染完，暂时无法标出引用位置；已经跳到该页。');
        return;
      }
      const located = locateAnchor(page, { quote: citation.quote, prefix: '', suffix: '' });
      if (located.match.kind === 'found') {
        setSelectionNotice(null);
        setSpotlight({ page: citation.page, rects: located.rects });
      } else if (located.match.kind === 'ambiguous') {
        setSelectionNotice('这段原文在这一页出现了多次，无法确定引用的是哪一处。');
      } else {
        setSelectionNotice('这段引文没有在这一页的文字里找到，可能是提取时残缺了。');
      }
    })();
  };

  /** Turns the reader's selection into a question for the assistant. */
  const openAi = (mode: AiMode, question: string): void => {
    if (pendingSelection === null) return;
    const pageRoot = scrollRef.current?.querySelector<HTMLElement>(
      `.pdf-page[data-page="${String(pendingSelection.anchor.page)}"]`,
    );
    const layer = pageRoot?.querySelector<HTMLElement>('.textLayer') ?? null;
    const pageText = layer === null ? '' : readPageText(layer).page.text;
    setSelectionNotice(null);
    setSpotlight(null);
    setPanel('ai');
    ai.ask(
      {
        paperId: paper.id,
        title: paper.title,
        pdfSha256: pdfSha256 ?? '',
        anchor: pendingSelection.anchor,
        pageText,
        layoutNotice:
          pageRoot === null || pageRoot === undefined ? null : inspectPageLayout(pageRoot).notice,
        // Measured here, while the rendered page that the numbers describe is still on screen.
        fragmentation:
          pageRoot === null || pageRoot === undefined
            ? null
            : measureFragmentation(pageRoot, pendingSelection.anchor),
      },
      mode,
      question,
    );
    clearSelection();
  };

  const saveAiNote = (turn: AiTurn): void => {
    if (ai.session === null || turn.answer === null) return;
    onSaveAiNote(ai.session.source.anchor, {
      note: turn.answer.answer,
      sourceLabel: turn.answer.providerLabel,
    });
  };

  // The service's identity is only needed once the assistant is actually opened, so the app
  // does not call out on startup.
  useEffect(() => {
    if (panel !== 'ai' || health !== null) return;
    let cancelled = false;
    void (async () => {
      const found = await fetchAiHealth();
      if (!cancelled) setHealth(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [panel, health]);

  // A notice is a passing remark, not a permanent state.
  useEffect(() => {
    if (selectionNotice === null) return;
    const timer = window.setTimeout(() => {
      setSelectionNotice(null);
    }, 7000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [selectionNotice]);

  return (
    <div className="reader">
      <div className="reader-bar">
        <button type="button" className="btn btn-quiet" onClick={onClose}>
          <ArrowLeft size={15} aria-hidden="true" />
          返回
        </button>
        <h1 className="reader-title" title={paper.title}>
          {paper.title}
        </h1>

        <div className="reader-page">
          {state.status === 'ready' ? (
            <>
              <button
                type="button"
                className="icon-btn"
                aria-label="上一页"
                disabled={currentPage <= 1}
                onClick={() => {
                  scrollToPage(currentPage - 1);
                }}
              >
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
              <label className="reader-page-jump">
                <span className="sr-only">跳转到页码</span>
                <input
                  type="number"
                  min={1}
                  max={pageCount}
                  value={pageDraft ?? String(currentPage)}
                  onChange={(event) => {
                    setPageDraft(event.target.value);
                  }}
                  onBlur={commitPageDraft}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitPageDraft();
                  }}
                />
              </label>
              <span className="reader-page-total">/ {pageCount}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label="下一页"
                disabled={currentPage >= pageCount}
                onClick={() => {
                  scrollToPage(currentPage + 1);
                }}
              >
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </>
          ) : (
            <span className="reader-page-total">
              {state.status === 'loading' ? '正在打开…' : '—'}
            </span>
          )}
        </div>

        <div className="reader-zoom">
          <button
            type="button"
            className="icon-btn"
            aria-label="缩小"
            onClick={() => {
              zoom('out');
            }}
          >
            <ZoomOut size={15} aria-hidden="true" />
          </button>
          <span className="reader-zoom-value">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="放大"
            onClick={() => {
              zoom('in');
            }}
          >
            <ZoomIn size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            aria-pressed={fitWidth}
            onClick={() => {
              setFitWidth((value) => !value);
            }}
          >
            <Maximize2 size={14} aria-hidden="true" />
            适应宽度
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            aria-pressed={panel === 'notes'}
            onClick={() => {
              setPanel((value) => (value === 'notes' ? null : 'notes'));
            }}
          >
            <PanelRightOpen size={14} aria-hidden="true" />
            笔记{here.length > 0 ? ` ${String(here.length)}` : ''}
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            aria-pressed={panel === 'ai'}
            onClick={() => {
              setPanel((value) => (value === 'ai' ? null : 'ai'));
            }}
          >
            <Sparkles size={14} aria-hidden="true" />
            AI 答疑
          </button>
        </div>
      </div>

      {selectionNotice !== null && (
        <p className="reader-notice" role="status">
          {selectionNotice}
        </p>
      )}

      {state.status === 'loading' && (
        <p className="reader-status" role="status">
          正在打开 PDF…
        </p>
      )}

      {state.status === 'error' && (
        <div className="reader-status" role="alert">
          <p>{PDF_FAILURE_MESSAGE[state.failure]}</p>
          <button type="button" className="btn" onClick={onReplaceFile}>
            导入 PDF 文件
          </button>
        </div>
      )}

      {state.status === 'ready' && (
        <div className="reader-body">
          <div
            className="reader-scroll"
            ref={scrollRef}
            tabIndex={0}
            aria-label="PDF 页面"
            onMouseUp={readSelection}
            onKeyUp={(event) => {
              if (event.shiftKey || event.key === 'a') readSelection();
            }}
            onScroll={(event) => {
              const page = pageAtOffset(topsRef.current, event.currentTarget.scrollTop);
              const jump = jumping.current;
              if (jump !== null) {
                if (Date.now() < jump.until && page !== jump.page) return;
                jumping.current = null;
              }
              setCurrentPage((previous) => (previous === page ? previous : page));
              // A toolbar hanging over a moving page would point at nothing.
              setPendingSelection(null);
            }}
          >
            <div className="reader-column" style={{ height: `${totalHeight(heights)}px` }}>
              {Array.from({ length: pageCount }, (_, index) => {
                const pageNumber = index + 1;
                const active = pageNumber >= windowRange.first && pageNumber <= windowRange.last;
                return (
                  <div
                    key={pageNumber}
                    className="reader-slot"
                    style={{ top: `${tops[index] ?? 0}px` }}
                    data-rendered={active}
                  >
                    <PdfPage
                      doc={state.doc}
                      pageNumber={pageNumber}
                      scale={scale}
                      active={active}
                      placeholder={{
                        width: (baseSize?.width ?? 600) * scale,
                        height: (baseSize?.height ?? 800) * scale,
                      }}
                      annotations={byPage.get(pageNumber) ?? []}
                      flashId={flashId}
                      spotlight={spotlight?.page === pageNumber ? spotlight.rects : null}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {panel === 'notes' && (
            <NotesPanel
              annotations={annotations}
              currentPdfSha256={pdfSha256}
              activeId={activeAnnotationId}
              onJump={jumpToAnnotation}
              onEdit={onEditAnnotation}
              onDelete={setPendingDelete}
              onClose={() => {
                setPanel(null);
              }}
            />
          )}

          {panel === 'ai' && (
            <AiPanel
              session={ai.session}
              busy={ai.busy}
              health={health}
              onFollowUp={ai.followUp}
              onRetry={ai.retry}
              onCancel={ai.cancel}
              onClear={ai.clear}
              onSaveNote={saveAiNote}
              onJumpToCitation={jumpToCitation}
              onClose={() => {
                setPanel(null);
              }}
            />
          )}
        </div>
      )}

      {pendingSelection !== null && (
        <AnnotationToolbar
          spot={pendingSelection.spot}
          onHighlight={() => {
            saveAnnotation({ kind: 'note', note: '' });
          }}
          onNote={saveAnnotation}
          onAsk={openAi}
          onDismiss={clearSelection}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除笔记"
        confirmLabel="删除"
        danger
        onConfirm={() => {
          if (pendingDelete !== null) onDeleteAnnotation(pendingDelete);
          setPendingDelete(null);
        }}
        onClose={() => {
          setPendingDelete(null);
        }}
      >
        <p>确定删除这条高亮和它的笔记吗？删除后无法从应用里恢复。</p>
      </ConfirmDialog>
    </div>
  );
}
