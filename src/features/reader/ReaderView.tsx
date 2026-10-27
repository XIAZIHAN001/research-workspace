import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ListTree,
  Maximize2,
  Network,
  Redo2,
  Search,
  Sparkles,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type {
  Annotation,
  AnnotationEdit,
  AnnotationKind,
  NormalizedRect,
} from '../../domain/annotation';
import type { DifficultySuggestion } from '../../domain/difficulty';
import type { Bookmark as BookmarkEntry } from '../../domain/bookmark';
import { buildNotesMarkdown, notesFileName } from '../../domain/notesMarkdown';
import type { Paper } from '../../domain/papers';
import type { Project } from '../../domain/project';
import type { PdfBlobStore } from '../../services/pdfStore';
import { makeId } from '../../services/ids';
import { downloadTextFile } from '../../services/download';
import { readItem, writeItem } from '../../services/storage';
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_WIDTH_STORAGE_KEY,
  READER_OVERLAY_QUERY,
} from '../../app/config';
import {
  LAYOUT_CHANGE_EVENT,
  readLastZoom,
  readZoomDefault,
  storeLastZoom,
  type LayoutChangeDetail,
  type LayoutPreset,
} from '../../app/layoutPrefs';
import { askAi, fetchAiHealth } from '../../services/ai/client';
import type { AiCitation, AiHealth, AiMode } from '../../services/ai/types';
import { AI_MODE_EVENT } from '../../services/desktop/aiService';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { useMediaQuery } from '../../ui/useMediaQuery';
import { useTimeout } from '../../ui/useTimeout';
import { AiPanel } from './AiPanel';
import { AnnotationToolbar } from './AnnotationToolbar';
import { GlossaryHover } from './GlossaryHover';
import { buildAskContext, documentScope } from '../../services/ai/context';
import type { PaperSummary } from '../../domain/papers';
import type { GlossaryEdit, GlossaryEntry } from '../../domain/glossary';
import { FindBar } from './FindBar';
import { KnowledgePanel } from './KnowledgePanel';
import { useKnowledgeAnalysis } from './useKnowledgeAnalysis';
import type { KnowledgeApi } from '../knowledge/useKnowledgeApi';
import { inspectPageLayout, measureFragmentation } from './layout';
import { OutlinePanel } from './OutlinePanel';
import { PaperModeSwitch } from './PaperModeSwitch';
import { PdfPage } from './PdfPage';
import { ReaderMoreMenu } from './ReaderMoreMenu';
import { SuggestionCard } from './SuggestionCard';
import { useDifficultyScan, type LocatedQuote } from './useDifficultyScan';
import { usePaperMode } from './usePaperMode';
import {
  describeSelection,
  locateAll,
  locateAnchor,
  pageElementOf,
  pageNumberOf,
  readPageText,
  type SelectionAnchor,
} from './selection';
import {
  clampPage,
  fitWidthScale,
  MAX_SCALE,
  MIN_SCALE,
  nextScale,
  PAGE_GAP,
  PAGE_GUTTER,
  pageAtOffset,
  pageTops,
  previousScale,
  renderWindow,
  totalHeight,
} from './readerMath';
import { PDF_FAILURE_MESSAGE, usePdfDocument } from './usePdfDocument';
import { useDocumentText } from './useDocumentText';
import { usePdfOutline } from './usePdfOutline';
import { usePdfSearch } from './usePdfSearch';
import { useReadingHistory } from './useReadingHistory';
import { useAiReading, type AiAskClient, type AiSource, type AiTurn } from './useAiReading';
import type { PaperModeController } from './usePaperMode';

/** How long the reading column must hold still before a new fit-width scale is computed. */
const RESIZE_SETTLE_MS = 120;

interface ReaderViewProps {
  paper: Paper;
  blobs: PdfBlobStore;
  /** The paper's glossary terms; hovering one in the text layer shows its definition. */
  glossary?: readonly GlossaryEntry[];
  /** Saves a term the reader defined from a selection or in the outline panel. */
  onAddTerm?: (draft: { term: string; definition: string }) => void;
  /** Stores a generated summary card on the paper. */
  onSaveSummary?: (summary: PaperSummary) => void;
  onClearSummary?: () => void;
  onEditTerm?: (id: string, edit: GlossaryEdit) => void;
  onRemoveTerm?: (id: string) => void;
  onClose: () => void;
  /** Called with the page the reader is on; the caller decides how often to persist it. */
  onReadingPosition: (page: number) => void;
  /** Offered when the stored file cannot be opened any more. */
  onReplaceFile: () => void;
  /** Every highlight on this paper, on any of its files. */
  annotations: readonly Annotation[];
  /** Saved places in this paper, kept across sessions. */
  bookmarks: readonly BookmarkEntry[];
  /** Saves the page the reader is on; an empty name falls back to the page number. */
  onAddBookmark: (page: number, label: string) => void;
  onRenameBookmark: (id: string, label: string) => void;
  onDeleteBookmark: (bookmark: BookmarkEntry) => void;
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
  /** The shared knowledge graph, for the reader's local "related knowledge" panel. */
  knowledge: KnowledgeApi;
  /** Every project, for the concept's cross-project links in that panel. */
  projects: readonly Project[];
  /** The project the reader came from, or null when the paper was opened from the library. */
  projectId: string | null;
  /** Leaves the reader and opens a concept in the project's knowledge view. */
  onOpenConceptInProject: (conceptId: string, projectId: string) => void;
  onEditAnnotation: (id: string, edit: AnnotationEdit) => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
  /** Injectable so tests and the browser checks can supply a deterministic assistant. */
  aiClient?: AiAskClient;
  /** The application's resolved theme, which the paper follows until the reader chooses. */
  theme: 'light' | 'dark';
  /**
   * The chosen workspace layout preset. 研究模式 opens the side panel with the paper; the
   * other presets leave it on the rail. Switching it mid-session applies on the spot.
   */
  layoutPreset?: LayoutPreset;
  /**
   * The paper preference, lifted so Settings › 阅读偏好 and the toolbar share one state.
   * When omitted the reader owns it, as it always has.
   */
  paperMode?: PaperModeController;
  /**
   * A quotation to land on, when the reader was opened from a concept's evidence.
   *
   * It is a one-shot instruction: the reader scrolls to the page and marks the words, and the
   * caller clears it on close so an ordinary open never inherits it.
   */
  focus?: { page: number; quote: string } | null;
}

