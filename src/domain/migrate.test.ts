import { describe, expect, it } from 'vitest';
import { migrateStoredPayload, SCHEMA_VERSION, serializeProjects } from './migrate';
import type { Paper } from './papers';
import type { Project } from './project';
import type { ProjectsState } from './projectsState';

type Raw = Record<string, unknown>;

function legacyPaper(id: string, overrides: Raw = {}): Raw {
  return { id, title: `Paper ${id}`, authors: [], ...overrides };
}

function legacyProject(id: string, overrides: Raw = {}): Raw {
  return {
    id,
    name: `Project ${id}`,
    corePaper: legacyPaper(`core-${id}`),
    relatedPapers: [],
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

/** A Phase 0 payload: no version field anywhere. */
function legacyPayload(projects: unknown, selectedId: unknown = null): string {
  return JSON.stringify({ projects, selectedId });
}

/** The Phase 0 fixture the other tests build on: 2 projects, 3 paper references. */
const PHASE_0 = legacyPayload(
  [
    legacyProject('a', {
      name: 'Attention',
      corePaper: legacyPaper('pa', { title: 'Attention Is All You Need', year: 2017 }),
      relatedPapers: [legacyPaper('pb', { title: 'BERT', authors: ['Jacob Devlin'] })],
    }),
    legacyProject('b', {
      name: 'ResNet',
      corePaper: legacyPaper('pc', { title: 'Deep Residual Learning' }),
      relatedPapers: [legacyPaper('pa', { title: 'Attention Is All You Need', year: 2017 })],
    }),
  ],
  'b',
);

describe('migrateStoredPayload: Phase 0 payloads', () => {
  it('reports the version it migrated away from', () => {
    const outcome = migrateStoredPayload(PHASE_0);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.from).toBe(1);
    expect(SCHEMA_VERSION).toBe(2);
  });

  it('keeps every project with its id, name, order and timestamps', () => {
    const outcome = migrateStoredPayload(PHASE_0);
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.state.projects.map((p) => [p.id, p.name, p.createdAt, p.updatedAt])).toEqual([
      ['a', 'Attention', 100, 200],
      ['b', 'ResNet', 100, 200],
    ]);
    expect(outcome.state.selectedId).toBe('b');
  });

  it('turns paper references into ids and registers the papers they point at', () => {
    const outcome = migrateStoredPayload(PHASE_0);
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.state.projects[0]).toStrictEqual({
      id: 'a',
      name: 'Attention',
      corePaperId: 'pa',
      relatedPaperIds: ['pb'],
      createdAt: 100,
      updatedAt: 200,
    });
    expect(Object.keys(outcome.state.papers).sort()).toEqual(['pa', 'pb', 'pc']);
    expect(outcome.state.papers.pa).toStrictEqual({
      id: 'pa',
      title: 'Attention Is All You Need',
      authors: [],
      year: 2017,
      createdAt: 100,
      updatedAt: 100,
    });
  });

  it('registers one paper per id, so two projects can share it', () => {
    const outcome = migrateStoredPayload(PHASE_0);
    if (!outcome.ok) throw new Error(outcome.detail);
    // 'pa' is project a's core paper and project b's related paper.
    expect(Object.keys(outcome.state.papers)).toHaveLength(3);
    expect(outcome.state.projects[0]?.corePaperId).toBe(
      outcome.state.projects[1]?.relatedPaperIds[0],
    );
  });

  it('keeps papers with the same title but different ids apart', () => {
    const raw = legacyPayload([
      legacyProject('a', { corePaper: legacyPaper('pa', { title: 'Same Title' }) }),
      legacyProject('b', { corePaper: legacyPaper('pb', { title: 'Same Title' }) }),
    ]);
    const outcome = migrateStoredPayload(raw);
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(Object.keys(outcome.state.papers)).toHaveLength(2);
  });

  it('drops a related paper that repeats the core paper or an earlier link', () => {
    const raw = legacyPayload([
      legacyProject('a', {
        corePaper: legacyPaper('pa'),
        relatedPapers: [legacyPaper('pa'), legacyPaper('pb'), legacyPaper('pb')],
      }),
    ]);
    const outcome = migrateStoredPayload(raw);
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.state.projects[0]?.relatedPaperIds).toStrictEqual(['pb']);
  });

  it('treats an explicit version 1 exactly like a missing one', () => {
    const raw = JSON.stringify({
      version: 1,
      projects: [legacyProject('a')],
      selectedId: 'a',
    });
    const outcome = migrateStoredPayload(raw);
    expect(outcome.ok && outcome.from).toBe(1);
  });

  it('repairs a selection that points at no project', () => {
    const outcome = migrateStoredPayload(legacyPayload([legacyProject('a')], 'ghost'));
    expect(outcome.ok && outcome.state.selectedId).toBe('a');
  });

  it('does not carry unknown fields into the migrated state', () => {
    const raw = legacyPayload([
      legacyProject('a', { extra: 'x', corePaper: legacyPaper('pa', { note: 'y' }) }),
    ]);
    const outcome = migrateStoredPayload(raw);
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.state.projects[0]).not.toHaveProperty('extra');
    expect(outcome.state.papers.pa).not.toHaveProperty('note');
  });

  it.each([
    { label: 'an empty paper id', project: legacyProject('b', { corePaper: legacyPaper('') }) },
    {
      label: 'an empty related paper id',
      project: legacyProject('b', { relatedPapers: [legacyPaper('')] }),
    },
  ])('rejects a payload with $label as invalid', ({ project }) => {
    const outcome = migrateStoredPayload(legacyPayload([project]));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('invalid');
  });

  it('rejects duplicate project ids instead of merging two projects', () => {
    const raw = legacyPayload([legacyProject('a'), legacyProject('a')]);
    const outcome = migrateStoredPayload(raw);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('invalid');
  });

  it('migrates deterministically: the same payload always yields the same state', () => {
    const first = migrateStoredPayload(PHASE_0);
    const second = migrateStoredPayload(PHASE_0);
    expect(first).toStrictEqual(second);
  });

  it('is idempotent: re-reading its own output changes nothing', () => {
    const migrated = migrateStoredPayload(PHASE_0);
    if (!migrated.ok) throw new Error(migrated.detail);
    const again = migrateStoredPayload(serializeProjects(migrated.state));
    expect(again).toStrictEqual({ ok: true, state: migrated.state, from: SCHEMA_VERSION });
  });
});

