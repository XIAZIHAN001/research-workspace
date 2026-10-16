import { describe, expect, it, vi } from 'vitest';
import { PROJECTS_BACKUP_KEY, PROJECTS_CORRUPT_KEY, PROJECTS_STORAGE_KEY } from '../app/config';
import { SCHEMA_VERSION } from '../domain/migrate';
import type { Paper } from '../domain/papers';
import type { Project } from '../domain/project';
import { EMPTY_STATE, type ProjectsState } from '../domain/projectsState';
import {
  defaultStore,
  loadProjects,
  loadProjectsWithReport,
  readItem,
  removeItem,
  saveProjects,
  writeItem,
  type KeyValueStore,
} from './storage';

interface MemoryStore extends KeyValueStore {
  readonly data: Map<string, string>;
}

function createMemoryStore(initial: Record<string, string> = {}): MemoryStore {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function quotaError(): DOMException {
  return new DOMException('The quota has been exceeded.', 'QuotaExceededError');
}

/** Reads work, but every write hits the quota. */
function createFullStore(initial: Record<string, string> = {}): MemoryStore {
  return {
    ...createMemoryStore(initial),
    setItem: () => {
      throw quotaError();
    },
  };
}

function createUnreadableStore(): KeyValueStore {
  return {
    getItem: () => {
      throw new DOMException('Access is denied for this document.', 'SecurityError');
    },
    setItem: () => undefined,
    removeItem: () => undefined,
  };
}

/** Simulates a browser that throws as soon as `window.localStorage` is touched. */
function withBlockedLocalStorage<T>(run: () => T): T {
  const spy = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new DOMException('Access is denied for this document.', 'SecurityError');
  });
  try {
    return run();
  } finally {
    spy.mockRestore();
  }
}

function makePaper(id: string, overrides: Partial<Paper> = {}): Paper {
  return { id, title: `Paper ${id}`, authors: [], createdAt: 1, updatedAt: 2, ...overrides };
}

function makeProject(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: `Project ${id}`,
    corePaperId: `paper-${id}`,
    relatedPaperIds: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

const SAMPLE_STATE: ProjectsState = {
  projects: [
    { ...makeProject('p1', { name: 'Attention' }), relatedPaperIds: ['r1'] },
    makeProject('p2', { name: 'ResNet', createdAt: 3, updatedAt: 4 }),
  ],
  papers: {
    'paper-p1': makePaper('paper-p1', {
      title: 'Attention',
      authors: ['Ashish Vaswani'],
      year: 2017,
    }),
    'paper-p2': makePaper('paper-p2', { title: 'ResNet' }),
    r1: makePaper('r1', { title: 'BERT' }),
  },
  selectedId: 'p2',
};

/** A payload as this build writes it. */
function currentPayload(state: ProjectsState): string {
  return JSON.stringify({ version: SCHEMA_VERSION, ...state });
}

/** A Phase 0 payload: two projects, the second referencing the first's core paper. */
const PHASE_0_PROJECT_1 = {
  id: 'p1',
  name: 'Attention',
  corePaper: { id: 'c1', title: 'Attention', authors: ['Ashish Vaswani'], year: 2017 },
  relatedPapers: [{ id: 'r1', title: 'BERT', authors: [] }],
  createdAt: 1,
  updatedAt: 2,
};

const PHASE_0_PROJECT_2 = {
  id: 'p2',
  name: 'ResNet',
  corePaper: { id: 'c2', title: 'ResNet', authors: [] },
  relatedPapers: [{ id: 'c1', title: 'Attention', authors: ['Ashish Vaswani'], year: 2017 }],
  createdAt: 3,
  updatedAt: 4,
};

const PHASE_0_PAYLOAD = JSON.stringify({
  projects: [PHASE_0_PROJECT_1, PHASE_0_PROJECT_2],
  selectedId: 'p2',
});

describe('defaultStore', () => {
  it('returns window.localStorage', () => {
    expect(defaultStore()).toBe(window.localStorage);
  });

  it('returns null when touching window.localStorage throws', () => {
    withBlockedLocalStorage(() => {
      expect(defaultStore()).toBeNull();
    });
  });
});

describe('readItem', () => {
  it('returns the stored value', () => {
    expect(readItem('k', createMemoryStore({ k: 'v' }))).toBe('v');
  });

  it('returns null for a missing key', () => {
    expect(readItem('k', createMemoryStore())).toBeNull();
  });

  it('returns null when getItem throws', () => {
    expect(readItem('k', createUnreadableStore())).toBeNull();
  });

  it('returns null without a store', () => {
    expect(readItem('k', null)).toBeNull();
  });
});

describe('writeItem', () => {
  it('stores the value and reports success', () => {
    const store = createMemoryStore();
    expect(writeItem('k', 'v', store)).toBe(true);
    expect(store.data.get('k')).toBe('v');
  });

  it('reports failure when the quota is exceeded', () => {
    expect(writeItem('k', 'v', createFullStore())).toBe(false);
  });

  it('reports failure without a store', () => {
    expect(writeItem('k', 'v', null)).toBe(false);
  });
});

describe('removeItem', () => {
  it('deletes the key', () => {
    const store = createMemoryStore({ k: 'v' });
    removeItem('k', store);
    expect(store.data.has('k')).toBe(false);
  });

  it('ignores a missing key', () => {
    expect(() => {
      removeItem('k', createMemoryStore());
    }).not.toThrow();
  });

  it('does not throw when the store throws or is missing', () => {
    const throwing: KeyValueStore = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => {
        throw new DOMException('Access is denied for this document.', 'SecurityError');
      },
    };
    expect(() => {
      removeItem('k', throwing);
    }).not.toThrow();
    expect(() => {
      removeItem('k', null);
    }).not.toThrow();
  });
});

