import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  suggestionId,
  type DifficultyLocation,
  type DifficultyPageRecord,
  type DifficultySuggestion,
} from '../../domain/difficulty';
import { analyzeDifficulties, type DifficultyAnalysis } from '../../services/ai/client';
import {
  DIFFICULTY_RULES_VERSION,
  ignoredFor,
  loadDifficultyPrefs,
  loadDifficulties,
  pageKey,
  saveDifficultyPrefs,
  saveDifficulties,
  withIgnored,
  withPageRecord,
  withoutPaper,
  type DifficultyState,
} from '../../services/difficultyStore';

/** How long the reader has to stay on a page before it is analysed on its own. */
const SETTLE_MS = 1200;

/** How many times to wait for a page to finish rendering before giving up on it. */
const RENDER_RETRIES = 3;
const RENDER_RETRY_MS = 700;

export interface LocatedQuote {
  location: DifficultyLocation;
  anchor: DifficultySuggestion['anchor'];
}

/**
 * One page waiting to be analysed, and who asked for it.
 *
 * A task carries the file it belongs to instead of borrowing the hook's current one: a queue
 * entry must not be able to analyse a page of a PDF that has since been replaced.
 */
interface ScanTask {
  page: number;
  pdfSha256: string;
  /** Automatic tasks stop with the feature; a manual request survives switching it off. */
  automatic: boolean;
}

/** A page that already failed, scoped to the file it failed on. */
function failureKey(pdfSha256: string, page: number): string {
  return `${pdfSha256}\u0000${String(page)}`;
}

export interface DifficultyScanOptions {
  paperId: string;
  pdfSha256: string;
  /** The model name from the service's own health report; empty until it is known. */
  model: string;
  /**
   * True when the service is paid. Automatic scanning then needs an explicit, session-only
   * consent: switching to online mode while the feature was already on must not silently turn
   * every page into a billable request.
   */
  online: boolean;
  /**
   * Identity of the service process currently answering, from its health report.
   *
   * A consent is tied to this value. The shell restarts the sidecar on every mode or key
   * change, so a new instance means the earlier consent no longer applies.
   */
  serviceInstanceId: string;
  currentPage: number;
  /** The page's rendered text, or null when that page is not on screen right now. */
  pageTextFor: (page: number) => string | null;
  /** Finds a quotation on the rendered page. Supplied by the reader, which owns the DOM. */
  locate: (page: number, quote: string) => LocatedQuote;
  /** Injectable for tests. */
  analyze?: typeof analyzeDifficulties;
}

export interface DifficultyScan {
  enabled: boolean;
  markersVisible: boolean;
  status: 'idle' | 'running' | 'error';
  error: string | null;
  analysedPages: number;
  /** This page's suggestions, newest analysis first within the page, excluding ignored ones. */
  current: DifficultySuggestion[];
  /** Every suggestion for this file, across the pages analysed so far. */
  all: DifficultySuggestion[];
  /** True when automatic page scanning is held back until the reader confirms online costs. */
  autoPaused: boolean;
  setEnabled: (next: boolean) => void;
  setMarkersVisible: (next: boolean) => void;
  /** Confirms that automatic scanning may make paid calls for this session. */
  grantOnlineConsent: () => void;
  analyse: (page?: number) => void;
  reanalyse: () => void;
  ignore: (id: string) => void;
}

/**
 * Runs the difficulty analysis over the pages the reader actually reads.
 *
 * Three things this deliberately does not do:
 *
 * - **It never analyses the paper.** One page at a time, only the page being read, only after
 *   the reader turned the feature on and only when that page is not already cached.
 * - **It never runs at startup or import.** Nothing happens until `enabled` is true, and the
 *   interface asks before setting it for an online provider.
 * - **It never lets a failure reach the reader's work.** Every failure path ends in a string in
 *   this hook; the page, the notes and the reading position are untouched.
 */
