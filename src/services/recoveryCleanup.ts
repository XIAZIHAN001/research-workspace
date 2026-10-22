import { RECOVERY_KEYS } from './backupService';
import { readItem, removeItem } from './storage';
import { createIndexedDbJournal } from './restoreJournal';

export interface RecoveryCleanupResult {
  /** How many quarantined LocalStorage copies were removed. */
  keys: number;
  /** Whether a restore journal was found and cleared. */
  journal: boolean;
}

/**
 * Removes the copies the app keeps aside for recovery.
 *
 * These are never the primary data: they are earlier payloads that could not be read, plus the
 * journal of an interrupted restore. Clearing them reclaims space without touching a paper,
 * a PDF, a note or a concept, which is why this is the only cleanup the settings page offers.
 * A missing key or an unavailable IndexedDB is not a failure — the result says what was found.
 */
export async function clearRecoveryCopies(): Promise<RecoveryCleanupResult> {
  let keys = 0;
  for (const key of RECOVERY_KEYS) {
    if (readItem(key) === null) continue;
    removeItem(key);
    keys += 1;
  }

  let journal = false;
  try {
    const store = createIndexedDbJournal();
    if ((await store.read()) !== null) {
      await store.clear();
      journal = true;
    }
  } catch {
    // IndexedDB can be unavailable (sandboxed frame, blocked storage); the keys above still
    // count as cleared, and the caller never claims more than it did.
  }
  return { keys, journal };
}
