export type ThemePref = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/**
 * The Phase 12 dark palette name. Phase 12.1 no longer offers it as a choice: the palette is
 * continuous, and this name survives only to read old profiles and to write a derived value
 * an older build can still understand.
 */
export type ThemeStyle = 'graphite' | 'obsidian';

/**
 * 0 is the lightest dark grey (#242424), 100 is pure black. The default is pure black; the
 * value is a user-facing brightness control, not a CSS opacity.
 */
export type DarkLevel = number;

export const DARK_LEVEL_MIN = 0;
export const DARK_LEVEL_MAX = 100;
export const DEFAULT_DARK_LEVEL: DarkLevel = 100;
/** The neutral grey with roughly the luminance of Phase 12's Graphite. */
export const LEGACY_GRAPHITE_LEVEL: DarkLevel = 36;

/** The neutral surfaces derived from one dark level. All channels are equal in every value. */
export interface DarkPalette {
  app: string;
  sidebar: string;
  panel: string;
  elevated: string;
  border: string;
  hairline: string;
}

export function parseThemePref(raw: string | null): ThemePref {
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

/** Kept for migration: unknown or missing values describe Graphite, as they did in Phase 12. */
export function parseThemeStyle(raw: string | null): ThemeStyle {
  return raw === 'obsidian' ? 'obsidian' : 'graphite';
}

export function clampLevel(value: number): DarkLevel {
  if (!Number.isFinite(value)) return DEFAULT_DARK_LEVEL;
  return Math.min(DARK_LEVEL_MAX, Math.max(DARK_LEVEL_MIN, Math.round(value)));
}

/**
 * A stored level wins. A profile written by Phase 12 has no level, so its palette name is
 * translated: Obsidian was pure black, Graphite was a grey of the same luminance as level 36.
 * Everything else — no stored theme at all — starts at pure black.
 */
export function parseThemeLevel(raw: string | null, legacyStyle: string | null): DarkLevel {
  if (raw !== null && raw.trim() !== '') {
    const value = Number(raw);
    if (Number.isFinite(value)) return clampLevel(value);
  }
  if (legacyStyle === 'obsidian') return DARK_LEVEL_MAX;
  if (legacyStyle === 'graphite') return LEGACY_GRAPHITE_LEVEL;
  return DEFAULT_DARK_LEVEL;
}

/** The derived Phase 12 preset, written beside the level so an older build still works. */
export function levelPreset(level: DarkLevel): ThemeStyle {
  return clampLevel(level) >= DARK_LEVEL_MAX ? 'obsidian' : 'graphite';
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): ResolvedTheme {
  if (pref === 'system') return systemDark ? 'dark' : 'light';
  return pref;
}

const hex = (channel: number): string =>
  Math.min(255, Math.max(0, channel)).toString(16).padStart(2, '0');

/**
 * Neutral ladder for one level. The app background runs from #242424 at 0 to #000000 at 100;
 * the other surfaces are fixed channel offsets, so every level keeps a visible but restrained
 * separation between the app, the sidebar, ordinary panels and floating surfaces.
 */
export function darkPalette(level: DarkLevel): DarkPalette {
  const base = Math.round(36 * (1 - clampLevel(level) / 100));
  const shade = (offset: number): string => {
    const channel = hex(base + offset);
    return `#${channel}${channel}${channel}`;
  };
  return {
    app: shade(0),
    sidebar: shade(8),
    panel: shade(13),
    elevated: shade(24),
    border: shade(38),
    hairline: shade(26),
  };
}

/**
 * Mirrors what public/theme-init.js does before first paint.
 *
 * `data-theme` stays light/dark because the reader and the browser's `color-scheme` depend on
 * it. The neutral surfaces travel as custom properties, which the dark token block aliases;
 * light mode ignores them. Setting them in light mode too keeps a switch to dark instant.
 */
export function applyTheme(
  root: HTMLElement,
  pref: ThemePref,
  resolved: ResolvedTheme,
  level: DarkLevel,
): DarkPalette {
  const clamped = clampLevel(level);
  const palette = darkPalette(clamped);
  root.dataset.theme = resolved;
  root.dataset.themePref = pref;
  root.dataset.themeStyle = levelPreset(clamped);
  root.dataset.darkLevel = String(clamped);
  root.style.setProperty('--dark-level', String(clamped));
  root.style.setProperty('--dark-app', palette.app);
  root.style.setProperty('--dark-sidebar', palette.sidebar);
  root.style.setProperty('--dark-panel', palette.panel);
  root.style.setProperty('--dark-elevated', palette.elevated);
  root.style.setProperty('--dark-border', palette.border);
  root.style.setProperty('--dark-hairline', palette.hairline);
  return palette;
}
