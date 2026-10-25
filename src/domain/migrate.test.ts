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
    expect(SCHEMA_VERSION).toBe(7);
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
  const state: ProjectsState = {
    projects: [project],
    papers: { pa, pb },
    annotations: [],
    bookmarks: [],
    selectedId: 'a',
  };

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
    // The step claims to reach the current version, but what it produced is not a state.
    const outcome = migrateStoredPayload(PHASE_0, {
      1: (payload) => ({ ...payload, version: SCHEMA_VERSION, projects: 'nope' }),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('migration-failed');
    expect(outcome.ok === false && outcome.detail).toContain('invalid state');
  });
});

describe('migrateStoredPayload: a legacy id is not proof of identity', () => {
  const migrated = (raw: string): ProjectsState => {
    const outcome = migrateStoredPayload(raw);
    if (!outcome.ok) throw new Error(outcome.detail);
    return outcome.state;
  };

  /** Two projects whose core paper records carry the same id but different metadata. */
  function sharedIdPayload(first: Raw, second: Raw): string {
    return legacyPayload([
      legacyProject('a', { corePaper: legacyPaper('shared', first) }),
      legacyProject('b', { corePaper: legacyPaper('shared', second) }),
    ]);
  }

  it('keeps records that share an id but disagree on the title apart', () => {
    const state = migrated(sharedIdPayload({ title: 'Attention' }, { title: 'ResNet' }));
    expect(Object.keys(state.papers)).toStrictEqual(['shared', 'shared#1']);
    expect(state.papers.shared?.title).toBe('Attention');
    expect(state.papers['shared#1']?.title).toBe('ResNet');
    expect(state.projects.map((p) => p.corePaperId)).toStrictEqual(['shared', 'shared#1']);
  });

  it.each([
    { label: 'differing authors', second: { authors: ['Kaiming He'] } },
    { label: 'a differing year', second: { year: 2017 } },
    { label: 'an added year', second: { year: 0 } },
  ])('splits records that share an id and title but have $label', ({ second }) => {
    const state = migrated(
      sharedIdPayload({ title: 'Attention' }, { title: 'Attention', ...second }),
    );
    expect(Object.keys(state.papers)).toStrictEqual(['shared', 'shared#1']);
  });

  it('splits records whose authors differ only by one extra name', () => {
    const state = migrated(
      sharedIdPayload(
        { title: 'Attention', authors: ['Ashish Vaswani'] },
        { title: 'Attention', authors: ['Ashish Vaswani', 'Noam Shazeer'] },
      ),
    );
    expect(Object.keys(state.papers)).toHaveLength(2);
  });

  it('keeps exact duplicates as one paper, as it always did', () => {
    const state = migrated(
      sharedIdPayload(
        { title: 'Attention', authors: ['Ashish Vaswani'], year: 2017 },
        { title: 'Attention', authors: ['Ashish Vaswani'], year: 2017 },
      ),
    );
    expect(Object.keys(state.papers)).toStrictEqual(['shared']);
    expect(state.projects.map((p) => p.corePaperId)).toStrictEqual(['shared', 'shared']);
  });

  it('never loses a record: every split paper keeps its own metadata and a reference', () => {
    const state = migrated(
      sharedIdPayload({ title: 'Attention', authors: ['A'] }, { title: 'BERT', year: 2018 }),
    );
    expect(
      Object.values(state.papers).map((paper) => [paper.title, paper.authors, paper.year]),
    ).toStrictEqual([
      ['Attention', ['A'], undefined],
      ['BERT', [], 2018],
    ]);
    for (const project of state.projects) {
      expect(state.papers[project.corePaperId]).toBeDefined();
    }
  });

  it('gives split records ids that do not collide with a plain legacy id', () => {
    // The payload already uses `shared#1` as an id of its own, so the record split off
    // `shared` must not take it. Which record gives way is fixed by traversal order, but
    // what matters is that no id is shared and no paper is lost.
    const raw = legacyPayload([
      legacyProject('a', { corePaper: legacyPaper('shared', { title: 'Attention' }) }),
      legacyProject('b', { corePaper: legacyPaper('shared', { title: 'ResNet' }) }),
      legacyProject('c', { corePaper: legacyPaper('shared#1', { title: 'BERT' }) }),
    ]);
    const state = migrated(raw);

    const ids = Object.keys(state.papers);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(
      Object.values(state.papers)
        .map((paper) => paper.title)
        .sort(),
    ).toStrictEqual(['Attention', 'BERT', 'ResNet']);
    expect(state.projects.map((p) => p.corePaperId)).toStrictEqual(ids);
    for (const project of state.projects) {
      expect(state.papers[project.corePaperId]).toBeDefined();
    }
    // Deterministic: the same payload always assigns the same ids to the same titles.
    const titlesById = (s: ProjectsState): [string, string][] =>
      s.projects.map((p) => [p.corePaperId, s.papers[p.corePaperId]?.title ?? '']);
    expect(titlesById(migrated(raw))).toStrictEqual(titlesById(state));
  });

  it('stays deterministic and idempotent when it splits records', () => {
    const raw = sharedIdPayload({ title: 'Attention' }, { title: 'ResNet' });
    const first = migrateStoredPayload(raw);
    expect(migrateStoredPayload(raw)).toStrictEqual(first);
    if (!first.ok) throw new Error(first.detail);
    expect(migrateStoredPayload(serializeProjects(first.state))).toStrictEqual({
      ok: true,
      state: first.state,
      from: SCHEMA_VERSION,
    });
  });

  it('still migrates a repeated reference to the same record as a single paper', () => {
    const raw = legacyPayload([
      legacyProject('a', {
        corePaper: legacyPaper('shared', { title: 'Attention' }),
        relatedPapers: [legacyPaper('shared', { title: 'Attention' })],
      }),
    ]);
    const state = migrated(raw);
    expect(Object.keys(state.papers)).toStrictEqual(['shared']);
    expect(state.projects[0]?.relatedPaperIds).toStrictEqual([]);
  });

  it('keeps papers that share a title but were never the same id apart, as before', () => {
    const raw = legacyPayload([
      legacyProject('a', { corePaper: legacyPaper('pa', { title: 'Same Title' }) }),
      legacyProject('b', { corePaper: legacyPaper('pb', { title: 'Same Title' }) }),
    ]);
    const state = migrated(raw);
    expect(Object.keys(state.papers)).toStrictEqual(['pa', 'pb']);
  });
});

