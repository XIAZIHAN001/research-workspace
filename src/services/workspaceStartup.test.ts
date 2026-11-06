import { describe, expect, it, vi } from 'vitest';
import { initializeWorkspace } from './workspaceStartup';
import { createWorkspaceAccess } from './workspaceAccess';
import { memoryWebLocks } from '../test/webLocks';

for (const recovery of [
  async () => 'blocked' as const,
  async (): Promise<never> => {
    throw new Error('IndexedDB failed');
  },
]) {
  it('does not instantiate any stores or mount the app when recovery is blocked', async () => {
    const access = createWorkspaceAccess(() => memoryWebLocks());
    const mount = vi.fn();
    const result = await initializeWorkspace(mount, { access, recover: recovery });
    expect(result.status).toBe('blocked');
    expect(mount).not.toHaveBeenCalled();
    expect(access.canWrite()).toBe(false);
  });
}

describe('startup boundary', () => {
  it('checks recovery under the exclusive session lease before creating stores', async () => {
    const access = createWorkspaceAccess(() => memoryWebLocks());
    const order: string[] = [];
    const result = await initializeWorkspace(
      () => {
        order.push('stores');
        expect(access.canWrite()).toBe(true);
      },
      {
        access,
        recover: async () => {
          order.push('recovery');
          expect(access.canWrite()).toBe(false);
          return 'none';
        },
      },
    );
    expect(result.status).toBe('ready');
    expect(order).toEqual(['recovery', 'stores']);
    await access.release();
  });
});
