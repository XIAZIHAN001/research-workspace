import { Bot, Palette, UserRound } from 'lucide-react';
import { AppearancePanel } from './AppearancePanel';
import { AiSettingsPanel } from './AiSettingsPanel';
import { ProfilePanel } from './ProfilePanel';
import type { useAvatar } from '../home/useAvatar';
import type { DarkLevel, ThemePref } from '../theme/theme';

export type SettingsSection = 'profile' | 'appearance' | 'ai';

interface SettingsViewProps {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  pref: ThemePref;
  level: DarkLevel;
  onChangePref: (pref: ThemePref) => void;
  onChangeLevel: (level: DarkLevel) => void;
  avatar: ReturnType<typeof useAvatar>;
  profileName: string;
  /** Stores the nickname and returns what is displayed after trimming. */
  onProfileName: (raw: string) => string;
  stats: { papers: number; notes: number; concepts: number };
}

const SECTIONS = [
  { value: 'profile', label: '个人', Icon: UserRound },
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
  profileName,
  onProfileName,
  stats,
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
        ) : section === 'ai' ? (
          <AiSettingsPanel />
        ) : (
          <ProfilePanel name={profileName} onName={onProfileName} stats={stats} />
        )}
      </div>
    </section>
  );
}