export function useDifficultyScan(options: DifficultyScanOptions): DifficultyScan {
  const {
    paperId,
    pdfSha256,
    model,
    online,
    serviceInstanceId,
    currentPage,
    pageTextFor,
    locate,
    analyze,
  } = options;

  const [prefs, setPrefs] = useState(() => loadDifficultyPrefs());
  const [state, setState] = useState<DifficultyState>(() => loadDifficulties());
  const [status, setStatus] = useState<'idle' | 'running' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  /**
   * Session-only permission for automatic scanning to make paid calls.
   *
   * The permission remembers which service instance it was given to. Every mode or key change
   * restarts the sidecar with a new instance id, so an earlier consent stops matching without
   * a state-synchronising effect or a persisted flag.
   */
  const [consentInstance, setConsentInstance] = useState<string | null>(null);
  const onlineConsent = online && serviceInstanceId !== '' && consentInstance === serviceInstanceId;

  /** Pages that failed, keyed by file and page so a replaced PDF starts clean. */
  const failedPages = useRef(new Set<string>());
  /** Pages waiting for the one in-flight request to finish. */
  const queue = useRef<ScanTask[]>([]);
  const draining = useRef(false);
  /** The task that owns the model request right now, if any. */
  const inFlight = useRef<ScanTask | null>(null);
  const controller = useRef<AbortController | null>(null);
  /**
   * Identifies the tasks that may still write.
   *
   * Bumped when the file, the paper, the service instance or the paid consent changes, and when
   * the reader clears the cache. An old request that settles afterwards is stale even if its
   * fetch ignored the abort.
   */
  const epoch = useRef(0);
  /** The file the hook is looking at right now, for async callbacks between renders. */
  const pdfShaRef = useRef(pdfSha256);
  useLayoutEffect(() => {
    // Before the passive effects that clear stale work, and before any awaiting callback runs.
    pdfShaRef.current = pdfSha256;
  }, [pdfSha256]);
  const mounted = useRef(true);
  /** The cache as of the latest render, for timers that outlive the render that set them. */
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    // StrictMode mounts, cleans up and mounts again in development; the flag has to come back
    // up with the effect, or the second mount reports results into a dead component.
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current += 1;
      queue.current = [];
      controller.current?.abort();
      controller.current = null;
      inFlight.current = null;
    };
  }, []);

  // A mode/key change replaces the service and revokes an earlier paid consent. Anything queued
  // under the old permission must not be sent afterwards, and a running request is aborted so
  // it stops spending under a permission that no longer holds.
  useEffect(() => {
    epoch.current += 1;
    queue.current = [];
    controller.current?.abort();
    controller.current = null;
    inFlight.current = null;
    // The aborted request returns without touching state, so the "running" of a task that no
    // longer exists has to be cleared here. It runs after the abort, and a newer request starts
    // only from a later event, so this cannot clear a request that owns the status now.
    queueMicrotask(() => {
      if (mounted.current && inFlight.current === null) {
        setStatus((current) => (current === 'running' ? 'idle' : current));
      }
    });
  }, [paperId, pdfSha256, online, onlineConsent, serviceInstanceId]);

  const analysePage = useCallback(
    async (task: ScanTask, sequence: number): Promise<void> => {
      if (model === '') {
        setError('还没有连上本地 AI 服务，无法分析难点。');
        setStatus('error');
        return;
      }

      const active = new AbortController();
      controller.current = active;
      const stale = (): boolean =>
        !mounted.current || sequence !== epoch.current || active.signal.aborted;

      // The page may still be rendering. Waiting for it is cheaper than asking the reader to
      // move away and come back, and a page that never arrives simply ends the attempt.
      let text: string | null = null;
      for (let attempt = 0; attempt <= RENDER_RETRIES; attempt += 1) {
        if (stale()) {
          if (controller.current === active) controller.current = null;
          return;
        }
        text = pageTextFor(task.page);
        if (text !== null && text.trim() !== '') break;
        text = null;
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, RENDER_RETRY_MS);
        });
      }
      if (text === null || stale()) {
        if (controller.current === active) controller.current = null;
        return;
      }

      setStatus('running');
      setError(null);

      const ask = analyze ?? analyzeDifficulties;
      let outcome: Awaited<ReturnType<typeof ask>>;
      try {
        outcome = await ask(
          {
            paper: { id: paperId, title: '', page: task.page, pdfSha256: task.pdfSha256 },
            pageText: text,
          },
          { signal: active.signal },
        );
      } catch (caught) {
        if (controller.current === active) controller.current = null;
        // A cancelled or superseded request is not a failure: marking it would keep the page
        // out of the next automatic pass for a reason the reader never saw.
        if (stale()) return;
        failedPages.current.add(failureKey(task.pdfSha256, task.page));
        setStatus('error');
        setError(caught instanceof Error ? caught.message : '这一页的难点分析失败了。');
        return;
      }
      if (controller.current === active) controller.current = null;
      if (stale()) return;

      if (!outcome.ok) {
        if (outcome.failure.kind === 'cancelled') return;
        failedPages.current.add(failureKey(task.pdfSha256, task.page));
        setStatus('error');
        setError(outcome.failure.message);
        return;
      }

      const analysis = outcome.value;
      const suggestions = analysis.suggestions.map((proposal) =>
        place(proposal, analysis, { paperId, pdfSha256: task.pdfSha256, page: task.page }, locate),
      );
      const record: DifficultyPageRecord = {
        paperId,
        pdfSha256: task.pdfSha256,
        page: task.page,
        model: analysis.model,
        rulesVersion: analysis.rulesVersion || DIFFICULTY_RULES_VERSION,
        analysedAt: Date.now(),
        suggestions,
        rejected: analysis.rejected,
      };
      setState((current) => {
        const next = withPageRecord(
          current,
          pageKey(task.pdfSha256, task.page, record.model, record.rulesVersion),
          record,
        );
        saveDifficulties(next);
        return next;
      });
      setStatus('idle');
      setError(null);
    },
    [analyze, locate, model, paperId, pageTextFor],
  );

  /**
   * Runs one page at a time and keeps later requests in a queue.
   *
   * The previous implementation dropped overlap silently, so a manual "analyse this page" during
   * an automatic pass did nothing and the page might never be analysed. Queueing keeps both
   * requests visible and bounded by the service's own concurrency gate.
   */
  const drainQueue = useCallback(async (): Promise<void> => {
    if (draining.current) return;
    draining.current = true;
    try {
      while (mounted.current && queue.current.length > 0) {
        const task = queue.current.shift();
        if (task === undefined) break;
        // A task for a file the reader has left is dropped: it would only spend money on a
        // page nobody is looking at.
        if (task.pdfSha256 !== pdfShaRef.current) continue;
        inFlight.current = task;
        await analysePage(task, epoch.current);
        inFlight.current = null;
      }
    } finally {
      draining.current = false;
    }
  }, [analysePage]);

  const schedule = useCallback(
    (task: ScanTask) => {
      // A page already being analysed must not be started a second time: the queue only holds
      // waiting pages, so `includes` alone could not see the request that is already running.
      if (
        inFlight.current !== null &&
        inFlight.current.pdfSha256 === task.pdfSha256 &&
        inFlight.current.page === task.page
      ) {
        // A manual request for the page that is already running upgrades it, so turning the
        // automatic pass off cannot cancel what the reader explicitly asked for.
        if (!task.automatic) inFlight.current.automatic = false;
        return;
      }
      const queued = queue.current.find(
        (entry) => entry.pdfSha256 === task.pdfSha256 && entry.page === task.page,
      );
      if (queued !== undefined) {
        if (!task.automatic) queued.automatic = false;
        return;
      }
      queue.current.push(task);
      void drainQueue();
    },
    [drainQueue],
  );

  /** Analyses on request, clearing any earlier failure for that page. */
  const analyse = useCallback(
    (page: number = currentPage) => {
      const task: ScanTask = { page, pdfSha256, automatic: false };
      failedPages.current.delete(failureKey(pdfSha256, page));
      schedule(task);
    },
    [currentPage, pdfSha256, schedule],
  );

  const reanalyse = useCallback(() => {
    // The reader asked to start over. Anything already running belongs to the cache this call
    // is about to clear, so it is invalidated before the records are removed.
    epoch.current += 1;
    controller.current?.abort();
    controller.current = null;
    inFlight.current = null;
    queue.current = [];
    failedPages.current.clear();
    setState((current) => {
      const next = withoutPaper(current, pdfSha256);
      saveDifficulties(next);
      return next;
    });
    schedule({ page: currentPage, pdfSha256, automatic: false });
  }, [currentPage, pdfSha256, schedule]);

  // The automatic pass: one page, after the reader has settled on it.
  useEffect(() => {
    if (!prefs.enabled || model === '') return;
    // A paid provider needs a fresh, explicit confirmation before page turns become charges.
    if (online && !onlineConsent) return;
    if (failedPages.current.has(failureKey(pdfSha256, currentPage))) return;
    if (state.pages[pageKey(pdfSha256, currentPage, model)] !== undefined) return;
    const timer = window.setTimeout(() => {
      if (!prefs.enabled) return;
      // Re-check at fire time. A manual request may have answered or failed while this timer
      // was pending, and the effect's snapshot cannot see either: scheduling again would send
      // the same page, and billing it, a second time.
      if (failedPages.current.has(failureKey(pdfSha256, currentPage))) return;
      if (stateRef.current.pages[pageKey(pdfSha256, currentPage, model)] !== undefined) return;
      schedule({ page: currentPage, pdfSha256, automatic: true });
    }, SETTLE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [prefs.enabled, model, online, onlineConsent, currentPage, pdfSha256, state.pages, schedule]);

  const grantOnlineConsent = useCallback(() => {
    setConsentInstance(serviceInstanceId);
  }, [serviceInstanceId]);

  const setEnabled = useCallback((next: boolean) => {
    setPrefs((current) => {
      const updated = { ...current, enabled: next };
      saveDifficultyPrefs(updated);
      return updated;
    });
    if (!next) {
      // Turning automatic scanning off drops only its own work. A page the reader asked for
      // stays queued, and a manual request already running is not cancelled.
      queue.current = queue.current.filter((task) => !task.automatic);
      if (inFlight.current?.automatic === true) {
        controller.current?.abort();
        controller.current = null;
        inFlight.current = null;
      }
      setStatus('idle');
      setError(null);
    }
  }, []);

  const setMarkersVisible = useCallback((next: boolean) => {
    setPrefs((current) => {
      const updated = { ...current, markersVisible: next };
      saveDifficultyPrefs(updated);
      return updated;
    });
  }, []);

  const ignore = useCallback(
    (id: string) => {
      setState((current) => {
        const next = withIgnored(current, pdfSha256, id);
        saveDifficulties(next);
        return next;
      });
    },
    [pdfSha256],
  );

  const ignored = useMemo(() => ignoredFor(state, pdfSha256), [state, pdfSha256]);

  const all = useMemo(() => {
    const seen = new Set<string>();
    const list: DifficultySuggestion[] = [];
    for (const record of Object.values(state.pages)) {
      if (record.pdfSha256 !== pdfSha256) continue;
      for (const suggestion of record.suggestions) {
        if (ignored.has(suggestion.id) || seen.has(suggestion.id)) continue;
        seen.add(suggestion.id);
        list.push(suggestion);
      }
    }
    return list.sort((one, other) => one.page - other.page);
  }, [state.pages, pdfSha256, ignored]);

  const current = useMemo(
    () => all.filter((suggestion) => suggestion.page === currentPage),
    [all, currentPage],
  );

  const analysedPages = useMemo(() => {
    const pages = new Set<number>();
    for (const record of Object.values(state.pages)) {
      if (record.pdfSha256 === pdfSha256) pages.add(record.page);
    }
    return pages.size;
  }, [state.pages, pdfSha256]);

  return {
    enabled: prefs.enabled,
    markersVisible: prefs.markersVisible,
    status,
    error,
    analysedPages,
    current,
    all,
    autoPaused: online && prefs.enabled && !onlineConsent,
    setEnabled,
    setMarkersVisible,
    grantOnlineConsent,
    analyse,
    reanalyse,
    ignore,
  };
}

/** Binds one proposal to the page: an id, and — only when it is unambiguous — a location. */
function place(
  proposal: DifficultyAnalysis['suggestions'][number],
  analysis: DifficultyAnalysis,
  where: { paperId: string; pdfSha256: string; page: number },
  locate: DifficultyScanOptions['locate'],
): DifficultySuggestion {
  const found = locate(where.page, proposal.quote);
  return {
    ...proposal,
    id: suggestionId(where.pdfSha256, where.page, proposal.quote),
    paperId: where.paperId,
    pdfSha256: where.pdfSha256,
    page: where.page,
    location: found.location,
    anchor: found.anchor,
    model: analysis.model,
    analysedAt: Date.now(),
  };
}
