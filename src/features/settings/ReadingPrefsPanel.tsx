import { useState } from 'react';
import {
  ZOOM_DEFAULTS,
  ZOOM_DEFAULT_LABEL,
  readZoomDefault,
  storeZoomDefault,
  type ZoomDefault,
} from '../../app/layoutPrefs';
import { PaperModeSwitch } from '../reader/PaperModeSwitch';
import type { PaperModeController } from '../reader/usePaperMode';
import { TextSegments } from './PrefSegments';

interface ReadingPrefsPanelProps {
  /** The lifted paper preference, shared with the reader's toolbar so the two never diverge. */
  paperMode: PaperModeController;
}

/**
 * Settings › 阅读偏好: how the pages themselves are drawn, and how a paper opens.
 *
 * The paper mode is the very same controller the toolbar uses, so choosing here and choosing
 * above the page are one state, not two that drift apart. The default zoom applies when a
 * paper opens; it never reaches a session that is already reading.
 */
export function ReadingPrefsPanel({ paperMode }: ReadingPrefsPanelProps) {
  const [zoomDefault, setZoomDefault] = useState<ZoomDefault>(() => readZoomDefault());

  return (
    <section className="settings-panel" aria-labelledby="reading-title">
      <header className="settings-panel-head">
        <h2 id="reading-title">阅读偏好</h2>
        <p className="settings-panel-hint">
          这里只调整论文页面的呈现方式；版面坐标、文字提取和标注锚点不受任何一项影响。
        </p>
      </header>

      <div className="settings-section">
        <div className="settings-row">
          <div className="settings-row-text">
            <h3 className="settings-row-title">纸张模式</h3>
            <p className="settings-row-hint">跟随外观、原始、暖纸或深灰，只重绘页面颜色。</p>
          </div>
          <PaperModeSwitch pref={paperMode.pref} onChange={paperMode.setPref} />
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <h3 className="settings-row-title">默认缩放</h3>
            <p className="settings-row-hint">
              决定打开一篇论文时的起始方式，对已经在读的论文不生效。
            </p>
          </div>
          <TextSegments
            value={zoomDefault}
            values={ZOOM_DEFAULTS}
            labels={ZOOM_DEFAULT_LABEL}
            label="默认缩放"
            onChange={(next) => {
              setZoomDefault(next);
              storeZoomDefault(next);
            }}
          />
        </div>
      </div>
    </section>
  );
}
