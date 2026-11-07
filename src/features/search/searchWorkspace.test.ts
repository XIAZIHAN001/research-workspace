import { describe, expect, it, vi } from 'vitest';
import * as search from './searchWorkspace';
import * as papers from '../../domain/papers';
import { createAnnotation } from '../../domain/annotation';
import { createConcept, createEvidence } from '../../domain/knowledge';
import { createPaper } from '../../domain/papers';
import { searchWorkspace, type WorkspaceSearchSource } from './searchWorkspace';

const SHA = 'a'.repeat(64);

function workspace(annotationCount = 1): WorkspaceSearchSource {
  let sequence = 0;
  const makeId = (): string => `id-${String(++sequence)}`;
  const paper = createPaper(
    {
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer'],
      year: 2017,
      doi: '10.5555/attention',
    },
    makeId,
    1,
  );
  if (paper === null) throw new Error('fixture paper');
  const annotations = Array.from({ length: annotationCount }, (_, index) =>
    createAnnotation(
      {
        paperId: paper.id,
        pdfSha256: SHA,
        page: 4 + index,
        quote: 'The Transformer follows this overall architecture.',
        prefix: '',
        suffix: '',
        rects: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.02 }],
        kind: 'insight',
        note: `自注意力的核心动机 ${String(index)}`,
      },
      makeId,
      2,
    ),
  ).filter((annotation) => annotation !== null);
  const concept = createConcept(
    {
      name: '自注意力',
      aliases: ['self-attention'],
      summary: '让序列内部互相注意的机制',
      projectIds: ['p1'],
    },
    makeId,
    3,
  );
  if (concept === null) throw new Error('fixture concept');
  const evidence = createEvidence(
    {
      conceptId: concept.id,
      paperId: paper.id,
      pdfSha256: SHA,
      page: 4,
      quote: 'Scaled dot-product attention',
      rects: [],
      source: 'annotation',
      note: '效率更高',
    },
    makeId,
    4,
  );
  if (evidence === null) throw new Error('fixture evidence');
  return {
    papers: [paper],
    annotations,
    concepts: [concept],
    evidence: [evidence],
  };
}

describe('searchWorkspace', () => {
  it('returns nothing for a blank query', () => {
    expect(searchWorkspace(workspace(), '   ')).toEqual([]);
  });

  it('finds papers by metadata such as DOI and title', () => {
    const groups = searchWorkspace(workspace(), '10.5555');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('paper');
    expect(groups[0]?.results[0]?.title).toBe('Attention Is All You Need');
  });

  it('finds a note by its quotation and shows the matching text', () => {
    const groups = searchWorkspace(workspace(), 'transformer');
    expect(groups.map((group) => group.kind)).toEqual(['note']);
    const result = groups[0]?.results[0];
    expect(result?.kind).toBe('note');
    expect(result?.title).toBe('自注意力的核心动机 0');
    expect(result?.snippet).toContain('Transformer');
    expect(result?.page).toBe(4);
  });

  it('requires every token to match, across fields of one record', () => {
    const groups = searchWorkspace(workspace(), 'transformer 核心');
    expect(groups.map((group) => group.kind)).toEqual(['note']);
  });

  it('finds concepts by alias and evidence by note text', () => {
    expect(searchWorkspace(workspace(), 'self-attention')[0]?.kind).toBe('concept');
    const evidence = searchWorkspace(workspace(), '效率更高')[0];
    expect(evidence?.kind).toBe('evidence');
    expect(evidence?.results[0]?.meta).toContain('自注意力');
    expect(evidence?.results[0]?.page).toBe(4);
  });

  it('keeps a group total while showing a limited number of rows', () => {
    const groups = searchWorkspace(workspace(9), 'transformer', 3);
    expect(groups[0]?.total).toBe(9);
    expect(groups[0]?.results).toHaveLength(3);
  });
});