describe('migrateStoredPayload: v2 → current', () => {
  const PROJECT = {
    id: 'p1',
    name: 'Attention',
    corePaperId: 'pa',
    relatedPaperIds: [],
    createdAt: 1,
    updatedAt: 2,
  };
  const PAPER_V2 = {
    id: 'pa',
    title: 'Attention',
    authors: ['Ashish Vaswani'],
    doi: '10.1000/abc',
    createdAt: 1,
    updatedAt: 1,
  };
  const V2_PAYLOAD = JSON.stringify({
    version: 2,
    projects: [PROJECT],
    papers: { pa: PAPER_V2 },
    selectedId: 'p1',
  });

  it('walks the version chain to the current one and changes nothing else', () => {
    const outcome = migrateStoredPayload(V2_PAYLOAD);
    expect(outcome.ok && outcome.from).toBe(2);
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.state).toStrictEqual({
      projects: [PROJECT],
      papers: { pa: PAPER_V2 },
      annotations: [],
      bookmarks: [],
      selectedId: 'p1',
    });
  });

  it('is idempotent: the payload it writes is already current', () => {
    const migrated = migrateStoredPayload(V2_PAYLOAD);
    if (!migrated.ok) throw new Error(migrated.detail);
    expect(migrateStoredPayload(serializeProjects(migrated.state))).toStrictEqual({
      ok: true,
      state: migrated.state,
      from: SCHEMA_VERSION,
    });
  });

  it('keeps a PDF binding and a reading position already present', () => {
    const pdf = {
      sha256: 'a'.repeat(64),
      name: 'attention.pdf',
      bytes: 12,
      pageCount: 9,
      addedAt: 5,
    };
    const raw = JSON.stringify({
      version: 2,
      projects: [PROJECT],
      papers: { pa: { ...PAPER_V2, pdf, reading: { page: 3, updatedAt: 8 } } },
      selectedId: 'p1',
    });
    const outcome = migrateStoredPayload(raw);
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.state.papers.pa).toStrictEqual({
      ...PAPER_V2,
      pdf,
      reading: { page: 3, updatedAt: 8 },
    });
  });

  it('reports a payload that claims v2 but is not one as invalid', () => {
    const outcome = migrateStoredPayload('{"version":2,"projects":"nope"}');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('invalid');
  });

  it('reports a payload from the next version as unsupported', () => {
    const outcome = migrateStoredPayload(
      JSON.stringify({
        version: SCHEMA_VERSION + 1,
        projects: [],
        papers: {},
        selectedId: null,
      }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('unsupported-version');
    expect(outcome.ok === false && outcome.reason === 'unsupported-version' && outcome.found).toBe(
      SCHEMA_VERSION + 1,
    );
  });
});

