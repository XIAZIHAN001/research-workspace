import { useCallback, useEffect, useState } from 'react';
import { DARK_SCHEME_QUERY, THEME_STORAGE_KEY } from '../../app/config';
import { readItem, writeItem } from '../../services/storage';
import { useMediaQuery } from '../../ui/useMediaQuery';
import { applyTheme, parseThemePref, resolveTheme, type ThemePref } from './theme';

/** Owns the theme preference. public/theme-init.js already set the first paint. */
export function useTheme() {
  const [pref, setPrefState] = useState<ThemePref>(() =>
    parseThemePref(readItem(THEME_STORAGE_KEY)),
  );
  const systemDark = useMediaQuery(DARK_SCHEME_QUERY);
  const resolved = resolveTheme(pref, systemDark);

  useEffect(() => {
    applyTheme(document.documentElement, pref, resolved);
  }, [pref, resolved]);

  const setPref = useCallback((next: ThemePref) => {
    setPrefState(next);
    writeItem(THEME_STORAGE_KEY, next);
  }, []);

  return { pref, resolved, setPref };
}
