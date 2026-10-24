import { ChevronDown } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { PAPER_MODE_LABEL, type PaperMode } from './paperTheme';

const PAPER_MODES: readonly PaperMode[] = ['auto', 'original', 'warm', 'dark'];

interface ReaderMoreMenuProps {
  findOpen: boolean;
  onToggleFind: () => void;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  paperMode: PaperMode;
  onPaperMode: (mode: PaperMode) => void;
}

/**
 * The narrow-window overflow for the reader toolbar.
 *
 * Below the reader's overlay breakpoint the bar stops carrying the reading history, the find
 * toggle and the paper-mode switch directly — page navigation and zoom stay out in the open,
 * because they are the reason the bar exists. The menu keeps every folded action reachable
 * without remembering a shortcut, and it closes on Escape or on a click outside, like the
 * paper-mode menu it shares its visual language with.
 */
export function ReaderMoreMenu({
  findOpen,
  onToggleFind,
  canBack,
  canForward,
  onBack,
  onForward,
  paperMode,
  onPaperMode,
}: ReaderMoreMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const closeOnPointer = (event: PointerEvent) => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', closeOnPointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const closeAnd = (action: () => void): void => {
    action();
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div className="reader-more" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        更多
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div className="reader-more__menu" id={`${id}-menu`} role="menu" aria-label="更多阅读工具">
          <button
            type="button"
            role="menuitem"
            className="reader-more__item"
            disabled={!canBack}
            onClick={() => {
              closeAnd(onBack);
            }}
          >
            上一个阅读位置
            <span className="reader-more__key">Alt+←</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="reader-more__item"
            disabled={!canForward}
            onClick={() => {
              closeAnd(onForward);
            }}
          >
            下一个阅读位置
            <span className="reader-more__key">Alt+→</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="reader-more__item"
            onClick={() => {
              closeAnd(onToggleFind);
            }}
          >
            {findOpen ? '关闭查找' : '查找'}
            <span className="reader-more__key">Ctrl+F</span>
          </button>
          <p className="reader-more__label">纸张模式</p>
          {PAPER_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              role="menuitemradio"
              aria-checked={paperMode === mode}
              className="reader-more__item"
              onClick={() => {
                closeAnd(() => {
                  onPaperMode(mode);
                });
              }}
            >
              <span className="paper-modes__swatch" data-mode={mode} aria-hidden="true" />
              {PAPER_MODE_LABEL[mode]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
