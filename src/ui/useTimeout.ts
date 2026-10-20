import { useCallback, useEffect, useRef } from 'react';

/**
 * A `setTimeout` that belongs to the component.
 *
 * A timer scheduled without a way to cancel is the commonest small leak in a component this
 * size: the reader schedules a flash, a save and a health probe, and any of them can fire after
 * the reader has been closed. Nothing here throws or warns when that happens — the callback
 * simply does not run — but the point is that the state update never reaches an unmounted tree.
 *
 * `schedule` returns an id that can be passed to `cancel`, which is what a caller needs when it
 * wants to replace a pending timer rather than let both run.
 */
export function useTimeout() {
  const ids = useRef<Set<number>>(new Set());

  useEffect(() => {
    const pending = ids.current;
    return () => {
      for (const id of pending) window.clearTimeout(id);
      pending.clear();
    };
  }, []);

  const schedule = useCallback((run: () => void, delayMs: number): number => {
    const id = window.setTimeout(() => {
      ids.current.delete(id);
      run();
    }, delayMs);
    ids.current.add(id);
    return id;
  }, []);

  const cancel = useCallback((id: number | undefined): void => {
    if (id === undefined) return;
    window.clearTimeout(id);
    ids.current.delete(id);
  }, []);

  /** Replaces any pending timer: whatever was waiting is dropped, the new one is kept. */
  const scheduleReplacing = useCallback(
    (previous: number | undefined, run: () => void, delayMs: number): number => {
      cancel(previous);
      return schedule(run, delayMs);
    },
    [cancel, schedule],
  );

  return { schedule, scheduleReplacing, cancel };
}