describe('workspace search compatibility fixtures', () => {
  it('preserves source ordering, phrase ranking, snippets and unusual limits', () => {
    const base = workspace();
    const paper = base.papers[0]!;
    const note = base.annotations[0]!;
    const concept = base.concepts[0]!;
    const entry = base.evidence[0]!;
    const texts = [
      'body only',
      'alpha beta',
      'alpha\t beta',
      `${'x'.repeat(91)} alpha beta`,
      'İSTANBUL 中文 😀 alpha beta',
      '  alpha\n beta  ',
      'alpha beta again',
      '   ',
    ];
    const fixture: WorkspaceSearchSource = {
      papers: texts.map((title, i) => ({
        ...paper,
        id: `p${String(i)}`,
        title,
        authors: ['alpha beta'],
      })),
      annotations: texts.map((text, i) => ({
        ...note,
        id: `n${String(i)}`,
        note: text,
        quote: `${'前'.repeat(70)} İSTANBUL 中文 😀 alpha beta end`,
        paperId: i === 0 ? 'missing' : 'p0',
      })),
      concepts: texts.map((name, i) => ({
        ...concept,
        id: `c${String(i)}`,
        name,
        aliases: ['alpha beta'],
        summary: `${'x '.repeat(80)} 中文 alpha beta`,
        projectIds: i === 0 ? [] : ['project'],
      })),
      evidence: texts.map((quote, i) => ({
        ...entry,
        id: `e${String(i)}`,
        quote,
        note: 'alpha beta 中文 İSTANBUL',
        conceptId: 'missing',
        paperId: 'p0',
      })),
    };
    for (const query of ['alpha beta', ' BETA\tALPHA ', '中文', 'i̇', '😀', 'missing', '   ']) {
      for (const limit of [undefined, 1, 2.9, 0, -5, NaN, Infinity]) {
        expect(searchWorkspace(fixture, query, limit)).toMatchSnapshot(`${query}/${String(limit)}`);
      }
    }
  });
});