describe('migrateStoredPayload: v4 → current', () => {
  const PAPER = {
    id: 'pa',
    title: 'Attention',
    authors: ['Ashish Vaswani'],
    createdAt: 1,
    updatedAt: 1,
  };
  const PROJECT = {
    id: 'p1',
    name: 'Reading',
    corePaperId: 'pa',
    relatedPaperIds: [],
    createdAt: 1,
    updatedAt: 2,
  };
  const NOTE_V4 = {
    id: 'n1',
    paperId: 'pa',
    pdfSha256: 'a'.repeat(64),
    page: 4,
    quote: 'the rotated attention mechanism',
    prefix: 'we replace ',
    suffix: ' which lets',
    rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }],
    kind: 'insight',
    note: '作者用旋转替换了绝对位置编码。',
    createdAt: 5,
    updatedAt: 6,
  };
  const V4_PAYLOAD = JSON.stringify({
    version: 4,
    projects: [PROJECT],
    papers: { pa: PAPER },
    annotations: [NOTE_V4],
    selectedId: 'p1',
  });

  it('stamps every existing note as the reader’s own work', () => {
    const outcome = migrateStoredPayload(V4_PAYLOAD);
    expect(outcome.ok && outcome.from).toBe(4);
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.state.annotations).toStrictEqual([
      { ...NOTE_V4, origin: 'user', sourceLabel: '' },
    ]);
  });

  it('leaves every other field alone', () => {
    const outcome = migrateStoredPayload(V4_PAYLOAD);
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.state.projects).toStrictEqual([PROJECT]);
    expect(outcome.state.papers).toStrictEqual({ pa: PAPER });
    expect(outcome.state.selectedId).toBe('p1');
  });

  it('carries a hand-written assistant note through instead of relabelling it', () => {
    const raw = JSON.stringify({
      ...JSON.parse(V4_PAYLOAD),
      annotations: [{ ...NOTE_V4, origin: 'assistant', sourceLabel: 'DeepSeek deepseek-flash' }],
    });
    const outcome = migrateStoredPayload(raw);
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.state.annotations[0]?.origin).toBe('assistant');
    expect(outcome.state.annotations[0]?.sourceLabel).toBe('DeepSeek deepseek-flash');
  });

  it('is idempotent: the payload it writes is already current', () => {
    const migrated = migrateStoredPayload(V4_PAYLOAD);
    if (!migrated.ok) throw new Error(migrated.detail);
    expect(migrateStoredPayload(serializeProjects(migrated.state))).toStrictEqual({
      ok: true,
      state: migrated.state,
      from: SCHEMA_VERSION,
    });
  });

  it('rejects an unknown origin rather than defaulting it to the reader', () => {
    const raw = JSON.stringify({
      ...JSON.parse(V4_PAYLOAD),
      annotations: [{ ...NOTE_V4, origin: 'claude' }],
    });
    const outcome = migrateStoredPayload(raw);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('invalid');
  });

  it('rejects an assistant note with no provenance to show the reader', () => {
    const raw = JSON.stringify({
      ...JSON.parse(V4_PAYLOAD),
      annotations: [{ ...NOTE_V4, origin: 'assistant' }],
    });
    const outcome = migrateStoredPayload(raw);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('invalid');
  });
});

