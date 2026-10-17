import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Lightbulb,
  Maximize2,
  NotebookPen,
  Sparkles,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  Annotation,
  AnnotationEdit,
  AnnotationKind,
  NormalizedRect,
} from '../../domain/annotation';
import type { DifficultySuggestion } from '../../domain/difficulty';
import type { Paper } from '../../domain/papers';
import type { PdfBlobStore } from '../../services/pdfStore';
import { fetchAiHealth } from '../../services/ai/client';
import type { AiCitation, AiHealth, AiMode } from '../../services/ai/types';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { AiPanel } from './AiPanel';
import { AnnotationToolbar } from './AnnotationToolbar';
import { DifficultyPanel } from './DifficultyPanel';
import { inspectPageLayout, measureFragmentation } from './layout';
import { NotesPanel } from './NotesPanel';
import { PaperModeSwitch } from './PaperModeSwitch';
import { PdfPage } from './PdfPage';
import { SuggestionCard } from './SuggestionCard';
import { useDifficultyScan, type LocatedQuote } from './useDifficultyScan';
import { usePaperMode } from './usePaperMode';
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
import { useAiReading, type AiClient, type AiSource, type AiTurn } from './useAiReading';

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
  /** Files a difficulty suggestion as a concept in the project the reader came from. */
  onSaveConcept?: (suggestion: DifficultySuggestion) => void;
  /** False when the paper was opened outside a project, where there is no graph to file into. */
  canSaveConcept?: boolean;
  onEditAnnotation: (id: string, edit: AnnotationEdit) => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
  /** Injectable so tests and the browser checks can supply a deterministic assistant. */
  aiClient?: AiClient;
  /** The application's resolved theme, which the paper follows until the reader chooses. */
  theme: 'light' | 'dark';
  /**
   * A quotation to land on, when the reader was opened from a concept's evidence.
   *
   * It is a one-shot instruction: the reader scrolls to the page and marks the words, and the
   * caller clears it on close so an ordinary open never inherits it.
   */
  focus?: { page: number; quote: string } | null;
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
  onSaveConcept,
  canSaveConcept = false,
  onEditAnnotation,
  onDeleteAnnotation,
  aiClient,
  theme,
  focus = null,
}: ReaderViewProps) {
  const state = usePdfDocument(paper.pdf, blobs);
  const paperMode = usePaperMode(theme);
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
  /** Which of the side panels is showing, if any. */
  const [panel, setPanel] = useState<'notes' | 'ai' | 'difficulty' | null>(() =>
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

  /** The card that opens when a difficulty marker or list entry is clicked. */
  const [activeSuggestion, setActiveSuggestion] = useState<{
    suggestion: DifficultySuggestion;
    spot: { x: number; y: number };
  } | null>(null);

  /** The rendered text of one page, or null when that page is not on screen right now. */
  const pageTextFor = useCallback((page: number): string | null => {
    const layer = scrollRef.current?.querySelector<HTMLElement>(
      `.pdf-page[data-page="${String(page)}"] .textLayer`,
    );
    if (layer === null || layer === undefined) return null;
    return readPageText(layer).page.text;
  }, []);

  /**
   * Finds a suggested quotation on the page, with the same conservative matching a highlight
   * uses. Only `found` produces boxes; an ambiguous or missing quotation is kept as a
   * suggestion without a marker, never drawn somewhere plausible.
   */
  const locateQuote = useCallback((page: number, quote: string): LocatedQuote => {
    const pageRoot = scrollRef.current?.querySelector<HTMLElement>(
      `.pdf-page[data-page="${String(page)}"]`,
    );
    if (pageRoot === null || pageRoot === undefined) return { location: 'missing', anchor: null };
    const located = locateAnchor(pageRoot, { quote, prefix: '', suffix: '' });
    if (located.match.kind !== 'found') {
      return {
        location: located.match.kind === 'ambiguous' ? 'ambiguous' : 'missing',
        anchor: null,
      };
    }
    return {
      location: 'found',
      anchor: {
        quote,
        prefix: '',
        suffix: '',
        rects: located.rects,
        start: located.match.start,
        end: located.match.end,
      },
    };
  }, []);

  const scan = useDifficultyScan({
    paperId: paper.id,
    pdfSha256: pdfSha256 ?? '',
    model: health?.model ?? '',
    currentPage,
    pageTextFor,
    locate: locateQuote,
  });

  const suggestionsByPage = useMemo(() => {
    const map = new Map<number, { id: string; title: string; rects: NormalizedRect[] }[]>();
    if (!scan.markersVisible) return map;
    for (const suggestion of scan.all) {
      if (suggestion.location !== 'found' || suggestion.anchor === null) continue;
      const list = map.get(suggestion.page) ?? [];
      list.push({
        id: suggestion.id,
        title: suggestion.title,
        rects: suggestion.anchor.rects,
      });
      map.set(suggestion.page, list);
    }
    return map;
  }, [scan.all, scan.markersVisible]);

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
  const heightsRef = useRef(heights);
  useEffect(() => {
    heightsRef.current = heights;
  }, [heights]);
  /**
   * Where in the page the reader is, kept as a fraction so a width change can restore it.
   *
   * Opening or closing the side panel changes the fit-width scale, which changes every page's
   * height. Without this the scroll offset would keep its pixel value and the reader would land
   * somewhere else in the paper — the "lost my place" bug, triggered by opening a panel.
   */
  const viewAnchor = useRef<{ page: number; fraction: number }>({
    page: currentPage,
    fraction: 0,
  });
  const lastRenderedScale = useRef<number | null>(null);

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

  /**
   * Lands on a quotation a concept pointed at.
   *
   * The jump uses the same conservative matching as a citation: the page is opened either way,
   * but the words are only marked when they are found exactly once — and when they are not, the
   * reader is told rather than shown an approximate place.
   */
  useEffect(() => {
    if (focus === null || !measurable) return;
    // Started from a callback rather than the effect body: the jump changes state, and doing
    // that synchronously inside an effect cascades renders.
    void (async () => {
      scrollToPage(focus.page);
      const page = await waitForRenderedPage(scrollRef.current, focus.page);
      if (page === null) {
        setSelectionNotice('这一页还没有渲染完，暂时无法标出这条出处；已经跳到该页。');
        return;
      }
      const located = locateAnchor(page, { quote: focus.quote, prefix: '', suffix: '' });
      if (located.match.kind === 'found') {
        setSelectionNotice(null);
        setSpotlight({ page: focus.page, rects: located.rects });
      } else if (located.match.kind === 'ambiguous') {
        setSelectionNotice('这条出处在这一页出现了多次，无法确定是哪一处。');
      } else {
        setSelectionNotice('这条出处没有在这一页的文字里找到，可能是提取时残缺了。');
      }
    })();
  }, [focus, measurable, scrollToPage]);

  // Report the page the reader is on. The caller decides whether it is worth persisting.
  useEffect(() => {
    if (state.status !== 'ready' || !restored.current) return;
    onReadingPosition(clampPage(currentPage, pageCount));
  }, [currentPage, pageCount, state.status, onReadingPosition]);

  /**
   * Keeps the reader's place when the pages change size under them.
   *
   * Fit-width recalculates whenever the scroll column's width changes — which is exactly what
   * opening or closing the side panel does. The scroll offset is in pixels, so it would stay put
   * while every page grew or shrank around it. Re-anchoring on (page, fraction of that page)
   * makes the reflow invisible where it matters.
   */
  useLayoutEffect(() => {
    if (lastRenderedScale.current === null) {
      lastRenderedScale.current = scale;
      return;
    }
    if (lastRenderedScale.current === scale) return;
    lastRenderedScale.current = scale;
    const container = scrollRef.current;
    if (container === null || heights.length === 0) return;
    const page = clampPage(viewAnchor.current.page, heights.length);
    const top = tops[page - 1];
    const height = heights[page - 1];
    if (top === undefined || height === undefined) return;
    container.scrollTop = Math.max(0, top + viewAnchor.current.fraction * height - PAGE_GAP);
  }, [scale, tops, heights]);

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
  const sourceFor = (pageNumber: number, anchor: SelectionAnchor | null): AiSource | null => {
    const pageRoot = scrollRef.current?.querySelector<HTMLElement>(
      `.pdf-page[data-page="${String(pageNumber)}"]`,
    );
    const layer = pageRoot?.querySelector<HTMLElement>('.textLayer') ?? null;
    if (pageRoot == null || layer === null) return null;
    return {
      paperId: paper.id,
      title: paper.title,
      pdfSha256: pdfSha256 ?? '',
      page: pageNumber,
      anchor,
      pageText: readPageText(layer).page.text,
      layoutNotice: inspectPageLayout(pageRoot).notice,
      // Measured here, while the rendered page that the numbers describe is still on screen.
      fragmentation: anchor === null ? null : measureFragmentation(pageRoot, anchor),
    };
  };

  const openAi = (mode: AiMode, question: string): void => {
    if (pendingSelection === null) return;
    const source = sourceFor(pendingSelection.anchor.page, pendingSelection.anchor);
    if (source === null) {
      setSelectionNotice('这一页还没有渲染好，暂时无法提问。');
      return;
    }
    setSelectionNotice(null);
    setSpotlight(null);
    setPanel('ai');
    ai.ask(source, mode, question);
    clearSelection();
  };

  /**
   * A question about the page itself, with nothing selected.
   *
   * The assistant is not selection-only: opening it and asking about the page is a first-class
   * way to use it. What it is given is exactly this page's text, and the panel says so.
   */
  const askAboutPage = (mode: AiMode, question: string): void => {
    const source = sourceFor(currentPage, null);
    if (source === null || source.pageText.trim() === '') {
      setSelectionNotice('这一页还没有可提取的文字，暂时无法提问。');
      return;
    }
    setSelectionNotice(null);
    setSpotlight(null);
    setPanel('ai');
    ai.ask(source, mode, question);
  };

  /** Opens the short explanation for a suggestion, near the marker when there is one. */
  const showSuggestion = (
    suggestion: DifficultySuggestion,
    spot?: { x: number; y: number },
  ): void => {
    if (suggestion.page !== currentPage) scrollToPage(suggestion.page);
    setActiveSuggestion({
      suggestion,
      spot: spot ?? { x: window.innerWidth / 2, y: 200 },
    });
  };

  /**
   * Goes deeper: the assistant, opened on the very passage the suggestion quoted.
   *
   * This is a call the reader asked for by clicking, not one the app makes on its own — the
   * panel's provider line says what it will cost before the answer arrives.
   */
  const explainSuggestion = (suggestion: DifficultySuggestion): void => {
    setActiveSuggestion(null);
    const anchor = suggestion.anchor;
    if (anchor === null) {
      setSelectionNotice('这条建议没有可定位的原文，没法带着它提问。');
      return;
    }
    const source = sourceFor(suggestion.page, {
      page: suggestion.page,
      quote: anchor.quote,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
      rects: anchor.rects,
      start: anchor.start,
      end: anchor.end,
    });
    if (source === null) {
      setSelectionNotice('这一页还没有渲染好，暂时无法提问。');
      return;
    }
    setSpotlight(null);
    setPanel('ai');
    ai.ask(
      source,
      'walkthrough',
      `请解释「${suggestion.title}」：它在这一页里是什么意思？为什么在这里出现？`,
    );
  };

  /** Saves a suggestion as an ordinary note, marked as coming from the assistant. */
  const saveSuggestionNote = (suggestion: DifficultySuggestion): void => {
    const anchor = suggestion.anchor;
    if (anchor === null) return;
    onSaveAiNote(
      {
        page: suggestion.page,
        quote: anchor.quote,
        prefix: anchor.prefix,
        suffix: anchor.suffix,
        rects: anchor.rects,
        start: anchor.start,
        end: anchor.end,
      },
      {
        note: `${suggestion.title}\n\n${suggestion.quick}\n\n${suggestion.why}`,
        sourceLabel: 'AI 难点',
      },
    );
    setActiveSuggestion(null);
  };

  const ignoreSuggestion = (id: string): void => {
    scan.ignore(id);
    setActiveSuggestion(null);
  };

  const saveAiNote = (turn: AiTurn): void => {
    const anchor = ai.session?.source.anchor ?? null;
    // A note is anchored to text. A whole-page answer has no passage to point at, so it stays
    // an answer — saving it would mean inventing a highlight that covers the page.
    if (turn.answer === null || anchor === null) return;
    onSaveAiNote(anchor, {
      note: turn.answer.answer,
      sourceLabel: turn.answer.providerLabel,
    });
  };

  // The service's identity is only needed once the assistant or the difficulty panel is
  // actually opened, so the app does not call out on startup. Difficulty analysis also needs
  // the model name for its cache key, and it keeps working after the panel is closed.
  useEffect(() => {
    if (health !== null) return;
    if (panel !== 'ai' && panel !== 'difficulty' && !scan.enabled) return;
    let cancelled = false;
    void (async () => {
      const found = await fetchAiHealth();
      if (!cancelled) setHealth(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [panel, health, scan.enabled]);

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
          <PaperModeSwitch pref={paperMode.pref} onChange={paperMode.setPref} />
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
              const top = event.currentTarget.scrollTop;
              const page = pageAtOffset(topsRef.current, top);
              const jump = jumping.current;
              if (jump !== null) {
                if (Date.now() < jump.until && page !== jump.page) return;
                jumping.current = null;
              }
              // Remembered as (page, fraction of that page) so a reflow can put it back.
              const pageTop = topsRef.current[page - 1] ?? 0;
              const pageHeight = heightsRef.current[page - 1] ?? 0;
              viewAnchor.current = {
                page,
                fraction:
                  pageHeight > 0 ? Math.min(1, Math.max(0, (top - pageTop) / pageHeight)) : 0,
              };
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
                      palette={paperMode.palette}
                      suggestions={suggestionsByPage.get(pageNumber) ?? []}
                      onSuggestionClick={(id, spot) => {
                        const suggestion = scan.all.find((entry) => entry.id === id);
                        if (suggestion !== undefined) showSuggestion(suggestion, spot);
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {panel === null ? (
            /*
             * Collapsed, the side panel leaves a rail rather than disappearing. "Open the
             * assistant" should be one click away from anywhere in the paper, and not behind a
             * command the reader has to find first.
             */
            <div className="reader-rail" role="group" aria-label="侧边面板">
              <button
                type="button"
                className="rail-btn"
                aria-label="打开 AI 助手"
                title="AI 助手"
                onClick={() => {
                  setPanel('ai');
                }}
              >
                <Sparkles size={17} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="rail-btn"
                aria-label="打开智能难点"
                title="智能难点"
                onClick={() => {
                  setPanel('difficulty');
                }}
              >
                <Lightbulb size={17} aria-hidden="true" />
                {scan.all.length > 0 && <span className="rail-count">{scan.all.length}</span>}
              </button>
              <button
                type="button"
                className="rail-btn"
                aria-label="打开我的笔记"
                title="我的笔记"
                onClick={() => {
                  setPanel('notes');
                }}
              >
                <NotebookPen size={17} aria-hidden="true" />
                {here.length > 0 && <span className="rail-count">{here.length}</span>}
              </button>
            </div>
          ) : (
            <div className="reader-side">
              <div className="reader-side-tabs" role="group" aria-label="侧边面板">
                <button
                  type="button"
                  className="chip"
                  aria-pressed={panel === 'ai'}
                  onClick={() => {
                    setPanel('ai');
                  }}
                >
                  AI 助手
                </button>
                <button
                  type="button"
                  className="chip"
                  aria-pressed={panel === 'difficulty'}
                  onClick={() => {
                    setPanel('difficulty');
                  }}
                >
                  难点{scan.all.length > 0 ? ` ${String(scan.all.length)}` : ''}
                </button>
                <button
                  type="button"
                  className="chip"
                  aria-pressed={panel === 'notes'}
                  onClick={() => {
                    setPanel('notes');
                  }}
                >
                  我的笔记{here.length > 0 ? ` ${String(here.length)}` : ''}
                </button>
              </div>

              {panel === 'ai' && (
                <AiPanel
                  session={ai.session}
                  busy={ai.busy}
                  health={health}
                  currentPage={currentPage}
                  onAskAboutPage={(question) => {
                    askAboutPage('ask', question);
                  }}
                  onFollowUp={ai.followUp}
                  onRetry={ai.retry}
                  onCancel={ai.cancel}
                  onClear={ai.clear}
                  canSaveNote={ai.session?.source.anchor != null}
                  onSaveNote={saveAiNote}
                  onJumpToCitation={jumpToCitation}
                  onClose={() => {
                    setPanel(null);
                  }}
                />
              )}

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

              {panel === 'difficulty' && (
                <DifficultyPanel
                  scan={scan}
                  online={health?.online === true}
                  currentPage={currentPage}
                  onShow={showSuggestion}
                  onClose={() => {
                    setPanel(null);
                  }}
                />
              )}
            </div>
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

      {activeSuggestion !== null && (
        <SuggestionCard
          suggestion={activeSuggestion.suggestion}
          spot={activeSuggestion.spot}
          canSaveNote={activeSuggestion.suggestion.anchor !== null}
          canSaveConcept={canSaveConcept}
          onSaveConcept={() => {
            onSaveConcept?.(activeSuggestion.suggestion);
            setActiveSuggestion(null);
          }}
          onExplain={() => {
            explainSuggestion(activeSuggestion.suggestion);
          }}
          onSaveNote={() => {
            saveSuggestionNote(activeSuggestion.suggestion);
          }}
          onIgnore={() => {
            ignoreSuggestion(activeSuggestion.suggestion.id);
          }}
          onDismiss={() => {
            setActiveSuggestion(null);
          }}
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
