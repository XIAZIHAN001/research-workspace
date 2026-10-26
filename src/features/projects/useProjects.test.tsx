import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createPaper } from '../../domain/papers';
import { createProjectsStore } from '../../services/projectsStore';
import { useProjects } from './useProjects';

/** A store holding one project, so `referencePaper` has somewhere to link to. */
function storeWithProject(id = 'p1') {
  const store = createProjectsStore(null);
  const project = {
    id,
    name: `Project ${id}`,
    corePaperId: `paper-${id}`,
    relatedPaperIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
  store.dispatch({
    type: 'add',
    project,
    paper: { id: `paper-${id}`, title: `Paper ${id}`, authors: [], createdAt: 1, updatedAt: 1 },
  });
  return store;
}

function setup() {
  const store = storeWithProject();
  const { result } = renderHook(() => useProjects(store));
  return { store, result };
}

const registryOf = (store: ReturnType<typeof storeWithProject>) => store.getSnapshot().state.papers;

const linkedPaperIds = (store: ReturnType<typeof storeWithProject>, projectId = 'p1'): string[] =>
  store.getSnapshot().state.projects.find((p) => p.id === projectId)?.relatedPaperIds ?? [];

describe('useProjects: referencePaper', () => {
  it('creates a paper when nothing identifies an existing one', () => {
    const { store, result } = setup();

    const outcome = result.current.actions.referencePaper('p1', { title: '  Deep Learning ' });

    if (outcome.status !== 'linked') throw new Error(outcome.status);
    expect(outcome.paper.title).toBe('Deep Learning');
    expect(Object.keys(registryOf(store))).toHaveLength(2);
    expect(linkedPaperIds(store)).toStrictEqual([outcome.paper.id]);
  });

  it('normalizes identifiers on the paper it creates', () => {
    const { result } = setup();

    const outcome = result.current.actions.referencePaper('p1', {
      title: 'Attention',
      doi: 'https://doi.org/10.1000/ABC',
      arxivId: 'arXiv:2401.12345v2',
    });

    if (outcome.status !== 'linked') throw new Error(outcome.status);
    expect(outcome.paper.doi).toBe('10.1000/abc');
    expect(outcome.paper.arxivId).toBe('2401.12345');
  });

  it('reuses one paper when both identifiers point at it', () => {
    const { store, result } = setup();
    const created = result.current.actions.referencePaper('p1', {
      title: 'Attention',
      doi: '10.1000/abc',
      arxivId: '2401.12345',
    });
    if (created.status !== 'linked') throw new Error(created.status);

    const again = result.current.actions.referencePaper('p1', {
      title: 'Attention (v2)',
      doi: '10.1000/ABC',
      arxivId: 'arXiv:2401.12345v3',
    });

    expect(again).toStrictEqual({ status: 'linked', paper: created.paper });
    expect(Object.keys(registryOf(store))).toHaveLength(2);
  });

  it('reports a conflict, and changes nothing, when the identifiers point elsewhere', () => {
    const store = storeWithProject();
    const byDoi = createPaper({ title: 'By DOI', doi: '10.1000/abc' }, () => 'doi-paper', 0);
    const byArxiv = createPaper(
      { title: 'By arXiv', arxivId: '2401.12345' },
      () => 'arxiv-paper',
      0,
    );
    if (byDoi === null || byArxiv === null) throw new Error('fixture');
    store.dispatch({ type: 'linkPaper', projectId: 'p1', paper: byDoi, now: 1 });
    store.dispatch({ type: 'linkPaper', projectId: 'p1', paper: byArxiv, now: 1 });
    const before = store.getSnapshot().state;

    const { result } = renderHook(() => useProjects(store));
    const outcome = result.current.actions.referencePaper('p1', {
      title: 'Attention',
      doi: '10.1000/abc',
      arxivId: '2401.12345',
    });

    expect(outcome).toStrictEqual({ status: 'conflict', papers: [byDoi, byArxiv] });
    // Neither existing paper was picked, no third record was created, no link was added.
    expect(store.getSnapshot().state).toBe(before);
  });

  it('links the existing paper without rewriting its identity when metadata arrives later', () => {
    const { store, result } = setup();
    const created = result.current.actions.referencePaper('p1', {
      title: 'Attention',
      doi: '10.1000/abc',
    });
    if (created.status !== 'linked') throw new Error(created.status);
    const originalId = created.paper.id;

    const enriched = result.current.actions.referencePaper('p1', {
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani'],
      year: 2017,
      doi: '10.1000/abc',
      arxivId: '2401.12345',
    });

    expect(enriched.status).toBe('linked');
    if (enriched.status !== 'linked') throw new Error(enriched.status);
    expect(enriched.paper.id).toBe(originalId);
    expect(registryOf(store)[originalId]).toStrictEqual(created.paper);
    expect(Object.keys(registryOf(store))).toHaveLength(2);
  });

  it('refuses input that cannot describe a paper', () => {
    const { store, result } = setup();

    expect(result.current.actions.referencePaper('p1', { title: '   ' })).toStrictEqual({
      status: 'invalid',
    });
    expect(Object.keys(registryOf(store))).toHaveLength(1);
    expect(linkedPaperIds(store)).toStrictEqual([]);
  });

  it('does not merge two papers that only share a title', () => {
    const { store, result } = setup();
    const first = result.current.actions.referencePaper('p1', { title: 'Attention' });
    const second = result.current.actions.referencePaper('p1', { title: 'Attention' });

    if (first.status !== 'linked' || second.status !== 'linked') throw new Error('expected links');
    expect(first.paper.id).not.toBe(second.paper.id);
    expect(Object.keys(registryOf(store))).toHaveLength(3);
  });
});

describe('useProjects: addPapers', () => {
  it('registers a whole bibliography in one write and reuses identifiers inside the batch', () => {
    const { store, result } = setup();
    let dispatches = 0;
    const unsubscribe = store.subscribe(() => {
      dispatches += 1;
    });

    const outcomes = result.current.actions.addPapers([
      { title: 'One', doi: '10.1000/one' },
      { title: 'Two', doi: '10.1000/two' },
      { title: 'One again', doi: '10.1000/ONE' },
    ]);
    unsubscribe();

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['added', 'added', 'added']);
    const first = outcomes[0];
    const third = outcomes[2];
    if (first?.status !== 'added' || third?.status !== 'added') throw new Error('not added');
    expect(third.paper.id).toBe(first.paper.id);
    expect(Object.keys(registryOf(store))).toHaveLength(3);
    expect(dispatches).toBe(1);
  });

  it('reports an identifier conflict inside the batch without adding a paper', () => {
    const { store, result } = setup();
    store.dispatch({
      type: 'registerPapers',
      papers: [
        {
          id: 'by-doi',
          title: 'By DOI',
          authors: [],
          doi: '10.1000/shared',
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'by-arxiv',
          title: 'By arXiv',
          authors: [],
          arxivId: '2401.12345',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const outcomes = result.current.actions.addPapers([
      { title: 'Both', doi: '10.1000/shared', arxivId: '2401.12345' },
    ]);

    expect(outcomes[0]?.status).toBe('conflict');
    expect(Object.keys(registryOf(store))).toHaveLength(3);
  });
});

describe('useProjects: unlinkPaper', () => {
  it('drops the link and keeps the paper in the registry', () => {
    const { store, result } = setup();
    const linked = result.current.actions.referencePaper('p1', { title: 'Attention' });
    if (linked.status !== 'linked') throw new Error(linked.status);

    result.current.actions.unlinkPaper('p1', linked.paper.id);

    expect(linkedPaperIds(store)).toStrictEqual([]);
    expect(registryOf(store)[linked.paper.id]).toStrictEqual(linked.paper);
  });
});
