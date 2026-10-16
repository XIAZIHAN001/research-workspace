import { PROJECTS_BACKUP_KEY, PROJECTS_CORRUPT_KEY, PROJECTS_STORAGE_KEY } from '../app/config';
import { migrateStoredPayload, SCHEMA_VERSION, serializeProjects } from '../domain/migrate';
import { EMPTY_STATE, type ProjectsState } from '../domain/projectsState';

/** The slice of Storage this app uses, so tests can inject a stub. */
export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Why the stored payload is not in use. Null after a clean load. */
export type LoadIssue =
  | { kind: 'unreadable'; detail: string }
  | { kind: 'invalid'; detail: string }
  | { kind: 'unsupported-version'; detail: string; found: number }
  | { kind: 'migration-failed'; detail: string; from: number };

export interface LoadResult {
  state: ProjectsState;
  /** Null when the stored payload was read (or absent) as expected. */
  issue: LoadIssue | null;
  /** False when a migrated payload could not be written back to this store. */
  persisted: boolean;
}

/** Reading `window.localStorage` itself can throw (blocked storage, sandboxed frames). */
export function defaultStore(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readItem(key: string, store: KeyValueStore | null = defaultStore()): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Returns false when the write did not land (quota exceeded or storage unavailable). */
export function writeItem(
  key: string,
  value: string,
  store: KeyValueStore | null = defaultStore(),
): boolean {
  if (store === null) return false;
  try {
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeItem(key: string, store: KeyValueStore | null = defaultStore()): void {
  try {
    store?.removeItem(key);
  } catch {
    // Storage is unavailable; there is nothing left to clean up.
  }
}

/**
 * Reads the stored payload and reports what happened to it.
 *
 * A payload this build cannot interpret never reaches `rw.projects`: it is copied aside
 * verbatim and the caller carries on with an empty state, so the original stays available
 * for recovery and a later write cannot silently destroy it.
 */
export function loadProjectsWithReport(store: KeyValueStore | null = defaultStore()): LoadResult {
  const raw = readItem(PROJECTS_STORAGE_KEY, store);
  if (raw === null) return { state: EMPTY_STATE, issue: null, persisted: true };

  const outcome = migrateStoredPayload(raw);
  if (!outcome.ok) {
    if (outcome.reason === 'unsupported-version' || outcome.reason === 'migration-failed') {
      // The payload may be perfectly good data that this build cannot handle: keep a copy
      // before the app is allowed to overwrite the live key.
      writeItem(PROJECTS_BACKUP_KEY, raw, store);
      const issue: LoadIssue =
        outcome.reason === 'unsupported-version'
          ? { kind: 'unsupported-version', detail: outcome.detail, found: outcome.found }
          : { kind: 'migration-failed', detail: outcome.detail, from: outcome.from };
      return { state: EMPTY_STATE, issue, persisted: true };
    }
    // Unreadable or wrong shape: quarantine next to the live key, then start clean.
    writeItem(PROJECTS_CORRUPT_KEY, raw, store);
    return {
      state: EMPTY_STATE,
      issue: { kind: outcome.reason, detail: outcome.detail },
      persisted: true,
    };
  }

  if (outcome.from >= SCHEMA_VERSION) return { state: outcome.state, issue: null, persisted: true };

  // Older payload: keep the original, then write the migrated one back so the upgrade
  // happens once instead of on every load.
  writeItem(PROJECTS_BACKUP_KEY, raw, store);
  return { state: outcome.state, issue: null, persisted: saveProjects(outcome.state, store) };
}

/** The projects state, without the report. Anything unreadable yields the empty state. */
export function loadProjects(store: KeyValueStore | null = defaultStore()): ProjectsState {
  return loadProjectsWithReport(store).state;
}

export function saveProjects(
  state: ProjectsState,
  store: KeyValueStore | null = defaultStore(),
): boolean {
  return writeItem(PROJECTS_STORAGE_KEY, serializeProjects(state), store);
}
