import { AvatarPicker } from '../home/AvatarPicker';
import type { useAvatar } from '../home/useAvatar';
import { DENSITY_LABEL, UI_FONT_LABEL, type Density, type UiFont } from '../theme/appearancePrefs';
import { DarkLevelSlider, ThemeSegments } from '../theme/ThemeSwitch';
import type { DarkLevel, ThemePref } from '../theme/theme';

interface AppearancePanelProps {
  pref: ThemePref;
  level: DarkLevel;
  onChangePref: (pref: ThemePref) => void;
  onChangeLevel: (level: DarkLevel) => void;
  density: Density;
  uiFont: UiFont;
  onChangeDensity: (density: Density) => void;
  onChangeUiFont: (font: UiFont) => void;
  avatar: ReturnType<typeof useAvatar>;
}

/** One text-only segmented control for a three-way preference. */
function TextSegments<T extends string>({
  value,
  values,
  labels,
  label,
  onChange,
}: {
  value: T;
  values: readonly T[];
  labels: Record<T, string>;
  label: string;
  onChange: (next: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label} data-count={values.length}>
      {values.map((option) => (
        <button
          key={option}
          type="button"
          className="seg"
          aria-pressed={value === option}
          onClick={() => {
            onChange(option);
          }}
        >
          {labels[option]}
        </button>
      ))}
    </div>
  );
}

/** Settings › Appearance: theme, dark depth, interface density and UI text size. */
export function AppearancePanel({
  pref,
  level,
  onChangePref,
  onChangeLevel,
  density,
  uiFont,
  onChangeDensity,
  onChangeUiFont,
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
            <h3 className="settings-row-title">界面密度</h3>
            <p className="settings-row-hint">调整间距与控件高度，不影响论文页面。</p>
          </div>
          <TextSegments
            value={density}
            values={['compact', 'standard', 'comfortable'] as const}
            labels={DENSITY_LABEL}
            label="界面密度"
            onChange={onChangeDensity}
          />
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <h3 className="settings-row-title">界面字号</h3>
            <p className="settings-row-hint">只放大界面文字，论文页面保持原样。</p>
          </div>
          <TextSegments
            value={uiFont}
            values={['default', 'large', 'larger'] as const}
            labels={UI_FONT_LABEL}
            label="界面字号"
            onChange={onChangeUiFont}
          />
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
