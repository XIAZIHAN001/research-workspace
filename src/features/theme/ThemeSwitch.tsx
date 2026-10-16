import { Monitor, Moon, Sun } from 'lucide-react';
import type { ThemePref } from './theme';

const OPTIONS = [
  { value: 'system', label: '跟随系统', Icon: Monitor },
  { value: 'light', label: '浅色', Icon: Sun },
  { value: 'dark', label: '深色', Icon: Moon },
] as const;

interface ThemeSwitchProps {
  pref: ThemePref;
  onChange: (pref: ThemePref) => void;
}

export function ThemeSwitch({ pref, onChange }: ThemeSwitchProps) {
  return (
    <div className="segmented" role="group" aria-label="主题">
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
