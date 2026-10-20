import { Bot, Palette } from 'lucide-react';
import { AppearancePanel } from './AppearancePanel';
import { AiSettingsPanel } from './AiSettingsPanel';
import type { useAvatar } from '../home/useAvatar';
import type { DarkLevel, ThemePref } from '../theme/theme';

export type SettingsSection = 'appearance' | 'ai';

interface SettingsViewProps {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  pref: ThemePref;
  level: DarkLevel;
  onChangePref: (pref: ThemePref) => void;
  onChangeLevel: (level: DarkLevel) => void;
  avatar: ReturnType<typeof useAvatar>;
}

const SECTIONS = [
  { value: 'appearance', label: '外观', Icon: Palette },
  { value: 'ai', label: 'AI 服务', Icon: Bot },
] as const;

/** A full settings page: category list on the left, one compact panel on the right. */
export function SettingsView({
  section,
  onSection,
  pref,
  level,
  onChangePref,
  onChangeLevel,
  avatar,
}: SettingsViewProps) {
  return (
    <section className="settings" aria-label="设置">
      <nav className="settings-nav" aria-label="设置分类">
        {SECTIONS.map(({ value, label, Icon }) => (
          <button
            key={value}
            type="button"
            className="settings-nav-item"
            aria-current={section === value ? 'page' : undefined}
            onClick={() => {
              onSection(value);
            }}
          >
            <Icon size={15} aria-hidden="true" />
            {label}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {section === 'appearance' ? (
          <AppearancePanel
            pref={pref}
            level={level}
            onChangePref={onChangePref}
            onChangeLevel={onChangeLevel}
            avatar={avatar}
          />
        ) : (
          <AiSettingsPanel />
        )}
      </div>
    </section>
  );
}
