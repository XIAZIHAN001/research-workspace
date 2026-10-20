import { useCallback, useEffect, useState } from 'react';
import {
  DARK_SCHEME_QUERY,
  THEME_LEVEL_STORAGE_KEY,
  THEME_STORAGE_KEY,
  THEME_STYLE_STORAGE_KEY,
} from '../../app/config';
import { readItem, writeItem } from '../../services/storage';
import { useMediaQuery } from '../../ui/useMediaQuery';
import {
  applyTheme,
  clampLevel,
  levelPreset,
  parseThemeLevel,
  parseThemePref,
  resolveTheme,
  type DarkLevel,
  type ThemePref,
} from './theme';

/** Owns the theme preference. public/theme-init.js already set the first paint. */
export function useTheme() {
  const [pref, setPrefState] = useState<ThemePref>(() =>
    parseThemePref(readItem(THEME_STORAGE_KEY)),
  );
  const [level, setLevelState] = useState<DarkLevel>(() =>
    parseThemeLevel(readItem(THEME_LEVEL_STORAGE_KEY), readItem(THEME_STYLE_STORAGE_KEY)),
  );
  const systemDark = useMediaQuery(DARK_SCHEME_QUERY);
  const resolved = resolveTheme(pref, systemDark);

  useEffect(() => {
    applyTheme(document.documentElement, pref, resolved, level);
  }, [pref, resolved, level]);

  const persist = useCallback((nextPref: ThemePref, nextLevel: DarkLevel) => {
    writeItem(THEME_STORAGE_KEY, nextPref);
    writeItem(THEME_LEVEL_STORAGE_KEY, String(nextLevel));
    // Older builds only know the two named palettes; keep their stored value coherent.
    writeItem(THEME_STYLE_STORAGE_KEY, levelPreset(nextLevel));
  }, []);

  const setPref = useCallback(
    (next: ThemePref) => {
      setPrefState(next);
      persist(next, level);
    },
    [level, persist],
  );

  const setLevel = useCallback(
    (next: DarkLevel) => {
      const clamped = clampLevel(next);
      setLevelState(clamped);
      persist(pref, clamped);
    },
    [persist, pref],
  );

  return { pref, resolved, level, setPref, setLevel };
}
