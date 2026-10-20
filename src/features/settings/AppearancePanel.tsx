import { AvatarPicker } from '../home/AvatarPicker';
import type { useAvatar } from '../home/useAvatar';
import { DarkLevelSlider, ThemeSegments } from '../theme/ThemeSwitch';
import type { DarkLevel, ThemePref } from '../theme/theme';

interface AppearancePanelProps {
  pref: ThemePref;
  level: DarkLevel;
  onChangePref: (pref: ThemePref) => void;
  onChangeLevel: (level: DarkLevel) => void;
  avatar: ReturnType<typeof useAvatar>;
}

/** Settings › Appearance: the only place the theme preference is edited. */
export function AppearancePanel({
  pref,
  level,
  onChangePref,
  onChangeLevel,
  avatar,
}: AppearancePanelProps) {
  return (
    <section className="settings-panel" aria-labelledby="appearance-title">
      <header className="settings-panel-head">
        <h2 id="appearance-title">外观</h2>
        <p className="settings-panel-hint">
          界面使用中性灰阶。主题偏好只影响应用外壳，不改变论文页面的纸张模式。
        </p>
      </header>

      <div className="settings-section">
        <div className="settings-row">
          <div className="settings-row-text">
            <h3 className="settings-row-title">主题</h3>
            <p className="settings-row-hint">跟随系统、浅色或深色；深色使用可调的中性灰阶。</p>
          </div>
          <ThemeSegments pref={pref} onChange={onChangePref} />
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <h3 className="settings-row-title">深色程度</h3>
            <p className="settings-row-hint">
              0 为较浅的中性深灰，100 为纯黑。跟随系统切换到深色时也会使用这个值。
            </p>
          </div>
          <div className="settings-slider">
            <DarkLevelSlider level={level} onChange={onChangeLevel} />
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <h3 className="settings-row-title">头像</h3>
            <p className="settings-row-hint">
              显示在侧栏左下角。支持 PNG、JPEG、WebP 或 SVG，最大 1 MB。
            </p>
          </div>
          <AvatarPicker
            compact
            src={avatar.src}
            isCustom={avatar.isCustom}
            problem={avatar.problem}
            onUpload={avatar.upload}
            onReset={avatar.reset}
            onDismissProblem={avatar.dismiss}
          />
        </div>
      </div>
    </section>
  );
}
