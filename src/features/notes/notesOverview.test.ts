import { describe, expect, it } from 'vitest';
import type { Annotation } from '../../domain/annotation';
import type { Paper } from '../../domain/papers';
import { filterNotes, groupNotes, openQuestionCount } from './notesOverview';

function note(id: string, paperId: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id,
    paperId,
    pdfSha256: 'a'.repeat(64),
    page: 1,
    quote: `Quote ${id}`,
    prefix: '',
    suffix: '',
    rects: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.02 }],
    kind: 'note',
    note: '',
    origin: 'user',
    sourceLabel: '',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function paper(id: string, title: string): Paper {
  return { id, title, authors: [], createdAt: 0, updatedAt: 0 };
}

const alpha = note('a1', 'p1', { kind: 'insight', note: 'Key idea', page: 4, updatedAt: 10 });
const beta = note('b1', 'p1', {
  kind: 'question',
  quote: 'Why does this work?',
  page: 2,
  updatedAt: 20,
});
const gamma = note('c1', 'p2', {
  kind: 'note',
  note: 'Follow up on transformers',
  page: 7,
  updatedAt: 5,
});
const delta = note('d1', 'p1', { kind: 'note', quote: 'Unrelated', page: 1, updatedAt: 1 });

describe('filterNotes', () => {
  it('keeps every note when nothing is filtered', () => {
    expect(
      filterNotes([alpha, beta, gamma], { query: '', kind: 'all', paperId: null }),
    ).toHaveLength(3);
  });

  it('matches the highlighted text and the note body case-insensitively', () => {
    const byQuote = filterNotes([alpha, beta, gamma], {
      query: 'TRANSFORMERS',
      kind: 'all',
      paperId: null,
    });
    expect(byQuote.map((entry) => entry.id)).toStrictEqual(['c1']);

    const byBody = filterNotes([alpha, beta, gamma], {
      query: 'key idea',
      kind: 'all',
      paperId: null,
    });
    expect(byBody.map((entry) => entry.id)).toStrictEqual(['a1']);
  });

  it('filters by kind and by paper at the same time', () => {
    const result = filterNotes([alpha, beta, gamma, delta], {
      query: '',
      kind: 'note',
      paperId: 'p1',
    });
    expect(result.map((entry) => entry.id)).toStrictEqual(['d1']);
  });

  it('narrows to open or resolved questions only, whatever their paper', () => {
    const resolved = { ...gamma, kind: 'question' as const, resolvedAt: 77 };
    const open = filterNotes([alpha, beta, resolved, delta], {
      query: '',
      kind: 'all',
      paperId: null,
      questionStatus: 'open',
    });
    expect(open.map((entry) => entry.id)).toStrictEqual([beta.id]);
    const done = filterNotes([alpha, beta, resolved, delta], {
      query: '',
      kind: 'all',
      paperId: null,
      questionStatus: 'resolved',
    });
    expect(done.map((entry) => entry.id)).toStrictEqual([gamma.id]);
  });

  it('counts only the questions that are still open', () => {
    expect(openQuestionCount([alpha, beta, { ...gamma, resolvedAt: 9 }])).toBe(1);
    expect(openQuestionCount([])).toBe(0);
  });
});

describe('groupNotes', () => {
  const papers = { p1: paper('p1', 'Attention'), p2: paper('p2', 'BERT') };

  it('groups by paper, newest activity first, notes in page order', () => {
    const groups = groupNotes([alpha, beta, gamma, delta], papers);
    expect(groups.map((group) => group.paperId)).toStrictEqual(['p1', 'p2']);
    expect(groups[0]?.items.map((entry) => entry.id)).toStrictEqual(['d1', 'b1', 'a1']);
  });

  it('keeps the notes of a paper whose record is missing', () => {
    const groups = groupNotes([gamma], {});
    expect(groups).toStrictEqual([{ paperId: 'p2', title: '未知论文', items: [gamma] }]);
  });

  it('returns no groups for no notes', () => {
    expect(groupNotes([], papers)).toStrictEqual([]);
  });
});
