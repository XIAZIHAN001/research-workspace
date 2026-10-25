import { useCallback, useEffect, useState } from 'react';
import { useMediaQuery } from '../ui/useMediaQuery';
import { readItem, writeItem } from '../services/storage';
import {
  NARROW_VIEWPORT_QUERY,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from './config';
import { LAYOUT_CHANGE_EVENT, readLayoutPreset, type LayoutChangeDetail } from './layoutPrefs';

/** Clamps a stored or dragged width into the range the layout can actually use. */
function clampWidth(raw: number | null, min: number, max: number, fallback: number): number {
  if (raw === null || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.round(raw)));
}

/**
 * Wide windows keep a column whose width persists and whose open/closed state follows the
 * layout preset: 专注 starts collapsed, the others start open. Narrow windows start closed and
 * show the sidebar as an overlay that never persists, so a small window cannot hide it forever.
 */
export function useSidebar() {
  const narrow = useMediaQuery(NARROW_VIEWPORT_QUERY);
  const [wideOpen, setWideOpen] = useState(() => readLayoutPreset() !== 'focus');
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [width, setWidthState] = useState(() => {
    // `Number(null)` is 0, which is finite — so a first run with nothing stored used to clamp
    // to the minimum width (200px) instead of starting at the designed default.
    const stored = readItem(SIDEBAR_WIDTH_STORAGE_KEY);
    return clampWidth(
      stored === null ? null : Number(stored),
      SIDEBAR_MIN_WIDTH,
      SIDEBAR_MAX_WIDTH,
      SIDEBAR_DEFAULT_WIDTH,
    );
  });
  const open = narrow ? overlayOpen : wideOpen;

  const setOpen = useCallback(
    (next: boolean) => {
      if (narrow) {
        setOverlayOpen(next);
        return;
      }
      setWideOpen(next);
    },
    [narrow],
  );

  const setWidthRaw = useCallback((next: number) => {
    setWidthState(next);
    writeItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next));
  }, []);

  /** Sets the column width from Settings' slider, with the same clamp a drag gets. */
  const setWidth = useCallback(
    (next: number) => {
      setWidthRaw(clampWidth(next, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_DEFAULT_WIDTH));
    },
    [setWidthRaw],
  );

  // "恢复默认布局" writes the default width and opens the sidebar again; both are applied to
  // the live layout here instead of waiting for a reload.
  useEffect(() => {
    const onLayoutChange = (event: Event): void => {
      const detail = (event as CustomEvent<LayoutChangeDetail>).detail ?? {};
      if (detail.reset !== true) return;
      setWidthRaw(SIDEBAR_DEFAULT_WIDTH);
      if (narrow) setOverlayOpen(false);
      else setWideOpen(true);
    };
    window.addEventListener(LAYOUT_CHANGE_EVENT, onLayoutChange);
    return () => {
      window.removeEventListener(LAYOUT_CHANGE_EVENT, onLayoutChange);
    };
  }, [narrow, setWidthRaw]);

  useEffect(() => {
    if (!narrow || !overlayOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // A modal dialog owns Escape; closing the overlay underneath it would surprise the user.
      if (event.key === 'Escape' && document.querySelector('dialog[open]') === null) {
        setOverlayOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [narrow, overlayOpen]);

  /**
   * Drags the column's edge.
   *
   * Pointer capture keeps the drag alive when the cursor leaves the handle, and the width is
   * written on every move so a reload mid-drag still restores what the reader had chosen. The
   * direction is inverted on the overlay layout, where the sidebar covers the content instead
   * of sitting beside it.
   */
  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (narrow) return;
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = width;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';

      const onMove = (move: PointerEvent): void => {
        const delta = move.clientX - startX;
        setWidthRaw(
          clampWidth(startWidth + delta, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, startWidth),
        );
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
    [narrow, width, setWidthRaw],
  );

  /** Keyboard equivalent, so the width is reachable without a pointer. */
  const nudgeWidth = useCallback(
    (delta: number) => {
      setWidthRaw(clampWidth(width + delta, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, width));
    },
    [width, setWidthRaw],
  );

  const resetWidth = useCallback(() => {
    setWidthRaw(SIDEBAR_DEFAULT_WIDTH);
  }, [setWidthRaw]);

  return { open, narrow, setOpen, width, setWidth, startResize, nudgeWidth, resetWidth };
}
