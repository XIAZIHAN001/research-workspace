import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { clearRecoveryCopies } from './recoveryCleanup';
import { createIndexedDbJournal } from './restoreJournal';
import { workspaceAccess } from './workspaceAccess';

describe('manual recovery-copy cleanup', () => {
  it('never discards an unfinished restore journal', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    try {
      const journal = createIndexedDbJournal();
      await journal.write({ id: 'unfinished', startedAt: 1, keys: {}, phase: 'prepared' });
      await clearRecoveryCopies();
      expect(await journal.read()).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('does not remove quarantine copies during restore', async () => {
    localStorage.setItem('rw.projects.corrupt', 'preserve');
    await workspaceAccess.exclusive(async () => {
      await expect(clearRecoveryCopies()).rejects.toThrow();
    });
    expect(localStorage.getItem('rw.projects.corrupt')).toBe('preserve');
  });
});