describe('migrateStoredPayload: v5 → current', () => {
  const PAPER = {
    id: 'pa',
    title: 'Attention',
    authors: ['Ashish Vaswani'],
    createdAt: 1,
    updatedAt: 1,
  };
  const PROJECT = {
    id: 'p1',
    name: 'Reading',
    corePaperId: 'pa',
    relatedPaperIds: [],
    createdAt: 1,
    updatedAt: 2,
  };
  const NOTE = {
    id: 'n1',
    paperId: 'pa',
    pdfSha256: 'a'.repeat(64),
    page: 4,
    quote: 'the rotated attention mechanism',
    prefix: 'we replace ',
    suffix: ' which lets',
    rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }],
    kind: 'insight',
    note: '作者用旋转替换了绝对位置编码。',
    origin: 'user',
    sourceLabel: '',
    createdAt: 5,
    updatedAt: 6,
  };
  const V5_PAYLOAD = JSON.stringify({
    version: 5,
    projects: [PROJECT],
    papers: { pa: PAPER },
    annotations: [NOTE],
    selectedId: 'p1',
  });

  it('adds an empty bookmark list and reports the version it came from', () => {
    const outcome = migrateStoredPayload(V5_PAYLOAD);
    expect(outcome.ok && outcome.from).toBe(5);
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.state.bookmarks).toStrictEqual([]);
  });

  it('leaves the papers, notes and selection alone', () => {
    const outcome = migrateStoredPayload(V5_PAYLOAD);
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.state.projects).toStrictEqual([PROJECT]);
    expect(outcome.state.papers).toStrictEqual({ pa: PAPER });
    expect(outcome.state.annotations).toStrictEqual([NOTE]);
    expect(outcome.state.selectedId).toBe('p1');
  });

  it('keeps tags and a reading status the payload already carries', () => {
    const raw = JSON.stringify({
      ...JSON.parse(V5_PAYLOAD),
      papers: {
        pa: { ...PAPER, tags: [' Transformer ', 'transformer', 'Attention'], status: 'reading' },
      },
    });
    const outcome = migrateStoredPayload(raw);
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.state.papers.pa?.tags).toStrictEqual(['Transformer', 'Attention']);
    expect(outcome.state.papers.pa?.status).toBe('reading');
  });

  it('is idempotent: the payload it writes is already current', () => {
    const migrated = migrateStoredPayload(V5_PAYLOAD);
    if (!migrated.ok) throw new Error(migrated.detail);
    expect(migrateStoredPayload(serializeProjects(migrated.state))).toStrictEqual({
      ok: true,
      state: migrated.state,
      from: SCHEMA_VERSION,
    });
  });
});

describe('v6 → v7: question resolutions', () => {
  const PAPER = {
    id: 'pa',
    title: 'Attention Is All You Need',
    authors: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const PROJECT = {
    id: 'p1',
    name: '阅读',
    corePaperId: 'pa',
    relatedPaperIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const base = {
    version: 6,
    projects: [PROJECT],
    papers: { pa: PAPER },
    annotations: [
      {
        id: 'an1',
        paperId: 'pa',
        pdfSha256: 'a'.repeat(64),
        page: 2,
        quote: 'what does multi-head buy us',
        prefix: 'we ask ',
        suffix: ' in return',
        rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }],
        kind: 'question',
        note: '',
        origin: 'user',
        sourceLabel: '',
        createdAt: 5,
        updatedAt: 6,
      },
    ],
    bookmarks: [],
    selectedId: 'p1',
  };

  it('reports the version it came from and changes nothing else', () => {
    const outcome = migrateStoredPayload(JSON.stringify(base));
    expect(outcome.ok && outcome.from).toBe(6);
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.state.annotations[0]?.resolvedAt).toBeUndefined();
    expect(outcome.state.bookmarks).toStrictEqual([]);
  });

  it('keeps a resolution the payload already carries', () => {
    const payload = JSON.stringify({
      ...base,
      annotations: [{ ...base.annotations[0], resolvedAt: 42 }],
    });
    const outcome = migrateStoredPayload(payload);
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.state.annotations[0]?.resolvedAt).toBe(42);
  });

  it('rejects a resolution that is not a timestamp', () => {
    const payload = JSON.stringify({
      ...base,
      annotations: [{ ...base.annotations[0], resolvedAt: 'soon' }],
    });
    const outcome = migrateStoredPayload(payload);
    expect(outcome.ok).toBe(false);
  });
});
