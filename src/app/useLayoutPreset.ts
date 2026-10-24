import { useCallback, useEffect, useState } from 'react';
import {
  LAYOUT_CHANGE_EVENT,
  readLayoutPreset,
  storeLayoutPreset,
  type LayoutChangeDetail,
  type LayoutPreset,
} from './layoutPrefs';

/**
 * Owns the chosen workspace layout preset. Applying it to the live surfaces is done by the
 * caller — the sidebar from the App, the reader's panel through the `layoutPreset` prop — so
 * the preset switch is one decision with one write, observed by whoever renders the layout.
 */
export function useLayoutPreset(): {
  preset: LayoutPreset;
  setPreset: (next: LayoutPreset) => void;
} {
  const [preset, setPresetState] = useState<LayoutPreset>(() => readLayoutPreset());

  const setPreset = useCallback((next: LayoutPreset) => {
    setPresetState(next);
    storeLayoutPreset(next);
  }, []);

  // "恢复默认布局" writes the preset key directly; follow it so the settings page and the
  // live layout agree without a reload.
  useEffect(() => {
    const onLayoutChange = (event: Event): void => {
      const detail = (event as CustomEvent<LayoutChangeDetail>).detail ?? {};
      if (detail.reset === true) setPresetState(readLayoutPreset());
    };
    window.addEventListener(LAYOUT_CHANGE_EVENT, onLayoutChange);
    return () => {
      window.removeEventListener(LAYOUT_CHANGE_EVENT, onLayoutChange);
    };
  }, []);

  return { preset, setPreset };
}
