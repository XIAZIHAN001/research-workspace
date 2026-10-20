import { Dialog } from '../../ui/Dialog';
import type { useAvatar } from '../home/useAvatar';
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
  avatar: ReturnType<typeof useAvatar>;
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
        avatar={props.avatar}
      />
    </Dialog>
  );
}
