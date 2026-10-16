export type ThemePref = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export function parseThemePref(raw: string | null): ThemePref {
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): ResolvedTheme {
  if (pref === 'system') return systemDark ? 'dark' : 'light';
  return pref;
}

/** Mirrors what public/theme-init.js does before first paint. */
export function applyTheme(root: HTMLElement, pref: ThemePref, resolved: ResolvedTheme): void {
  root.dataset.theme = resolved;
  root.dataset.themePref = pref;
}
