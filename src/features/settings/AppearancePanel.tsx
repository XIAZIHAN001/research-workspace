import { DENSITY_LABEL, UI_FONT_LABEL, type Density, type UiFont } from '../theme/appearancePrefs';
import { DarkLevelSlider, ThemeSegments } from '../theme/ThemeSwitch';
import type { DarkLevel, ThemePref } from '../theme/theme';
import { TextSegments } from './PrefSegments';

interface AppearancePanelProps {
  pref: ThemePref;
  level: DarkLevel;
  onChangePref: (pref: ThemePref) => void;
  onChangeLevel: (level: DarkLevel) => void;
  density: Density;
  uiFont: UiFont;
  onChangeDensity: (density: Density) => void;
  onChangeUiFont: (font: UiFont) => void;
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
      </div>
    </section>
  );
}
