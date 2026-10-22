import { describe, expect, it } from 'vitest';
import type { Annotation } from './annotation';
import type { Bookmark } from './bookmark';
import { MAX_NAME_LENGTH } from './normalize';
import type { Paper } from './papers';
import type { Project } from './project';
import {
  EMPTY_STATE,
  projectsReducer,
  type ProjectsAction,
  type ProjectsState,
} from './projectsState';

function makePaper(id: string, overrides: Partial<Paper> = {}): Paper {
  return {
    id,
    title: `Paper ${id}`,
    authors: [],
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
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

/** Registry holding the core paper of every project in the list. */
function papersOf(projects: Project[]): Record<string, Paper> {
  return Object.fromEntries(projects.map((p) => [p.corePaperId, makePaper(p.corePaperId)]));
}

function makeState(ids: string[], selectedId: string | null = ids[0] ?? null): ProjectsState {
  const projects = ids.map((id) => makeProject(id));
  return { projects, papers: papersOf(projects), annotations: [], bookmarks: [], selectedId };
}

const idsOf = (state: ProjectsState): string[] => state.projects.map((p) => p.id);

const byId = (state: ProjectsState, id: string): Project | undefined =>
  state.projects.find((p) => p.id === id);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

describe('EMPTY_STATE', () => {
  it('has no projects, no papers, no annotations, no bookmarks and no selection', () => {
    expect(EMPTY_STATE).toStrictEqual({
      projects: [],
      papers: {},
      annotations: [],
      bookmarks: [],
      selectedId: null,
    });
  });
});

describe('projectsReducer', () => {
  describe('hydrate', () => {
    it('replaces the whole state with the given one', () => {
      const incoming = makeState(['x', 'y'], 'y');
      const next = projectsReducer(makeState(['a']), { type: 'hydrate', state: incoming });
      expect(next).toBe(incoming);
    });

    it('can reset to the empty state', () => {
      const next = projectsReducer(makeState(['a', 'b']), { type: 'hydrate', state: EMPTY_STATE });
      expect(next).toStrictEqual({
        projects: [],
        papers: {},
        annotations: [],
        bookmarks: [],
        selectedId: null,
      });
    });
  });

  describe('add', () => {
    it('puts the new project first and selects it', () => {
      const state = makeState(['a', 'b'], 'b');
      const added = makeProject('c');
      const next = projectsReducer(state, {
        type: 'add',
        project: added,
        paper: makePaper('paper-c'),
      });
      expect(idsOf(next)).toStrictEqual(['c', 'a', 'b']);
      expect(next.projects[0]).toBe(added);
      expect(next.selectedId).toBe('c');
    });

    it('registers the paper the project is built around', () => {
      const paper = makePaper('paper-c', { title: 'Attention', doi: '10.1000/abc' });
      const next = projectsReducer(EMPTY_STATE, { type: 'add', project: makeProject('c'), paper });
      expect(next.papers['paper-c']).toBe(paper);
      expect(next.projects[0]?.corePaperId).toBe('paper-c');
    });

    it('keeps the registered paper when the id is already known', () => {
      const state = makeState(['a']);
      const stale = makePaper('paper-a', { title: 'Stale title' });
      const next = projectsReducer(state, {
        type: 'add',
        project: makeProject('c'),
        paper: stale,
      });
      expect(next.papers['paper-a']).toBe(state.papers['paper-a']);
      expect(next.papers['paper-a']?.title).toBe('Paper paper-a');
    });

    it('works on an empty state', () => {
      const added = makeProject('first');
      const paper = makePaper('paper-first');
      const next = projectsReducer(EMPTY_STATE, { type: 'add', project: added, paper });
      expect(next).toStrictEqual({
        projects: [added],
        papers: { 'paper-first': paper },
        annotations: [],
        bookmarks: [],
        selectedId: 'first',
      });
      expect(EMPTY_STATE).toStrictEqual({
        projects: [],
        papers: {},
        annotations: [],
        bookmarks: [],
        selectedId: null,
      });
    });

    it('keeps the existing projects, papers and their references', () => {
      const state = makeState(['a', 'b']);
      const next = projectsReducer(state, {
        type: 'add',
        project: makeProject('c'),
        paper: makePaper('paper-c'),
      });
      expect(next.projects.slice(1)).toStrictEqual(state.projects);
      expect(next.projects[1]).toBe(state.projects[0]);
      expect(next.projects[2]).toBe(state.projects[1]);
      expect(next.papers['paper-a']).toBe(state.papers['paper-a']);
    });
  });

  describe('linkPaper', () => {
    it('appends the paper and registers it', () => {
      const state = makeState(['a']);
      const paper = makePaper('shared');
      const next = projectsReducer(state, { type: 'linkPaper', projectId: 'a', paper, now: 999 });
      expect(byId(next, 'a')).toStrictEqual({
        ...makeProject('a'),
        relatedPaperIds: ['shared'],
        updatedAt: 999,
      });
      expect(next.papers.shared).toBe(paper);
    });

    it('lets two projects share one paper without duplicating it', () => {
      const paper = makePaper('shared');
      const first = projectsReducer(makeState(['a', 'b']), {
        type: 'linkPaper',
        projectId: 'a',
        paper,
        now: 1,
      });
      const second = projectsReducer(first, { type: 'linkPaper', projectId: 'b', paper, now: 2 });
      expect(byId(second, 'a')?.relatedPaperIds).toStrictEqual(['shared']);
      expect(byId(second, 'b')?.relatedPaperIds).toStrictEqual(['shared']);
      expect(Object.keys(second.papers)).toStrictEqual(['paper-a', 'paper-b', 'shared']);
    });

    it('keeps the registered copy of a paper another project already linked', () => {
      const paper = makePaper('shared');
      const state = projectsReducer(makeState(['a']), {
        type: 'linkPaper',
        projectId: 'a',
        paper,
        now: 1,
      });
      const next = projectsReducer(state, {
        type: 'linkPaper',
        projectId: 'b',
        paper: { ...paper, title: 'Different metadata' },
        now: 2,
      });
      expect(next.papers.shared).toBe(paper);
    });

    it('leaves the other projects and the selection alone', () => {
      const state = makeState(['a', 'b', 'c'], 'c');
      const next = projectsReducer(state, {
        type: 'linkPaper',
        projectId: 'b',
        paper: makePaper('shared'),
        now: 5,
      });
      expect(idsOf(next)).toStrictEqual(['a', 'b', 'c']);
      expect(next.selectedId).toBe('c');
      expect(next.projects[0]).toBe(state.projects[0]);
      expect(next.projects[2]).toBe(state.projects[2]);
    });

    it('returns the same state when the project is unknown', () => {
      const state = makeState(['a']);
      expect(
        projectsReducer(state, {
          type: 'linkPaper',
          projectId: 'nope',
          paper: makePaper('shared'),
          now: 1,
        }),
      ).toBe(state);
    });

    it('returns the same state when the paper is already linked', () => {
      const state = projectsReducer(makeState(['a']), {
        type: 'linkPaper',
        projectId: 'a',
        paper: makePaper('shared'),
        now: 1,
      });
      expect(
        projectsReducer(state, {
          type: 'linkPaper',
          projectId: 'a',
          paper: makePaper('shared'),
          now: 2,
        }),
      ).toBe(state);
    });

    it('returns the same state when the paper is the core paper of the project', () => {
      const state = makeState(['a']);
      expect(
        projectsReducer(state, {
          type: 'linkPaper',
          projectId: 'a',
          paper: makePaper('paper-a'),
          now: 1,
        }),
      ).toBe(state);
    });
  });

  describe('unlinkPaper', () => {
    function linked(): ProjectsState {
      return projectsReducer(makeState(['a']), {
        type: 'linkPaper',
        projectId: 'a',
        paper: makePaper('shared'),
        now: 1,
      });
    }

    it('drops the link and stamps updatedAt', () => {
      const next = projectsReducer(linked(), {
        type: 'unlinkPaper',
        projectId: 'a',
        paperId: 'shared',
        now: 999,
      });
      expect(byId(next, 'a')).toStrictEqual({
        ...makeProject('a'),
        relatedPaperIds: [],
        updatedAt: 999,
      });
    });

    it('keeps the paper in the registry, because another project may still use it', () => {
      const next = projectsReducer(linked(), {
        type: 'unlinkPaper',
        projectId: 'a',
        paperId: 'shared',
        now: 999,
      });
      expect(next.papers.shared).toBeDefined();
    });

    it.each([
      { label: 'the project is unknown', projectId: 'nope', paperId: 'shared' },
      { label: 'the paper was never linked', projectId: 'a', paperId: 'other' },
      { label: 'the paper is the core paper', projectId: 'a', paperId: 'paper-a' },
    ])('returns the same state when $label', ({ projectId, paperId }) => {
      const state = linked();
      expect(projectsReducer(state, { type: 'unlinkPaper', projectId, paperId, now: 9 })).toBe(
        state,
      );
    });
  });

  describe('rename', () => {
    it('applies the normalized name and stamps updatedAt', () => {
      const state = makeState(['a', 'b']);
      const next = projectsReducer(state, {
        type: 'rename',
        id: 'b',
        name: '  New   name ',
        now: 999,
      });
      expect(byId(next, 'b')).toStrictEqual({
        ...makeProject('b'),
        name: 'New name',
        updatedAt: 999,
      });
    });

    it('leaves createdAt, other projects and the selection alone', () => {
      const state = makeState(['a', 'b', 'c'], 'c');
      const next = projectsReducer(state, { type: 'rename', id: 'b', name: 'Renamed', now: 999 });
      expect(byId(next, 'b')?.createdAt).toBe(100);
      expect(next.projects[0]).toBe(state.projects[0]);
      expect(next.projects[2]).toBe(state.projects[2]);
      expect(idsOf(next)).toStrictEqual(['a', 'b', 'c']);
      expect(next.selectedId).toBe('c');
    });

    it('leaves the paper the project is built around untouched', () => {
      const state = makeState(['a']);
      const next = projectsReducer(state, { type: 'rename', id: 'a', name: 'Renamed', now: 999 });
      expect(next.papers['paper-a']).toBe(state.papers['paper-a']);
      expect(byId(next, 'a')?.corePaperId).toBe('paper-a');
    });

    it('allows a name that another project already uses', () => {
      const state = makeState(['a', 'b']);
      const next = projectsReducer(state, { type: 'rename', id: 'a', name: 'Project b', now: 7 });
      expect(byId(next, 'a')).toMatchObject({ name: 'Project b', updatedAt: 7 });
      expect(byId(next, 'b')).toBe(state.projects[1]);
    });

    it('truncates over-long names to the shared limit', () => {
      const next = projectsReducer(makeState(['a']), {
        type: 'rename',
        id: 'a',
        name: 'n'.repeat(MAX_NAME_LENGTH + 10),
        now: 5,
      });
      expect(byId(next, 'a')?.name).toBe('n'.repeat(MAX_NAME_LENGTH));
    });

    it.each([
      { label: 'empty', name: '' },
      { label: 'whitespace-only', name: ' \t\n ' },
    ])('returns the same state for a $label name', ({ name }) => {
      const state = makeState(['a', 'b']);
      expect(projectsReducer(state, { type: 'rename', id: 'a', name, now: 5 })).toBe(state);
    });
  });

  describe('remove', () => {
    it('drops the project and keeps the selection when another one was selected', () => {
      const state = makeState(['a', 'b', 'c'], 'c');
      const next = projectsReducer(state, { type: 'remove', id: 'a' });
      expect(idsOf(next)).toStrictEqual(['b', 'c']);
      expect(next.selectedId).toBe('c');
    });

    it('selects the project that slides into the vacated slot', () => {
      const state = makeState(['a', 'b', 'c'], 'b');
      const next = projectsReducer(state, { type: 'remove', id: 'b' });
      expect(idsOf(next)).toStrictEqual(['a', 'c']);
      expect(next.selectedId).toBe('c');
    });

    it('selects the first project when the first one was selected and removed', () => {
      const state = makeState(['a', 'b', 'c'], 'a');
      const next = projectsReducer(state, { type: 'remove', id: 'a' });
      expect(idsOf(next)).toStrictEqual(['b', 'c']);
      expect(next.selectedId).toBe('b');
    });

    it('falls back to the project above when the last one was selected and removed', () => {
      const state = makeState(['a', 'b', 'c'], 'c');
      const next = projectsReducer(state, { type: 'remove', id: 'c' });
      expect(idsOf(next)).toStrictEqual(['a', 'b']);
      expect(next.selectedId).toBe('b');
    });

    it('clears the selection when the only project is removed', () => {
      const state = makeState(['a'], 'a');
      const next = projectsReducer(state, { type: 'remove', id: 'a' });
      expect(next).toStrictEqual({
        projects: [],
        papers: state.papers,
        annotations: state.annotations,
        bookmarks: state.bookmarks,
        selectedId: null,
      });
    });

    it('keeps every paper in the registry', () => {
      const shared = makePaper('shared');
      const state = projectsReducer(
        projectsReducer(makeState(['a', 'b']), {
          type: 'linkPaper',
          projectId: 'a',
          paper: shared,
          now: 1,
        }),
        { type: 'linkPaper', projectId: 'b', paper: shared, now: 2 },
      );
      const next = projectsReducer(state, { type: 'remove', id: 'a' });
      expect(next.papers.shared).toBe(shared);
      expect(byId(next, 'b')?.relatedPaperIds).toStrictEqual(['shared']);
      expect(next.papers['paper-a']).toBe(state.papers['paper-a']);
    });

    it('keeps a null selection when an unselected project is removed', () => {
      const next = projectsReducer(makeState(['a', 'b'], null), { type: 'remove', id: 'a' });
      expect(idsOf(next)).toStrictEqual(['b']);
      expect(next.selectedId).toBeNull();
    });

    it('returns the same state for an unknown id', () => {
      const state = makeState(['a', 'b']);
      expect(projectsReducer(state, { type: 'remove', id: 'nope' })).toBe(state);
    });

    it('returns the same state when there is nothing to remove from', () => {
      expect(projectsReducer(EMPTY_STATE, { type: 'remove', id: 'a' })).toBe(EMPTY_STATE);
    });
  });

  describe('select', () => {
    it('selects an existing project without reordering the list', () => {
      const state = makeState(['a', 'b', 'c'], 'a');
      const next = projectsReducer(state, { type: 'select', id: 'c' });
      expect(next.selectedId).toBe('c');
      expect(idsOf(next)).toStrictEqual(['a', 'b', 'c']);
      expect(next.projects).toBe(state.projects);
    });

    it('selects a project when nothing was selected before', () => {
      const next = projectsReducer(makeState(['a', 'b'], null), { type: 'select', id: 'b' });
      expect(next.selectedId).toBe('b');
    });

    it('returns the same state for an unknown id', () => {
      const state = makeState(['a', 'b'], 'a');
      expect(projectsReducer(state, { type: 'select', id: 'nope' })).toBe(state);
    });

    it('returns the same state when the list is empty', () => {
      expect(projectsReducer(EMPTY_STATE, { type: 'select', id: 'a' })).toBe(EMPTY_STATE);
    });
  });

  describe('no-op actions', () => {
    // The store compares references to decide whether to persist and notify,
    // so every no-op must hand back the very same state object.
    it.each<{ label: string; action: ProjectsAction }>([
      {
        label: 'rename with an unknown id',
        action: { type: 'rename', id: 'nope', name: 'Other', now: 9 },
      },
      {
        label: 'rename to the current name',
        action: { type: 'rename', id: 'a', name: 'Project a', now: 9 },
      },
      {
        label: 'rename to the current name with extra whitespace',
        action: { type: 'rename', id: 'a', name: '  Project   a ', now: 9 },
      },
      { label: 'rename to a blank name', action: { type: 'rename', id: 'a', name: '   ', now: 9 } },
      { label: 'select of the already selected project', action: { type: 'select', id: 'a' } },
      { label: 'select of an unknown id', action: { type: 'select', id: 'nope' } },
      { label: 'remove of an unknown id', action: { type: 'remove', id: 'nope' } },
      {
        label: 'link of a paper that is not in a project',
        action: { type: 'linkPaper', projectId: 'nope', paper: makePaper('shared'), now: 9 },
      },
      {
        label: 'link of a project its own core paper',
        action: { type: 'linkPaper', projectId: 'a', paper: makePaper('paper-a'), now: 9 },
      },
      {
        label: 'unlink of a paper that is not linked',
        action: { type: 'unlinkPaper', projectId: 'a', paperId: 'shared', now: 9 },
      },
    ])('returns the same state reference for $label', ({ action }) => {
      const state = makeState(['a', 'b'], 'a');
      expect(projectsReducer(state, action)).toBe(state);
    });
  });

  describe('purity', () => {
    const actions: ProjectsAction[] = [
      { type: 'hydrate', state: makeState(['x']) },
      { type: 'add', project: makeProject('c'), paper: makePaper('paper-c') },
      { type: 'linkPaper', projectId: 'b', paper: makePaper('shared'), now: 9 },
      { type: 'unlinkPaper', projectId: 'a', paperId: 'paper-a', now: 9 },
      { type: 'rename', id: 'b', name: 'Renamed', now: 9 },
      { type: 'remove', id: 'a' },
      { type: 'select', id: 'b' },
    ];

    it.each(actions)('does not mutate its input for a $type action', (action) => {
      const state = deepFreeze(makeState(['a', 'b'], 'a'));
      const before = structuredClone(state);
      expect(() => projectsReducer(state, action)).not.toThrow();
      expect(state).toStrictEqual(before);
    });
  });

  describe('sequences of actions', () => {
    it('keeps the selection valid through add, select and remove', () => {
      const actionsInOrder: ProjectsAction[] = [
        { type: 'add', project: makeProject('a'), paper: makePaper('paper-a') },
        { type: 'add', project: makeProject('b'), paper: makePaper('paper-b') },
        { type: 'add', project: makeProject('c'), paper: makePaper('paper-c') },
        { type: 'select', id: 'b' },
        { type: 'remove', id: 'b' },
        { type: 'remove', id: 'a' },
      ];
      const states = actionsInOrder.reduce<ProjectsState[]>(
        (history, action) => [...history, projectsReducer(history.at(-1) ?? EMPTY_STATE, action)],
        [],
      );
      for (const state of states) {
        expect(state.selectedId === null || byId(state, state.selectedId) !== undefined).toBe(true);
      }
      const last = states.at(-1);
      expect(last?.projects).toStrictEqual([makeProject('c')]);
      expect(last?.selectedId).toBe('c');
      // Papers outlive the projects that introduced them.
      expect(Object.keys(last?.papers ?? {}).sort()).toStrictEqual([
        'paper-a',
        'paper-b',
        'paper-c',
      ]);
    });

    it('keeps every project→paper reference resolvable through link and remove', () => {
      const shared = makePaper('shared');
      const actionsInOrder: ProjectsAction[] = [
        { type: 'add', project: makeProject('a'), paper: makePaper('paper-a') },
        { type: 'add', project: makeProject('b'), paper: makePaper('paper-b') },
        { type: 'linkPaper', projectId: 'b', paper: shared, now: 3 },
        { type: 'unlinkPaper', projectId: 'b', paperId: 'shared', now: 4 },
        { type: 'linkPaper', projectId: 'a', paper: shared, now: 5 },
        { type: 'remove', id: 'b' },
      ];
      const states = actionsInOrder.reduce<ProjectsState[]>(
        (history, action) => [...history, projectsReducer(history.at(-1) ?? EMPTY_STATE, action)],
        [],
      );
      for (const state of states) {
        for (const project of state.projects) {
          expect(state.papers[project.corePaperId]).toBeDefined();
          for (const paperId of project.relatedPaperIds) {
            expect(state.papers[paperId]).toBeDefined();
          }
        }
      }
      const last = states.at(-1);
      expect(byId(last as ProjectsState, 'a')?.relatedPaperIds).toStrictEqual(['shared']);
      expect(last?.papers.shared).toBe(shared);
    });
  });
});

describe('projectsReducer: updatePaper', () => {
  const PDF = {
    sha256: 'e'.repeat(64),
    name: 'attention.pdf',
    bytes: 20,
    pageCount: 3,
    addedAt: 9,
  };

  function twoPapers(): ProjectsState {
    const state = makeState(['a']);
    return {
      ...state,
      papers: {
        ...state.papers,
        other: makePaper('other', { title: 'BERT', doi: '10.1000/bert' }),
      },
    };
  }

  it('replaces one paper and leaves everything else alone', () => {
    const state = twoPapers();
    const next = projectsReducer(state, {
      type: 'updatePaper',
      paperId: 'paper-a',
      edit: { title: 'Attention Is All You Need', pdf: PDF },
      now: 50,
    });
    expect(next.papers['paper-a']).toMatchObject({
      id: 'paper-a',
      title: 'Attention Is All You Need',
      pdf: PDF,
      updatedAt: 50,
    });
    expect(next.papers.other).toBe(state.papers.other);
    expect(next.projects).toBe(state.projects);
    expect(next.selectedId).toBe(state.selectedId);
  });

  it('records where reading stopped', () => {
    const next = projectsReducer(twoPapers(), {
      type: 'updatePaper',
      paperId: 'paper-a',
      edit: { reading: { page: 7, updatedAt: 60 } },
      now: 60,
    });
    expect(next.papers['paper-a']?.reading).toStrictEqual({ page: 7, updatedAt: 60 });
  });

  it('refuses an identifier another paper owns, changing nothing at all', () => {
    const state = twoPapers();
    const next = projectsReducer(state, {
      type: 'updatePaper',
      paperId: 'paper-a',
      edit: { doi: '10.1000/bert' },
      now: 50,
    });
    expect(next).toBe(state);
    expect(next.papers['paper-a']).not.toHaveProperty('doi');
    expect(next.papers.other?.doi).toBe('10.1000/bert');
  });

  it('returns the same state for an unknown paper', () => {
    const state = twoPapers();
    expect(
      projectsReducer(state, {
        type: 'updatePaper',
        paperId: 'ghost',
        edit: { title: 'x' },
        now: 1,
      }),
    ).toBe(state);
  });

  it('returns the same state when the edit changes nothing', () => {
    const state = twoPapers();
    expect(
      projectsReducer(state, {
        type: 'updatePaper',
        paperId: 'paper-a',
        edit: { title: 'Paper paper-a' },
        now: 1,
      }),
    ).toBe(state);
  });

  it('does not mutate the state it is given', () => {
    const state = deepFreeze(twoPapers());
    const before = structuredClone(state);
    expect(() =>
      projectsReducer(state, {
        type: 'updatePaper',
        paperId: 'paper-a',
        edit: { pdf: PDF, reading: { page: 2, updatedAt: 3 } },
        now: 9,
      }),
    ).not.toThrow();
    expect(state).toStrictEqual(before);
  });
});

describe('projectsReducer: annotations belong to the paper, not the project', () => {
  const SHA = 'c'.repeat(64);

  function makeAnnotation(
    id: string,
    paperId: string,
    overrides: Partial<Annotation> = {},
  ): Annotation {
    return {
      id,
      paperId,
      pdfSha256: SHA,
      page: 1,
      quote: `quote ${id}`,
      prefix: 'before ',
      suffix: ' after',
      rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }],
      kind: 'note',
      note: '',
      origin: 'user',
      sourceLabel: '',
      createdAt: 10,
      updatedAt: 10,
      ...overrides,
    };
  }

  function stateWithAnnotation(): ProjectsState {
    const state = makeState(['a', 'b']);
    return {
      ...state,
      annotations: [makeAnnotation('one', 'paper-a'), makeAnnotation('two', 'paper-b')],
    };
  }

  it('keeps its own list in creation order', () => {
    const next = projectsReducer(stateWithAnnotation(), {
      type: 'addAnnotation',
      annotation: makeAnnotation('three', 'paper-a', { kind: 'question' }),
    });
    expect(next.annotations.map((annotation) => annotation.id)).toStrictEqual([
      'one',
      'two',
      'three',
    ]);
  });

  it('ignores an annotation id that is already there', () => {
    const state = stateWithAnnotation();
    expect(
      projectsReducer(state, {
        type: 'addAnnotation',
        annotation: makeAnnotation('one', 'paper-a'),
      }),
    ).toBe(state);
  });

  it('edits what was written and stamps the time, leaving the anchor alone', () => {
    const state = stateWithAnnotation();
    const next = projectsReducer(state, {
      type: 'updateAnnotation',
      id: 'one',
      edit: { note: 'a thought', kind: 'insight' },
      now: 55,
    });
    const updated = next.annotations.find((annotation) => annotation.id === 'one');
    expect(updated).toMatchObject({ note: 'a thought', kind: 'insight', updatedAt: 55, page: 1 });
    expect(updated?.quote).toBe('quote one');
    expect(next.annotations.find((annotation) => annotation.id === 'two')).toBe(
      state.annotations[1],
    );
  });

  it('returns the same state for an unknown annotation or an empty edit', () => {
    const state = stateWithAnnotation();
    expect(
      projectsReducer(state, {
        type: 'updateAnnotation',
        id: 'ghost',
        edit: { note: 'x' },
        now: 1,
      }),
    ).toBe(state);
    expect(
      projectsReducer(state, {
        type: 'updateAnnotation',
        id: 'one',
        edit: { note: '', kind: 'note' },
        now: 1,
      }),
    ).toBe(state);
  });

  it('removes one annotation and leaves the rest', () => {
    const next = projectsReducer(stateWithAnnotation(), { type: 'removeAnnotation', id: 'one' });
    expect(next.annotations.map((annotation) => annotation.id)).toStrictEqual(['two']);
  });

  it('returns the same state when there is nothing to remove', () => {
    const state = stateWithAnnotation();
    expect(projectsReducer(state, { type: 'removeAnnotation', id: 'ghost' })).toBe(state);
  });

  it('survives the project being deleted', () => {
    const next = projectsReducer(stateWithAnnotation(), { type: 'remove', id: 'a' });
    expect(idsOf(next)).toStrictEqual(['b']);
    expect(next.annotations.map((annotation) => annotation.id)).toStrictEqual(['one', 'two']);
  });

  it('survives the paper being renamed and re-linked elsewhere', () => {
    const renamed = projectsReducer(stateWithAnnotation(), {
      type: 'rename',
      id: 'a',
      name: 'Renamed',
      now: 99,
    });
    const unlinked = projectsReducer(renamed, {
      type: 'unlinkPaper',
      projectId: 'b',
      paperId: 'paper-b',
      now: 99,
    });
    expect(unlinked.annotations).toStrictEqual(renamed.annotations);
  });

  it('does not mutate the state it is given', () => {
    const state = deepFreeze(stateWithAnnotation());
    const before = structuredClone(state);
    expect(() =>
      projectsReducer(state, {
        type: 'addAnnotation',
        annotation: makeAnnotation('three', 'paper-a'),
      }),
    ).not.toThrow();
    expect(state).toStrictEqual(before);
  });
});

