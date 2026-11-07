import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { LAYOUT_CHANGE_EVENT, type LayoutChangeDetail } from '../../app/layoutPrefs';
import {
  applyDensity,
  applyScrollEdge,
  applyUiFont,
  readDensity,
  readScrollEdge,
  readUiFont,
  storeDensity,
  storeScrollEdge,
  storeUiFont,
  type Density,
  type ScrollEdge,
  type UiFont,
} from './appearancePrefs';

/**
 * Owns the interface-appearance preferences that are not the colour theme: how dense the UI
 * is, how large its text is, and how strongly scrolling surfaces fade at their edges. All are
 * written to `<html>` as data attributes so the token overrides in tokens.css (and the edge
 * bars in scroll-edges.css) apply everywhere at once.
 */
export function useAppearancePrefs(): {
  density: Density;
  uiFont: UiFont;
  scrollEdge: ScrollEdge;
  setDensity: (next: Density) => void;
  setUiFont: (next: UiFont) => void;
  setScrollEdge: (next: ScrollEdge) => void;
} {
  const [density, setDensityState] = useState<Density>(() => readDensity());
  const [uiFont, setUiFontState] = useState<UiFont>(() => readUiFont());
  const [scrollEdge, setScrollEdgeState] = useState<ScrollEdge>(() => readScrollEdge());

  // Layout effects, so the stored density/font/edge apply in the same commit as the first
  // render: a passive effect lets the browser paint the defaults once and then swap them.
  useLayoutEffect(() => {
    applyDensity(document.documentElement, density);
  }, [density]);

  useLayoutEffect(() => {
    applyUiFont(document.documentElement, uiFont);
  }, [uiFont]);

  useLayoutEffect(() => {
    applyScrollEdge(document.documentElement, scrollEdge);
  }, [scrollEdge]);

  // "恢复默认布局" writes the standard density, default font and soft edges; follow it live.
  useEffect(() => {
    const onLayoutChange = (event: Event): void => {
      const detail = (event as CustomEvent<LayoutChangeDetail>).detail ?? {};
      if (detail.reset !== true) return;
      setDensityState(readDensity());
      setUiFontState(readUiFont());
      setScrollEdgeState(readScrollEdge());
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

  const setScrollEdge = useCallback((next: ScrollEdge) => {
    setScrollEdgeState(next);
    storeScrollEdge(next);
  }, []);

  return { density, uiFont, scrollEdge, setDensity, setUiFont, setScrollEdge };
}
