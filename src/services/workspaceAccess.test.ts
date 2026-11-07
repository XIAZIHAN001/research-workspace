import { describe, expect, it, vi } from 'vitest';
import { memoryWebLocks } from '../test/webLocks';
import { createWorkspaceAccess, workspaceAccess } from './workspaceAccess';
import { writeItem, removeItem } from './storage';
import { createProjectsStore } from './projectsStore';
import { createKnowledgeStore } from './knowledgeStore';
import { createPdfBlobStore } from './pdfStore';
import { IDBFactory } from 'fake-indexeddb';

const tick = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('native workspace lease', () => {
  it('allows only one tab to recover or write, and permits a waiting tab after closure', async () => {
    const locks = memoryWebLocks();
    const first = createWorkspaceAccess(() => locks);
    const second = createWorkspaceAccess(() => locks);
    await first.acquire();
    first.allowWrites();
    let acquired = false;
    const pending = second.acquire().then(() => {
      acquired = true;
    });
    await tick();
    expect(acquired).toBe(false);
    expect(second.canWrite()).toBe(false);
    await expect(second.exclusive(async () => undefined)).rejects.toThrow();
    await first.release();
    await pending;
    expect(first.canWrite()).toBe(false);
    second.allowWrites();
    expect(second.canWrite()).toBe(true);
    await second.release();
  });

  it('fails closed without Web Locks', async () => {
    const access = createWorkspaceAccess(() => undefined);
    await expect(access.acquire()).rejects.toThrow(/Web Locks/);
    expect(access.canWrite()).toBe(false);
  });

  it('times out a waiting tab without creating an unprotected writer', async () => {
    const locks = memoryWebLocks();
    const first = createWorkspaceAccess(() => locks);
    const second = createWorkspaceAccess(() => locks);
    await first.acquire();
    await expect(second.acquire(5)).rejects.toThrow();
    expect(second.canWrite()).toBe(false);
    await first.release();
    await second.acquire();
    await second.release();
  });

  it('blocks normal writes during restore and drains already-started PDF transactions', async () => {
    const access = createWorkspaceAccess(() => memoryWebLocks());
    await access.acquire();
    access.allowWrites();
    let finish!: () => void;
    const writing = access.writeAsync(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let restoring = false;
    const restore = access.exclusive(async (permit) => {
      restoring = true;
      expect(access.canWrite()).toBe(false);
      await expect(access.writeAsync(async () => undefined)).rejects.toThrow();
      await access.writeAsync(async () => undefined, permit);
    });
    await tick();
    expect(restoring).toBe(false);
    finish();
    await writing;
    await restore;
    expect(restoring).toBe(true);
    expect(access.canWrite()).toBe(true);
    await access.release();
  });

  it('releases the transaction barrier on failure and rejects overlapping restores', async () => {
    const access = createWorkspaceAccess(() => memoryWebLocks());
    await access.acquire();
    access.allowWrites();
    let finish!: () => void;
    const restoring = access.exclusive(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      throw new Error('restore failed');
    });
    await tick();
    await expect(access.exclusive(async () => undefined)).rejects.toThrow();
    finish();
    await expect(restoring).rejects.toThrow('restore failed');
    expect(access.canWrite()).toBe(true);
    await access.release();
  });

  it('revokes writes before releasing a pagehide lease and reloads bfcache pages', async () => {
    const access = createWorkspaceAccess(() => memoryWebLocks());
    await access.acquire();
    access.allowWrites();
    const target = new EventTarget();
    const reload = vi.fn();
    const detach = access.bindLifecycle(target, reload);
    target.dispatchEvent(new Event('pagehide'));
    expect(access.canWrite()).toBe(false);
    target.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(reload).toHaveBeenCalledOnce();
    expect(access.canWrite()).toBe(false);
    detach();
    await access.release();
  });
});

