import { useCallback, useRef, useState } from 'react';

/**
 * Where the reader has been, as page numbers.
 *
 * The history is deliberately session-only and holds no scroll fraction: it exists to undo a
 * *jump* — following a note, a citation, a search hit or an outline entry — not to replay every
 * pixel of a scroll. Ordinary scrolling never writes an entry, so "back" always returns to a
 * place the reader was taken away from rather than to the previous screenful.
 */
export interface ReadingHistory {
  entries: readonly number[];
  index: number;
}

/** A long session can jump hundreds of times; the oldest entries stop being useful. */
const MAX_ENTRIES = 100;

export function createReadingHistory(page: number): ReadingHistory {
  return { entries: [Math.max(1, Math.floor(page))], index: 0 };
}

/**
 * Records a jump from `from` to `to`, and drops the forward branch.
 *
 * Both ends are recorded. The destination has to be an entry, otherwise a second jump from it
 * would leave "back" skipping over the page the reader actually came from; the departure has to
 * be one when the reader had scrolled away from the last recorded place before jumping. A jump
 * within one page only clears the forward branch, because nothing new was visited.
 *
 * Moving somewhere new after going back is a new branch: keeping the old forward entries would
 * make "forward" lead to a place that no longer follows from where the reader is.
 */
export function recordJump(history: ReadingHistory, from: number, to: number): ReadingHistory {
  const departure = Math.max(1, Math.floor(from));
  const target = Math.max(1, Math.floor(to));
  const branch = history.entries.slice(0, history.index + 1);
  const last = branch[branch.length - 1];

  if (target === departure) {
    if (departure === last && branch.length === history.entries.length) return history;
    const entries = departure === last ? branch : [...branch, departure];
    return trim({ entries, index: entries.length - 1 });
  }

  const entries = departure === last ? [...branch, target] : [...branch, departure, target];
  return trim({ entries, index: entries.length - 1 });
}

function trim(history: ReadingHistory): ReadingHistory {
  if (history.entries.length <= MAX_ENTRIES) return history;
  const entries = history.entries.slice(history.entries.length - MAX_ENTRIES);
  return { entries, index: entries.length - 1 };
}

export function canGoBack(history: ReadingHistory): boolean {
  return history.index > 0;
}

export function canGoForward(history: ReadingHistory): boolean {
  return history.index < history.entries.length - 1;
}

/** The page to return to, and the history with its cursor moved; null at the start. */
export function stepBack(
  history: ReadingHistory,
): { history: ReadingHistory; page: number } | null {
  if (!canGoBack(history)) return null;
  const index = history.index - 1;
  return { history: { ...history, index }, page: history.entries[index] ?? 1 };
}

export function stepForward(
  history: ReadingHistory,
): { history: ReadingHistory; page: number } | null {
  if (!canGoForward(history)) return null;
  const index = history.index + 1;
  return { history: { ...history, index }, page: history.entries[index] ?? 1 };
}

export interface ReadingHistoryApi {
  canBack: boolean;
  canForward: boolean;
  /** Call immediately before a programmatic jump, with the page being left and the target. */
  remember: (from: number, to: number) => void;
  /** Moves the cursor back and returns the page to show, or null when there is none. */
  back: () => number | null;
  forward: () => number | null;
}

/**
 * The history above, held for one reader.
 *
 * The stack lives in a ref because a jump needs to read it and write to it in the same event,
 * before React has re-rendered. The two booleans are state so the toolbar buttons can disable
 * themselves without reading a ref during render.
 */
export function useReadingHistory(initialPage: number): ReadingHistoryApi {
  const history = useRef<ReadingHistory>(createReadingHistory(initialPage));
  const [backAvailable, setBackAvailable] = useState(false);
  const [forwardAvailable, setForwardAvailable] = useState(false);

  const sync = useCallback((): void => {
    setBackAvailable(canGoBack(history.current));
    setForwardAvailable(canGoForward(history.current));
  }, []);

  const remember = useCallback(
    (from: number, to: number): void => {
      const next = recordJump(history.current, from, to);
      if (next === history.current) return;
      history.current = next;
      sync();
    },
    [sync],
  );

  const back = useCallback((): number | null => {
    const stepped = stepBack(history.current);
    if (stepped === null) return null;
    history.current = stepped.history;
    sync();
    return stepped.page;
  }, [sync]);

  const forward = useCallback((): number | null => {
    const stepped = stepForward(history.current);
    if (stepped === null) return null;
    history.current = stepped.history;
    sync();
    return stepped.page;
  }, [sync]);

  return {
    canBack: backAvailable,
    canForward: forwardAvailable,
    remember,
    back,
    forward,
  };
}
