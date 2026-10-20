import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DARK_SCHEME_QUERY,
  THEME_LEVEL_STORAGE_KEY,
  THEME_STORAGE_KEY,
  THEME_STYLE_STORAGE_KEY,
} from '../../app/config';
import themeInitSource from '../../../public/theme-init.js?raw';
import {
  applyTheme,
  clampLevel,
  darkPalette,
  DEFAULT_DARK_LEVEL,
  LEGACY_GRAPHITE_LEVEL,
  levelPreset,
  parseThemeLevel,
  parseThemePref,
  parseThemeStyle,
  resolveTheme,
  type DarkPalette,
  type ResolvedTheme,
  type ThemePref,
} from './theme';

function channels(color: string): [number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

describe('parseThemePref', () => {
  it.each([
    { raw: 'light', expected: 'light' },
    { raw: 'dark', expected: 'dark' },
    { raw: 'system', expected: 'system' },
    { raw: null, expected: 'system' },
    { raw: '', expected: 'system' },
    { raw: 'auto', expected: 'system' },
    { raw: 'Dark', expected: 'system' },
    { raw: ' light', expected: 'system' },
    { raw: 'dark\n', expected: 'system' },
  ])('maps $raw to $expected', ({ raw, expected }) => {
    expect(parseThemePref(raw)).toBe(expected);
  });
});

describe('parseThemeStyle', () => {
  it.each([
    { raw: 'graphite', expected: 'graphite' },
    { raw: 'obsidian', expected: 'obsidian' },
    { raw: null, expected: 'graphite' },
    { raw: 'OLED', expected: 'graphite' },
  ])('maps $raw to $expected', ({ raw, expected }) => {
    expect(parseThemeStyle(raw)).toBe(expected);
  });
});

describe('clampLevel', () => {
  it.each([
    { value: 0, expected: 0 },
    { value: 25, expected: 25 },
    { value: 100, expected: 100 },
    { value: -10, expected: 0 },
    { value: 150, expected: 100 },
    { value: 50.6, expected: 51 },
    { value: 49.4, expected: 49 },
    { value: Number.NaN, expected: DEFAULT_DARK_LEVEL },
    { value: Number.POSITIVE_INFINITY, expected: DEFAULT_DARK_LEVEL },
  ])('maps $value to $expected', ({ value, expected }) => {
    expect(clampLevel(value)).toBe(expected);
  });
});

describe('parseThemeLevel', () => {
  it.each([
    { raw: '0', style: null, expected: 0 },
    { raw: '25', style: null, expected: 25 },
    { raw: '50', style: null, expected: 50 },
    { raw: '75', style: null, expected: 75 },
    { raw: '100', style: null, expected: 100 },
    { raw: ' 40 ', style: null, expected: 40 },
    { raw: '-10', style: null, expected: 0 },
    { raw: '150', style: null, expected: 100 },
    { raw: '50.6', style: null, expected: 51 },
    { raw: null, style: null, expected: DEFAULT_DARK_LEVEL },
    { raw: '', style: null, expected: DEFAULT_DARK_LEVEL },
    { raw: 'not-a-number', style: null, expected: DEFAULT_DARK_LEVEL },
    { raw: null, style: 'obsidian', expected: 100 },
    { raw: null, style: 'graphite', expected: LEGACY_GRAPHITE_LEVEL },
    { raw: 'not-a-number', style: 'obsidian', expected: 100 },
    { raw: 'not-a-number', style: 'graphite', expected: LEGACY_GRAPHITE_LEVEL },
    { raw: '40', style: 'obsidian', expected: 40 },
    { raw: '40', style: 'graphite', expected: 40 },
  ])('maps level=$raw and style=$style to $expected', ({ raw, style, expected }) => {
    expect(parseThemeLevel(raw, style)).toBe(expected);
  });
});

describe('levelPreset', () => {
  it.each([
    { level: 0, expected: 'graphite' },
    { level: 99, expected: 'graphite' },
    { level: 100, expected: 'obsidian' },
  ] as const)('maps level $level to $expected', ({ level, expected }) => {
    expect(levelPreset(level)).toBe(expected);
  });
});

describe('resolveTheme', () => {
  it.each([
    { pref: 'system', systemDark: true, expected: 'dark' },
    { pref: 'system', systemDark: false, expected: 'light' },
    { pref: 'light', systemDark: true, expected: 'light' },
    { pref: 'light', systemDark: false, expected: 'light' },
    { pref: 'dark', systemDark: true, expected: 'dark' },
    { pref: 'dark', systemDark: false, expected: 'dark' },
  ] as const)(
    'resolves $pref to $expected when the system is dark: $systemDark',
    ({ pref, systemDark, expected }) => {
      expect(resolveTheme(pref, systemDark)).toBe(expected);
    },
  );
});

describe('darkPalette', () => {
  const expected: Record<number, DarkPalette> = {
    0: {
      app: '#242424',
      sidebar: '#2c2c2c',
      panel: '#313131',
      elevated: '#3c3c3c',
      border: '#4a4a4a',
      hairline: '#3e3e3e',
    },
    25: {
      app: '#1b1b1b',
      sidebar: '#232323',
      panel: '#282828',
      elevated: '#333333',
      border: '#414141',
      hairline: '#353535',
    },
    50: {
      app: '#121212',
      sidebar: '#1a1a1a',
      panel: '#1f1f1f',
      elevated: '#2a2a2a',
      border: '#383838',
      hairline: '#2c2c2c',
    },
    75: {
      app: '#090909',
      sidebar: '#111111',
      panel: '#161616',
      elevated: '#212121',
      border: '#2f2f2f',
      hairline: '#232323',
    },
    100: {
      app: '#000000',
      sidebar: '#080808',
      panel: '#0d0d0d',
      elevated: '#181818',
      border: '#262626',
      hairline: '#1a1a1a',
    },
  };

  it.each([0, 25, 50, 75, 100])('produces the neutral ladder at level %i', (level) => {
    const palette = darkPalette(level);
    expect(palette).toStrictEqual(expected[level]);
    for (const value of Object.values(palette)) {
      const [red, green, blue] = channels(value);
      expect([red, green, blue]).toStrictEqual([red, red, red]);
    }
  });

  it('gets darker monotonically and always separates its layers', () => {
    let previous = 256;
    for (let level = 0; level <= 100; level += 5) {
      const palette = darkPalette(level);
      const [app] = channels(palette.app);
      expect(app).toBeLessThanOrEqual(previous);
      previous = app;
      expect(channels(palette.sidebar)[0]).toBeGreaterThan(channels(palette.app)[0]);
      expect(channels(palette.panel)[0]).toBeGreaterThan(channels(palette.sidebar)[0]);
      expect(channels(palette.elevated)[0]).toBeGreaterThan(channels(palette.panel)[0]);
    }
  });

  it('accepts the same out-of-range values as clampLevel', () => {
    expect(darkPalette(-50)).toStrictEqual(darkPalette(0));
    expect(darkPalette(180)).toStrictEqual(darkPalette(100));
  });
});

describe('applyTheme', () => {
  it('sets the dataset and the neutral surface properties', () => {
    const root = document.createElement('div');
    applyTheme(root, 'dark', 'dark', 50);
    expect(root.dataset.theme).toBe('dark');
    expect(root.dataset.themePref).toBe('dark');
    expect(root.dataset.themeStyle).toBe('graphite');
    expect(root.dataset.darkLevel).toBe('50');
    expect(root.style.getPropertyValue('--dark-level')).toBe('50');
    expect(root.style.getPropertyValue('--dark-app')).toBe('#121212');
    expect(root.style.getPropertyValue('--dark-sidebar')).toBe('#1a1a1a');
    expect(root.style.getPropertyValue('--dark-panel')).toBe('#1f1f1f');
    expect(root.style.getPropertyValue('--dark-elevated')).toBe('#2a2a2a');
    expect(root.style.getPropertyValue('--dark-border')).toBe('#383838');
    expect(root.style.getPropertyValue('--dark-hairline')).toBe('#2c2c2c');
  });

  it('derives the Obsidian preset only at pure black', () => {
    const root = document.createElement('div');
    applyTheme(root, 'dark', 'dark', 100);
    expect(root.dataset.themeStyle).toBe('obsidian');
    applyTheme(root, 'dark', 'dark', 99);
    expect(root.dataset.themeStyle).toBe('graphite');
  });

  it('clamps the level it stores', () => {
    const root = document.createElement('div');
    applyTheme(root, 'dark', 'dark', 150);
    expect(root.dataset.darkLevel).toBe('100');
    applyTheme(root, 'dark', 'dark', -5);
    expect(root.dataset.darkLevel).toBe('0');
    expect(root.style.getPropertyValue('--dark-app')).toBe('#242424');
  });

  it('keeps the dark surfaces available in light mode for an instant switch', () => {
    const root = document.createElement('div');
    applyTheme(root, 'light', 'light', 25);
    expect(root.dataset.theme).toBe('light');
    expect(root.style.getPropertyValue('--dark-app')).toBe('#1b1b1b');
  });

  it('sets only the expected attributes and properties', () => {
    const root = document.createElement('div');
    applyTheme(root, 'system', 'light', 100);
    expect(root.getAttributeNames().sort()).toStrictEqual([
      'data-dark-level',
      'data-theme',
      'data-theme-pref',
      'data-theme-style',
      'style',
    ]);
  });

  it('replaces the values written by an earlier call', () => {
    const root = document.createElement('div');
    applyTheme(root, 'system', 'light', 0);
    applyTheme(root, 'dark', 'dark', 100);
    expect(root.dataset.theme).toBe('dark');
    expect(root.dataset.themePref).toBe('dark');
    expect(root.dataset.darkLevel).toBe('100');
    expect(root.style.getPropertyValue('--dark-app')).toBe('#000000');
  });

  it('leaves unrelated attributes alone', () => {
    const root = document.createElement('div');
    root.id = 'app';
    root.className = 'shell';
    applyTheme(root, 'dark', 'dark', 100);
    expect(root.id).toBe('app');
    expect(root.className).toBe('shell');
  });
});

describe('public/theme-init.js', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.themePref;
    delete document.documentElement.dataset.themeStyle;
    delete document.documentElement.dataset.darkLevel;
    document.documentElement.removeAttribute('style');
    window.localStorage.clear();
  });

  function runThemeInit(
    storedPref: string | null,
    storedStyle: string | null,
    storedLevel: string | null,
    systemDark: boolean,
  ) {
    if (storedPref !== null) window.localStorage.setItem(THEME_STORAGE_KEY, storedPref);
    if (storedStyle !== null) window.localStorage.setItem(THEME_STYLE_STORAGE_KEY, storedStyle);
    if (storedLevel !== null) window.localStorage.setItem(THEME_LEVEL_STORAGE_KEY, storedLevel);
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: systemDark && query === DARK_SCHEME_QUERY,
    }));
    new Function(themeInitSource)();
    const root = document.documentElement;
    const { theme, themePref, themeStyle, darkLevel } = root.dataset;
    return {
      theme,
      pref: themePref,
      style: themeStyle,
      level: darkLevel,
      app: root.style.getPropertyValue('--dark-app'),
      panel: root.style.getPropertyValue('--dark-panel'),
    };
  }

  it('reads the same storage keys and media query as the TypeScript side', () => {
    expect(themeInitSource).toContain(`'${THEME_STORAGE_KEY}'`);
    expect(themeInitSource).toContain(`'${THEME_LEVEL_STORAGE_KEY}'`);
    expect(themeInitSource).toContain(`'${THEME_STYLE_STORAGE_KEY}'`);
    expect(themeInitSource).toContain(`'${DARK_SCHEME_QUERY}'`);
  });

  it.each([
    {
      pref: null,
      style: null,
      level: null,
      systemDark: true,
      expected: { theme: 'dark', pref: 'system', style: 'obsidian', level: '100' },
    },
    {
      pref: 'dark',
      style: 'graphite',
      level: null,
      systemDark: false,
      expected: { theme: 'dark', pref: 'dark', style: 'graphite', level: '36' },
    },
    {
      pref: 'dark',
      style: 'obsidian',
      level: null,
      systemDark: false,
      expected: { theme: 'dark', pref: 'dark', style: 'obsidian', level: '100' },
    },
    {
      pref: 'dark',
      style: 'obsidian',
      level: '0',
      systemDark: false,
      expected: { theme: 'dark', pref: 'dark', style: 'graphite', level: '0' },
    },
    {
      pref: 'system',
      style: 'graphite',
      level: '50',
      systemDark: true,
      expected: { theme: 'dark', pref: 'system', style: 'graphite', level: '50' },
    },
    {
      pref: 'light',
      style: 'obsidian',
      level: '25',
      systemDark: true,
      expected: { theme: 'light', pref: 'light', style: 'graphite', level: '25' },
    },
    {
      pref: 'garbage',
      style: 'graphite',
      level: 'garbage',
      systemDark: true,
      expected: { theme: 'dark', pref: 'system', style: 'graphite', level: '36' },
    },
  ])(
    'resolves pref=$pref style=$style level=$level with systemDark=$systemDark',
    ({ pref, style, level, systemDark, expected }) => {
      const result = runThemeInit(pref, style, level, systemDark);
      expect({
        theme: result.theme,
        pref: result.pref,
        style: result.style,
        level: result.level,
      }).toStrictEqual(expected);
    },
  );

  it('uses the same palette formula as darkPalette for every level', () => {
    for (const level of [0, 10, 25, 36, 50, 75, 90, 100]) {
      window.localStorage.clear();
      const result = runThemeInit(null, null, String(level), true);
      const palette = darkPalette(level);
      expect(result.app).toBe(palette.app);
      expect(result.panel).toBe(palette.panel);
    }
  });

  it('agrees with parseThemePref and resolveTheme for every stored value', () => {
    for (const stored of [null, 'light', 'dark', 'system', 'nope']) {
      for (const systemDark of [true, false]) {
        const pref: ThemePref = parseThemePref(stored);
        const theme: ResolvedTheme = resolveTheme(pref, systemDark);
        window.localStorage.clear();
        expect(runThemeInit(stored, null, null, systemDark)).toMatchObject({
          theme,
          pref,
          level: '100',
        });
      }
    }
  });

  it('keeps the defaults from index.html when storage is blocked', () => {
    const root = document.documentElement;
    root.dataset.theme = 'light';
    root.dataset.themePref = 'system';
    root.dataset.themeStyle = 'graphite';
    root.dataset.darkLevel = '100';
    const spy = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('Access is denied for this document.', 'SecurityError');
    });
    try {
      expect(() => new Function(themeInitSource)()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(root.dataset.theme).toBe('light');
    expect(root.dataset.themePref).toBe('system');
    expect(root.dataset.themeStyle).toBe('graphite');
    expect(root.dataset.darkLevel).toBe('100');
  });
});
