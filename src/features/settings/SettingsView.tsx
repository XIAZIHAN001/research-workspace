import { BookOpen, Bot, LayoutDashboard, Palette, UserRound } from 'lucide-react';
import { AppearancePanel } from './AppearancePanel';
import { AiSettingsPanel } from './AiSettingsPanel';
import { LayoutPanel } from './LayoutPanel';
import { ReadingPrefsPanel } from './ReadingPrefsPanel';
import { ProfilePanel } from './ProfilePanel';
import type { useAvatar } from '../home/useAvatar';
import type { PaperModeController } from '../reader/usePaperMode';
import type { Density, UiFont } from '../theme/appearancePrefs';
import type { DarkLevel, ThemePref } from '../theme/theme';
import type { LayoutPreset } from '../../app/layoutPrefs';

export type SettingsSection = 'profile' | 'appearance' | 'reading' | 'layout' | 'ai';

interface SettingsViewProps {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  pref: ThemePref;
  level: DarkLevel;
  onChangePref: (pref: ThemePref) => void;
  onChangeLevel: (level: DarkLevel) => void;
  density: Density;
  uiFont: UiFont;
  onChangeDensity: (density: Density) => void;
  onChangeUiFont: (font: UiFont) => void;
  /** The lifted paper preference, shared with the reader's toolbar. */
  paperMode: PaperModeController;
  layoutPreset: LayoutPreset;
  /** Applies the preset to storage and to the live layout. */
  onChangeLayoutPreset: (preset: LayoutPreset) => void;
  sidebarWidth: number;
  onSidebarWidth: (width: number) => void;
  avatar: ReturnType<typeof useAvatar>;
  profileName: string;
  /** Stores the nickname and returns what is displayed after trimming. */
  onProfileName: (raw: string) => string;
  stats: { papers: number; notes: number; concepts: number };
}

const SECTIONS = [
  { value: 'profile', label: '个人', Icon: UserRound },
  { value: 'appearance', label: '外观', Icon: Palette },
  { value: 'reading', label: '阅读偏好', Icon: BookOpen },
  { value: 'layout', label: '工作区布局', Icon: LayoutDashboard },
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
  density,
  uiFont,
  onChangeDensity,
  onChangeUiFont,
  paperMode,
  layoutPreset,
  onChangeLayoutPreset,
  sidebarWidth,
  onSidebarWidth,
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
            density={density}
            uiFont={uiFont}
            onChangeDensity={onChangeDensity}
            onChangeUiFont={onChangeUiFont}
          />
        ) : section === 'reading' ? (
          <ReadingPrefsPanel paperMode={paperMode} />
        ) : section === 'layout' ? (
          <LayoutPanel
            preset={layoutPreset}
            onChangePreset={onChangeLayoutPreset}
            sidebarWidth={sidebarWidth}
            onSidebarWidth={onSidebarWidth}
          />
        ) : section === 'ai' ? (
          <AiSettingsPanel />
        ) : (
          <ProfilePanel name={profileName} onName={onProfileName} stats={stats} avatar={avatar} />
        )}
      </div>
    </section>
  );
}