describe('projectsReducer: bookmarks are saved places, not notes', () => {
  function makeBookmark(id: string, paperId: string, overrides: Partial<Bookmark> = {}): Bookmark {
    return { id, paperId, page: 1, label: `Place ${id}`, createdAt: 10, ...overrides };
  }

  function stateWithBookmarks(): ProjectsState {
    const state = makeState(['a', 'b']);
    return {
      ...state,
      bookmarks: [
        makeBookmark('one', 'paper-a', { page: 3 }),
        makeBookmark('two', 'paper-b', { page: 7 }),
      ],
    };
  }

  it('adds a bookmark at the end and keeps the existing ones', () => {
    const state = stateWithBookmarks();
    const added = makeBookmark('three', 'paper-a', { page: 9 });
    const next = projectsReducer(state, { type: 'addBookmark', bookmark: added });
    expect(next.bookmarks.map((bookmark) => bookmark.id)).toStrictEqual(['one', 'two', 'three']);
    expect(next.bookmarks[0]).toBe(state.bookmarks[0]);
    expect(next.annotations).toBe(state.annotations);
    expect(next.projects).toBe(state.projects);
  });

  it('allows two bookmarks on the same page of one paper', () => {
    const next = projectsReducer(stateWithBookmarks(), {
      type: 'addBookmark',
      bookmark: makeBookmark('same-page', 'paper-a', { page: 3 }),
    });
    expect(next.bookmarks.filter((bookmark) => bookmark.paperId === 'paper-a')).toHaveLength(2);
  });

  it('ignores a bookmark id that is already there', () => {
    const state = stateWithBookmarks();
    expect(
      projectsReducer(state, {
        type: 'addBookmark',
        bookmark: makeBookmark('one', 'paper-a', { page: 99 }),
      }),
    ).toBe(state);
  });

  it('renames one bookmark without moving it or touching the rest', () => {
    const state = stateWithBookmarks();
    const next = projectsReducer(state, {
      type: 'renameBookmark',
      id: 'one',
      label: '方法比较',
    });
    expect(next.bookmarks.find((bookmark) => bookmark.id === 'one')).toStrictEqual({
      ...makeBookmark('one', 'paper-a', { page: 3 }),
      label: '方法比较',
    });
    expect(next.bookmarks.find((bookmark) => bookmark.id === 'two')).toBe(state.bookmarks[1]);
  });

  it('returns the same state for an unknown bookmark or an unchanged label', () => {
    const state = stateWithBookmarks();
    expect(projectsReducer(state, { type: 'renameBookmark', id: 'ghost', label: 'x' })).toBe(state);
    expect(projectsReducer(state, { type: 'renameBookmark', id: 'one', label: 'Place one' })).toBe(
      state,
    );
  });

  it('removes one bookmark and leaves the rest', () => {
    const next = projectsReducer(stateWithBookmarks(), { type: 'removeBookmark', id: 'one' });
    expect(next.bookmarks.map((bookmark) => bookmark.id)).toStrictEqual(['two']);
  });

  it('returns the same state when there is nothing to remove', () => {
    const state = stateWithBookmarks();
    expect(projectsReducer(state, { type: 'removeBookmark', id: 'ghost' })).toBe(state);
  });

  it('survives the project and the paper reference being removed', () => {
    const removed = projectsReducer(stateWithBookmarks(), { type: 'remove', id: 'b' });
    expect(removed.bookmarks.map((bookmark) => bookmark.id)).toStrictEqual(['one', 'two']);
    const unlinked = projectsReducer(removed, {
      type: 'unlinkPaper',
      projectId: 'a',
      paperId: 'paper-a',
      now: 99,
    });
    expect(unlinked.bookmarks).toStrictEqual(removed.bookmarks);
  });

  it('does not mutate the state it is given', () => {
    const state = deepFreeze(stateWithBookmarks());
    const before = structuredClone(state);
    expect(() =>
      projectsReducer(state, {
        type: 'addBookmark',
        bookmark: makeBookmark('three', 'paper-a'),
      }),
    ).not.toThrow();
    expect(state).toStrictEqual(before);
  });
});
