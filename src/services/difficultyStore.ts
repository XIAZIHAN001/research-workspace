/**
 * Where difficulty suggestions are kept.
 *
 * Deliberately a store of its own, with its own key and its own version: these are derived,
 * disposable machine output, and they must never be able to damage the notes, the highlights or
 * the project file. Losing this entire key costs the reader a re-analysis; losing `rw.projects`
 * would cost them their work.
 *
 * The cache key contains the file hash, the page, the model and the rule version. A replaced PDF
 * therefore starts empty — an old file's suggestions can never be drawn on a new file's text —
 * and a change to the analysis rules invalidates what came before without deleting anything.
 */

import { defaultStore, readItem, writeItem, type KeyValueStore } from './storage';
import {
  DEFAULT_DIFFICULTY_PREFS,
  isDifficultyPageRecord,
  trimDifficultyPages,
  type DifficultyPageRecord,
  type DifficultyPrefs,
  type DifficultyState,
} from '../domain/difficulty';

export const DIFFICULTY_STORAGE_KEY = 'rw.difficulties';
export const DIFFICULTY_PREFS_KEY = 'rw.difficulties.prefs';

export type { DifficultyPrefs, DifficultyState };

/**
 * Bumping this invalidates every cached page.
 *
 * It is not a schema version: the payload format is stable. It identifies the *rules* that
 * produced a suggestion — what counts as a difficulty, how many per page, how quotes are
 * checked. Changing those makes old results not wrong exactly, but not the current answer.
 */
export const DIFFICULTY_RULES_VERSION = 'd1';

/** Enough for a long paper read end to end, bounded so storage cannot fill up. */
export const MAX_CACHED_PAGES = 400;

const EMPTY: DifficultyState = { pages: {}, ignored: {} };

export function pageKey(
  pdfSha256: string,
  page: number,
  model: string,
  rulesVersion: string = DIFFICULTY_RULES_VERSION,
): string {
  return `${pdfSha256}|${String(page)}|${model}|${rulesVersion}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads what is there, keeping only entries this build understands.
 *
 * A corrupt payload is treated as empty rather than repaired: it is derived data, and an
 * unreadable cache is not worth a quarantine copy that could confuse a later recovery.
 */
export function loadDifficulties(store: KeyValueStore | null = defaultStore()): DifficultyState {
  const raw = readItem(DIFFICULTY_STORAGE_KEY, store);
  if (raw === null) return EMPTY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  if (!isRecord(parsed)) return EMPTY;

  const pages: Record<string, DifficultyPageRecord> = {};
  if (isRecord(parsed.pages)) {
    for (const [key, value] of Object.entries(parsed.pages)) {
      if (key === '__proto__') continue;
      if (isDifficultyPageRecord(value)) pages[key] = value;
    }
  }

  const ignored: Record<string, string[]> = {};
  if (isRecord(parsed.ignored)) {
    for (const [key, value] of Object.entries(parsed.ignored)) {
      if (key === '__proto__') continue;
      if (Array.isArray(value)) ignored[key] = value.filter((id) => typeof id === 'string');
    }
  }
  return { pages, ignored };
}

/** Drops the oldest pages once the cache is over its bound. */
function trim(pages: Record<string, DifficultyPageRecord>): Record<string, DifficultyPageRecord> {
  return trimDifficultyPages(pages, MAX_CACHED_PAGES);
}

export function serializeDifficulties(state: DifficultyState): string {
  return JSON.stringify({ version: 1, pages: trim(state.pages), ignored: state.ignored });
}

export function saveDifficulties(
  state: DifficultyState,
  store: KeyValueStore | null = defaultStore(),
): boolean {
  return writeItem(DIFFICULTY_STORAGE_KEY, serializeDifficulties(state), store);
}

/** Adds one page's result, replacing whatever was there for the same key. */
export function withPageRecord(
  state: DifficultyState,
  key: string,
  record: DifficultyPageRecord,
): DifficultyState {
  return { ...state, pages: { ...state.pages, [key]: record } };
}

export function withIgnored(
  state: DifficultyState,
  pdfSha256: string,
  id: string,
): DifficultyState {
  const current = state.ignored[pdfSha256] ?? [];
  if (current.includes(id)) return state;
  return { ...state, ignored: { ...state.ignored, [pdfSha256]: [...current, id] } };
}

export function ignoredFor(state: DifficultyState, pdfSha256: string): ReadonlySet<string> {
  return new Set(state.ignored[pdfSha256] ?? []);
}

/** Forgets one paper's suggestions, for "重新分析" and for a file that has been replaced. */
export function withoutPaper(state: DifficultyState, pdfSha256: string): DifficultyState {
  const pages: Record<string, DifficultyPageRecord> = {};
  for (const [key, record] of Object.entries(state.pages)) {
    if (record.pdfSha256 !== pdfSha256) pages[key] = record;
  }
  const ignored = { ...state.ignored };
  delete ignored[pdfSha256];
  return { pages, ignored };
}

export function loadDifficultyPrefs(store: KeyValueStore | null = defaultStore()): DifficultyPrefs {
  const raw = readItem(DIFFICULTY_PREFS_KEY, store);
  if (raw === null) return DEFAULT_DIFFICULTY_PREFS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return DEFAULT_DIFFICULTY_PREFS;
    return {
      enabled: parsed.enabled === true,
      markersVisible: parsed.markersVisible !== false,
    };
  } catch {
    return DEFAULT_DIFFICULTY_PREFS;
  }
}

export function saveDifficultyPrefs(
  prefs: DifficultyPrefs,
  store: KeyValueStore | null = defaultStore(),
): void {
  writeItem(DIFFICULTY_PREFS_KEY, JSON.stringify(prefs), store);
}
