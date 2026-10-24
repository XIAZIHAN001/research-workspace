import { useCallback, useEffect, useState } from 'react';
import { LAYOUT_CHANGE_EVENT, type LayoutChangeDetail } from '../../app/layoutPrefs';
import {
  applyDensity,
  applyUiFont,
  readDensity,
  readUiFont,
  storeDensity,
  storeUiFont,
  type Density,
  type UiFont,
} from './appearancePrefs';

/**
 * Owns the two interface-appearance preferences that are not the colour theme: how dense the
 * UI is, and how large its text is. Both are written to `<html>` as data attributes so the
 * token overrides in tokens.css apply everywhere at once.
 */
export function useAppearancePrefs(): {
  density: Density;
  uiFont: UiFont;
  setDensity: (next: Density) => void;
  setUiFont: (next: UiFont) => void;
} {
  const [density, setDensityState] = useState<Density>(() => readDensity());
  const [uiFont, setUiFontState] = useState<UiFont>(() => readUiFont());

  useEffect(() => {
    applyDensity(document.documentElement, density);
  }, [density]);

  useEffect(() => {
    applyUiFont(document.documentElement, uiFont);
  }, [uiFont]);

  // "恢复默认布局" writes the standard density and default font; follow it live.
  useEffect(() => {
    const onLayoutChange = (event: Event): void => {
      const detail = (event as CustomEvent<LayoutChangeDetail>).detail ?? {};
      if (detail.reset !== true) return;
      setDensityState(readDensity());
      setUiFontState(readUiFont());
    };
    window.addEventListener(LAYOUT_CHANGE_EVENT, onLayoutChange);
    return () => {
      window.removeEventListener(LAYOUT_CHANGE_EVENT, onLayoutChange);
    };
  }, []);

  const setDensity = useCallback((next: Density) => {
    setDensityState(next);
    storeDensity(next);
  }, []);

  const setUiFont = useCallback((next: UiFont) => {
    setUiFontState(next);
    storeUiFont(next);
  }, []);

  return { density, uiFont, setDensity, setUiFont };
}
