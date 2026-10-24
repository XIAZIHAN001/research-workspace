import { describe, expect, it } from 'vitest';
import { DENSITY_STORAGE_KEY, UI_FONT_STORAGE_KEY } from '../../app/config';
import {
  applyDensity,
  applyUiFont,
  parseDensity,
  readDensity,
  readUiFont,
} from './appearancePrefs';

describe('appearance preferences', () => {
  it('accepts only the three density values', () => {
    expect(parseDensity('compact')).toBe('compact');
    expect(parseDensity('cosy')).toBeNull();
    expect(parseDensity(null)).toBeNull();
    expect(parseDensity(2)).toBeNull();
  });

  it('falls back to the standard density when the key is absent or invalid', () => {
    expect(readDensity()).toBe('standard');
    window.localStorage.setItem(DENSITY_STORAGE_KEY, 'huge');
    expect(readDensity()).toBe('standard');
    window.localStorage.setItem(DENSITY_STORAGE_KEY, 'comfortable');
    expect(readDensity()).toBe('comfortable');
  });

  it('falls back to the default UI font when the key is absent or invalid', () => {
    expect(readUiFont()).toBe('default');
    window.localStorage.setItem(UI_FONT_STORAGE_KEY, 'giant');
    expect(readUiFont()).toBe('default');
    window.localStorage.setItem(UI_FONT_STORAGE_KEY, 'larger');
    expect(readUiFont()).toBe('larger');
  });

  it('applies the choice to the document element as a data attribute', () => {
    applyDensity(document.documentElement, 'compact');
    applyUiFont(document.documentElement, 'large');
    expect(document.documentElement).toHaveAttribute('data-density', 'compact');
    expect(document.documentElement).toHaveAttribute('data-ui-font', 'large');
    delete document.documentElement.dataset.density;
    delete document.documentElement.dataset.uiFont;
  });
});