describe('explicit immutable workspace index', () => {
  it('normalizes source text once, rather than on each query', () => {
    expect(search).toHaveProperty('createWorkspaceSearchIndex');
    const data = workspace(50);
    const index = search.createWorkspaceSearchIndex(data);
    // A first query may prepare the bounded visible snippets; later queries reuse them.
    search.searchWorkspaceIndex(index, 'TRANSFORMER');
    const lowercase = vi.spyOn(String.prototype, 'toLowerCase');
    try {
      const results = search.searchWorkspaceIndex(index, 'TRANSFORMER');
      const calls = lowercase.mock.calls.length;
      lowercase.mockRestore();
      expect(results[0]?.total).toBe(50);
      expect(results[0]?.results).toHaveLength(6);
      expect(calls).toBe(1);
    } finally {
      lowercase.mockRestore();
    }
  });

  it('does not format paper metadata until a bounded result is displayed', () => {
    const data = workspace();
    const source = {
      ...data,
      papers: Array.from({ length: 40 }, (_, i) => ({
        ...data.papers[0]!,
        id: `paper-${String(i)}`,
      })),
    };
    const credit = vi.spyOn(papers, 'authorCredit');
    try {
      const index = search.createWorkspaceSearchIndex(source);
      expect(credit).not.toHaveBeenCalled();
      expect(search.searchWorkspaceIndex(index, 'absent')).toEqual([]);
      expect(credit).not.toHaveBeenCalled();
      const results = search.searchWorkspaceIndex(index, 'attention', 2)[0]!;
      expect(results.total).toBe(40);
      expect(results.results.map((result) => result.meta)).toEqual([
        'Vaswani 等 · 2017 · 论文 · DOI',
        'Vaswani 等 · 2017 · 论文 · DOI',
      ]);
      expect(credit).toHaveBeenCalledTimes(2);
      search.searchWorkspaceIndex(index, 'vaswani', 2);
      expect(credit).toHaveBeenCalledTimes(2);
    } finally {
      credit.mockRestore();
    }
  });

  it('cleans snippet text only for selected results and reuses that preparation', () => {
    const data = workspace(200);
    const raw = `Transformer\t ${'x '.repeat(100)}end`;
    for (const note of data.annotations) note.quote = raw;
    const replace = vi.spyOn(String.prototype, 'replace');
    const preparations = (): number =>
      replace.mock.contexts.filter((value) => String(value) === raw).length;
    try {
      const index = search.createWorkspaceSearchIndex(data);
      expect(preparations()).toBe(0);
      expect(search.searchWorkspaceIndex(index, 'absent')).toEqual([]);
      expect(preparations()).toBe(0);
      const group = search.searchWorkspaceIndex(index, 'transformer', 2)[0]!;
      expect(group.total).toBe(200);
      expect(group.results).toHaveLength(2);
      expect(group.results[0]?.snippet).toMatch(/^Transformer x /);
      expect(preparations()).toBe(2);
      search.searchWorkspaceIndex(index, 'TRANSFORMER', 2);
      expect(preparations()).toBe(2);
    } finally {
      replace.mockRestore();
    }
  });

  it('replaces raw display snapshots when materialized rather than retaining both forms', () => {
    const index = search.createWorkspaceSearchIndex(workspace(2));
    const paper = index.groups.paper[0]!;
    const note = index.groups.note[0]!;
    const rawPaper = paper.snapshot;
    const rawNote = note.snapshot;
    expect(search.searchWorkspaceIndex(index, 'attention')[0]?.results[0]?.meta).toBe(
      'Vaswani 等 · 2017 · 论文 · DOI',
    );
    expect(paper.snapshot).not.toBe(rawPaper);
    expect(note.snapshot).toBe(rawNote);
    const firstResult = search.searchWorkspaceIndex(index, 'transformer');
    expect(note.snapshot).not.toBe(rawNote);
    const materializedNote = note.snapshot;
    expect(search.searchWorkspaceIndex(index, 'transformer')).toEqual(firstResult);
    expect(note.snapshot).toBe(materializedNote);
  });

  it('snapshots all display fields and nested arrays before lazy materialization', () => {
    const data = workspace();
    const queries = ['attention', 'transformer', '自注意力', '效率更高'];
    const expected = queries.map((query) => searchWorkspace(data, query, Infinity));
    const index = search.createWorkspaceSearchIndex(data);
    const paper = data.papers[0]!;
    paper.id = 'changed-paper';
    paper.title = 'Changed title';
    paper.authors.splice(0, paper.authors.length, 'Changed Author');
    paper.year = 2026;
    paper.doi = undefined;
    paper.arxivId = 'changed-identifier';
    Object.assign(data.annotations[0]!, {
      id: 'changed-note',
      paperId: 'changed-paper',
      page: 99,
      kind: 'question',
      note: 'Changed note',
      quote: 'Changed quote',
    });
    const concept = data.concepts[0]!;
    concept.id = 'changed-concept';
    concept.name = 'Changed name';
    concept.status = 'suggested';
    concept.summary = 'Changed summary';
    concept.aliases.splice(0, concept.aliases.length, 'changed-alias');
    concept.projectIds.splice(0, concept.projectIds.length, 'changed-project');
    Object.assign(data.evidence[0]!, {
      id: 'changed-evidence',
      conceptId: 'changed-concept',
      paperId: 'changed-paper',
      page: 98,
      note: 'Changed evidence note',
      quote: 'Changed evidence quote',
    });
    expect(queries.map((query) => search.searchWorkspaceIndex(index, query, Infinity))).toEqual(
      expected,
    );
    const returned = search.searchWorkspaceIndex(index, 'attention', Infinity);
    for (const group of returned) {
      for (const result of group.results) {
        result.title = 'Mutated returned title';
        result.meta = 'Mutated returned meta';
        result.snippet = 'Mutated returned snippet';
      }
    }
    expect(search.searchWorkspaceIndex(index, 'attention', Infinity)).toEqual(expected[0]);
  });

  it('snapshots mutable input explicitly while the compatibility wrapper remains fresh', () => {
    expect(search).toHaveProperty('createWorkspaceSearchIndex');
    const data = workspace();
    const index = search.createWorkspaceSearchIndex(data);
    data.papers[0]!.title = 'Replacement paper';
    expect(search.searchWorkspaceIndex(index, 'attention')[0]?.results[0]?.title).toBe(
      'Attention Is All You Need',
    );
    expect(searchWorkspace(data, 'replacement')[0]?.results[0]?.title).toBe('Replacement paper');
    expect(
      search.searchWorkspaceIndex(search.createWorkspaceSearchIndex(data), 'replacement')[0]
        ?.results[0]?.title,
    ).toBe('Replacement paper');
  });

  it('materializes snippets only for bounded selected matches', () => {
    expect(search).toHaveProperty('createWorkspaceSearchIndex');
    const data = workspace(200);
    for (const note of data.annotations) note.quote = `Transformer ${'x'.repeat(200)}`;
    const index = search.createWorkspaceSearchIndex(data);
    const slice = vi.spyOn(String.prototype, 'slice');
    try {
      const groups = search.searchWorkspaceIndex(index, 'transformer', 2);
      const calls = slice.mock.calls.length;
      slice.mockRestore();
      expect(groups[0]?.total).toBe(200);
      expect(groups[0]?.results).toHaveLength(2);
      expect(calls).toBe(2);
    } finally {
      slice.mockRestore();
    }
  });
});
