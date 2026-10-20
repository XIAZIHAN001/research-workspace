import { Monitor, Moon, Sun } from 'lucide-react';
import { DARK_LEVEL_MAX, DARK_LEVEL_MIN, type DarkLevel, type ThemePref } from './theme';

const OPTIONS = [
  { value: 'system', label: '跟随系统', Icon: Monitor },
  { value: 'light', label: '浅色', Icon: Sun },
  { value: 'dark', label: '深色', Icon: Moon },
] as const;

interface ThemeSegmentsProps {
  pref: ThemePref;
  onChange: (pref: ThemePref) => void;
}

/** The three-way light/dark/system choice, used inside Settings › Appearance. */
export function ThemeSegments({ pref, onChange }: ThemeSegmentsProps) {
  return (
    <div className="segmented" role="group" aria-label="主题" data-count={OPTIONS.length}>
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          className="seg"
          aria-pressed={pref === value}
          aria-label={label}
          title={label}
          onClick={() => {
            onChange(value);
          }}
        >
          <Icon size={15} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

interface DarkLevelSliderProps {
  level: DarkLevel;
  onChange: (level: DarkLevel) => void;
}

function levelText(level: DarkLevel): string {
  if (level >= DARK_LEVEL_MAX) return '纯黑';
  if (level <= DARK_LEVEL_MIN) return '深灰';
  return `深色程度 ${String(level)}`;
}

/**
 * Dark level: one slider, 0 (deep grey) to 100 (pure black). It stays available in light mode
 * because it configures the dark surfaces the system will use when it switches.
 */
export function DarkLevelSlider({ level, onChange }: DarkLevelSliderProps) {
  return (
    <label className="theme-level">
      <span className="theme-level__label">深色程度</span>
      <input
        className="theme-level__range"
        type="range"
        min={DARK_LEVEL_MIN}
        max={DARK_LEVEL_MAX}
        step={1}
        value={level}
        aria-label="深色程度"
        aria-valuetext={levelText(level)}
        title="0 为深灰，100 为纯黑；只影响深色主题"
        onChange={(event) => {
          onChange(Number(event.target.value));
        }}
      />
      <span className="theme-level__value" aria-hidden="true">
        {level}
      </span>
    </label>
  );
}
