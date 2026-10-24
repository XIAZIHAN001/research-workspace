import { useEffect, useState } from 'react';
import { readItem, writeItem } from '../../services/storage';
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_WIDTH_STORAGE_KEY,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '../../app/config';
import {
  LAYOUT_CHANGE_EVENT,
  LAYOUT_PRESETS,
  LAYOUT_PRESET_HINT,
  LAYOUT_PRESET_LABEL,
  announceLayoutChange,
  resetLayoutDefaults,
  type LayoutChangeDetail,
  type LayoutPreset,
} from '../../app/layoutPrefs';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { TextSegments } from './PrefSegments';

interface LayoutPanelProps {
  preset: LayoutPreset;
  /** Applies the preset and arranges the live layout with it (the sidebar, then the reader). */
  onChangePreset: (preset: LayoutPreset) => void;
  sidebarWidth: number;
  onSidebarWidth: (width: number) => void;
}

function clampPanelWidth(value: number): number {
  return Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(value)));
}

function readPanelWidth(): number {
  const stored = Number(readItem(PANEL_WIDTH_STORAGE_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampPanelWidth(stored) : PANEL_DEFAULT_WIDTH;
}

function WidthSlider({
  label,
  hint,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  min: number;
  max: number;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <h3 className="settings-row-title">{label}</h3>
        <p className="settings-row-hint">{hint}</p>
      </div>
      <div className="settings-slider">
        <label className="theme-level">
          <span className="sr-only">{label}</span>
          <input
            className="theme-level__range"
            type="range"
            min={min}
            max={max}
            step={4}
            value={value}
            aria-label={label}
            aria-valuetext={`${String(value)} 像素`}
            onChange={(event) => {
              onChange(Number(event.target.value));
            }}
          />
          <span className="theme-level__value" aria-hidden="true">
            {value}
          </span>
        </label>
      </div>
    </div>
  );
}

/**
 * Settings › 工作区布局: the startup preset, the two column widths, and the way back.
 *
 * The width sliders drive the live layout — the sidebar through the app's own sidebar state,
 * the reader's panel through a layout-change announcement the reader listens for. Nothing here
 * writes workspace data; 恢复默认布局 touches preference keys only.
 */
export function LayoutPanel({
  preset,
  onChangePreset,
  sidebarWidth,
  onSidebarWidth,
}: LayoutPanelProps) {
  const [panelWidth, setPanelWidth] = useState(readPanelWidth);
  const [resetOpen, setResetOpen] = useState(false);
  // "恢复默认布局" happens elsewhere (or in another surface); keep the slider honest.
  useEffect(() => {
    const onLayoutChange = (event: Event): void => {
      const detail = (event as CustomEvent<LayoutChangeDetail>).detail ?? {};
      if (detail.reset === true) setPanelWidth(PANEL_DEFAULT_WIDTH);
    };
    window.addEventListener(LAYOUT_CHANGE_EVENT, onLayoutChange);
    return () => {
      window.removeEventListener(LAYOUT_CHANGE_EVENT, onLayoutChange);
    };
  }, []);

  const setPanelWidthLive = (next: number): void => {
    const clamped = clampPanelWidth(next);
    setPanelWidth(clamped);
    writeItem(PANEL_WIDTH_STORAGE_KEY, String(clamped));
    announceLayoutChange({ panelWidth: clamped });
  };

  return (
    <section className="settings-panel" aria-labelledby="layout-title">
      <header className="settings-panel-head">
        <h2 id="layout-title">工作区布局</h2>
        <p className="settings-panel-hint">
          预设决定应用启动时的布局；拖动分隔条或这里的滑块随时可以再调。
        </p>
      </header>

      <div className="settings-section">
        <div className="settings-row">
          <div className="settings-row-text">
            <h3 className="settings-row-title">布局预设</h3>
            <p className="settings-row-hint">{LAYOUT_PRESET_HINT[preset]}</p>
          </div>
          <TextSegments
            value={preset}
            values={LAYOUT_PRESETS}
            labels={LAYOUT_PRESET_LABEL}
            label="布局预设"
            onChange={onChangePreset}
          />
        </div>

        <WidthSlider
          label="项目导航宽度"
          hint="左侧导航栏的宽度，拖动侧栏分隔条得到的结果就是同一个值。"
          min={SIDEBAR_MIN_WIDTH}
          max={SIDEBAR_MAX_WIDTH}
          value={sidebarWidth}
          onChange={onSidebarWidth}
        />

        <WidthSlider
          label="内容面板宽度"
          hint="阅读器右侧面板的宽度；窄窗口下面板会自动改为浮层。"
          min={PANEL_MIN_WIDTH}
          max={PANEL_MAX_WIDTH}
          value={panelWidth}
          onChange={setPanelWidthLive}
        />

        <div className="settings-row">
          <div className="settings-row-text">
            <h3 className="settings-row-title">恢复默认布局</h3>
            <p className="settings-row-hint">
              布局预设、两栏宽度、密度、字号和默认缩放都会回到默认值。
            </p>
          </div>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              setResetOpen(true);
            }}
          >
            恢复默认
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={resetOpen}
        title="恢复默认布局？"
        confirmLabel="恢复默认"
        onConfirm={resetLayoutDefaults}
        onClose={() => {
          setResetOpen(false);
        }}
      >
        <p>
          布局预设、侧栏与面板宽度、界面密度、界面字号和默认缩放将回到默认值。论文、笔记、标注和知识不会受任何影响。
        </p>
      </ConfirmDialog>
    </section>
  );
}
