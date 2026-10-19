import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

  /** Pages that failed, so an automatic pass does not retry them in a loop. */
  const failedPages = useRef(new Set<number>());
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    // StrictMode mounts, cleans up and mounts again in development; the flag has to come back
    // up with the effect, or the second mount reports results into a dead component.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const analysePage = useCallback(
    async (page: number): Promise<void> => {
      if (model === '') {
        setError('还没有连上本地 AI 服务，无法分析难点。');
        setStatus('error');
        return;
      }

      // The page may still be rendering. Waiting for it is cheaper than asking the reader to
      // move away and come back, and a page that never arrives simply ends the attempt.
      let text: string | null = null;
      for (let attempt = 0; attempt <= RENDER_RETRIES; attempt += 1) {
        text = pageTextFor(page);
        if (text !== null && text.trim() !== '') break;
        text = null;
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, RENDER_RETRY_MS);
        });
      }
      if (text === null) return;
      if (running.current) return;

      running.current = true;
      setStatus('running');
      setError(null);

      const ask = analyze ?? analyzeDifficulties;
      const outcome = await ask({
        paper: { id: paperId, title: '', page, pdfSha256 },
        pageText: text,
      });
      running.current = false;
      if (!mounted.current) return;

      if (!outcome.ok) {
        failedPages.current.add(page);
        setStatus('error');
        setError(outcome.failure.message);
        return;
      }

      const analysis = outcome.value;
      const suggestions = analysis.suggestions.map((proposal) =>
        place(proposal, analysis, { paperId, pdfSha256, page }, locate),
      );
      const record: DifficultyPageRecord = {
        paperId,
        pdfSha256,
        page,
        model: analysis.model,
        rulesVersion: analysis.rulesVersion || DIFFICULTY_RULES_VERSION,
        analysedAt: Date.now(),
        suggestions,
        rejected: analysis.rejected,
      };
      setState((current) => {
        const next = withPageRecord(
          current,
          pageKey(pdfSha256, page, record.model, record.rulesVersion),
          record,
        );
        saveDifficulties(next);
        return next;
      });
      setStatus('idle');
      setError(null);
    },
    [analyze, locate, model, paperId, pageTextFor, pdfSha256],
  );

  /** Analyses on request, clearing any earlier failure for that page. */
  const analyse = useCallback(
    (page: number = currentPage) => {
      failedPages.current.delete(page);
      void analysePage(page);
    },
    [analysePage, currentPage],
  );

  const reanalyse = useCallback(() => {
    failedPages.current.clear();
    setState((current) => {
      const next = withoutPaper(current, pdfSha256);
      saveDifficulties(next);
      return next;
    });
    void analysePage(currentPage);
  }, [analysePage, currentPage, pdfSha256]);

  // The automatic pass: one page, after the reader has settled on it.
  useEffect(() => {
    if (!prefs.enabled || model === '') return;
    // A paid provider needs a fresh, explicit confirmation before page turns become charges.
    if (online && !onlineConsent) return;
    if (failedPages.current.has(currentPage)) return;
    if (state.pages[pageKey(pdfSha256, currentPage, model)] !== undefined) return;
    const timer = window.setTimeout(() => {
      void analysePage(currentPage);
    }, SETTLE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    prefs.enabled,
    model,
    online,
    onlineConsent,
    currentPage,
    pdfSha256,
    state.pages,
    analysePage,
  ]);

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
