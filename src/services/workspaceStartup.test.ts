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
    const locks = memoryWebLocks();
    const access = createWorkspaceAccess(() => locks);
    const contender = createWorkspaceAccess(() => locks);
    const mount = vi.fn();
    const result = await initializeWorkspace(mount, { access, recover: recovery });
    expect(result.status).toBe('blocked');
    expect(mount).not.toHaveBeenCalled();
    expect(access.canWrite()).toBe(false);
    // Ordinary blocked/error startup still releases its lease for a later corrected page.
    await contender.acquire(20);
    await contender.release();
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

it('keeps a manual-only blocked startup lease until pagehide so another tab cannot replay', async () => {
  const locks = memoryWebLocks();
  const access = createWorkspaceAccess(() => locks);
  const contender = createWorkspaceAccess(() => locks);
  const lifecycle = new EventTarget();
  const unbind = access.bindLifecycle(lifecycle, vi.fn());
  try {
    const result = await initializeWorkspace(vi.fn(), {
      access,
      recover: async () => 'blocked',
      retainLeaseOnBlock: () => true,
    });
    expect(result.status).toBe('blocked');
    expect(access.canWrite()).toBe(false);
    await expect(contender.acquire(10)).rejects.toThrow();
    lifecycle.dispatchEvent(new Event('pagehide'));
    await access.release();
    await contender.acquire();
    contender.allowWrites();
    expect(contender.canWrite()).toBe(true);
  } finally {
    unbind();
    await access.release();
    await contender.release();
  }
});
