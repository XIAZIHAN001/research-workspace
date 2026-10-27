import { readItem, writeItem } from '../services/storage';
import {
  DENSITY_STORAGE_KEY,
  LAYOUT_PRESET_STORAGE_KEY,
  PANEL_DEFAULT_WIDTH,
  PANEL_WIDTH_STORAGE_KEY,
  SCROLL_EDGE_STORAGE_KEY,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_STORAGE_KEY,
  SIDEBAR_WIDTH_STORAGE_KEY,
  UI_FONT_STORAGE_KEY,
  ZOOM_DEFAULT_STORAGE_KEY,
  ZOOM_LAST_STORAGE_KEY,
} from './config';
import type { Density, ScrollEdge, UiFont } from '../features/theme/appearancePrefs';

/**
 * The three workspace layouts. A preset is the layout the app *starts* in — the sidebar and
 * the reader's side panel are arranged from it on launch, and choosing one applies it on the
 * spot. Dragging widths or toggling panels during a session stays free; nothing a preset does
 * forbids further adjustment.
 */
export type LayoutPreset = 'focus' | 'balanced' | 'research';

export const LAYOUT_PRESETS: readonly LayoutPreset[] = ['focus', 'balanced', 'research'];

export const LAYOUT_PRESET_LABEL: Record<LayoutPreset, string> = {
  focus: '专注阅读',
  balanced: '均衡布局',
  research: '研究模式',
};

export const LAYOUT_PRESET_HINT: Record<LayoutPreset, string> = {
  focus: '启动时收起项目导航和内容面板，把窗口留给论文。',
  balanced: '启动时显示项目导航，内容面板按需打开。',
  research: '启动时同时打开项目导航和内容面板。',
};

/** How the reader picks its initial zoom when a paper opens. */
export type ZoomDefault = 'fit-width' | '100' | 'last';

export const ZOOM_DEFAULTS: readonly ZoomDefault[] = ['fit-width', '100', 'last'];

export const ZOOM_DEFAULT_LABEL: Record<ZoomDefault, string> = {
  'fit-width': '适应宽度',
  '100': '固定 100%',
  last: '沿用上次',
};

function oneOf<T extends string>(values: readonly T[], raw: unknown): T | null {
  return typeof raw === 'string' && (values as readonly string[]).includes(raw) ? (raw as T) : null;
}

export function parseLayoutPreset(raw: unknown): LayoutPreset | null {
  return oneOf(LAYOUT_PRESETS, raw);
}

export function parseZoomDefault(raw: unknown): ZoomDefault | null {
  return oneOf(ZOOM_DEFAULTS, raw);
}

/**
 * Reads the stored preset, migrating profiles that predate it.
 *
 * The legacy `rw.sidebar` open/closed switch becomes the preset: a profile last seen with the
 * sidebar closed starts in 专注阅读, any other profile in 均衡布局. Either way the stored value
 * is rewritten as a preset once, so the migration is idempotent and the settings page shows
 * the layout that was already in effect.
 */
export function readLayoutPreset(): LayoutPreset {
  const stored = readItem(LAYOUT_PRESET_STORAGE_KEY);
  if (stored !== null) return parseLayoutPreset(stored) ?? 'balanced';
  const legacyOpen = readItem(SIDEBAR_STORAGE_KEY);
  const preset: LayoutPreset = legacyOpen === 'closed' ? 'focus' : 'balanced';
  writeItem(LAYOUT_PRESET_STORAGE_KEY, preset);
  return preset;
}

export function storeLayoutPreset(preset: LayoutPreset): void {
  writeItem(LAYOUT_PRESET_STORAGE_KEY, preset);
}

export function readZoomDefault(): ZoomDefault {
  return parseZoomDefault(readItem(ZOOM_DEFAULT_STORAGE_KEY)) ?? 'fit-width';
}

export function storeZoomDefault(value: ZoomDefault): void {
  writeItem(ZOOM_DEFAULT_STORAGE_KEY, value);
}

/** The zoom the reader used last, kept for the "沿用上次" strategy. */
export function readLastZoom(): { fit: boolean; scale: number } | null {
  const raw = readItem(ZOOM_LAST_STORAGE_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { fit?: unknown }).fit !== 'boolean' ||
      typeof (parsed as { scale?: unknown }).scale !== 'number'
    ) {
      return null;
    }
    const { fit, scale } = parsed as { fit: boolean; scale: number };
    return { fit, scale: Math.min(3, Math.max(0.5, scale)) };
  } catch {
    return null;
  }
}

export function storeLastZoom(zoom: { fit: boolean; scale: number }): void {
  writeItem(ZOOM_LAST_STORAGE_KEY, JSON.stringify(zoom));
}

/** Fired on `window` when a preference changed in place and live surfaces should follow. */
export const LAYOUT_CHANGE_EVENT = 'rw:layout-change';

export interface LayoutChangeDetail {
  /** A new width for the reader's side panel, already in range. */
  panelWidth?: number;
  /** Every layout and appearance preference was restored to its default. */
  reset?: boolean;
}

export function announceLayoutChange(detail: LayoutChangeDetail): void {
  window.dispatchEvent(new CustomEvent<LayoutChangeDetail>(LAYOUT_CHANGE_EVENT, { detail }));
}

/**
 * Restores every layout and appearance preference to its designed default.
 *
 * Only preference keys are written. The workspace data keys — projects, papers, annotations,
 * bookmarks, knowledge — are never touched, and neither is the paper's reading position.
 */
export function resetLayoutDefaults(): void {
  writeItem(LAYOUT_PRESET_STORAGE_KEY, 'balanced');
  writeItem(SIDEBAR_WIDTH_STORAGE_KEY, String(SIDEBAR_DEFAULT_WIDTH));
  writeItem(PANEL_WIDTH_STORAGE_KEY, String(PANEL_DEFAULT_WIDTH));
  writeItem(DENSITY_STORAGE_KEY, 'standard' satisfies Density);
  writeItem(UI_FONT_STORAGE_KEY, 'default' satisfies UiFont);
  writeItem(SCROLL_EDGE_STORAGE_KEY, 'soft' satisfies ScrollEdge);
  writeItem(ZOOM_DEFAULT_STORAGE_KEY, 'fit-width');
  writeItem(ZOOM_LAST_STORAGE_KEY, JSON.stringify({ fit: true, scale: 1 }));
  announceLayoutChange({ reset: true });
}
