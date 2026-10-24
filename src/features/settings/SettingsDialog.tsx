import { Dialog } from '../../ui/Dialog';
import type { useAvatar } from '../home/useAvatar';
import type { PaperModeController } from '../reader/usePaperMode';
import type { LayoutPreset } from '../../app/layoutPrefs';
import type { Density, UiFont } from '../theme/appearancePrefs';
import type { DarkLevel, ThemePref } from '../theme/theme';
import { SettingsView, type SettingsSection } from './SettingsView';

interface SettingsDialogProps {
  open: boolean;
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onClose: () => void;
  pref: ThemePref;
  level: DarkLevel;
  onChangePref: (pref: ThemePref) => void;
  onChangeLevel: (level: DarkLevel) => void;
  density: Density;
  uiFont: UiFont;
  onChangeDensity: (density: Density) => void;
  onChangeUiFont: (font: UiFont) => void;
  paperMode: PaperModeController;
  layoutPreset: LayoutPreset;
  onChangeLayoutPreset: (preset: LayoutPreset) => void;
  sidebarWidth: number;
  onSidebarWidth: (width: number) => void;
  avatar: ReturnType<typeof useAvatar>;
  profileName: string;
  onProfileName: (raw: string) => string;
  stats: { papers: number; notes: number; concepts: number };
}

/**
 * Settings as a large floating window. It keeps the reading surface mounted underneath, so
 * changing the theme while a paper is open does not close the reader or lose its position.
 */
export function SettingsDialog(props: SettingsDialogProps) {
  return (
    <Dialog open={props.open} title="设置" onClose={props.onClose}>
      <SettingsView
        section={props.section}
        onSection={props.onSection}
        pref={props.pref}
        level={props.level}
        onChangePref={props.onChangePref}
        onChangeLevel={props.onChangeLevel}
        density={props.density}
        uiFont={props.uiFont}
        onChangeDensity={props.onChangeDensity}
        onChangeUiFont={props.onChangeUiFont}
        paperMode={props.paperMode}
        layoutPreset={props.layoutPreset}
        onChangeLayoutPreset={props.onChangeLayoutPreset}
        sidebarWidth={props.sidebarWidth}
        onSidebarWidth={props.onSidebarWidth}
        avatar={props.avatar}
        profileName={props.profileName}
        onProfileName={props.onProfileName}
        stats={props.stats}
      />
    </Dialog>
  );
}
