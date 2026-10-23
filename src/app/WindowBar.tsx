import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Copy, Minus, Square, X } from 'lucide-react';

/**
 * The window's own title bar.
 *
 * The native one is switched off in Rust (`decorations(false)`), so this strip supplies what it
 * used to: a place to drag the window from, and minimise / maximise / close. Dragging is done by
 * `data-tauri-drag-region` rather than by listening for pointer events, which is what also keeps
 * double-click-to-maximise and the Windows snap gestures working.
 *
 * It is rendered only in the desktop shell; a browser has no window to control.
 */
export function WindowBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let mounted = true;
    const sync = (): void => {
      void appWindow.isMaximized().then((value) => {
        if (mounted) setMaximized(value);
      });
    };
    sync();
    // Maximising by any route (button, double click, snap layout) has to update the icon.
    const pending = appWindow.onResized(sync);
    return () => {
      mounted = false;
      void pending.then((unlisten) => {
        unlisten();
      });
    };
  }, []);

  const toggleLabel = maximized ? '向下还原' : '最大化';

  return (
    <div className="window-bar" data-tauri-drag-region="true">
      <div className="window-bar__buttons">
        <button
          type="button"
          className="window-bar__btn"
          aria-label="最小化"
          title="最小化"
          onClick={() => {
            void getCurrentWindow().minimize();
          }}
        >
          <Minus size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="window-bar__btn"
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={() => {
            void getCurrentWindow().toggleMaximize();
          }}
        >
          {maximized ? (
            <Copy size={12} aria-hidden="true" />
          ) : (
            <Square size={11} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="window-bar__btn window-bar__btn--close"
          aria-label="关闭窗口"
          title="关闭窗口"
          onClick={() => {
            void getCurrentWindow().close();
          }}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
