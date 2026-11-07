/** A shared lock server for independent tab coordinators. The callback holds the lease. */
export function memoryWebLocks(): LockManager {
  let held = false;
  const queue: (() => void)[] = [];
  return {
    request: (_name: string, options: LockOptions, callback: (lock: Lock) => Promise<unknown>) =>
      new Promise<unknown>((resolve, reject) => {
        const run = (): void => {
          if (options.signal?.aborted) {
            reject(new DOMException('aborted', 'AbortError'));
            queue.shift()?.();
            return;
          }
          held = true;
          void Promise.resolve(callback({ name: _name, mode: 'exclusive' } as Lock))
            .then(resolve, reject)
            .finally(() => {
              held = false;
              queue.shift()?.();
            });
        };
        options.signal?.addEventListener(
          'abort',
          () => {
            const index = queue.indexOf(run);
            if (index >= 0) queue.splice(index, 1);
            reject(new DOMException('aborted', 'AbortError'));
          },
          { once: true },
        );
        if (held) queue.push(run);
        else run();
      }),
  } as LockManager;
}
