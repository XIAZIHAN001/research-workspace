import { describe, expect, it } from 'vitest';
import { parseLegacyState, parseProjectsState, type LegacyProjectsState } from './parse';

type Raw = Record<string, unknown>;

function rawPaper(id: string, overrides: Raw = {}): Raw {
  return { id, title: `Paper ${id}`, authors: [], createdAt: 1, updatedAt: 2, ...overrides };
}

function rawProject(id: string, overrides: Raw = {}): Raw {
  return {
    id,
    name: `Project ${id}`,
    corePaperId: `core-${id}`,
    relatedPaperIds: [],
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

function rawState(
  projects: unknown,
  papers: unknown,
  selectedId: unknown = null,
  annotations: unknown = [],
): Raw {
  return { projects, papers, annotations, bookmarks: [], glossary: [], selectedId };
}

/** A registry that matches the default project fixture. */
function registryOf(...ids: string[]): Raw {
  return Object.fromEntries(ids.map((id) => [id, rawPaper(id)]));
}

function without(source: Raw, key: string): Raw {
  return Object.fromEntries(Object.entries(source).filter(([name]) => name !== key));
}

describe('parseProjectsState (current schema)', () => {
  describe('well-formed input', () => {
    it('accepts a valid state and returns it', () => {
      const raw = rawState(
        [rawProject('a', { relatedPaperIds: ['rel-a'] }), rawProject('b')],
        registryOf('core-a', 'rel-a', 'core-b'),
        'b',
      );
      expect(parseProjectsState(raw)).toStrictEqual(raw);
    });

    it('accepts an empty state', () => {
      expect(parseProjectsState(rawState([], {}))).toStrictEqual({
        projects: [],
        papers: {},
        annotations: [],
        bookmarks: [],
        glossary: [],
        selectedId: null,
      });
    });

    it('keeps every optional paper field', () => {
      const papers = {
        'core-a': rawPaper('core-a', {
          year: 2017,
          doi: '10.1000/abc',
          arxivId: '2401.12345',
          authors: ['Ashish Vaswani'],
        }),
      };
      const parsed = parseProjectsState(rawState([rawProject('a')], papers, 'a'));
      expect(parsed?.papers['core-a']).toStrictEqual({
        id: 'core-a',
        title: 'Paper core-a',
        authors: ['Ashish Vaswani'],
        year: 2017,
        doi: '10.1000/abc',
        arxivId: '2401.12345',
        createdAt: 1,
        updatedAt: 2,
      });
    });

    it.each([
      { label: 'year', overrides: { year: '2017' } },
      { label: 'doi', overrides: { doi: 10 } },
      { label: 'arxivId', overrides: { arxivId: null } },
    ])('drops a $label of the wrong type instead of failing', ({ overrides }) => {
      const papers = { 'core-a': rawPaper('core-a', overrides) };
      const parsed = parseProjectsState(rawState([rawProject('a')], papers, 'a'));
      expect(parsed?.papers['core-a']).toStrictEqual({
        id: 'core-a',
        title: 'Paper core-a',
        authors: [],
        createdAt: 1,
        updatedAt: 2,
      });
    });

    it('copies the related paper list rather than sharing the parsed array', () => {
      const raw = rawState(
        [rawProject('a', { relatedPaperIds: ['rel-a'] })],
        registryOf('core-a', 'rel-a'),
        'a',
      );
      const parsed = parseProjectsState(raw);
      expect(parsed?.projects[0]?.relatedPaperIds).toStrictEqual(['rel-a']);
      expect(parsed?.projects[0]?.relatedPaperIds).not.toBe(
        (raw.projects as Raw[])[0]?.relatedPaperIds,
      );
    });
  });

  describe('hostile input', () => {
    const valid = (): Raw => rawState([rawProject('a')], registryOf('core-a'), 'a');

    it.each([
      { label: 'null', value: null },
      { label: 'undefined', value: undefined },
      { label: 'a number', value: 42 },
      { label: 'a string', value: 'text' },
      { label: 'an array', value: [rawProject('a')] },
    ])('rejects a root that is $label', ({ value }) => {
      expect(parseProjectsState(value)).toBeNull();
    });

    it.each([
      { label: 'missing', projects: undefined },
      { label: 'null', projects: null },
      { label: 'an object', projects: {} },
      { label: 'a string', projects: 'a' },
    ])('rejects a projects field that is $label', ({ projects }) => {
      expect(parseProjectsState(rawState(projects, {}))).toBeNull();
    });

    it.each([
      { label: 'missing', papers: undefined },
      { label: 'null', papers: null },
      { label: 'an array', papers: [] },
      { label: 'a string', papers: 'papers' },
    ])('rejects a papers registry that is $label', ({ papers }) => {
      expect(parseProjectsState(rawState([], papers))).toBeNull();
    });

    it.each(['id', 'name', 'corePaperId', 'relatedPaperIds', 'createdAt', 'updatedAt'])(
      'rejects a project that lacks %s',
      (key) => {
        const project = without(rawProject('a'), key);
        expect(parseProjectsState(rawState([project], registryOf('core-a'), 'a'))).toBeNull();
      },
    );

    it.each([
      { label: 'id', overrides: { id: 7 } },
      { label: 'name', overrides: { name: null } },
      { label: 'corePaperId', overrides: { corePaperId: 5 } },
      { label: 'relatedPaperIds', overrides: { relatedPaperIds: 'rel' } },
      { label: 'a related paper id', overrides: { relatedPaperIds: [7] } },
      { label: 'createdAt', overrides: { createdAt: '10' } },
      { label: 'updatedAt', overrides: { updatedAt: undefined } },
    ])('rejects a project whose $label has the wrong type', ({ overrides }) => {
      expect(
        parseProjectsState(rawState([rawProject('a', overrides)], registryOf('core-a'), 'a')),
      ).toBeNull();
    });

    it.each(['id', 'title', 'authors', 'createdAt', 'updatedAt'])(
      'rejects a paper that lacks %s',
      (key) => {
        const paper = without(rawPaper('core-a'), key);
        expect(
          parseProjectsState(rawState([rawProject('a')], { 'core-a': paper }, 'a')),
        ).toBeNull();
      },
    );

    it('rejects the whole state when a single project is bad', () => {
      const bad = rawProject('b', { name: 42 });
      const raw = rawState([rawProject('a'), bad], registryOf('core-a', 'core-b'), 'a');
      expect(parseProjectsState(raw)).toBeNull();
    });

    it('rejects the whole state when a single paper is bad', () => {
      const papers = { ...registryOf('core-a'), extra: rawPaper('extra', { authors: 'Ada' }) };
      expect(parseProjectsState(rawState([rawProject('a')], papers, 'a'))).toBeNull();
    });

    it('rejects a registry entry filed under a different id than its own', () => {
      const papers = { alias: rawPaper('core-a') };
      expect(parseProjectsState(rawState([rawProject('a')], papers, 'a'))).toBeNull();
    });

    it('does not carry unknown fields through', () => {
      const raw = rawState(
        [rawProject('a', { extra: 'x' })],
        { 'core-a': rawPaper('core-a', { note: 'y' }) },
        'a',
      );
      const parsed = parseProjectsState(raw);
      expect(parsed?.projects[0]).not.toHaveProperty('extra');
      expect(parsed?.papers['core-a']).not.toHaveProperty('note');
    });

    it('is not fooled by prototype keys in the payload', () => {
      const payload: unknown = JSON.parse(
        '{"projects":[],"papers":{},"annotations":[],"selectedId":null,"__proto__":{"polluted":true}}',
      );
      expect(parseProjectsState(payload)).toStrictEqual({
        projects: [],
        papers: {},
        annotations: [],
        bookmarks: [],
        glossary: [],
        selectedId: null,
      });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('accepts a state that carries a version field, ignoring it', () => {
      expect(parseProjectsState({ ...valid(), version: 2 })).toStrictEqual(
        parseProjectsState(valid()),
      );
    });
  });

  describe('project to paper consistency', () => {
    it('rejects a core paper that is not in the registry', () => {
      expect(parseProjectsState(rawState([rawProject('a')], {}, 'a'))).toBeNull();
    });

    it('rejects a related paper that is not in the registry', () => {
      const raw = rawState(
        [rawProject('a', { relatedPaperIds: ['rel-a'] })],
        registryOf('core-a'),
        'a',
      );
      expect(parseProjectsState(raw)).toBeNull();
    });

    it('rejects a project that lists its core paper as related too', () => {
      const raw = rawState(
        [rawProject('a', { relatedPaperIds: ['core-a'] })],
        registryOf('core-a'),
        'a',
      );
      expect(parseProjectsState(raw)).toBeNull();
    });

    it('rejects a repeated related paper in the same project', () => {
      const raw = rawState(
        [rawProject('a', { relatedPaperIds: ['rel-a', 'rel-a'] })],
        registryOf('core-a', 'rel-a'),
        'a',
      );
      expect(parseProjectsState(raw)).toBeNull();
    });

    it('rejects two projects sharing an id', () => {
      const raw = rawState([rawProject('a'), rawProject('a')], registryOf('core-a'), 'a');
      expect(parseProjectsState(raw)).toBeNull();
    });

    it('rejects an empty core paper id', () => {
      const raw = rawState([rawProject('a', { corePaperId: '' })], registryOf(''), 'a');
      expect(parseProjectsState(raw)).toBeNull();
    });

    it('keeps a registry paper that no project references', () => {
      const papers = registryOf('core-a', 'orphan');
      const parsed = parseProjectsState(rawState([rawProject('a')], papers, 'a'));
      expect(Object.keys(parsed?.papers ?? {})).toStrictEqual(['core-a', 'orphan']);
    });
  });

  describe('selection repair', () => {
    it('keeps a valid selection', () => {
      const raw = rawState([rawProject('a'), rawProject('b')], registryOf('core-a', 'core-b'), 'b');
      expect(parseProjectsState(raw)?.selectedId).toBe('b');
    });

    it('falls back to the first project when the selection is unknown', () => {
      const raw = rawState(
        [rawProject('a'), rawProject('b')],
        registryOf('core-a', 'core-b'),
        'ghost',
      );
      expect(parseProjectsState(raw)?.selectedId).toBe('a');
    });

    it.each([
      { label: 'null', selectedId: null },
      { label: 'missing', selectedId: undefined },
      { label: 'a number', selectedId: 5 },
      { label: 'an object', selectedId: {} },
    ])('falls back to the first project when selectedId is $label', ({ selectedId }) => {
      const raw = rawState(
        [rawProject('a'), rawProject('b')],
        registryOf('core-a', 'core-b'),
        selectedId,
      );
      expect(parseProjectsState(raw)?.selectedId).toBe('a');
    });

    it('selects nothing when there are no projects, whatever selectedId says', () => {
      expect(parseProjectsState(rawState([], {}, 'a'))?.selectedId).toBeNull();
    });
  });
});

describe('parseProjectsState: paper tags, reading status and bookmarks', () => {
  const valid = (): Raw => rawState([rawProject('a')], registryOf('core-a'), 'a');

  it('keeps tags normalized, deduplicated and bounded', () => {
    const papers = {
      'core-a': rawPaper('core-a', { tags: ['  Transformer ', 'transformer', '', 'Attention'] }),
    };
    const parsed = parseProjectsState(rawState([rawProject('a')], papers, 'a'));
    expect(parsed?.papers['core-a']?.tags).toStrictEqual(['Transformer', 'Attention']);
  });

  it('drops a malformed tag list instead of the whole paper', () => {
    const papers = { 'core-a': rawPaper('core-a', { tags: 'attention' }) };
    const parsed = parseProjectsState(rawState([rawProject('a')], papers, 'a'));
    expect(parsed?.papers['core-a']).toStrictEqual(rawPaper('core-a'));
  });

  it.each([
    { label: 'a known status', status: 'reading', kept: true },
    { label: 'an unknown status', status: 'archived', kept: false },
    { label: 'a non-string status', status: 3, kept: false },
  ])('keeps $label only when this build knows it', ({ status, kept }) => {
    const papers = { 'core-a': rawPaper('core-a', { status }) };
    const parsed = parseProjectsState(rawState([rawProject('a')], papers, 'a'));
    expect(parsed?.papers['core-a']).toStrictEqual(
      kept ? { ...rawPaper('core-a'), status } : rawPaper('core-a'),
    );
  });

  it('round-trips a bookmark and drops unknown fields', () => {
    const bookmark = { id: 'b1', paperId: 'core-a', page: 3, label: '方法', createdAt: 7 };
    const parsed = parseProjectsState({
      ...valid(),
      bookmarks: [{ ...bookmark, extra: 'x' }],
    });
    expect(parsed?.bookmarks).toStrictEqual([bookmark]);
  });

  it('treats a missing bookmark list as none', () => {
    expect(parseProjectsState(without(valid(), 'bookmarks'))?.bookmarks).toStrictEqual([]);
  });

  it.each([
    { label: 'an object', bookmarks: {} },
    { label: 'a string', bookmarks: 'b1' },
  ])('rejects a bookmark list that is $label', ({ bookmarks }) => {
    expect(parseProjectsState({ ...valid(), bookmarks })).toBeNull();
  });

  it.each([
    { label: 'a paper that is not in the registry', overrides: { paperId: 'ghost' } },
    { label: 'a page below the first', overrides: { page: 0 } },
    { label: 'a fractional page', overrides: { page: 1.5 } },
    { label: 'a missing label', overrides: { label: undefined } },
    { label: 'a non-numeric createdAt', overrides: { createdAt: '7' } },
    { label: 'an empty id', overrides: { id: '' } },
  ])('rejects a bookmark with $label', ({ overrides }) => {
    const bookmark = {
      id: 'b1',
      paperId: 'core-a',
      page: 3,
      label: '方法',
      createdAt: 7,
      ...overrides,
    };
    expect(parseProjectsState({ ...valid(), bookmarks: [bookmark] })).toBeNull();
  });

  it('rejects two bookmarks sharing an id', () => {
    const bookmark = { id: 'b1', paperId: 'core-a', page: 3, label: '方法', createdAt: 7 };
    expect(
      parseProjectsState({ ...valid(), bookmarks: [bookmark, { ...bookmark, page: 4 }] }),
    ).toBeNull();
  });

  it('allows two bookmarks on the same page of one paper', () => {
    const bookmark = { id: 'b1', paperId: 'core-a', page: 3, label: '方法', createdAt: 7 };
    const parsed = parseProjectsState({
      ...valid(),
      bookmarks: [bookmark, { ...bookmark, id: 'b2' }],
    });
    expect(parsed?.bookmarks).toHaveLength(2);
  });
});

/* The Phase 0 shape: only the 1→2 migration reads it, but it must stay strictly validated. */

function legacyPaper(id: string, overrides: Raw = {}): Raw {
  return { id, title: 'A Paper', authors: ['Ada Lovelace'], ...overrides };
}

function legacyProject(id: string, overrides: Raw = {}): Raw {
  return {
    id,
    name: `Project ${id}`,
    corePaper: legacyPaper(`core-${id}`),
    relatedPapers: [legacyPaper(`rel-${id}`)],
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

function legacyState(projects: unknown, selectedId: unknown = null): Raw {
  return { projects, selectedId };
}

describe('parseLegacyState (schema 1)', () => {
  describe('well-formed input', () => {
    it('accepts a valid state and returns it unchanged', () => {
      const raw = legacyState([legacyProject('a'), legacyProject('b')], 'b');
      expect(parseLegacyState(raw)).toStrictEqual(raw);
    });

    it('survives a JSON round trip of a real state', () => {
      const state: LegacyProjectsState = {
        projects: [
          {
            id: 'p1',
            name: 'Attention',
            corePaper: { id: 'c1', title: 'Attention', authors: ['A', 'B'], year: 2017 },
            relatedPapers: [{ id: 'r1', title: 'BERT', authors: [] }],
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        selectedId: 'p1',
      };
      expect(parseLegacyState(JSON.parse(JSON.stringify(state)))).toStrictEqual(state);
    });

    it('accepts an empty project list', () => {
      expect(parseLegacyState(legacyState([]))).toStrictEqual({ projects: [], selectedId: null });
    });

    it('accepts a project without related papers and a paper without authors', () => {
      const project = legacyProject('a', {
        relatedPapers: [],
        corePaper: legacyPaper('core-a', { authors: [] }),
      });
      expect(parseLegacyState(legacyState([project], 'a'))?.projects[0]).toMatchObject({
        relatedPapers: [],
        corePaper: { authors: [] },
      });
    });

    it.each([
      { label: 'a number', year: 2017, kept: true },
      { label: 'a numeric string', year: '2017', kept: false },
      { label: 'null', year: null, kept: false },
      { label: 'an object', year: {}, kept: false },
    ])('handles a paper year given as $label', ({ year, kept }) => {
      const project = legacyProject('a', { corePaper: legacyPaper('core-a', { year }) });
      const base = { id: 'core-a', title: 'A Paper', authors: ['Ada Lovelace'] };
      const core = parseLegacyState(legacyState([project], 'a'))?.projects[0]?.corePaper;
      expect(core).toStrictEqual(kept ? { ...base, year } : base);
    });
  });

  describe('hostile input', () => {
    it.each([
      { label: 'null', value: null },
      { label: 'undefined', value: undefined },
      { label: 'a number', value: 42 },
      { label: 'a string', value: 'text' },
      { label: 'an array', value: [legacyProject('a')] },
    ])('rejects a root that is $label', ({ value }) => {
      expect(parseLegacyState(value)).toBeNull();
    });

    it.each([
      { label: 'missing', projects: undefined },
      { label: 'null', projects: null },
      { label: 'an object', projects: {} },
      { label: 'a string', projects: 'a' },
    ])('rejects a projects field that is $label', ({ projects }) => {
      expect(parseLegacyState(legacyState(projects))).toBeNull();
    });

    it.each(['id', 'name', 'corePaper', 'relatedPapers', 'createdAt', 'updatedAt'])(
      'rejects a project that lacks %s',
      (key) => {
        expect(parseLegacyState(legacyState([without(legacyProject('a'), key)], 'a'))).toBeNull();
      },
    );

    it.each([
      { label: 'id', overrides: { id: 7 } },
      { label: 'name', overrides: { name: null } },
      { label: 'createdAt', overrides: { createdAt: '10' } },
      { label: 'updatedAt', overrides: { updatedAt: undefined } },
      { label: 'corePaper', overrides: { corePaper: 'paper' } },
      { label: 'relatedPapers', overrides: { relatedPapers: 'none' } },
    ])('rejects a project whose $label has the wrong type', ({ overrides }) => {
      expect(parseLegacyState(legacyState([legacyProject('a', overrides)], 'a'))).toBeNull();
    });

    it('rejects a project array that holds a non-object entry', () => {
      expect(parseLegacyState(legacyState([legacyProject('a'), null], 'a'))).toBeNull();
    });

    it('rejects the whole state when a single project is bad', () => {
      const bad = legacyProject('b', { name: 42 });
      expect(parseLegacyState(legacyState([legacyProject('a'), bad], 'a'))).toBeNull();
    });

    it.each([
      { label: 'id', overrides: { id: 1 } },
      { label: 'title', overrides: { title: undefined } },
      { label: 'authors', overrides: { authors: 'Ada' } },
      { label: 'an author entry', overrides: { authors: ['Ada', 7] } },
    ])('rejects a core paper whose $label is invalid', ({ overrides }) => {
      const project = legacyProject('a', { corePaper: legacyPaper('core-a', overrides) });
      expect(parseLegacyState(legacyState([project], 'a'))).toBeNull();
    });

    it('rejects a project when any related paper is invalid', () => {
      const project = legacyProject('a', {
        relatedPapers: [legacyPaper('ok'), legacyPaper('bad', { title: 3 })],
      });
      expect(parseLegacyState(legacyState([project], 'a'))).toBeNull();
    });

    it('does not carry unknown fields through', () => {
      const project = legacyProject('a', {
        extra: 'x',
        corePaper: legacyPaper('core-a', { note: 'y' }),
      });
      const parsed = parseLegacyState(legacyState([project], 'a'));
      expect(parsed?.projects[0]).not.toHaveProperty('extra');
      expect(parsed?.projects[0]?.corePaper).not.toHaveProperty('note');
    });

    it('is not fooled by prototype keys in the payload', () => {
      const payload: unknown = JSON.parse(
        '{"projects":[],"selectedId":null,"__proto__":{"polluted":true}}',
      );
      expect(parseLegacyState(payload)).toStrictEqual({ projects: [], selectedId: null });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  describe('selection repair', () => {
    it('keeps a valid selection', () => {
      const parsed = parseLegacyState(legacyState([legacyProject('a'), legacyProject('b')], 'b'));
      expect(parsed?.selectedId).toBe('b');
    });

    it('falls back to the first project when the selection is unknown', () => {
      const parsed = parseLegacyState(
        legacyState([legacyProject('a'), legacyProject('b')], 'ghost'),
      );
      expect(parsed?.selectedId).toBe('a');
    });

    it.each([
      { label: 'null', selectedId: null },
      { label: 'missing', selectedId: undefined },
      { label: 'a number', selectedId: 5 },
      { label: 'an object', selectedId: {} },
    ])('falls back to the first project when selectedId is $label', ({ selectedId }) => {
      const parsed = parseLegacyState(
        legacyState([legacyProject('a'), legacyProject('b')], selectedId),
      );
      expect(parsed?.selectedId).toBe('a');
    });

    it('selects nothing when there are no projects, whatever selectedId says', () => {
      expect(parseLegacyState(legacyState([], 'a'))?.selectedId).toBeNull();
    });
  });
});

describe('parseProjectsState: PDF binding and reading position', () => {
  const PDF = {
    sha256: 'a'.repeat(64),
    name: 'attention.pdf',
    bytes: 1024,
    pageCount: 9,
    addedAt: 5,
  };

  function stateWithPaperFields(fields: Raw): Raw {
    const papers = { 'core-a': rawPaper('core-a', fields) };
    return rawState([rawProject('a')], papers, 'a');
  }

  it('keeps a well-formed PDF binding and reading position', () => {
    const parsed = parseProjectsState(
      stateWithPaperFields({ pdf: PDF, reading: { page: 3, updatedAt: 7 } }),
    );
    expect(parsed?.papers['core-a']).toMatchObject({
      pdf: PDF,
      reading: { page: 3, updatedAt: 7 },
    });
  });

  it('accepts a binding whose page count was never recorded', () => {
    const parsed = parseProjectsState(stateWithPaperFields({ pdf: { ...PDF, pageCount: null } }));
    expect(parsed?.papers['core-a']?.pdf).toStrictEqual({ ...PDF, pageCount: null });
  });

  it('leaves a paper without a PDF or a position alone', () => {
    const parsed = parseProjectsState(stateWithPaperFields({}));
    expect(parsed?.papers['core-a']).toStrictEqual({
      id: 'core-a',
      title: 'Paper core-a',
      authors: [],
      createdAt: 1,
      updatedAt: 2,
    });
  });

  it.each([
    { label: 'a hash that is not a SHA-256', pdf: { ...PDF, sha256: 'nope' } },
    { label: 'an uppercase hash', pdf: { ...PDF, sha256: 'A'.repeat(64) } },
    { label: 'a missing name', pdf: { ...PDF, name: '' } },
    { label: 'a negative size', pdf: { ...PDF, bytes: -1 } },
    { label: 'a page count of the wrong type', pdf: { ...PDF, pageCount: 'nine' } },
    { label: 'a missing timestamp', pdf: { ...PDF, addedAt: undefined } },
    { label: 'something that is not an object', pdf: 'attention.pdf' },
  ])('drops a PDF binding with $label rather than failing the payload', ({ pdf }) => {
    const parsed = parseProjectsState(stateWithPaperFields({ pdf }));
    expect(parsed).not.toBeNull();
    expect(parsed?.papers['core-a']).not.toHaveProperty('pdf');
  });

  it.each([
    { label: 'page zero', reading: { page: 0, updatedAt: 1 } },
    { label: 'a fractional page', reading: { page: 1.5, updatedAt: 1 } },
    { label: 'a missing page', reading: { updatedAt: 1 } },
    { label: 'a missing timestamp', reading: { page: 2 } },
    { label: 'a string page', reading: { page: '2', updatedAt: 1 } },
  ])('drops a reading position with $label', ({ reading }) => {
    const parsed = parseProjectsState(stateWithPaperFields({ reading }));
    expect(parsed?.papers['core-a']).not.toHaveProperty('reading');
  });
});
