import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  DENSITY_STORAGE_KEY,
  LAYOUT_PRESET_STORAGE_KEY,
  PANEL_WIDTH_STORAGE_KEY,
  SIDEBAR_STORAGE_KEY,
  SIDEBAR_WIDTH_STORAGE_KEY,
  UI_FONT_STORAGE_KEY,
  ZOOM_DEFAULT_STORAGE_KEY,
  ZOOM_LAST_STORAGE_KEY,
  SCROLL_EDGE_STORAGE_KEY,
} from './config';
import {
  LAYOUT_CHANGE_EVENT,
  parseLayoutPreset,
  parseZoomDefault,
  readLastZoom,
  readLayoutPreset,
  readZoomDefault,
  resetLayoutDefaults,
  storeLastZoom,
} from './layoutPrefs';
import { useSidebar } from './useSidebar';

describe('layout presets', () => {
  it('rejects unknown presets and zoom strategies', () => {
    expect(parseLayoutPreset('cozy')).toBeNull();
    expect(parseLayoutPreset('research')).toBe('research');
    expect(parseZoomDefault('125')).toBeNull();
    expect(parseZoomDefault('last')).toBe('last');
  });

  it('migrates a profile that last closed the sidebar into 专注阅读', () => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, 'closed');
    expect(readLayoutPreset()).toBe('focus');
    expect(window.localStorage.getItem(LAYOUT_PRESET_STORAGE_KEY)).toBe('focus');
  });

  it('migrates every other profile into 均衡布局', () => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, 'open');
    expect(readLayoutPreset()).toBe('balanced');
  });

  it('keeps a stored preset and falls back when the stored value is unknown', () => {
    window.localStorage.setItem(LAYOUT_PRESET_STORAGE_KEY, 'research');
    expect(readLayoutPreset()).toBe('research');
    window.localStorage.setItem(LAYOUT_PRESET_STORAGE_KEY, 'wide');
    expect(readLayoutPreset()).toBe('balanced');
  });

  it('defaults the zoom strategy to fit-width and honours a stored one', () => {
    expect(readZoomDefault()).toBe('fit-width');
    window.localStorage.setItem(ZOOM_DEFAULT_STORAGE_KEY, '100');
    expect(readZoomDefault()).toBe('100');
  });

  it('keeps the last zoom in range for the "沿用上次" strategy', () => {
    storeLastZoom({ fit: false, scale: 1.75 });
    expect(readLastZoom()).toEqual({ fit: false, scale: 1.75 });
    storeLastZoom({ fit: true, scale: 99 });
    expect(readLastZoom()).toEqual({ fit: true, scale: 3 });
    storeLastZoom({ fit: true, scale: 0.01 });
    expect(readLastZoom()).toEqual({ fit: true, scale: 0.5 });
  });
});

describe('resetLayoutDefaults', () => {
  it('writes every preference key back to its default and announces it once', () => {
    window.localStorage.setItem(LAYOUT_PRESET_STORAGE_KEY, 'focus');
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '400');
    window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, '560');
    window.localStorage.setItem(DENSITY_STORAGE_KEY, 'compact');
    window.localStorage.setItem(UI_FONT_STORAGE_KEY, 'large');
    window.localStorage.setItem(SCROLL_EDGE_STORAGE_KEY, 'off');
    window.localStorage.setItem(ZOOM_DEFAULT_STORAGE_KEY, '100');
    const events: CustomEvent[] = [];
    window.addEventListener(LAYOUT_CHANGE_EVENT, (event) => {
      events.push(event as CustomEvent);
    });

    resetLayoutDefaults();

    expect(window.localStorage.getItem(LAYOUT_PRESET_STORAGE_KEY)).toBe('balanced');
    expect(Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))).toBe(224);
    // The legacy open/closed key is no longer written by this build; the preset owns that.
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBeNull();
    expect(Number(window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY))).toBe(360);
    expect(window.localStorage.getItem(DENSITY_STORAGE_KEY)).toBe('standard');
    expect(window.localStorage.getItem(UI_FONT_STORAGE_KEY)).toBe('default');
    expect(window.localStorage.getItem(SCROLL_EDGE_STORAGE_KEY)).toBe('soft');
    expect(window.localStorage.getItem(ZOOM_DEFAULT_STORAGE_KEY)).toBe('fit-width');
    expect(JSON.parse(window.localStorage.getItem(ZOOM_LAST_STORAGE_KEY) ?? '{}')).toEqual({
      fit: true,
      scale: 1,
    });
    expect(events).toHaveLength(1);
    expect((events[0] as CustomEvent | undefined)?.detail).toMatchObject({ reset: true });
  });

  it('never writes the workspace data keys', () => {
    window.localStorage.setItem('rw.projects', '{"kept":true}');
    resetLayoutDefaults();
    expect(window.localStorage.getItem('rw.projects')).toBe('{"kept":true}');
  });
});

describe('useSidebar', () => {
  it('starts open under the default preset and clamps a width set from Settings', () => {
    const { result } = renderHook(() => useSidebar());
    expect(result.current.open).toBe(true);
    act(() => {
      result.current.setWidth(9999);
    });
    expect(result.current.width).toBe(420);
    act(() => {
      result.current.setWidth(1);
    });
    expect(result.current.width).toBe(200);
  });

  it('starts collapsed when the migrated preset is 专注阅读', () => {
    window.localStorage.setItem(LAYOUT_PRESET_STORAGE_KEY, 'focus');
    const { result } = renderHook(() => useSidebar());
    expect(result.current.open).toBe(false);
  });
});
