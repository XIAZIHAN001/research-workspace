import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Reveals text a piece at a time, the way a model writes it.
 *
 * The service answers in one piece, so there is nothing to stream — but dropping a finished
 * wall of text into the panel reads as a jump cut, and the reader loses the thread of what
 * arrived. This replays the writing instead: the full answer is already in memory, and it is
 * handed over progressively.
 *
 * The pace is chosen for the whole answer rather than per character, so a long reply does not
 * take a minute to appear: every answer finishes inside `MAX_MS`, and a short one still gets a
 * visible run-up. Nothing here is allowed to become the reason a reader waits — the reveal can
 * be skipped with one click, and `prefers-reduced-motion` turns it off entirely.
 */
export interface AnswerReveal {
  /** The part of the answer to render right now. */
  text: string;
  /** True while there is still text to reveal. */
  typing: boolean;
  /** Shows the rest of the answer at once. */
  skip: () => void;
}

const MIN_MS = 420;
const MAX_MS = 2200;

/** True when the reader asked the system for less movement. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

interface Progress {
  /** Which text this progress belongs to; progress for another answer is not shown at all. */
  text: string;
  shown: number;
  typing: boolean;
}

export function useAnswerReveal(full: string, enabled: boolean, onGrow?: () => void): AnswerReveal {
  // Splitting the string once per answer rather than once per frame: the reveal renders at
  // 60fps, and `Array.from` plus a slice/join on every one of those frames is pure garbage.
  const characters = useMemo(() => Array.from(full), [full]);
  // Seeded with the text it was created for, so a changed answer starts from nothing without a
  // state update first — the derived values below already know the old progress is stale.
  const [progress, setProgress] = useState<Progress>(() => ({
    text: full,
    shown: enabled ? 0 : characters.length,
    typing: enabled && characters.length > 0,
  }));
  const live = progress.text === full;
  const shown = live ? progress.shown : enabled ? 0 : characters.length;
  const typing = live ? progress.typing : enabled && characters.length > 0;
  // Held in a ref so skipping can cancel the loop itself. Without this the next scheduled
  // frame would happily set `typing` back to true and the "跳过" row would reappear.
  const frame = useRef(0);

  useEffect(() => {
    if (!enabled || characters.length === 0) return;
    const total = characters.length;
    const duration = Math.min(MAX_MS, Math.max(MIN_MS, total * 8));
    let start: number | null = null;
    const tick = (now: number): void => {
      start ??= now;
      const ratio = Math.min(1, (now - start) / duration);
      // Ease out: the first lines land quickly, the tail slows down, which is what reading a
      // reply actually feels like.
      const eased = 1 - (1 - ratio) * (1 - ratio);
      const next = Math.min(total, Math.ceil(eased * total));
      const stillTyping = ratio < 1;
      // Once the last character is out, the remaining frames would set the same state again.
      // Re-rendering the whole answer for an unchanged value is what made the tail stutter.
      setProgress((current) =>
        current.text === full && current.shown === next && current.typing === stillTyping
          ? current
          : { text: full, shown: next, typing: stillTyping },
      );
      onGrow?.();
      if (!stillTyping) return;
      frame.current = window.requestAnimationFrame(tick);
    };
    frame.current = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame.current);
    };
  }, [full, enabled, characters, onGrow]);

  const skip = useCallback(() => {
    window.cancelAnimationFrame(frame.current);
    setProgress({ text: full, shown: characters.length, typing: false });
  }, [full, characters.length]);

  return { text: characters.slice(0, shown).join(''), typing, skip };
}
