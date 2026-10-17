import { describe, expect, it } from 'vitest';
import type { DifficultyPageRecord } from '../domain/difficulty';
import {
  DIFFICULTY_PREFS_KEY,
  DIFFICULTY_RULES_VERSION,
  DIFFICULTY_STORAGE_KEY,
  ignoredFor,
  loadDifficultyPrefs,
  loadDifficulties,
  pageKey,
  saveDifficultyPrefs,
  saveDifficulties,
  withIgnored,
  withPageRecord,
  withoutPaper,
  type DifficultyState,
} from './difficultyStore';

/** A storage stub with the same failure modes LocalStorage has. */
function store(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  };
}

function record(overrides: Partial<DifficultyPageRecord> = {}): DifficultyPageRecord {
  return {
    paperId: 'paper-1',
    pdfSha256: 'a'.repeat(64),
    page: 3,
    model: 'mock-1',
    rulesVersion: DIFFICULTY_RULES_VERSION,
    analysedAt: 1,
    suggestions: [],
    rejected: 0,
    ...overrides,
  };
}

describe('pageKey', () => {
  it('changes when the file, the page, the model or the rules change', () => {
    const base = pageKey('a'.repeat(64), 3, 'mock-1');
    expect(pageKey('b'.repeat(64), 3, 'mock-1')).not.toBe(base);
    expect(pageKey('a'.repeat(64), 4, 'mock-1')).not.toBe(base);
    expect(pageKey('a'.repeat(64), 3, 'mock-2')).not.toBe(base);
    expect(pageKey('a'.repeat(64), 3, 'mock-1', 'd2')).not.toBe(base);
  });
});

describe('loadDifficulties', () => {
  it('starts empty when nothing is stored', () => {
    expect(loadDifficulties(store())).toEqual({ pages: {}, ignored: {} });
  });

  it('is empty, not broken, when the payload is not JSON', () => {
    expect(loadDifficulties(store({ [DIFFICULTY_STORAGE_KEY]: '{oops' }))).toEqual({
      pages: {},
      ignored: {},
    });
  });

  it('drops entries this build does not understand instead of throwing', () => {
    const payload = JSON.stringify({
      version: 1,
      pages: { good: record(), bad: { page: 'three' }, alsoBad: null },
      ignored: { ['a'.repeat(64)]: ['d1', 7, 'd2'] },
    });
    const loaded = loadDifficulties(store({ [DIFFICULTY_STORAGE_KEY]: payload }));
    expect(Object.keys(loaded.pages)).toEqual(['good']);
    expect(loaded.ignored['a'.repeat(64)]).toEqual(['d1', 'd2']);
  });
});

describe('saveDifficulties', () => {
  it('round-trips through storage', () => {
    const disk = store();
    const key = pageKey('a'.repeat(64), 3, 'mock-1');
    const state = withPageRecord({ pages: {}, ignored: {} }, key, record());
    expect(saveDifficulties(state, disk)).toBe(true);
    expect(loadDifficulties(disk).pages[key]?.page).toBe(3);
  });

  it('reports a write that could not land rather than pretending', () => {
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    expect(saveDifficulties({ pages: {}, ignored: {} }, failing)).toBe(false);
  });

  it('keeps the newest pages when the cache is full', () => {
    const disk = store();
    let state: DifficultyState = { pages: {}, ignored: {} };
    for (let index = 0; index < 405; index += 1) {
      state = withPageRecord(
        state,
        pageKey('a'.repeat(64), index + 1, 'mock-1'),
        record({ page: index + 1, analysedAt: index }),
      );
    }
    saveDifficulties(state, disk);
    const loaded = loadDifficulties(disk);
    expect(Object.keys(loaded.pages)).toHaveLength(400);
    // The five oldest went; the newest stayed.
    expect(loaded.pages[pageKey('a'.repeat(64), 405, 'mock-1')]).toBeDefined();
    expect(loaded.pages[pageKey('a'.repeat(64), 1, 'mock-1')]).toBeUndefined();
  });
});

describe('ignored suggestions', () => {
  it('are recorded once per file and deduplicated', () => {
    const state = withIgnored({ pages: {}, ignored: {} }, 'a'.repeat(64), 'd1');
    const twice = withIgnored(state, 'a'.repeat(64), 'd1');
    expect(twice).toBe(state);
    expect([...ignoredFor(twice, 'a'.repeat(64))]).toEqual(['d1']);
    expect([...ignoredFor(twice, 'b'.repeat(64))]).toEqual([]);
  });
});

describe('withoutPaper', () => {
  it('forgets one file and leaves every other file alone', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    let state = { pages: {}, ignored: {} };
    state = withPageRecord(state, pageKey(a, 1, 'm'), record({ pdfSha256: a, page: 1 }));
    state = withPageRecord(state, pageKey(b, 1, 'm'), record({ pdfSha256: b, page: 1 }));
    state = withIgnored(state, a, 'd1');
    const cleared = withoutPaper(state, a);
    expect(Object.values(cleared.pages).map((entry) => entry.pdfSha256)).toEqual([b]);
    expect(cleared.ignored[a]).toBeUndefined();
  });
});

describe('preferences', () => {
  it('default to off, with markers on', () => {
    expect(loadDifficultyPrefs(store())).toEqual({ enabled: false, markersVisible: true });
  });

  it('round-trip, and treat anything unreadable as the default', () => {
    const disk = store();
    saveDifficultyPrefs({ enabled: true, markersVisible: false }, disk);
    expect(loadDifficultyPrefs(disk)).toEqual({ enabled: true, markersVisible: false });

    disk.items.set(DIFFICULTY_PREFS_KEY, 'not json');
    expect(loadDifficultyPrefs(disk)).toEqual({ enabled: false, markersVisible: true });
  });
});
