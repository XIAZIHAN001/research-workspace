import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { PAPER_MODE_LABEL, type PaperMode } from './paperTheme';

const OPTIONS: readonly PaperMode[] = ['auto', 'original', 'warm', 'dark'];

const HINTS: Record<PaperMode, string> = {
  auto: '纸张随应用外观变化：浅色用暖纸，深色用深灰',
  original: '保留 PDF 的原始颜色，不做任何处理',
  warm: '米白暖纸，适合长时间浅色阅读',
  dark: '深灰纸张配柔和浅色文字',
};

interface PaperModeSwitchProps {
  pref: PaperMode;
  onChange: (mode: PaperMode) => void;
}

/**
 * Chooses how the page itself is drawn.
 *
 * The toolbar used to hold all four choices as chips, which made a crowded bar even wider. Here
 * the current choice is one compact trigger; pressing it opens an overview of every mode with a
 * swatch, a label and a sentence about what it does, so the choice is made by looking at the
 * paper rather than by scanning four abbreviations in the toolbar.
 *
 * Deliberately not the application theme control: that one changes the chrome, this one changes
 * the paper. They are adjacent on purpose, because the two are easy to confuse and a reader who
 * wants a dark reader usually wants both.
 */
export function PaperModeSwitch({ pref, onChange }: PaperModeSwitchProps) {
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

  return (
    <div className="paper-modes" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="chip paper-modes__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        aria-label={`纸张模式：${PAPER_MODE_LABEL[pref]}`}
        title={HINTS[pref]}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        <span className="paper-modes__swatch" data-mode={pref} aria-hidden="true" />
        <span>{PAPER_MODE_LABEL[pref]}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div className="paper-modes__menu" id={`${id}-menu`} role="listbox" aria-label="纸张模式">
          <p className="paper-modes__title">纸张模式</p>
          {OPTIONS.map((mode) => (
            <button
              key={mode}
              type="button"
              role="option"
              aria-selected={pref === mode}
              className="paper-modes__option"
              onClick={() => {
                onChange(mode);
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <span className="paper-modes__swatch" data-mode={mode} aria-hidden="true" />
              <span className="paper-modes__copy">
                <span className="paper-modes__name">
                  {PAPER_MODE_LABEL[mode]}
                  {pref === mode && <Check size={12} aria-hidden="true" />}
                </span>
                <span className="paper-modes__hint">{HINTS[mode]}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
