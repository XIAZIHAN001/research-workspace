import { useCallback, useEffect, useState } from 'react';
import { useMediaQuery } from '../ui/useMediaQuery';
import { readItem, writeItem } from '../services/storage';
import { NARROW_VIEWPORT_QUERY, SIDEBAR_STORAGE_KEY } from './config';

/**
 * Wide windows keep a persisted open/closed column. Narrow windows start closed and show
 * the sidebar as an overlay that never persists, so a small window cannot hide it forever.
 */
export function useSidebar() {
  const narrow = useMediaQuery(NARROW_VIEWPORT_QUERY);
  const [wideOpen, setWideOpen] = useState(() => readItem(SIDEBAR_STORAGE_KEY) !== 'closed');
  const [overlayOpen, setOverlayOpen] = useState(false);
  const open = narrow ? overlayOpen : wideOpen;

  const setOpen = useCallback(
    (next: boolean) => {
      if (narrow) {
        setOverlayOpen(next);
        return;
      }
      setWideOpen(next);
      writeItem(SIDEBAR_STORAGE_KEY, next ? 'open' : 'closed');
    },
    [narrow],
  );

  useEffect(() => {
    if (!narrow || !overlayOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // A modal dialog owns Escape; closing the overlay underneath it would surprise the user.
      if (event.key === 'Escape' && document.querySelector('dialog[open]') === null) {
        setOverlayOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [narrow, overlayOpen]);

  return { open, narrow, setOpen };
}
