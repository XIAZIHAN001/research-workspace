import { useCallback, useState } from 'react';
import { readLayoutPreset, storeLayoutPreset, type LayoutPreset } from './layoutPrefs';

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

  return { preset, setPreset };
}
