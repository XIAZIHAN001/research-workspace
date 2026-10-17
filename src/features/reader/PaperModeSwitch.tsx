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
 * Deliberately not the application theme control: that one changes the chrome, this one changes
 * the paper. They are adjacent on purpose, because the two are easy to confuse and a reader who
 * wants a dark reader usually wants both.
 */
export function PaperModeSwitch({ pref, onChange }: PaperModeSwitchProps) {
  return (
    <div className="paper-modes" role="group" aria-label="纸张模式">
      {OPTIONS.map((mode) => (
        <button
          key={mode}
          type="button"
          className="chip"
          aria-pressed={pref === mode}
          title={HINTS[mode]}
          onClick={() => {
            onChange(mode);
          }}
        >
          {PAPER_MODE_LABEL[mode]}
        </button>
      ))}
    </div>
  );
}
