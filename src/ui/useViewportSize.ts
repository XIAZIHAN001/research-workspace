import { useCallback, useSyncExternalStore } from 'react';

/** The viewport, as far as a floating element needs to know it. */
export interface ViewportSize {
  width: number;
  height: number;
}

const hasWindow = (): boolean => typeof window !== 'undefined';

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

  const getSnapshot = useCallback((): ViewportSize => {
    if (!hasWindow()) return { width: 0, height: 0 };
    return { width: window.innerWidth, height: window.innerHeight };
  }, []);

  // Server and first paint both report zero: a floating element placed against "no viewport"
  // is then positioned by its own layout rather than by a number that was never real.
  const getServerSnapshot = useCallback((): ViewportSize => ({ width: 0, height: 0 }), []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
