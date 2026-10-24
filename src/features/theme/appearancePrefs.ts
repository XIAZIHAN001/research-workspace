import { readItem, writeItem } from '../../services/storage';
import { DENSITY_STORAGE_KEY, UI_FONT_STORAGE_KEY } from '../../app/config';

/** How dense the interface is. `standard` is the designed default. */
export type Density = 'compact' | 'standard' | 'comfortable';
/** The UI text size step. It never reaches the PDF pages themselves. */
export type UiFont = 'default' | 'large' | 'larger';

export const DENSITIES: readonly Density[] = ['compact', 'standard', 'comfortable'];
export const UI_FONTS: readonly UiFont[] = ['default', 'large', 'larger'];

export const DENSITY_LABEL: Record<Density, string> = {
  compact: '紧凑',
  standard: '标准',
  comfortable: '舒适',
};

export const UI_FONT_LABEL: Record<UiFont, string> = {
  default: '默认',
  large: '大',
  larger: '更大',
};

function oneOf<T extends string>(values: readonly T[], raw: unknown): T | null {
  return typeof raw === 'string' && (values as readonly string[]).includes(raw) ? (raw as T) : null;
}

/** A stored value from an older build (or a hand-edited one) falls back to the default. */
export function parseDensity(raw: unknown): Density | null {
  return oneOf(DENSITIES, raw);
}

export function parseUiFont(raw: unknown): UiFont | null {
  return oneOf(UI_FONTS, raw);
}

export function readDensity(): Density {
  return parseDensity(readItem(DENSITY_STORAGE_KEY)) ?? 'standard';
}

export function readUiFont(): UiFont {
  return parseUiFont(readItem(UI_FONT_STORAGE_KEY)) ?? 'default';
}

export function storeDensity(density: Density): void {
  writeItem(DENSITY_STORAGE_KEY, density);
}

export function storeUiFont(font: UiFont): void {
  writeItem(UI_FONT_STORAGE_KEY, font);
}

/**
 * Writes the choice onto `<html>` as a data attribute, where tokens.css re-tunes the UI
 * spacing, control-height and type tokens. Applied to the document element, like the theme.
 */
export function applyDensity(root: HTMLElement, density: Density): void {
  root.dataset.density = density;
}

export function applyUiFont(root: HTMLElement, font: UiFont): void {
  root.dataset.uiFont = font;
}