describe('workspace writers enforce the lease', () => {
  it('blocks paper, note, preference and PDF writes during restore', async () => {
    const projects = createProjectsStore();
    const knowledge = createKnowledgeStore();
    const before = projects.getSnapshot().state;
    const beforeKnowledge = knowledge.getSnapshot().state;
    localStorage.setItem('rw.theme', 'light');
    await workspaceAccess.exclusive(async () => {
      expect(writeItem('rw.theme', 'dark')).toBe(false);
      removeItem('rw.theme');
      projects.dispatch({
        type: 'registerPaper',
        paper: { id: 'blocked', title: 'blocked', authors: [], createdAt: 1, updatedAt: 1 },
      });
      knowledge.dispatch({
        type: 'concept/create',
        input: { name: 'blocked', projectIds: [] },
        id: 'blocked',
        at: 1,
      });
      expect(localStorage.getItem('rw.theme')).toBe('light');
      expect(projects.getSnapshot().state).toBe(before);
      expect(knowledge.getSnapshot().state).toBe(beforeKnowledge);
      const blobs = createPdfBlobStore(new IDBFactory());
      await expect(blobs.put('a'.repeat(64), new Uint8Array([1]))).rejects.toThrow();
    });
    expect(writeItem('rw.theme', 'dark')).toBe(true);
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('workspace lease shutdown races', () => {
  it('defers native lease release until an executing restore and its writes finish', async () => {
    const locks = memoryWebLocks();
    const first = createWorkspaceAccess(() => locks);
    const second = createWorkspaceAccess(() => locks);
    await first.acquire();
    first.allowWrites();
    const entered = deferred();
    const finish = deferred();
    const restoring = first.exclusive(async (token) => {
      entered.resolve();
      await finish.promise;
      await first.writeAsync(async () => undefined, token);
    });
    await entered.promise;
    let released = false;
    const releasing = first.release().then(() => {
      released = true;
    });
    let acquired = false;
    const waiting = second.acquire(1000).then(() => {
      acquired = true;
    });
    await tick();
    expect(released).toBe(false);
    expect(acquired).toBe(false);
    finish.resolve();
    await restoring;
    await releasing;
    await waiting;
    expect(first.canWrite()).toBe(false);
    second.allowWrites();
    expect(second.canWrite()).toBe(true);
    await second.release();
  });

  it('does not reopen ordinary writes or start a restore while release drains a write', async () => {
    const access = createWorkspaceAccess(() => memoryWebLocks());
    await access.acquire();
    access.allowWrites();
    const finish = deferred();
    const writing = access.writeAsync(() => finish.promise);
    const releasing = access.release();
    expect(access.canWrite()).toBe(false);
    expect(() => access.allowWrites()).toThrow();
    await expect(access.exclusive(async () => undefined)).rejects.toThrow();
    finish.resolve();
    await writing;
    await releasing;
    expect(access.canWrite()).toBe(false);
  });

  it('does not start a restore when release was requested while earlier writes drain', async () => {
    const access = createWorkspaceAccess(() => memoryWebLocks());
    await access.acquire();
    access.allowWrites();
    const finish = deferred();
    const writing = access.writeAsync(() => finish.promise);
    const work = vi.fn(async () => undefined);
    const restoring = access.exclusive(work);
    const outcome = restoring.catch((error: unknown) => error);
    const releasing = access.release();
    finish.resolve();
    await writing;
    expect(await outcome).toBeInstanceOf(Error);
    await releasing;
    expect(work).not.toHaveBeenCalled();
    expect(access.canWrite()).toBe(false);
  });

  it('releases a pagehide lease after restore failure and cannot reopen the old page', async () => {
    const locks = memoryWebLocks();
    const first = createWorkspaceAccess(() => locks);
    const second = createWorkspaceAccess(() => locks);
    await first.acquire();
    first.allowWrites();
    const entered = deferred();
    const finish = deferred();
    const restoring = first.exclusive(async () => {
      entered.resolve();
      await finish.promise;
      throw new Error('restore failed');
    });
    const outcome = restoring.catch((error: unknown) => error);
    await entered.promise;
    const target = new EventTarget();
    const detach = first.bindLifecycle(target, () => undefined);
    target.dispatchEvent(new Event('pagehide'));
    expect(first.canWrite()).toBe(false);
    finish.resolve();
    expect(await outcome).toBeInstanceOf(Error);
    await expect(second.acquire(1000)).resolves.toBeUndefined();
    expect(() => first.allowWrites()).toThrow();
    await expect(first.acquire()).rejects.toThrow();
    detach();
    await second.release();
  });

  it('rejects forged and revoked transaction tokens even while ordinary writes are enabled', async () => {
    const access = createWorkspaceAccess(() => memoryWebLocks());
    await access.acquire();
    access.allowWrites();
    const forged = Symbol('not a permit');
    await expect(access.writeAsync(async () => undefined, forged)).rejects.toThrow();
    let revoked: symbol | undefined;
    await access.exclusive(async (token) => {
      revoked = token;
    });
    expect(access.canWrite()).toBe(true);
    await expect(access.writeAsync(async () => undefined, revoked)).rejects.toThrow();
    await access.writeAsync(async () => undefined);
    await access.release();
  });

  it('does not revoke an executing transaction before its non-awaited PDF write settles', async () => {
    const access = createWorkspaceAccess(() => memoryWebLocks());
    await access.acquire();
    access.allowWrites();
    const finish = deferred();
    const entered = deferred();
    let writing!: Promise<void>;
    let completed = false;
    const restoring = access
      .exclusive(async (token) => {
        writing = access.writeAsync(() => finish.promise, token);
        entered.resolve();
      })
      .then(() => {
        completed = true;
      });
    await entered.promise;
    await tick();
    expect(completed).toBe(false);
    expect(access.canWrite()).toBe(false);
    finish.resolve();
    await writing;
    await restoring;
    expect(access.canWrite()).toBe(true);
    await access.release();
  });

  it('rechecks writes that begin while the transaction completion barrier yields', async () => {
    const access = createWorkspaceAccess(() => memoryWebLocks());
    await access.acquire();
    access.allowWrites();
    const finish = deferred();
    const entered = deferred();
    let writing!: Promise<void>;
    let completed = false;
    const restoring = access
      .exclusive(async (token) => {
        queueMicrotask(() =>
          queueMicrotask(() => {
            writing = access.writeAsync(() => finish.promise, token);
            entered.resolve();
          }),
        );
      })
      .then(() => {
        completed = true;
      });
    await entered.promise;
    await tick();
    expect(completed).toBe(false);
    expect(access.canWrite()).toBe(false);
    finish.resolve();
    await writing;
    await restoring;
    await access.release();
  });

  it('registers a write before its callback can synchronously request release', async () => {
    const locks = memoryWebLocks();
    const first = createWorkspaceAccess(() => locks);
    const second = createWorkspaceAccess(() => locks);
    await first.acquire();
    first.allowWrites();
    const finish = deferred();
    let releasing!: Promise<void>;
    const writing = first.writeAsync(() => {
      releasing = first.release();
      return finish.promise;
    });
    let acquired = false;
    const waiting = second.acquire(1000).then(() => {
      acquired = true;
    });
    await tick();
    expect(acquired).toBe(false);
    finish.resolve();
    await writing;
    await releasing;
    await waiting;
    await second.release();
  });

  it('cleans up a synchronous lock request failure and permits retry', async () => {
    const locks = memoryWebLocks();
    vi.spyOn(locks, 'request').mockImplementationOnce(() => {
      throw new Error('request failed');
    });
    const access = createWorkspaceAccess(() => locks);
    await expect(access.acquire(5)).rejects.toThrow();
    await expect(access.acquire()).resolves.toBeUndefined();
    access.allowWrites();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(access.canWrite()).toBe(true);
    await access.release();
  });

  it('rejects a concurrent acquire without disturbing the first request', async () => {
    const access = createWorkspaceAccess(() => memoryWebLocks());
    const acquiring = access.acquire();
    await expect(access.acquire()).rejects.toThrow();
    await acquiring;
    access.allowWrites();
    expect(access.canWrite()).toBe(true);
    await access.release();
  });

  it('does not report a lease acquired if release races its acquisition result', async () => {
    const access = createWorkspaceAccess(() => memoryWebLocks());
    const acquiring = access.acquire().catch((error: unknown) => error);
    const releasing = access.release();
    expect(await acquiring).toBeInstanceOf(Error);
    await releasing;
    expect(access.canWrite()).toBe(false);
    await access.acquire();
    expect(access.canWrite()).toBe(false);
    await access.release();
  });

  it('does not let a failed request timeout cancel a newer queued acquisition', async () => {
    const locks = memoryWebLocks();
    const first = createWorkspaceAccess(() => locks);
    const second = createWorkspaceAccess(() => locks);
    await first.acquire();
    vi.spyOn(locks, 'request').mockImplementationOnce(() => {
      throw new Error('request failed');
    });
    await expect(second.acquire(5)).rejects.toThrow();
    const acquiring = second.acquire(1000).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await first.release();
    expect(await acquiring).toBeUndefined();
    second.allowWrites();
    expect(second.canWrite()).toBe(true);
    await second.release();
  });

  it('settles repeated releases during acquisition and allows a fresh retry', async () => {
    const locks = memoryWebLocks();
    const first = createWorkspaceAccess(() => locks);
    const second = createWorkspaceAccess(() => locks);
    await first.acquire();
    const acquisition = second.acquire().catch((error: unknown) => error);
    await Promise.all([second.release(), second.release()]);
    expect(await acquisition).toBeInstanceOf(Error);
    await first.release();
    await second.acquire();
    expect(second.canWrite()).toBe(false);
    second.allowWrites();
    expect(second.canWrite()).toBe(true);
    await second.release();
  });
});
