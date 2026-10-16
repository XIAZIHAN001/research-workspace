import { useSyncExternalStore } from 'react';

const TICK_MS = 60_000;

let current = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    current = Date.now();
    timer = setInterval(() => {
      current = Date.now();
      listeners.forEach((notify) => {
        notify();
      });
    }, TICK_MS);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) clearInterval(timer);
  };
}

/** Wall-clock time that refreshes once a minute, so "今天" and greetings stay right. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => current);
}
