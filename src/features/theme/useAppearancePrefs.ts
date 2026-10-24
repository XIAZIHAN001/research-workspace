import { useCallback, useEffect, useState } from 'react';
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