/**
 * The overlay breakpoint lives in `app/config` because two modules need it and it has to stay in
 * step with `styles/reader.css`: below it the side column covers part of the page instead of
 * taking a column, and a drag handle there would resize nothing.
 */
const OVERLAY_QUERY = READER_OVERLAY_QUERY;

/** How long to wait for a page the reader jumped to to finish rendering its text layer. */
const RENDER_WAIT_MS = 2500;

/**
 * The summary card's transport when the host injected none.
 *
 * It is the same default `useAiReading` already uses: the assistant works without a caller
 * supplying a client, and the summary card must too. Without this fallback the button was
 * rendered but its handler returned immediately, which read as a dead control.
 */
const DEFAULT_SUMMARY_CLIENT: AiAskClient = { ask: askAi };

/**
 * Identity of the paper's summary card, as a value.
 *
 * A reference check would misread a card reloaded from storage as an edit, and would miss an
 * edit that kept the object. Creation time plus text is what actually changed when the reader
 * cleared, edited or regenerated the card.
 */
function summaryStamp(summary: PaperSummary | undefined): string | null {
  return summary === undefined ? null : `${String(summary.createdAt)}\u0000${summary.text}`;
}

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
  signal?: AbortSignal,
): Promise<HTMLElement | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // The reader may have been closed, or a different paper opened, while this was waiting.
    // Polling a detached tree would keep a timer alive for the rest of the timeout.
    if (signal?.aborted === true) return null;
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
  bookmarks,
  onAddBookmark,
  onRenameBookmark,
  onDeleteBookmark,
  onCreateAnnotation,
  onSaveAiNote,
  onSaveConcept,
  canSaveConcept = false,
  knowledge,
  projects,
  projectId,
  onOpenConceptInProject,
  onEditAnnotation,
  onDeleteAnnotation,
  glossary = [],
  onAddTerm,
  onEditTerm,
  onRemoveTerm,
  onSaveSummary,
  onClearSummary,
  aiClient,
  theme,
  layoutPreset = 'balanced',
  paperMode: paperModeProp,
  focus = null,
}: ReaderViewProps) {
  const state = usePdfDocument(paper.pdf, blobs);
  const ownedPaperMode = usePaperMode(theme);
  const paperMode = paperModeProp ?? ownedPaperMode;
  // Below the reader's overlay breakpoint the bar folds its secondary tools into a menu; the
  // breakpoint is the same one that turns the panel into an overlay, so the whole reading
  // layout switches shape together.
  const compactBar = useMediaQuery(READER_OVERLAY_QUERY);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The default-zoom strategy is read once per paper: it decides how this open starts, and
  // "沿用上次" replays the zoom of the previous session with this file.
  const [{ fit: initialFit, scale: initialScale }] = useState(() => {
    const mode = readZoomDefault();
    if (mode === '100') return { fit: false, scale: 1 };
    if (mode === 'last') return readLastZoom() ?? { fit: true, scale: 1 };
    return { fit: true, scale: 1 };
  });
  const [manualScale, setManualScale] = useState(initialScale);
  const [fitWidth, setFitWidth] = useState(initialFit);
  const [currentPage, setCurrentPage] = useState(() => paper.reading?.page ?? 1);
  /**
   * Jumps made in this session, so a reader can come back from a note, a citation or an
   * outline entry. Ordinary scrolling never writes an entry — see `useReadingHistory`.
   */
  const {
    canBack,
    canForward,
    remember: rememberPlace,
    back: stepBack,
    forward: stepForward,
  } = useReadingHistory(paper.reading?.page ?? 1);
  const currentPageRef = useRef(currentPage);
  useLayoutEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);
  const [containerWidth, setContainerWidth] = useState(0);
  const [baseSize, setBaseSize] = useState<{ width: number; height: number } | null>(null);
  /**
   * Per-page real sizes, filled by each page's own measurement.
   *
   * A paper is usually all the same size, but mixed-height documents (a tall figure page,
   * a landscape appendix) break that. The reader used to assume page 1's size applied to
   * every page, which silently mis-places scroll offsets and page jumps on such documents.
   * `baseSize` is only a starting estimate: any page that reports its real size replaces
   * its own entry, and the column re-renders from the merged map.
   */
  const [pageHeights, setPageHeights] = useState<ReadonlyMap<number, number>>(() => new Map());
  /** The widest page seen so far, at scale 1. Only ever grows, so the column never jitters. */
  const [widestPage, setWidestPage] = useState<number | null>(null);
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
  /**
   * Timers that belong to this reader, and a signal that says "this reader is gone".
   *
   * The reader polls for a page's text layer and flashes a highlight after a jump. Both are
   * asynchronous and both used to outlive the component: a poll kept a timer alive after the
   * reader closed, and a flash timer could set state on an unmounted tree. The hook cancels
   * every pending timer on unmount, and the signal lets the poll stop waiting immediately
   * rather than running out its full timeout first.
   */
  const timers = useTimeout();
  const flashTimer = useRef<number | undefined>(undefined);
  const alive = useRef<AbortController | null>(null);
  useEffect(() => {
    // A fresh controller per effect run: StrictMode's simulated unmount aborts the first one,
    // and reusing it would leave every poll in this reader cancelled for good.
    const controller = new AbortController();
    alive.current = controller;
    return () => {
      controller.abort();
      if (alive.current === controller) alive.current = null;
    };
  }, []);
  const [pendingDelete, setPendingDelete] = useState<Annotation | null>(null);
  /** The find bar is open. The query lives in the hook, so closing and reopening keeps it. */
  const [findOpen, setFindOpen] = useState(false);
  /** Boxes for the find hits on one page. Only ever one page has boxes. */
  const [findRects, setFindRects] = useState<{ page: number; rects: NormalizedRect[] } | null>(
    null,
  );
  const search = usePdfSearch(state.status === 'ready' ? state.doc : null, findOpen);
  /** The document's own table of contents, loaded when the document opens. */
  const outline = usePdfOutline(state.status === 'ready' ? state.doc : null);
  /** Which of the side panels is showing, if any. */
  const [panel, setPanel] = useState<'ai' | 'knowledge' | 'outline' | null>(() => {
    if (typeof window.matchMedia === 'function' && window.matchMedia(OVERLAY_QUERY).matches) {
      return null;
    }
    return layoutPreset === 'research' ? 'outline' : null;
  });
  /** The panel that was open last, so 研究模式 reopens the one the reader used. */
  const lastPanelRef = useRef<'ai' | 'knowledge' | 'outline'>('outline');
  useEffect(() => {
    if (panel !== null) lastPanelRef.current = panel;
  }, [panel]);
  // Choosing a preset in Settings applies while reading: research opens the last panel, the
  // others fold back to the rail. Below the overlay breakpoint the panel is transient, so
  // nothing to apply there.
  const presetRef = useRef(layoutPreset);
  useEffect(() => {
    if (presetRef.current === layoutPreset) return;
    presetRef.current = layoutPreset;
    if (typeof window.matchMedia === 'function' && window.matchMedia(OVERLAY_QUERY).matches) {
      return;
    }
    setPanel(layoutPreset === 'research' ? lastPanelRef.current : null);
  }, [layoutPreset]);
  /**
   * How wide the side panel column is.
   *
   * Persisted, clamped, and adjustable by dragging its edge or with the arrow keys. Reading is
   * the reason this column exists, and a reader working through a proof needs it narrower or
   * wider depending on the paper and the window — a fixed width serves neither.
   */
  const [panelWidth, setPanelWidthRaw] = useState(() => {
    const stored = Number(readItem(PANEL_WIDTH_STORAGE_KEY));
    if (!Number.isFinite(stored) || stored <= 0) return PANEL_DEFAULT_WIDTH;
    return Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(stored)));
  });
  const setPanelWidth = useCallback((next: number) => {
    const clamped = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(next)));
    setPanelWidthRaw(clamped);
    writeItem(PANEL_WIDTH_STORAGE_KEY, String(clamped));
  }, []);
  const nudgePanelWidth = useCallback(
    (delta: number) => {
      setPanelWidth(panelWidth + delta);
    },
    [panelWidth, setPanelWidth],
  );
  /** Pointer-captured drag on the panel's left edge; growing the panel means dragging left. */
  const startPanelResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = panelWidth;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      const onMove = (move: PointerEvent): void => {
        setPanelWidth(startWidth - (move.clientX - startX));
      };
      const onUp = (): void => {
        handle.releasePointerCapture(event.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    },
    [panelWidth, setPanelWidth],
  );

  // Settings can set the panel's width directly, and "恢复默认布局" resets width and zoom;
  // both arrive as one layout-change announcement because the column lives here.
  useEffect(() => {
    const onLayoutChange = (event: Event): void => {
      const detail = (event as CustomEvent<LayoutChangeDetail>).detail ?? {};
      if (detail.panelWidth !== undefined) {
        setPanelWidthRaw(
          Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(detail.panelWidth))),
        );
      }
      if (detail.reset === true) {
        setPanelWidthRaw(PANEL_DEFAULT_WIDTH);
        setFitWidth(true);
        setManualScale(1);
      }
    };
    window.addEventListener(LAYOUT_CHANGE_EVENT, onLayoutChange);
    return () => {
      window.removeEventListener(LAYOUT_CHANGE_EVENT, onLayoutChange);
    };
  }, []);

  // The "沿用上次" default needs to know what the reader used last. It is written on every
  // zoom change; the strategy only reads it back when it is the selected one.
  useEffect(() => {
    storeLastZoom({ fit: fitWidth, scale: manualScale });
  }, [fitWidth, manualScale]);

  /** Boxes shown briefly when the reader follows a citation. Never saved, never a highlight. */
  const [spotlight, setSpotlight] = useState<{ page: number; rects: NormalizedRect[] } | null>(
    null,
  );
  const [health, setHealth] = useState<AiHealth | null>(null);
  const ai = useAiReading(aiClient);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryNotice, setSummaryNotice] = useState<string | null>(null);
  /**
   * Identifies the one summary generation allowed to write its result.
   *
   * A request that was replaced, cancelled or left behind by a closed reader still settles. Only
   * the generation that still owns the card may call `onSaveSummary`.
   */
  const summarySeq = useRef(0);
  const summaryInFlight = useRef<AbortController | null>(null);
  /**
   * What a summary result must still match when it arrives.
   *
   * A ref rather than a closure: an in-flight request's own closure holds the values from when
   * it started, which is exactly what cannot tell whether the reader has since changed them.
   */
  const summaryTarget = useRef<{
    paperId: string;
    pdfSha256: string | null;
    summary: string | null;
  }>({
    paperId: paper.id,
    pdfSha256: paper.pdf?.sha256 ?? null,
    summary: summaryStamp(paper.summary),
  });
  useLayoutEffect(() => {
    // A layout effect, not a render-time write: the value must be current before an in-flight
    // request's continuation can read it, and refs may not be written during render.
    summaryTarget.current = {
      paperId: paper.id,
      pdfSha256: paper.pdf?.sha256 ?? null,
      summary: summaryStamp(paper.summary),
    };
  }, [paper.id, paper.pdf?.sha256, paper.summary]);
  /**
   * One health probe at a time, shared by the summary disclosure.
   *
   * The disclosure is the first place a reader can send a whole paper to the assistant
   * without ever opening the AI panel, so it must ask what the service is before saying
   * anything about cost. It also must not ask twice while the same answer is in flight.
   */
  const healthInFlight = useRef(false);
  const ensureHealth = useCallback(async (): Promise<void> => {
    if (health !== null || healthInFlight.current) return;
    healthInFlight.current = true;
    try {
      const found = await fetchAiHealth();
      if (found !== null) setHealth(found);
    } finally {
      healthInFlight.current = false;
    }
  }, [health]);

  const pdfSha256 = paper.pdf?.sha256 ?? null;
  useEffect(() => {
    // Opening another paper, replacing the file or leaving the reader invalidates a pending
    // summary: aborting stops its cost, and the sequence stops a late success from being saved.
    // The reset runs off the effect body (a synchronous setState there cascades renders); by
    // then the abort above has cleared the controller, so a newer request cannot be clobbered.
    queueMicrotask(() => {
      if (summaryInFlight.current === null) setSummaryBusy(false);
    });
    return () => {
      summarySeq.current += 1;
      summaryInFlight.current?.abort();
      summaryInFlight.current = null;
    };
  }, [paper.id, pdfSha256]);
  // One transport for the summary card, injected or the app's own. The AI panel already has
  // the same fallback through `useAiReading`; the summary must not be the one path that can
  // silently have no client at all.
  const summaryClient = aiClient ?? DEFAULT_SUMMARY_CLIENT;
  // Read in the background, once per file: the assistant answers from the whole paper, not the page.
  const documentText = useDocumentText(
    state.status === 'ready' ? state.doc : null,
    pdfSha256 === null ? null : `pdf:${pdfSha256}`,
  );
  // The disclosure and the request share one calculation: pages actually eligible, not the
  // total on the file. The current page is skipped there because its text travels as the
  // primary passage; it is still counted as sent.
  const summaryScope = useMemo(() => {
    const planned = documentScope(documentText.pages, currentPage);
    return planned === null
      ? null
      : {
          pagesSent: planned.pagesSent,
          pagesTotal: planned.pagesTotal,
          truncated: planned.truncated,
        };
  }, [documentText.pages, currentPage]);
  const here = useMemo(
    () => annotations.filter((annotation) => annotation.pdfSha256 === pdfSha256),
    [annotations, pdfSha256],
  );
  // The same paper after its file was replaced: the notes are kept, but they belong to a file
  // this reader cannot draw. They stay visible in the outline (without a jump) instead of
  // silently disappearing — the merge into the outline must not hide them.
  const elsewhere = useMemo(
    () =>
      pdfSha256 === null
        ? []
        : annotations.filter(
            (annotation) => annotation.paperId === paper.id && annotation.pdfSha256 !== pdfSha256,
          ),
    [annotations, paper.id, pdfSha256],
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
    online: health?.online === true,
    serviceInstanceId: health?.instanceId ?? '',
    currentPage,
    pageTextFor,
    locate: locateQuote,
  });

  const knowledgeAnalysis = useKnowledgeAnalysis({
    doc: state.status === 'ready' ? state.doc : null,
    knowledge,
    makeId,
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

  const heights = useMemo(() => {
    if (baseSize === null) return [];
    return Array.from({ length: pageCount }, (_, index) => {
      const pageNumber = index + 1;
      const measured = pageHeights.get(pageNumber);
      // A page with its own measurement wins; otherwise fall back to the page-1 estimate.
      return (measured ?? baseSize.height) * scale;
    });
  }, [baseSize, pageCount, scale, pageHeights]);

  const onMeasure = useCallback((pageNumber: number, size: { width: number; height: number }) => {
    setPageHeights((prev) => {
      const next = new Map(prev);
      next.set(pageNumber, size.height);
      return next;
    });
    // A paper is usually one page size, but a landscape figure page is not, and the column has
    // to be wide enough for the widest page the reader can scroll to.
    setWidestPage((prev) => (prev === null || size.width > prev ? size.width : prev));
  }, []);
  const tops = useMemo(() => pageTops(heights), [heights]);
  // Read by the scroll handler, which needs the current column rather than the one from
  // the render it was attached in. Kept in step inside `useLayoutEffect`: a scale change writes
  // `scrollTop` from the new column in a layout effect of the same commit, and the scroll event
  // that write produces must read the new column too — a passive-effect update can land after
  // the event, and the handler would then measure the new offset against the old layout and
  // report a page the reader is not on.
  const topsRef = useRef(tops);
  useLayoutEffect(() => {
    topsRef.current = tops;
  }, [tops]);
  const heightsRef = useRef(heights);
  useLayoutEffect(() => {
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
  //
  // The measurement is debounced because the column width rarely changes in one step: the
  // sidebar slides over 230ms and the panel handle is dragged continuously. Each intermediate
  // width used to produce a new fit-width scale, and every new scale cancels and re-renders
  // the active PDF canvases — the page visibly zoomed and flickered all the way through the
  // animation. One measurement after the width settles gives the same final scale with a
  // single render.
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    let timer = 0;
    const measure = (): void => {
      setContainerWidth(element.clientWidth);
    };
    const schedule = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, RESIZE_SETTLE_MS);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    return () => {
      window.clearTimeout(timer);
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
    (page: number, behavior: ScrollBehavior = 'smooth', record = true) => {
      const target = clampPage(page, pageCount);
      // Both ends of the jump are recorded: "back" returns to where it started, and a later
      // jump treats this page as a real place. A history replay itself, and ordinary page
      // stepping, pass `record: false`.
      if (record) rememberPlace(currentPageRef.current, target);
      setCurrentPage(target);
      // The anchor moves with the jump, not after it lands: a reflow that arrives while the
      // smooth scroll is still travelling (opening a panel, resizing the column) restores from
      // this anchor, and restoring the pre-jump place would undo the jump under the reader.
      viewAnchor.current = { page: target, fraction: 0 };
      // A smooth scroll passes through the pages in between; without this the indicator
      // would flicker back to them and the position could be saved mid-flight.
      jumping.current = { page: target, until: Date.now() + 1500 };
      const container = scrollRef.current;
      const top = topsRef.current[target - 1];
      if (container === null || top === undefined) return;
      container.scrollTo({ top: Math.max(0, top - PAGE_GAP), behavior });
    },
    [pageCount, rememberPlace],
  );

  const goBack = useCallback(() => {
    const page = stepBack();
    if (page !== null) scrollToPage(page, 'smooth', false);
  }, [scrollToPage, stepBack]);

  const goForward = useCallback(() => {
    const page = stepForward();
    if (page !== null) scrollToPage(page, 'smooth', false);
  }, [scrollToPage, stepForward]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindRects(null);
    // Back to the page, where the keyboard already was: Esc should not leave focus inside a
    // bar that just disappeared.
    scrollRef.current?.focus();
  }, []);

  // The app's own find, in place of the web view's. Only the shortcut is global; once the bar
  // is open, its keys are handled locally so they cannot trip the reader's other shortcuts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return;
      // A dialog owns its focus and its keys; a field is where the reader is already typing.
      if (document.querySelector('dialog[open]') !== null) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('input, textarea, [contenteditable="true"]') !== null) return;
      event.preventDefault();
      setFindOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  // Alt+← / Alt+→ walk the jump history. The same guard as the find shortcut: a dialog or a
  // text field owns its keys, and a replay must not be recorded as a new jump.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      if (document.querySelector('dialog[open]') !== null) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target !== null && target.closest('input, textarea, [contenteditable="true"]') !== null) {
        return;
      }
      event.preventDefault();
      if (event.key === 'ArrowLeft') goBack();
      else goForward();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [goBack, goForward]);

  const findHit = search.active >= 0 ? search.hits[search.active] : undefined;
  const visibleFindRects =
    findOpen && findHit !== undefined && findRects !== null && findRects.page === findHit.page
      ? findRects.rects
      : null;

  /**
   * Follows the current result.
   *
   * The column only renders a window of pages, so a result on a far page cannot be measured
   * until the scroll has brought it in. The effect scrolls first, waits for that page's text
   * layer, and only then asks where the words are — measuring before the text exists would
   * report "not found" for words that are plainly there.
   */
  useEffect(() => {
    if (!findOpen || findHit === undefined) return;
    let cancelled = false;
    void (async () => {
      scrollToPage(findHit.page, 'auto');
      const page = await waitForRenderedPage(
        scrollRef.current,
        findHit.page,
        RENDER_WAIT_MS,
        alive.current?.signal,
      );
      if (cancelled || page === null) return;
      const located = locateAll(page, search.query);
      const chosen = located[Math.min(findHit.ordinal, located.length - 1)];
      if (cancelled) return;
      if (chosen === undefined) {
        setFindRects(null);
        return;
      }
      setFindRects({ page: findHit.page, rects: chosen.rects });
      const container = scrollRef.current;
      const top = topsRef.current[findHit.page - 1];
      const height = heightsRef.current[findHit.page - 1];
      const first = chosen.rects[0];
      if (container !== null && top !== undefined && height !== undefined && first !== undefined) {
        // A little above the words, so the toolbar does not sit on the result.
        container.scrollTop = Math.max(0, top + first.y * height - 96);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [findOpen, findHit, search.query, scrollToPage]);

  // Opening the knowledge panel changes the reading column's width; in fit-width mode that
  // reflows every page and can leave the page the reader selected out of view. Put the panel's
  // own page back under the reader once the layout has settled — this is the one page the
  // selection and the panel are talking about.
  useEffect(() => {
    if (panel !== 'knowledge') return;
    const page = knowledgeAnalysis.context?.currentPage;
    if (page === undefined) return;
    const timer = window.setTimeout(() => {
      // A reflow put the page out of view; this is not a navigation the reader asked for.
      scrollToPage(page, 'auto', false);
    }, 80);
    return () => {
      window.clearTimeout(timer);
    };
  }, [panel, knowledgeAnalysis.context?.currentPage, scrollToPage]);

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
      const page = await waitForRenderedPage(
        scrollRef.current,
        focus.page,
        RENDER_WAIT_MS,
        alive.current?.signal,
      );
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
    // The fraction is measured from the page's own top, so restoring it needs no gap
    // adjustment. A reflow happens many times in a row while a column animates or is dragged,
    // and any constant term here would be lost again on every one of them — the view drifted
    // a step per reflow and landed pages away from where the reader was.
    container.scrollTop = Math.max(0, top + viewAnchor.current.fraction * height);
    // Horizontally the page stays centred, which is where it sits whenever it fits: zooming in
    // from fit-width would otherwise hand the reader the page's left edge instead of its middle.
    container.scrollLeft = Math.max(0, (container.scrollWidth - container.clientWidth) / 2);
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
      const page = await waitForRenderedPage(
        scrollRef.current,
        annotation.page,
        RENDER_WAIT_MS,
        alive.current?.signal,
      );
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
    // Replaces any flash still running, and is cancelled with the reader if it closes first.
    flashTimer.current = timers.scheduleReplacing(
      flashTimer.current,
      () => {
        setFlashId((current) => (current === annotation.id ? null : current));
      },
      1600,
    );
  };

  /**
   * Follows any verified quotation back to its page.
   *
   * Used by assistant citations and by knowledge evidence. The page is a fact from our own
   * record; where on the page it points is found by matching the quoted text — and when that is
   * ambiguous or fails, the reader is told. Nothing is highlighted on a guess.
   */
  const jumpToQuote = (page: number, quote: string): void => {
    scrollToPage(page);
    setFlashId(null);
    setSpotlight(null);
    void (async () => {
      const pageElement = await waitForRenderedPage(
        scrollRef.current,
        page,
        RENDER_WAIT_MS,
        alive.current?.signal,
      );
      if (pageElement === null) {
        setSelectionNotice('这一页还没有渲染完，暂时无法标出引用位置；已经跳到该页。');
        return;
      }
      const located = locateAnchor(pageElement, { quote, prefix: '', suffix: '' });
      if (located.match.kind === 'found') {
        setSelectionNotice(null);
        setSpotlight({ page, rects: located.rects });
      } else if (located.match.kind === 'ambiguous') {
        setSelectionNotice('这段原文在这一页出现了多次，无法确定引用的是哪一处。');
      } else {
        setSelectionNotice('这段引文没有在这一页的文字里找到，可能是提取时残缺了。');
      }
    })();
  };

  const jumpToCitation = (citation: AiCitation): void => {
    jumpToQuote(citation.page, citation.quote);
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
      documentPages: documentText.pages,
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

  /**
   * Opens the knowledge panel for a selection, or for the page when nothing is selected.
   *
   * This is deliberately local: it assembles the context and reads the existing graph. No
   * request leaves the machine until the reader presses "开始分析" inside the panel.
   */
  const openKnowledge = (anchor: SelectionAnchor | null): void => {
    const page = anchor?.page ?? currentPage;
    const source = sourceFor(page, anchor);
    if (source === null || source.pageText.trim() === '') {
      setSelectionNotice('这一页还没有可提取的文字，暂时无法查看相关知识。');
      return;
    }
    setSelectionNotice(null);
    setSpotlight(null);
    setPanel('knowledge');
    knowledgeAnalysis.open({
      paperId: paper.id,
      title: paper.title,
      pdfSha256: pdfSha256 ?? '',
      currentPage: page,
      projectId,
      selection: anchor,
      pageText: source.pageText,
      annotations: here,
      difficulties: scan.all,
    });
    if (anchor !== null) clearSelection();
  };

  /**
   * Generates the paper's summary card: the whole document as passages, one confirmed click.
   *
   * The answer is stored verbatim with its provenance, the same rule an assistant note follows:
   * a card keeps saying which model wrote it, forever, even after that model is long gone.
   */
  const generateSummary = async (): Promise<void> => {
    if (summaryBusy || onSaveSummary === undefined) return;
    setSummaryNotice(null);
    if (documentText.pages.length === 0) {
      setSummaryNotice('论文文字还没有提取好，稍等一下再试。');
      return;
    }
    const pageSource = sourceFor(currentPage, null);
    if (pageSource === null) {
      setSummaryNotice('当前页还没有渲染好，暂时无法组织请求。');
      return;
    }
    const sequence = ++summarySeq.current;
    // A newer generation owns the card from here on. The older request is aborted so it does
    // not keep spending; its late result is discarded by the sequence check below.
    summaryInFlight.current?.abort();
    const controller = new AbortController();
    summaryInFlight.current = controller;
    const target = {
      paperId: paper.id,
      pdfSha256,
      summary: summaryTarget.current.summary,
    };
    setSummaryBusy(true);
    try {
      const request = buildAskContext({
        paperId: paper.id,
        title: paper.title,
        pdfSha256: pdfSha256 ?? '',
        page: currentPage,
        pageText: pageSource.pageText,
        layoutNotice: null,
        documentPages: documentText.pages,
        mode: 'summarize',
        question: '请按「问题 / 方法 / 结论」生成这篇论文的摘要卡。',
      });
      const result = await summaryClient.ask(request, { signal: controller.signal });
      // Only the current generation, for the current paper and file, may write. A closed reader,
      // a replaced PDF or a newer generation all bump the sequence.
      if (summarySeq.current !== sequence) return;
      const now = summaryTarget.current;
      if (now.paperId !== target.paperId || now.pdfSha256 !== target.pdfSha256) return;
      if (now.summary !== target.summary) {
        // The reader cleared or edited the card while this request was running. Writing the
        // result now would silently undo that edit.
        setSummaryNotice('摘要在等待期间已经变更，这次生成的结果没有覆盖它。');
        return;
      }
      if (!result.ok) {
        if (result.failure.kind === 'cancelled') return;
        setSummaryNotice(`生成失败：${result.failure.message}`);
        return;
      }
      // A card with no text would be stored only until the next reload, where the parser
      // rightly drops it. Refuse it now and say why instead of showing a card that vanishes.
      if (result.answer.answer.trim() === '') {
        setSummaryNotice('生成失败：模型没有返回可保存的内容。');
        return;
      }
      onSaveSummary({
        text: result.answer.answer,
        // The card keeps naming the file it was written from, so a replaced PDF can be caught.
        ...(pdfSha256 === null ? {} : { pdfSha256 }),
        provider: result.answer.provider,
        providerLabel: result.answer.providerLabel,
        model: result.answer.model,
        online: result.answer.online,
        createdAt: Date.now(),
      });
    } catch (error) {
      if (summarySeq.current !== sequence) return;
      setSummaryNotice(`生成失败：${String(error)}`);
    } finally {
      // A superseded request must not clear the newer one's busy state.
      if (summarySeq.current === sequence) {
        summaryInFlight.current = null;
        setSummaryBusy(false);
      }
    }
  };

  /** The tab and the rail open the current session when there is one, and create one if not. */
  const showKnowledgePanel = (): void => {
    if (knowledgeAnalysis.context === null || knowledgeAnalysis.context.paperId !== paper.id) {
      openKnowledge(null);
      return;
    }
    setPanel('knowledge');
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
    if (panel !== 'ai' && panel !== 'knowledge' && !scan.enabled) return;
    let cancelled = false;
    let retry: number | undefined;
    const load = async (): Promise<void> => {
      const found = await fetchAiHealth();
      if (cancelled) return;
      if (found === null) {
        // The sidecar may be restarting for a mode change. Retry while the panel is open
        // instead of leaving it permanently without provider information.
        retry = window.setTimeout(() => {
          void load();
        }, 1500);
        return;
      }
      setHealth(found);
    };
    void load();
    return () => {
      cancelled = true;
      if (retry !== undefined) window.clearTimeout(retry);
    };
  }, [panel, health, scan.enabled]);

  // A desktop mode or key change replaces the service process. The old health no longer
  // describes the service the panels will talk to, so drop it and let the effect above refetch.
  useEffect(() => {
    const refresh = (): void => {
      setHealth(null);
    };
    window.addEventListener(AI_MODE_EVENT, refresh);
    return () => {
      window.removeEventListener(AI_MODE_EVENT, refresh);
    };
  }, []);

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
        <div className="reader-bar-lead">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            <ArrowLeft size={15} aria-hidden="true" />
            返回
          </button>
          <h1 className="reader-title" title={paper.title}>
            {paper.title}
          </h1>

          {!compactBar && (
            <div className="reader-history" role="group" aria-label="阅读位置历史">
              <button
                type="button"
                className="icon-btn"
                aria-label="回到上一个阅读位置"
                title="上一个位置（Alt+←）"
                disabled={!canBack}
                onClick={goBack}
              >
                <Undo2 size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="前往下一个阅读位置"
                title="下一个位置（Alt+→）"
                disabled={!canForward}
                onClick={goForward}
              >
                <Redo2 size={15} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>

        {!compactBar && (
          <button
            type="button"
            className="icon-btn"
            aria-label="查找"
            title="查找（Ctrl+F）"
            aria-pressed={findOpen}
            disabled={state.status !== 'ready'}
            onClick={() => {
              if (findOpen) closeFind();
              else setFindOpen(true);
            }}
          >
            <Search size={15} aria-hidden="true" />
          </button>
        )}

        <div className="reader-page" role="group" aria-label="页码导航">
          {state.status === 'ready' ? (
            <>
              <button
                type="button"
                className="icon-btn"
                aria-label="上一页"
                disabled={currentPage <= 1}
                onClick={() => {
                  scrollToPage(currentPage - 1, 'smooth', false);
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
                  scrollToPage(currentPage + 1, 'smooth', false);
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

        <div className="reader-zoom" role="group" aria-label="缩放">
          <button
            type="button"
            className="icon-btn"
            aria-label="缩小"
            disabled={scale <= MIN_SCALE + 0.001}
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
            disabled={scale >= MAX_SCALE - 0.001}
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
          {!compactBar && <PaperModeSwitch pref={paperMode.pref} onChange={paperMode.setPref} />}
        </div>

        {compactBar && (
          <ReaderMoreMenu
            findOpen={findOpen}
            onToggleFind={() => {
              if (findOpen) closeFind();
              else setFindOpen(true);
            }}
            canBack={canBack}
            canForward={canForward}
            onBack={goBack}
            onForward={goForward}
            paperMode={paperMode.pref}
            onPaperMode={paperMode.setPref}
          />
        )}
      </div>

      {findOpen && state.status === 'ready' && (
        <FindBar
          query={search.query}
          onQuery={search.setQuery}
          active={search.active}
          count={search.hits.length}
          page={findHit?.page ?? null}
          status={search.status}
          searching={search.searching}
          scanned={search.scanned}
          total={search.total}
          onNext={search.next}
          onPrev={search.prev}
          onClose={closeFind}
        />
      )}

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
            {/*
              The column is as wide as the page it holds, not as wide as the viewport. The
              slots are centred absolutely inside it, so a column fixed to the viewport width
              let a zoomed-in page overflow on both sides — and a left-to-right scroll container
              can only scroll towards its end, which left the overflow on the left permanently
              unreachable (the paper's own line numbers on the left never showed).
            */}
            <div
              className="reader-column"
              style={{
                height: `${totalHeight(heights)}px`,
                width: `${Math.max(
                  containerWidth,
                  (widestPage ?? baseSize?.width ?? 600) * scale + PAGE_GUTTER * 2,
                )}px`,
              }}
            >
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
                      onMeasure={onMeasure}
                      annotations={byPage.get(pageNumber) ?? []}
                      flashId={flashId}
                      spotlight={spotlight?.page === pageNumber ? spotlight.rects : null}
                      findRects={
                        visibleFindRects !== null && findRects?.page === pageNumber
                          ? visibleFindRects
                          : null
                      }
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
                aria-label="打开目录、书签和笔记"
                title="目录 · 书签 · 笔记"
                onClick={() => {
                  setPanel('outline');
                }}
              >
                <ListTree size={17} aria-hidden="true" />
                {bookmarks.length + here.length > 0 && (
                  <span className="rail-count">{bookmarks.length + here.length}</span>
                )}
              </button>
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
                aria-label="打开相关知识与难点"
                title="相关知识 · 难点"
                onClick={showKnowledgePanel}
              >
                <Network size={17} aria-hidden="true" />
                {scan.all.length > 0 && <span className="rail-count">{scan.all.length}</span>}
              </button>
            </div>
          ) : (
            <div
              className="reader-side"
              style={{ '--panel-w': `${String(panelWidth)}px` } as CSSProperties}
            >
              <div
                className="panel-resize"
                role="separator"
                aria-label="调整侧边面板宽度"
                aria-orientation="vertical"
                aria-valuenow={panelWidth}
                aria-valuemin={PANEL_MIN_WIDTH}
                aria-valuemax={PANEL_MAX_WIDTH}
                tabIndex={0}
                onPointerDown={startPanelResize}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft') {
                    event.preventDefault();
                    nudgePanelWidth(-16);
                  } else if (event.key === 'ArrowRight') {
                    event.preventDefault();
                    nudgePanelWidth(16);
                  } else if (event.key === 'Home') {
                    event.preventDefault();
                    setPanelWidth(PANEL_MIN_WIDTH);
                  } else if (event.key === 'End') {
                    event.preventDefault();
                    setPanelWidth(PANEL_MAX_WIDTH);
                  }
                }}
              >
                <span className="panel-resize__grip" aria-hidden="true" />
              </div>
              <div className="reader-side-tabs" role="group" aria-label="侧边面板">
                <button
                  type="button"
                  className="chip"
                  aria-pressed={panel === 'outline'}
                  onClick={() => {
                    setPanel('outline');
                  }}
                >
                  目录
                  {bookmarks.length + here.length > 0
                    ? ` ${String(bookmarks.length + here.length)}`
                    : ''}
                </button>
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
                  aria-pressed={panel === 'knowledge'}
                  onClick={showKnowledgePanel}
                >
                  知识{scan.all.length > 0 ? ` ${String(scan.all.length)}` : ''}
                </button>
              </div>

              {panel === 'outline' && (
                <OutlinePanel
                  outline={outline}
                  currentPage={currentPage}
                  onJump={(page) => {
                    scrollToPage(page);
                  }}
                  onClose={() => {
                    setPanel(null);
                  }}
                  bookmarks={bookmarks}
                  annotations={here}
                  elsewhereNotes={elsewhere}
                  activeNoteId={activeAnnotationId}
                  onAddBookmark={(label) => {
                    onAddBookmark(currentPage, label);
                  }}
                  onRenameBookmark={onRenameBookmark}
                  onDeleteBookmark={onDeleteBookmark}
                  onJumpToNote={jumpToAnnotation}
                  onEditNote={(id, note) => {
                    onEditAnnotation(id, { note });
                  }}
                  onResolveNote={(id, resolvedAt) => {
                    onEditAnnotation(id, { resolvedAt });
                  }}
                  onDeleteNote={setPendingDelete}
                  glossary={glossary}
                  summary={paper.summary}
                  summaryBusy={summaryBusy}
                  summaryNotice={summaryNotice}
                  summaryScope={summaryScope}
                  summaryOnline={health === null ? null : health.online}
                  onPrepareSummary={() => {
                    void ensureHealth();
                  }}
                  summaryStale={
                    paper.summary?.pdfSha256 !== undefined &&
                    paper.summary.pdfSha256 !== (paper.pdf?.sha256 ?? paper.summary.pdfSha256)
                  }
                  onGenerateSummary={onSaveSummary === undefined ? undefined : generateSummary}
                  onClearSummary={onClearSummary}
                  onAddGlossaryTerm={onAddTerm}
                  onEditGlossaryTerm={onEditTerm}
                  onRemoveGlossaryTerm={onRemoveTerm}
                  onExportNotes={() => {
                    downloadTextFile(
                      notesFileName(paper),
                      buildNotesMarkdown({ paper, annotations }),
                      'text/markdown;charset=utf-8',
                    );
                  }}
                />
              )}

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
                  documentReady={documentText.ready && documentText.pages.length > 0}
                  onClose={() => {
                    setPanel(null);
                  }}
                />
              )}

              {panel === 'knowledge' && (
                <KnowledgePanel
                  paper={paper}
                  projectId={projectId}
                  projects={projects}
                  knowledge={knowledge}
                  analysis={knowledgeAnalysis}
                  health={health}
                  onClose={() => {
                    setPanel(null);
                  }}
                  onJumpToQuote={jumpToQuote}
                  onOpenConceptInProject={onOpenConceptInProject}
                  onNotice={setSelectionNotice}
                  scan={scan}
                  online={health?.online === true}
                  currentPage={currentPage}
                  onShowDifficulty={showSuggestion}
                />
              )}
            </div>
          )}
        </div>
      )}

      <GlossaryHover entries={glossary} />

      {pendingSelection !== null && (
        <AnnotationToolbar
          spot={pendingSelection.spot}
          onHighlight={() => {
            saveAnnotation({ kind: 'note', note: '' });
          }}
          onNote={saveAnnotation}
          onAsk={openAi}
          onKnowledge={() => {
            openKnowledge(pendingSelection.anchor);
          }}
          onTerm={
            onAddTerm === undefined
              ? undefined
              : (draft) => {
                  onAddTerm(draft);
                  // The toolbar belongs to the selection it was opened for; once the term is
                  // recorded there is nothing left to act on, and leaving it open made the
                  // reader dismiss a form that had already saved.
                  clearSelection();
                }
          }
          selectionText={pendingSelection.anchor.quote}
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