describe('migrateStoredPayload: current payloads', () => {
  const pa: Paper = {
    id: 'pa',
    title: 'Attention',
    authors: ['Ashish Vaswani'],
    createdAt: 1,
    updatedAt: 1,
  };
  const pb: Paper = {
    id: 'pb',
    title: 'BERT',
    authors: [],
    doi: '10.1000/abc',
    createdAt: 1,
    updatedAt: 1,
  };
  const project: Project = {
    id: 'a',
    name: 'Attention',
    corePaperId: 'pa',
    relatedPaperIds: ['pb'],
    createdAt: 1,
    updatedAt: 2,
  };
  const state: ProjectsState = { projects: [project], papers: { pa, pb }, selectedId: 'a' };

  it('round-trips through the persisted envelope', () => {
    const outcome = migrateStoredPayload(serializeProjects(state));
    expect(outcome).toStrictEqual({ ok: true, state, from: SCHEMA_VERSION });
  });

  it('always writes the current version into the envelope', () => {
    expect(JSON.parse(serializeProjects(state))).toHaveProperty('version', SCHEMA_VERSION);
  });

  it('rejects a payload whose project points at a paper it does not carry', () => {
    const broken = { ...state, projects: [{ ...project, corePaperId: 'missing' }] };
    const outcome = migrateStoredPayload(JSON.stringify(broken));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('invalid');
  });

  it('rejects a registry entry filed under the wrong id', () => {
    const outcome = migrateStoredPayload(JSON.stringify({ ...state, papers: { wrong: pa } }));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('invalid');
  });
});

describe('migrateStoredPayload: payloads this build cannot use', () => {
  it('reports JSON that does not parse as unreadable', () => {
    const outcome = migrateStoredPayload('{oops');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('unreadable');
  });

  it.each([
    { label: 'a number', raw: '42' },
    { label: 'a string', raw: '"projects"' },
    { label: 'an array', raw: '[]' },
    { label: 'null', raw: 'null' },
  ])('reports $label as invalid', ({ raw }) => {
    const outcome = migrateStoredPayload(raw);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('invalid');
  });

  it.each([
    { label: 'a version that is not a number', raw: '{"version":"2","projects":[]}' },
    { label: 'version zero', raw: '{"version":0,"projects":[]}' },
    { label: 'a fractional version', raw: '{"version":1.5,"projects":[]}' },
  ])('reports $label as invalid', ({ raw }) => {
    const outcome = migrateStoredPayload(raw);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('invalid');
  });

  it('reports a payload with no projects array as invalid', () => {
    const outcome = migrateStoredPayload('{"projects":"nope"}');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('invalid');
  });

  it('reports a newer schema version as unsupported, with the version it found', () => {
    const outcome = migrateStoredPayload('{"version":99,"projects":[],"papers":{}}');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('unsupported-version');
    expect(outcome.ok === false && outcome.reason === 'unsupported-version' && outcome.found).toBe(
      99,
    );
  });
});

describe('migrateStoredPayload: a broken migration table', () => {
  it('reports a missing step for the stored version as a migration failure, not bad data', () => {
    const outcome = migrateStoredPayload(PHASE_0, {});
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('migration-failed');
    expect(outcome.ok === false && outcome.reason === 'migration-failed' && outcome.from).toBe(1);
  });

  it('reports a step that throws as a migration failure', () => {
    const outcome = migrateStoredPayload(PHASE_0, {
      1: () => {
        throw new Error('boom');
      },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.detail).toContain('boom');
  });

  it('reports a step that does not advance the version as a migration failure', () => {
    const outcome = migrateStoredPayload(PHASE_0, { 1: (payload) => payload });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('migration-failed');
  });

  it('reports a step that overshoots the current version as a migration failure', () => {
    const outcome = migrateStoredPayload(PHASE_0, {
      1: (payload) => ({ ...payload, version: SCHEMA_VERSION + 1 }),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('migration-failed');
  });

  it('reports a step whose output does not validate as a migration failure', () => {
    const outcome = migrateStoredPayload(PHASE_0, { 1: () => ({ version: 2, projects: 'nope' }) });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('migration-failed');
    expect(outcome.ok === false && outcome.detail).toContain('invalid state');
  });
});
