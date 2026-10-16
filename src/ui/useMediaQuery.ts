import { useCallback, useSyncExternalStore } from 'react';

const hasMatchMedia = (): boolean => typeof window.matchMedia === 'function';

/** Live `matchMedia` result. Reports false where matchMedia does not exist (jsdom, SSR). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!hasMatchMedia()) return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => {
        list.removeEventListener('change', notify);
      };
    },
    [query],
  );
  const getSnapshot = useCallback(
    () => (hasMatchMedia() ? window.matchMedia(query).matches : false),
    [query],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
