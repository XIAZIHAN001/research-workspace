import { describe, expect, it } from 'vitest';
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