describe('loadProjects', () => {
  it('returns the empty state when nothing is stored', () => {
    expect(loadProjects(createMemoryStore())).toStrictEqual(EMPTY_STATE);
  });

  it('round-trips a saved state', () => {
    const store = createMemoryStore();
    expect(saveProjects(SAMPLE_STATE, store)).toBe(true);
    expect(loadProjects(store)).toStrictEqual(SAMPLE_STATE);
  });

  it('quarantines unreadable JSON under the .corrupt key and starts empty', () => {
    const store = createMemoryStore({ [PROJECTS_STORAGE_KEY]: '{oops' });
    expect(loadProjects(store)).toStrictEqual(EMPTY_STATE);
    expect(store.data.get(PROJECTS_CORRUPT_KEY)).toBe('{oops');
  });

  it('quarantines valid JSON that has the wrong shape', () => {
    const raw = JSON.stringify({ projects: 'nope', selectedId: null });
    const store = createMemoryStore({ [PROJECTS_STORAGE_KEY]: raw });
    expect(loadProjects(store)).toStrictEqual(EMPTY_STATE);
    expect(store.data.get(PROJECTS_CORRUPT_KEY)).toBe(raw);
  });

  it('falls back to the first project when the stored selection no longer exists', () => {
    const raw = currentPayload({ ...SAMPLE_STATE, selectedId: 'ghost' });
    const store = createMemoryStore({ [PROJECTS_STORAGE_KEY]: raw });
    expect(loadProjects(store).selectedId).toBe('p1');
  });

  it('starts empty without a store', () => {
    expect(loadProjects(null)).toStrictEqual(EMPTY_STATE);
  });

  it('starts empty when reading throws', () => {
    expect(loadProjects(createUnreadableStore())).toStrictEqual(EMPTY_STATE);
  });

  it('reads through window.localStorage by default', () => {
    window.localStorage.setItem(PROJECTS_STORAGE_KEY, currentPayload(SAMPLE_STATE));
    expect(loadProjects()).toStrictEqual(SAMPLE_STATE);
  });
});

