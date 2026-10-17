/** Storage keys and shared constants. Keep THEME_STORAGE_KEY in sync with public/theme-init.js. */
export const THEME_STORAGE_KEY = 'rw.theme';
export const PAPER_STORAGE_KEY = 'rw.paper';
export const SIDEBAR_STORAGE_KEY = 'rw.sidebar';
export const AVATAR_STORAGE_KEY = 'rw.avatar';
export const PROJECTS_STORAGE_KEY = 'rw.projects';
/** Verbatim copy of a payload that could not be read at all, kept for recovery by hand. */
export const PROJECTS_CORRUPT_KEY = 'rw.projects.corrupt';
/** Verbatim copy of a payload this build refused to interpret, before it can be overwritten. */
export const PROJECTS_BACKUP_KEY = 'rw.projects.backup';

/** Replace this file (or upload one in the UI) to change the default personal figure. */
export const DEFAULT_AVATAR_SRC = '/avatar/default.svg';

/** Below this width the sidebar becomes an overlay instead of taking a column. */
export const NARROW_VIEWPORT_QUERY = '(max-width: 759px)';
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export const AVATAR_MAX_BYTES = 1024 * 1024;
export const AVATAR_ACCEPTED_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
]);
