import { useCallback, useSyncExternalStore } from 'react';

/** The viewport, as far as a floating element needs to know it. */
export interface ViewportSize {
  width: number;
  height: number;
}

const hasWindow = (): boolean => typeof window !== 'undefined';

/** What a viewport reports before there is one. A constant, so it is always the same value. */
const NO_VIEWPORT: ViewportSize = { width: 0, height: 0 };

/**
 * The last size handed to a subscriber.
 *
 * `useSyncExternalStore` calls `getSnapshot` several times around every render and compares the
 * answers by identity; a fresh object on each call reads as "the store changed" on every
 * check, which sends the subscriber back into render forever — React stops the loop by
 * throwing, and the crash takes the component's whole boundary with it. The snapshot is only
 * allowed to change when the window actually did, so the same numbers return the same object.
 */
let cachedSize: ViewportSize | null = null;

function currentViewport(): ViewportSize {
  if (!hasWindow()) return NO_VIEWPORT;
  const width = window.innerWidth;
  const height = window.innerHeight;
  if (cachedSize !== null && cachedSize.width === width && cachedSize.height === height) {
    return cachedSize;
  }
  cachedSize = { width, height };
  return cachedSize;
}

/**
 * Live viewport size.
 *
 * A floating element — a toolbar, a menu, a popover — has to stay inside the window, and the
 * only honest way to know the window's size is to be told when it changes. Reading
 * `window.innerWidth` during render instead means the value is correct for the render that
 * read it and stale for every render after it: the toolbar keeps the position it computed
 * before the window was resized, and it keeps computing against a size that no longer exists.
 *
 * Reading it during render is also the one thing that cannot be undone by a test: a component
 * that touches `window` while rendering will throw the moment it is rendered on a server, and
 * will silently disagree with itself under concurrent rendering.
 */
export function useViewportSize(): ViewportSize {
  const subscribe = useCallback((notify: () => void) => {
    if (!hasWindow()) return () => undefined;
    window.addEventListener('resize', notify);
    window.addEventListener('orientationchange', notify);
    return () => {
      window.removeEventListener('resize', notify);
      window.removeEventListener('orientationchange', notify);
    };
  }, []);

  const getSnapshot = useCallback((): ViewportSize => currentViewport(), []);

  // Server and first paint both report zero: a floating element placed against "no viewport"
  // is then positioned by its own layout rather than by a number that was never real.
  const getServerSnapshot = useCallback((): ViewportSize => NO_VIEWPORT, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
