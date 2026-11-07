import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { armHarnessDeadline, crashRenderer } from './crash-control.mjs';

/** Model only Playwright's observable event/timeout contract; no browser is needed. */
function fakePage() {
  const page = new EventEmitter();
  page.waitForEvent = (name, { timeout }) =>
    new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        page.removeListener(name, finish);
        reject(new Error(`Timeout waiting for ${name}`));
      }, timeout);
      page.once(name, finish);
    });
  return page;
}

describe('crashRenderer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('finishes on an observed crash event even if the CDP command response stays pending forever', async () => {
    const page = fakePage();
    let listenerWasArmed = false;
    const session = {
      send(method) {
        expect(method).toBe('Page.crash');
        listenerWasArmed = page.listenerCount('crash') === 1;
        return new Promise(() => {});
      },
    };
    let completed = false;
    const operation = crashRenderer(page, session, 100).then(() => {
      completed = true;
    });
    page.emit('crash');
    await vi.advanceTimersByTimeAsync(100);
    expect(listenerWasArmed).toBe(true);
    expect(completed).toBe(true);
    await operation;
  });

  it('accepts an observed crash when the CDP command rejects after renderer termination', async () => {
    const page = fakePage();
    const operation = crashRenderer(
      page,
      { send: () => Promise.reject(new Error('Target crashed')) },
      100,
    );
    page.emit('crash');
    await expect(operation).resolves.toBeUndefined();
  });

  it('does not treat a successful CDP response as proof of an actual crash', async () => {
    const page = fakePage();
    const operation = crashRenderer(page, { send: () => Promise.resolve() }, 100);
    const rejected = expect(operation).rejects.toThrow(/crash/);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(page.listenerCount('crash')).toBe(0);
  });

  it('times out when both the command response and the actual crash event are missing', async () => {
    const page = fakePage();
    const operation = crashRenderer(page, { send: () => new Promise(() => {}) }, 100);
    const rejected = expect(operation).rejects.toThrow('No observed renderer crash within 100 ms');
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
  });

  it('observes synchronous command errors without accepting them as crash proof', async () => {
    const page = fakePage();
    const operation = crashRenderer(
      page,
      {
        send() {
          throw new Error('Disconnected session');
        },
      },
      100,
    );
    const rejected = expect(operation).rejects.toThrow(
      /No observed renderer crash.*Disconnected session/,
    );
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
  });

  it('does not treat a rejected CDP response as proof of an actual crash', async () => {
    const page = fakePage();
    const operation = crashRenderer(
      page,
      { send: () => Promise.reject(new Error('Protocol refused')) },
      100,
    );
    const rejected = expect(operation).rejects.toThrow(/crash/);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
  });
});

describe('armHarnessDeadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('records a failure before terminating a stuck harness at the deadline', async () => {
    const actions = [];
    armHarnessDeadline(
      100,
      () => actions.push('write failure report'),
      () => actions.push('terminate'),
    );
    await vi.advanceTimersByTimeAsync(99);
    expect(actions).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(actions).toEqual(['write failure report', 'terminate']);
  });

  it('does not terminate a harness that completed before the deadline', async () => {
    const actions = [];
    const cancel = armHarnessDeadline(
      100,
      () => actions.push('report'),
      () => actions.push('terminate'),
    );
    cancel();
    await vi.advanceTimersByTimeAsync(200);
    expect(actions).toEqual([]);
  });

  it('still terminates if writing the failure report itself throws', () => {
    let terminated = false;
    armHarnessDeadline(
      100,
      () => {
        throw new Error('fixture report failure');
      },
      () => {
        terminated = true;
      },
    );
    expect(() => vi.advanceTimersByTime(100)).toThrow('fixture report failure');
    expect(terminated).toBe(true);
  });
});