describe('saveProjects', () => {
  it('writes the state under the projects key in the versioned envelope', () => {
    const store = createMemoryStore();
    saveProjects(SAMPLE_STATE, store);
    expect(JSON.parse(store.data.get(PROJECTS_STORAGE_KEY) ?? 'null')).toStrictEqual({
      version: SCHEMA_VERSION,
      projects: SAMPLE_STATE.projects,
      papers: SAMPLE_STATE.papers,
      selectedId: SAMPLE_STATE.selectedId,
    });
  });

  it('returns false and keeps the previous value when the quota is exceeded', () => {
    const store = createFullStore({ [PROJECTS_STORAGE_KEY]: 'old' });
    expect(saveProjects(SAMPLE_STATE, store)).toBe(false);
    expect(store.data.get(PROJECTS_STORAGE_KEY)).toBe('old');
  });

  it('returns false without a store', () => {
    expect(saveProjects(SAMPLE_STATE, null)).toBe(false);
  });

  it('returns false when window.localStorage is blocked', () => {
    withBlockedLocalStorage(() => {
      expect(saveProjects(SAMPLE_STATE)).toBe(false);
    });
  });
});

describe('loadProjectsWithReport', () => {
  it('reports nothing to see for an empty store', () => {
    expect(loadProjectsWithReport(createMemoryStore())).toStrictEqual({
      state: EMPTY_STATE,
      issue: null,
      persisted: true,
    });
  });

  it('reports a clean load without writing anything', () => {
    const store = createMemoryStore({ [PROJECTS_STORAGE_KEY]: currentPayload(SAMPLE_STATE) });
    const setItem = vi.spyOn(store, 'setItem');
    expect(loadProjectsWithReport(store)).toStrictEqual({
      state: SAMPLE_STATE,
      issue: null,
      persisted: true,
    });
    expect(setItem).not.toHaveBeenCalled();
  });

  it('reports why unreadable data was set aside', () => {
    const store = createMemoryStore({ [PROJECTS_STORAGE_KEY]: '{oops' });
    const result = loadProjectsWithReport(store);
    expect(result.issue?.kind).toBe('unreadable');
    expect(result.state).toStrictEqual(EMPTY_STATE);
  });

  it('reports why a payload of the wrong shape was set aside', () => {
    const store = createMemoryStore({ [PROJECTS_STORAGE_KEY]: '{"projects":"nope"}' });
    expect(loadProjectsWithReport(store).issue?.kind).toBe('invalid');
  });
});

