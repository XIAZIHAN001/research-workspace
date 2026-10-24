export const THEME_STORAGE_KEY = 'rw.theme';
/**
 * How dark the dark theme is: 0 (deep grey) to 100 (pure black). Absent in profiles written
 * before Phase 12.1; those fall back to `rw.themeStyle`, then to pure black.
 * Keep this key in sync with public/theme-init.js too.
 */
export const THEME_LEVEL_STORAGE_KEY = 'rw.themeLevel';
/**
 * The Phase 12 palette name. Phase 12.1 derives the palette from `rw.themeLevel`; this key is
 * still read for migration and written as a derived value so an older build sees a sane preset.
 * Keep this key in sync with public/theme-init.js too.
 */
export const THEME_STYLE_STORAGE_KEY = 'rw.themeStyle';
export const PAPER_STORAGE_KEY = 'rw.paper';
/**
 * Legacy open/closed switch. Since layout presets exist this key is no longer written; it is
 * read exactly once, to infer the preset of a profile that predates them (see layoutPrefs.ts).
 */
export const SIDEBAR_STORAGE_KEY = 'rw.sidebar';
/** How wide the sidebar column is, in CSS pixels. Kept beside the open/closed key. */
export const SIDEBAR_WIDTH_STORAGE_KEY = 'rw.sidebarWidth';
/** Which of the three workspace layouts (专注/均衡/研究) the app starts in. */
export const LAYOUT_PRESET_STORAGE_KEY = 'rw.layoutPreset';
/** How the reader picks its initial zoom for a paper it opens. */
export const ZOOM_DEFAULT_STORAGE_KEY = 'rw.zoomDefault';
/** The last zoom the reader used, for the "沿用上次" default-zoom strategy. */
export const ZOOM_LAST_STORAGE_KEY = 'rw.zoomLast';
/** How dense the interface is: compact, standard or comfortable. */
export const DENSITY_STORAGE_KEY = 'rw.density';
/** The UI text size step. Never affects the PDF pages themselves. */
export const UI_FONT_STORAGE_KEY = 'rw.uiFont';
/** How strongly scrolling surfaces fade at their edges: off, soft (default) or standard. */
export const SCROLL_EDGE_STORAGE_KEY = 'rw.scrollEdge';
/** How wide the reader's side panel is, in CSS pixels. */
export const PANEL_WIDTH_STORAGE_KEY = 'rw.panelWidth';
export const AVATAR_STORAGE_KEY = 'rw.avatar';
/** The name shown at the bottom of the sidebar. Local only; there is no account. */
export const PROFILE_NAME_STORAGE_KEY = 'rw.profileName';
export const PROJECTS_STORAGE_KEY = 'rw.projects';
/** Verbatim copy of a payload that could not be read at all, kept for recovery by hand. */
export const PROJECTS_CORRUPT_KEY = 'rw.projects.corrupt';
/** Verbatim copy of a payload this build refused to interpret, before it can be overwritten. */
export const PROJECTS_BACKUP_KEY = 'rw.projects.backup';

/** Replace this file (or upload one in the UI) to change the default personal figure. */
export const DEFAULT_AVATAR_SRC = '/avatar/default.svg';

/** Below this width the sidebar becomes an overlay instead of taking a column. */
export const NARROW_VIEWPORT_QUERY = '(max-width: 759px)';

/**
 * Below this width the reader's side column becomes an overlay over the page.
 *
 * Deliberately not the sidebar's 759px: the reading layout needs the column to fold much
 * earlier, because the page itself has to keep a readable width beside it. The number is
 * duplicated in `styles/reader.css` (`@media (max-width: 1100px)`) because a media query cannot
 * read a custom property — the two must change together, and the CSS block says so.
 */
export const READER_OVERLAY_QUERY = '(max-width: 1100px)';
/**
 * How far a column may be dragged, in CSS pixels.
 *
 * The floor is the narrowest column that still fits a project name and its row buttons; the
 * ceiling is wide enough for a long title but still leaves the reading column the majority of a
 * 1280px window. Both ends are clamped in code, not only in CSS, so a stored value from an
 * older build (or a hand-edited one) cannot produce an unusable layout.
 */
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 420;
/** The designed default. Stored widths always win; this is what "恢复默认" writes. */
export const SIDEBAR_DEFAULT_WIDTH = 224;
export const PANEL_MIN_WIDTH = 260;
export const PANEL_MAX_WIDTH = 560;
export const PANEL_DEFAULT_WIDTH = 360;
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export const AVATAR_MAX_BYTES = 1024 * 1024;
export const AVATAR_ACCEPTED_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
]);
