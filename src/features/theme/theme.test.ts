import { afterEach, describe, expect, it, vi } from 'vitest';
import { DARK_SCHEME_QUERY, THEME_STORAGE_KEY } from '../../app/config';
import themeInitSource from '../../../public/theme-init.js?raw';
import {
  applyTheme,
  parseThemePref,
  resolveTheme,
  type ResolvedTheme,
  type ThemePref,
} from './theme';

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

describe('applyTheme', () => {
  it.each([
    { pref: 'system', resolved: 'dark' },
    { pref: 'system', resolved: 'light' },
    { pref: 'light', resolved: 'light' },
    { pref: 'dark', resolved: 'dark' },
  ] as const)('sets data-theme=$resolved and data-theme-pref=$pref', ({ pref, resolved }) => {
    const root = document.createElement('div');
    applyTheme(root, pref, resolved);
    expect(root.getAttribute('data-theme')).toBe(resolved);
    expect(root.getAttribute('data-theme-pref')).toBe(pref);
  });

  it('exposes the same values through dataset', () => {
    const root = document.createElement('div');
    applyTheme(root, 'system', 'dark');
    expect(root.dataset.theme).toBe('dark');
    expect(root.dataset.themePref).toBe('system');
  });

  it('sets only those two attributes', () => {
    const root = document.createElement('div');
    applyTheme(root, 'light', 'light');
    expect(root.getAttributeNames().sort()).toStrictEqual(['data-theme', 'data-theme-pref']);
  });

  it('replaces the values written by an earlier call', () => {
    const root = document.createElement('div');
    applyTheme(root, 'system', 'light');
    applyTheme(root, 'dark', 'dark');
    expect(root.dataset.theme).toBe('dark');
    expect(root.dataset.themePref).toBe('dark');
  });

  it('leaves unrelated attributes alone', () => {
    const root = document.createElement('div');
    root.id = 'app';
    root.className = 'shell';
    applyTheme(root, 'dark', 'dark');
    expect(root.id).toBe('app');
    expect(root.className).toBe('shell');
  });
});

describe('public/theme-init.js', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.themePref;
  });

  function runThemeInit(stored: string | null, systemDark: boolean) {
    if (stored !== null) window.localStorage.setItem(THEME_STORAGE_KEY, stored);
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: systemDark && query === DARK_SCHEME_QUERY,
    }));
    new Function(themeInitSource)();
    const { theme, themePref } = document.documentElement.dataset;
    return { theme, pref: themePref };
  }

  it('reads the same storage key and media query as the TypeScript side', () => {
    expect(themeInitSource).toContain(`'${THEME_STORAGE_KEY}'`);
    expect(themeInitSource).toContain(`'${DARK_SCHEME_QUERY}'`);
  });

  it.each([
    { stored: null, systemDark: true, theme: 'dark', pref: 'system' },
    { stored: null, systemDark: false, theme: 'light', pref: 'system' },
    { stored: 'system', systemDark: true, theme: 'dark', pref: 'system' },
    { stored: 'light', systemDark: true, theme: 'light', pref: 'light' },
    { stored: 'dark', systemDark: false, theme: 'dark', pref: 'dark' },
    { stored: 'garbage', systemDark: true, theme: 'dark', pref: 'system' },
  ])(
    'resolves stored=$stored with systemDark=$systemDark to $theme',
    ({ stored, systemDark, theme, pref }) => {
      expect(runThemeInit(stored, systemDark)).toStrictEqual({ theme, pref });
    },
  );

  it('agrees with parseThemePref and resolveTheme for every stored value', () => {
    for (const stored of [null, 'light', 'dark', 'system', 'nope']) {
      for (const systemDark of [true, false]) {
        const pref: ThemePref = parseThemePref(stored);
        const theme: ResolvedTheme = resolveTheme(pref, systemDark);
        window.localStorage.clear();
        expect(runThemeInit(stored, systemDark)).toStrictEqual({ theme, pref });
      }
    }
  });

  it('keeps the defaults from index.html when storage is blocked', () => {
    const root = document.documentElement;
    root.dataset.theme = 'light';
    root.dataset.themePref = 'system';
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
  });
});
