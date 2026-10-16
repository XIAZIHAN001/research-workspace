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
  /**
   * Whether the payload behind `issue` — or the original of a migrated one — is now safely
   * copied aside. `failed` means the live key holds the only copy left, so writing over it
   * would destroy data that may still be recoverable through another build.
   */
  recoveryCopy: 'saved' | 'not-needed' | 'failed';
}

/** Quarantine families: the base key plus a bounded number of alternate slots. */
const QUARANTINE_SLOTS = 3;

/**
 * Copies a payload this build cannot use into a quarantine slot, and reports whether a
 * copy is now safely in place.
 *
 * It never overwrites a slot holding different content: an earlier payload may be the only
 * surviving copy of the user's data, and it is worth more than the one in hand. Slots are
 * bounded, so a repeatedly failing payload cannot fill LocalStorage; once every slot holds
 * a different payload the copy is reported as failed and the caller must not write over
 * the live key.
 */
function keepCopy(raw: string, baseKey: string, store: KeyValueStore | null): boolean {
  const keyFor = (slot: number): string => (slot === 1 ? baseKey : `${baseKey}.${slot}`);

  // Already kept somewhere in the family: writing it again would only cost space.
  for (let slot = 1; slot <= QUARANTINE_SLOTS; slot += 1) {
    if (readItem(keyFor(slot), store) === raw) return true;
  }
  for (let slot = 1; slot <= QUARANTINE_SLOTS; slot += 1) {
    if (readItem(keyFor(slot), store) === null) return writeItem(keyFor(slot), raw, store);
  }
  return false;
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
 * A payload this build cannot interpret never reaches `rw.projects` in a rewritten form:
 * it is copied aside verbatim and the caller carries on with an empty state, so the
 * original stays available for recovery and a later write cannot silently destroy it.
 * When even that copy cannot be made, the live key keeps holding the only copy and the
 * result says so, so the caller can refuse to overwrite it.
 */
export function loadProjectsWithReport(store: KeyValueStore | null = defaultStore()): LoadResult {
  const raw = readItem(PROJECTS_STORAGE_KEY, store);
  if (raw === null) {
    return { state: EMPTY_STATE, issue: null, persisted: true, recoveryCopy: 'not-needed' };
  }

  const outcome = migrateStoredPayload(raw);
  if (!outcome.ok) {
    // A payload from a newer build may be perfectly good data we cannot handle, and a
    // migration failure is our bug, not the data's: both are set aside in the backup
    // family. Unreadable or wrong-shaped data goes to the quarantine family instead.
    const recoverable =
      outcome.reason === 'unsupported-version' || outcome.reason === 'migration-failed';
    const saved = keepCopy(raw, recoverable ? PROJECTS_BACKUP_KEY : PROJECTS_CORRUPT_KEY, store);
    const issue: LoadIssue =
      outcome.reason === 'unsupported-version'
        ? { kind: 'unsupported-version', detail: outcome.detail, found: outcome.found }
        : outcome.reason === 'migration-failed'
          ? { kind: 'migration-failed', detail: outcome.detail, from: outcome.from }
          : { kind: outcome.reason, detail: outcome.detail };
    return {
      state: EMPTY_STATE,
      issue,
      persisted: saved,
      recoveryCopy: saved ? 'saved' : 'failed',
    };
  }

  if (outcome.from >= SCHEMA_VERSION) {
    return { state: outcome.state, issue: null, persisted: true, recoveryCopy: 'not-needed' };
  }

  // Older payload: keep the original before the upgrade overwrites it. Without that copy
  // the upgrade is not attempted at all — the migrated state is still usable in memory,
  // but the stored data stays exactly as it was.
  if (!keepCopy(raw, PROJECTS_BACKUP_KEY, store)) {
    return { state: outcome.state, issue: null, persisted: false, recoveryCopy: 'failed' };
  }
  return {
    state: outcome.state,
    issue: null,
    persisted: saveProjects(outcome.state, store),
    recoveryCopy: 'saved',
  };
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
