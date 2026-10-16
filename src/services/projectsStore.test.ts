import { describe, expect, it, vi } from 'vitest';
import { PROJECTS_CORRUPT_KEY, PROJECTS_STORAGE_KEY } from '../app/config';
import { SCHEMA_VERSION } from '../domain/migrate';
import type { Paper } from '../domain/papers';
import type { Project } from '../domain/project';
import { EMPTY_STATE, type ProjectsState } from '../domain/projectsState';
import { createProjectsStore, type ProjectsSnapshot } from './projectsStore';
import { loadProjects, saveProjects, type KeyValueStore } from './storage';

const CORRUPT_KEY = PROJECTS_CORRUPT_KEY;

interface MemoryStore extends KeyValueStore {
  readonly data: Map<string, string>;
  /** When true, every write throws like a full disk. */
  failWrites: boolean;
}

function createMemoryStore(initial: Record<string, string> = {}): MemoryStore {
  const data = new Map(Object.entries(initial));
  const store: MemoryStore = {
    data,
    failWrites: false,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      if (store.failWrites) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
  return store;
}

function makePaper(id: string, overrides: Partial<Paper> = {}): Paper {
  return { id, title: `Paper ${id}`, authors: [], createdAt: 100, updatedAt: 100, ...overrides };
}

function makeProject(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: `Project ${id}`,
    corePaperId: `paper-${id}`,
    relatedPaperIds: [],
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

/** The state a `makeProject` list implies: every core paper registered. */
function stateOf(
  projects: Project[],
  selectedId: string | null = projects[0]?.id ?? null,
): ProjectsState {
  return {
    projects,
    papers: Object.fromEntries(projects.map((p) => [p.corePaperId, makePaper(p.corePaperId)])),
    selectedId,
  };
}

function seeded(state: ProjectsState): MemoryStore {
  const store = createMemoryStore();
  saveProjects(state, store);
  return store;
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

const idsOf = (snapshot: ProjectsSnapshot): string[] => snapshot.state.projects.map((p) => p.id);

const PHASE_0_PAYLOAD = JSON.stringify({
  projects: [
    {
      id: 'p1',
      name: 'Attention',
      corePaper: { id: 'c1', title: 'Attention', authors: ['Ashish Vaswani'], year: 2017 },
      relatedPapers: [{ id: 'r1', title: 'BERT', authors: [] }],
      createdAt: 1,
      updatedAt: 2,
    },
  ],
  selectedId: 'p1',
});

describe('createProjectsStore: initial state', () => {
  it('starts empty and persisted when nothing is stored', () => {
    const snapshot = createProjectsStore(createMemoryStore()).getSnapshot();
    expect(snapshot).toStrictEqual({ state: EMPTY_STATE, persisted: true, issue: null });
  });

  it('loads the stored state', () => {
    const stored = stateOf([makeProject('a'), makeProject('b')], 'b');
    const snapshot = createProjectsStore(seeded(stored)).getSnapshot();
    expect(snapshot).toStrictEqual({ state: stored, persisted: true, issue: null });
  });

  it('starts empty and quarantines an unreadable payload', () => {
    const storage = createMemoryStore({ [PROJECTS_STORAGE_KEY]: '{oops' });
    expect(createProjectsStore(storage).getSnapshot().state).toStrictEqual(EMPTY_STATE);
    expect(storage.data.get(CORRUPT_KEY)).toBe('{oops');
  });

  it('starts empty when there is no storage at all', () => {
    expect(createProjectsStore(null).getSnapshot().state).toStrictEqual(EMPTY_STATE);
  });
});

describe('createProjectsStore: schema migration on load', () => {
  it('migrates a Phase 0 payload into projects, papers and a selection', () => {
    const storage = createMemoryStore({ [PROJECTS_STORAGE_KEY]: PHASE_0_PAYLOAD });
    const { state, issue } = createProjectsStore(storage).getSnapshot();
    expect(issue).toBeNull();
    expect(state.projects[0]).toMatchObject({
      id: 'p1',
      corePaperId: 'c1',
      relatedPaperIds: ['r1'],
    });
    expect(Object.keys(state.papers).sort()).toStrictEqual(['c1', 'r1']);
    expect(state.selectedId).toBe('p1');
  });

  it('writes the migrated payload back under the live key', () => {
    const storage = createMemoryStore({ [PROJECTS_STORAGE_KEY]: PHASE_0_PAYLOAD });
    createProjectsStore(storage);
    const written = JSON.parse(storage.data.get(PROJECTS_STORAGE_KEY) ?? 'null');
    expect(written.version).toBe(SCHEMA_VERSION);
    expect(Object.keys(written.papers).sort()).toStrictEqual(['c1', 'r1']);
  });

  it('keeps paper ids stable when the app is created twice from the same payload', () => {
    const first = createProjectsStore(
      createMemoryStore({ [PROJECTS_STORAGE_KEY]: PHASE_0_PAYLOAD }),
    ).getSnapshot();
    const second = createProjectsStore(
      createMemoryStore({ [PROJECTS_STORAGE_KEY]: PHASE_0_PAYLOAD }),
    ).getSnapshot();
    expect(second.state).toStrictEqual(first.state);
  });

  it('reports an unreadable payload instead of pretending the store was empty', () => {
    const storage = createMemoryStore({ [PROJECTS_STORAGE_KEY]: '{oops' });
    const { state, issue } = createProjectsStore(storage).getSnapshot();
    expect(state).toStrictEqual(EMPTY_STATE);
    expect(issue?.kind).toBe('unreadable');
  });

  it('reports a payload from a newer build and leaves it where it is', () => {
    const raw = JSON.stringify({ version: 99, projects: [], papers: {}, selectedId: null });
    const storage = createMemoryStore({ [PROJECTS_STORAGE_KEY]: raw });
    const { state, issue, persisted } = createProjectsStore(storage).getSnapshot();
    expect(state).toStrictEqual(EMPTY_STATE);
    expect(issue).toMatchObject({ kind: 'unsupported-version', found: 99 });
    expect(persisted).toBe(true);
    expect(storage.data.get(PROJECTS_STORAGE_KEY)).toBe(raw);
  });
});

describe('createProjectsStore: dispatch', () => {
  it('applies the action, persists the result and notifies listeners', () => {
    const storage = createMemoryStore();
    const store = createProjectsStore(storage);
    const listener = vi.fn();
    store.subscribe(listener);

    store.dispatch({ type: 'add', project: makeProject('a'), paper: makePaper('paper-a') });

    expect(idsOf(store.getSnapshot())).toStrictEqual(['a']);
    expect(store.getSnapshot().state.selectedId).toBe('a');
    expect(loadProjects(storage)).toStrictEqual(store.getSnapshot().state);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('returns the same snapshot object until something changes', () => {
    const store = createProjectsStore(createMemoryStore());
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);
    store.dispatch({ type: 'add', project: makeProject('a'), paper: makePaper('paper-a') });
    expect(store.getSnapshot()).not.toBe(before);
  });

  it('ignores no-op actions: same snapshot, no write, no notification', () => {
    const storage = seeded(stateOf([makeProject('a')], 'a'));
    const store = createProjectsStore(storage);
    const before = store.getSnapshot();
    const listener = vi.fn();
    store.subscribe(listener);
    const setItem = vi.spyOn(storage, 'setItem');

    store.dispatch({ type: 'select', id: 'a' });
    store.dispatch({ type: 'select', id: 'missing' });
    store.dispatch({ type: 'rename', id: 'a', name: 'Project a', now: 5 });
    store.dispatch({ type: 'rename', id: 'a', name: '   ', now: 5 });
    store.dispatch({ type: 'remove', id: 'missing' });
    store.dispatch({ type: 'linkPaper', projectId: 'a', paper: makePaper('paper-a'), now: 5 });
    store.dispatch({ type: 'unlinkPaper', projectId: 'a', paperId: 'nope', now: 5 });

    expect(store.getSnapshot()).toBe(before);
    expect(setItem).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops notifying a listener after it unsubscribes', () => {
    const store = createProjectsStore(createMemoryStore());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.dispatch({ type: 'add', project: makeProject('a'), paper: makePaper('paper-a') });
    unsubscribe();
    store.dispatch({ type: 'add', project: makeProject('b'), paper: makePaper('paper-b') });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies every subscriber once per change', () => {
    const store = createProjectsStore(createMemoryStore());
    const first = vi.fn();
    const second = vi.fn();
    store.subscribe(first);
    store.subscribe(second);
    store.dispatch({ type: 'add', project: makeProject('a'), paper: makePaper('paper-a') });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('adds new projects at the front and selects them', () => {
    const store = createProjectsStore(createMemoryStore());
    store.dispatch({ type: 'add', project: makeProject('a'), paper: makePaper('paper-a') });
    store.dispatch({ type: 'add', project: makeProject('b'), paper: makePaper('paper-b') });
    expect(idsOf(store.getSnapshot())).toStrictEqual(['b', 'a']);
    expect(store.getSnapshot().state.selectedId).toBe('b');
  });

  it('replaces the whole state on hydrate', () => {
    const store = createProjectsStore(createMemoryStore());
    const state = stateOf([makeProject('x')], 'x');
    store.dispatch({ type: 'hydrate', state });
    expect(store.getSnapshot().state).toBe(state);
  });
});

describe('createProjectsStore: one paper in several projects', () => {
  function storeWithTwoProjects(): {
    store: ReturnType<typeof createProjectsStore>;
    shared: Paper;
  } {
    const store = createProjectsStore(createMemoryStore());
    store.dispatch({ type: 'add', project: makeProject('a'), paper: makePaper('paper-a') });
    store.dispatch({ type: 'add', project: makeProject('b'), paper: makePaper('paper-b') });
    const shared = makePaper('shared', { title: 'Attention', doi: '10.1000/abc' });
    store.dispatch({ type: 'linkPaper', projectId: 'a', paper: shared, now: 1 });
    store.dispatch({ type: 'linkPaper', projectId: 'b', paper: shared, now: 2 });
    return { store, shared };
  }

  it('registers the paper once and links it from both projects', () => {
    const { store, shared } = storeWithTwoProjects();
    const { papers, projects } = store.getSnapshot().state;
    expect(papers.shared).toBe(shared);
    expect(projects.map((p) => p.relatedPaperIds)).toStrictEqual([['shared'], ['shared']]);
    expect(Object.keys(papers)).toHaveLength(3);
  });

  it('still has the shared paper after one of the two projects is deleted', () => {
    const { store, shared } = storeWithTwoProjects();
    store.dispatch({ type: 'remove', id: 'a' });
    const { papers, projects } = store.getSnapshot().state;
    expect(papers.shared).toBe(shared);
    expect(projects.map((p) => p.relatedPaperIds)).toStrictEqual([['shared']]);
  });

  it('keeps every reference resolvable after a deletion', () => {
    const { store } = storeWithTwoProjects();
    store.dispatch({ type: 'remove', id: 'b' });
    const { papers, projects } = store.getSnapshot().state;
    for (const project of projects) {
      expect(papers[project.corePaperId]).toBeDefined();
      for (const paperId of project.relatedPaperIds) expect(papers[paperId]).toBeDefined();
    }
  });

  it('persists the link, so a reload finds the same registry', () => {
    const storage = createMemoryStore();
    const store = createProjectsStore(storage);
    store.dispatch({ type: 'add', project: makeProject('a'), paper: makePaper('paper-a') });
    store.dispatch({
      type: 'linkPaper',
      projectId: 'a',
      paper: makePaper('shared', { doi: '10.1000/abc' }),
      now: 1,
    });
    expect(createProjectsStore(storage).getSnapshot().state).toStrictEqual(
      store.getSnapshot().state,
    );
  });
});

describe('createProjectsStore: persistence failures', () => {
  it('flags persisted=false when a write fails but keeps the new state', () => {
    const storage = createMemoryStore();
    const store = createProjectsStore(storage);
    storage.failWrites = true;
    store.dispatch({ type: 'add', project: makeProject('a'), paper: makePaper('paper-a') });
    expect(store.getSnapshot().persisted).toBe(false);
    expect(idsOf(store.getSnapshot())).toStrictEqual(['a']);
  });

  it('flips persisted back to true once a later write succeeds', () => {
    const storage = createMemoryStore();
    const store = createProjectsStore(storage);
    storage.failWrites = true;
    store.dispatch({ type: 'add', project: makeProject('a'), paper: makePaper('paper-a') });
    storage.failWrites = false;
    store.dispatch({ type: 'add', project: makeProject('b'), paper: makePaper('paper-b') });
    expect(store.getSnapshot().persisted).toBe(true);
    expect(loadProjects(storage).projects).toHaveLength(2);
  });

  it('keeps working in memory when there is no storage at all', () => {
    const store = createProjectsStore(null);
    store.dispatch({ type: 'add', project: makeProject('a'), paper: makePaper('paper-a') });
    expect(store.getSnapshot().persisted).toBe(false);
    expect(idsOf(store.getSnapshot())).toStrictEqual(['a']);
  });

  it('survives window.localStorage being blocked when the store is created', () => {
    withBlockedLocalStorage(() => {
      const store = createProjectsStore();
      expect(store.getSnapshot().state).toStrictEqual(EMPTY_STATE);
      store.dispatch({ type: 'add', project: makeProject('a'), paper: makePaper('paper-a') });
      expect(store.getSnapshot().persisted).toBe(false);
    });
  });

  it('reports persisted=false when a migration cannot be written back', () => {
    const storage = createMemoryStore({ [PROJECTS_STORAGE_KEY]: PHASE_0_PAYLOAD });
    storage.failWrites = true;
    const { state, persisted } = createProjectsStore(storage).getSnapshot();
    expect(persisted).toBe(false);
    expect(state.projects).toHaveLength(1);
  });
});

describe('createProjectsStore: protecting a payload it could not copy aside', () => {
  /** Every quarantine slot already holds a different payload, so nothing can be copied. */
  function storeWithFullQuarantine(): MemoryStore {
    return createMemoryStore({
      [CORRUPT_KEY]: 'first',
      [`${CORRUPT_KEY}.2`]: 'second',
      [`${CORRUPT_KEY}.3`]: 'third',
      [PROJECTS_STORAGE_KEY]: '{oops',
    });
  }

  it('keeps working in memory but refuses to write over the only copy', () => {
    const storage = storeWithFullQuarantine();
    const store = createProjectsStore(storage);
    expect(store.getSnapshot().issue?.kind).toBe('unreadable');

    store.dispatch({ type: 'add', project: makeProject('a'), paper: makePaper('paper-a') });

    expect(idsOf(store.getSnapshot())).toStrictEqual(['a']);
    expect(store.getSnapshot().persisted).toBe(false);
    expect(storage.data.get(PROJECTS_STORAGE_KEY)).toBe('{oops');
  });

  it('writes again as soon as the payload has been copied aside', () => {
    const storage = createMemoryStore({ [PROJECTS_STORAGE_KEY]: '{oops' });
    const store = createProjectsStore(storage);

    store.dispatch({ type: 'add', project: makeProject('a'), paper: makePaper('paper-a') });

    expect(store.getSnapshot().persisted).toBe(true);
    expect(JSON.parse(storage.data.get(PROJECTS_STORAGE_KEY) ?? 'null')).toHaveProperty(
      'version',
      SCHEMA_VERSION,
    );
    expect(storage.data.get(CORRUPT_KEY)).toBe('{oops');
  });
});
