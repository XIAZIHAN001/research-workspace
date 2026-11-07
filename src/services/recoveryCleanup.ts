import { RECOVERY_KEYS } from './backupService';
import { readItem, removeItem } from './storage';
import { workspaceAccess } from './workspaceAccess';

export interface RecoveryCleanupResult {
  /** How many quarantined LocalStorage copies were removed. */
  keys: number;
  /** Whether a restore journal was found and cleared. */
  journal: boolean;
}

/** Removes only quarantined copies. Active/committed restore journals belong to recovery,
 * including their PDF cleanup obligations, and are never deleted by this manual action. */
export async function clearRecoveryCopies(): Promise<RecoveryCleanupResult> {
  workspaceAccess.assertWritable();
  let keys = 0;
  for (const key of RECOVERY_KEYS) {
    if (readItem(key) === null) continue;
    removeItem(key);
    if (readItem(key) === null) keys += 1;
  }
  return { keys, journal: false };
}
