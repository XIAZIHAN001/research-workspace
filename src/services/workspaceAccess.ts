/**
 * A single editable session per origin. The browser, not a tab-local flag, owns the lease.
 * Holding it across the entire session prevents stale React snapshots in another tab from
 * overwriting a completed restore. Unsupported environments are deliberately read-blocked.
 * The flags below only govern writes inside the already exclusively owned session.
 */
const LOCK_NAME = 'rw.workspace.writer.v1';
export type WorkspaceWritePermit = symbol;

export function createWorkspaceAccess(
  locks: () => LockManager | undefined = () => globalThis.navigator?.locks,
) {
  let held = false;
  let ready = false;
  let permit: WorkspaceWritePermit | null = null;
  let releaseLease: (() => void) | null = null;
  let lease: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let releaseRequested = false;
  let lifecycleEnded = false;
  let releasing: Promise<void> | null = null;
  let transactionDone: Promise<void> | null = null;
  const pending = new Set<Promise<void>>();

  const canWrite = (): boolean =>
    held && ready && permit === null && !releaseRequested && !lifecycleEnded;
  const assertWritable = (token?: WorkspaceWritePermit): void => {
    // A token authorises only the currently executing transaction. It must not fall back to
    // ordinary write permission once revoked, or a stale restore could write into a new one.
    if (!held || (token === undefined ? !canWrite() : token !== permit)) {
      throw new Error('工作区写入已暂停，请等待恢复完成或重新载入。');
    }
  };
  const block = (): void => {
    ready = false;
  };
  const drainPending = async (): Promise<void> => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  };
  const release = (): Promise<void> => {
    block();
    releaseRequested = true;
    controller?.abort();
    if (releasing !== null) return releasing;
    const currentLease = lease;
    const finished = (async () => {
      // pagehide can happen mid-restore. Keep its permit and the native lease until the work
      // (including rollback) and every already-started write settle. Browser termination
      // releases a crashed tab without requiring this cleanup to run.
      if (transactionDone !== null) await transactionDone;
      await drainPending();
      releaseLease?.();
      await currentLease;
    })().finally(() => {
      if (releasing === finished) releasing = null;
    });
    releasing = finished;
    return finished;
  };

  return {
    canWrite,
    assertWritable,
    block,
    async acquire(timeoutMs = 3000): Promise<void> {
      if (lifecycleEnded) throw new Error('此页面已退出，请重新载入后再使用工作区。');
      if (lease !== null || controller !== null || releasing !== null) {
        throw new Error('工作区锁已申请。');
      }
      const manager = locks();
      if (manager === undefined) {
        throw new Error(
          '当前环境不支持 Web Locks，已禁止工作区写入。请使用支持 Web Locks 的新版浏览器或桌面环境。',
        );
      }
      const acquisition = new AbortController();
      controller = acquisition;
      releaseRequested = false;
      ready = false;
      let accepted!: () => void;
      let refused!: (error: unknown) => void;
      const acquired = new Promise<void>((resolve, reject) => {
        accepted = resolve;
        refused = reject;
      });
      // Use this request's controller rather than a shared slot: an old timeout must never
      // abort a newer acquisition after a failed request is retried.
      const timeout = setTimeout(() => acquisition.abort(), timeoutMs);
      try {
        const request = manager.request(
          LOCK_NAME,
          { mode: 'exclusive', signal: acquisition.signal },
          async () => {
            clearTimeout(timeout);
            if (acquisition.signal.aborted || releaseRequested || lifecycleEnded) {
              refused(new Error('工作区锁申请已取消。'));
              return;
            }
            held = true;
            if (controller === acquisition) controller = null;
            try {
              await new Promise<void>((resolve) => {
                releaseLease = resolve;
                accepted();
              });
            } finally {
              held = false;
              ready = false;
              releaseLease = null;
            }
          },
        );
        const currentLease = request
          .catch((error: unknown) => {
            refused(error instanceof Error ? error : new Error('无法获取工作区锁。'));
          })
          .finally(() => {
            clearTimeout(timeout);
            if (controller === acquisition) controller = null;
            if (lease === currentLease) {
              held = false;
              ready = false;
              lease = null;
            }
          });
        lease = currentLease;
      } catch (error) {
        clearTimeout(timeout);
        acquisition.abort();
        if (controller === acquisition) controller = null;
        throw new Error('无法申请工作区锁，请重试。', { cause: error });
      }
      try {
        await acquired;
        if (!held || releaseRequested || lifecycleEnded) throw new Error('工作区锁已释放。');
      } catch {
        await lease;
        throw new Error('另一个标签页或窗口正在使用此工作区，或锁申请超时。请关闭其他窗口后重试。');
      }
    },
    allowWrites(): void {
      if (!held || permit !== null || releaseRequested || lifecycleEnded) {
        throw new Error('工作区尚未完成启动检查。');
      }
      ready = true;
    },
    async writeAsync<T>(work: () => Promise<T>, token?: WorkspaceWritePermit): Promise<T> {
      assertWritable(token);
      let finished!: () => void;
      const operation = new Promise<void>((resolve) => {
        finished = resolve;
      });
      // Register before calling user code, which can synchronously initiate shutdown.
      pending.add(operation);
      try {
        return await work();
      } finally {
        pending.delete(operation);
        finished();
      }
    },
    async exclusive<T>(work: (token: WorkspaceWritePermit) => Promise<T>): Promise<T> {
      if (!held || permit !== null || releaseRequested || lifecycleEnded) {
        throw new Error('工作区未获得独占锁或另一项恢复正在进行。');
      }
      const token = Symbol('workspace transaction');
      permit = token;
      let finished!: () => void;
      transactionDone = new Promise<void>((resolve) => {
        finished = resolve;
      });
      try {
        await drainPending();
        if (!held || releaseRequested || lifecycleEnded) throw new Error('工作区锁已释放。');
        return await work(token);
      } finally {
        // Even a callback that forgot to await a PDF write cannot open ordinary writers or
        // relinquish the native lease before that transaction actually settles.
        do {
          await drainPending();
          // A still-valid token may start another write in the microtask that resolves the
          // drain. Recheck without yielding before revoking it and reopening normal writes.
        } while (pending.size > 0);
        permit = null;
        transactionDone = null;
        finished();
      }
    },
    release,
    bindLifecycle(target: EventTarget, reload: () => void): () => void {
      const hide = (): void => {
        lifecycleEnded = true;
        void release();
      };
      const show = (event: Event): void => {
        if ((event as PageTransitionEvent).persisted) {
          lifecycleEnded = true;
          void release();
          reload();
        }
      };
      target.addEventListener('pagehide', hide);
      target.addEventListener('pageshow', show);
      return () => {
        target.removeEventListener('pagehide', hide);
        target.removeEventListener('pageshow', show);
      };
    },
  };
}

export const workspaceAccess = createWorkspaceAccess();
