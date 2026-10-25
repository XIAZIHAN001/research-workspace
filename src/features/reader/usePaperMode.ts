import { useCallback, useState } from 'react';
import { readItem, writeItem } from '../../services/storage';
import {
  PAPER_STORAGE_KEY,
  parsePaperMode,
  resolvePaperMode,
  type PaperMode,
  type PaperPalette,
} from './paperTheme';

/** The paper preference's public shape, shared by the reader and Settings › 阅读偏好. */
export type PaperModeController = ReturnType<typeof usePaperMode>;

/**
 * The reader's paper preference.
 *
 * It lives beside the themes but is deliberately its own setting: the application theme changes
 * the chrome, and this changes the sheet of paper inside it. `auto` follows the application
 * theme so that a reader who made the app dark is not handed a white rectangle; a manual choice
 * wins and survives reloads, because a preference that resets is not a preference.
 */
export function usePaperMode(appTheme: 'light' | 'dark'): {
  pref: PaperMode;
  palette: PaperPalette;
  setPref: (next: PaperMode) => void;
} {
  const [pref, setPrefState] = useState<PaperMode>(() =>
    parsePaperMode(readItem(PAPER_STORAGE_KEY)),
  );

  const setPref = useCallback((next: PaperMode) => {
    setPrefState(next);
    writeItem(PAPER_STORAGE_KEY, next);
  }, []);

  return { pref, palette: resolvePaperMode(pref, appTheme), setPref };
}