describe('loadProjectsWithReport: migrating a Phase 0 payload', () => {
  it('migrates the projects, their papers and the selection', () => {
    const store = createMemoryStore({ [PROJECTS_STORAGE_KEY]: PHASE_0_PAYLOAD });
    const { state, issue } = loadProjectsWithReport(store);
    expect(issue).toBeNull();
    expect(state.selectedId).toBe('p2');
    expect(state.projects.map((p) => p.name)).toStrictEqual(['Attention', 'ResNet']);
    expect(state.projects[0]).toMatchObject({
      id: 'p1',
      corePaperId: 'c1',
      relatedPaperIds: ['r1'],
    });
    expect(Object.keys(state.papers).sort()).toStrictEqual(['c1', 'c2', 'r1']);
    expect(state.papers.c1).toMatchObject({ title: 'Attention', year: 2017 });
  });

  it('writes the migrated payload back so the upgrade happens once', () => {
    const store = createMemoryStore({ [PROJECTS_STORAGE_KEY]: PHASE_0_PAYLOAD });
    const { state, persisted } = loadProjectsWithReport(store);
    expect(persisted).toBe(true);
    const written = JSON.parse(store.data.get(PROJECTS_STORAGE_KEY) ?? 'null');
    expect(written.version).toBe(SCHEMA_VERSION);
    expect(written.papers).toStrictEqual(state.papers);
  });

  it('keeps a verbatim copy of the payload it migrated away from', () => {
    const store = createMemoryStore({ [PROJECTS_STORAGE_KEY]: PHASE_0_PAYLOAD });
    loadProjectsWithReport(store);
    expect(store.data.get(PROJECTS_BACKUP_KEY)).toBe(PHASE_0_PAYLOAD);
  });

  it('does not migrate a second time: the next load writes nothing', () => {
    const store = createMemoryStore({ [PROJECTS_STORAGE_KEY]: PHASE_0_PAYLOAD });
    const first = loadProjectsWithReport(store);
    const setItem = vi.spyOn(store, 'setItem');
    const second = loadProjectsWithReport(store);
    expect(setItem).not.toHaveBeenCalled();
    expect(second).toStrictEqual(first);
  });

  it('is deterministic: two stores seeded alike end up byte-identical', () => {
    const one = createMemoryStore({ [PROJECTS_STORAGE_KEY]: PHASE_0_PAYLOAD });
    const two = createMemoryStore({ [PROJECTS_STORAGE_KEY]: PHASE_0_PAYLOAD });
    loadProjectsWithReport(one);
    loadProjectsWithReport(two);
    expect(one.data.get(PROJECTS_STORAGE_KEY)).toBe(two.data.get(PROJECTS_STORAGE_KEY));
  });

  it('keeps paper ids stable across reloads, so references survive', () => {
    const store = createMemoryStore({ [PROJECTS_STORAGE_KEY]: PHASE_0_PAYLOAD });
    const first = loadProjectsWithReport(store).state;
    const second = loadProjectsWithReport(store).state;
    expect(Object.keys(second.papers)).toStrictEqual(Object.keys(first.papers));
    expect(second).toStrictEqual(first);
  });

  it('still returns the migrated state when the write-back fails', () => {
    const store = createFullStore({ [PROJECTS_STORAGE_KEY]: PHASE_0_PAYLOAD });
    const { state, issue, persisted } = loadProjectsWithReport(store);
    expect(persisted).toBe(false);
    expect(issue).toBeNull();
    expect(state.projects).toHaveLength(2);
    // The original payload is still there, so nothing is lost.
    expect(store.data.get(PROJECTS_STORAGE_KEY)).toBe(PHASE_0_PAYLOAD);
  });
});

describe('loadProjectsWithReport: payloads this build cannot use', () => {
  it('leaves a newer payload where it is and backs it up instead of quarantining it', () => {
    const raw = JSON.stringify({ version: SCHEMA_VERSION + 1, projects: [], papers: {} });
    const store = createMemoryStore({ [PROJECTS_STORAGE_KEY]: raw });
    const { state, issue } = loadProjectsWithReport(store);
    expect(state).toStrictEqual(EMPTY_STATE);
    expect(issue).toMatchObject({ kind: 'unsupported-version', found: SCHEMA_VERSION + 1 });
    expect(store.data.get(PROJECTS_STORAGE_KEY)).toBe(raw);
    expect(store.data.get(PROJECTS_BACKUP_KEY)).toBe(raw);
    expect(store.data.has(PROJECTS_CORRUPT_KEY)).toBe(false);
  });

  it('keeps a newer payload recoverable even after the app writes over the live key', () => {
    const raw = JSON.stringify({ version: SCHEMA_VERSION + 1, projects: [], papers: {} });
    const store = createMemoryStore({ [PROJECTS_STORAGE_KEY]: raw });
    loadProjectsWithReport(store);
    saveProjects(EMPTY_STATE, store);
    expect(store.data.get(PROJECTS_BACKUP_KEY)).toBe(raw);
  });

  it('quarantines a payload whose projects cannot be told apart, leaving the live key alone', () => {
    const raw = JSON.stringify({
      projects: [
        { ...PHASE_0_PROJECT_1, id: 'same' },
        { ...PHASE_0_PROJECT_2, id: 'same' },
      ],
      selectedId: null,
    });
    const store = createMemoryStore({ [PROJECTS_STORAGE_KEY]: raw });
    const { state, issue } = loadProjectsWithReport(store);
    expect(state).toStrictEqual(EMPTY_STATE);
    expect(issue?.kind).toBe('invalid');
    expect(store.data.get(PROJECTS_STORAGE_KEY)).toBe(raw);
    expect(store.data.get(PROJECTS_CORRUPT_KEY)).toBe(raw);
  });
});
