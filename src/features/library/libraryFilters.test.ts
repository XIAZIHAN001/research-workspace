import { describe, expect, it } from 'vitest';
import type { Paper } from '../../domain/papers';
import { collectTags, libraryPapers, readingProgress, type LibraryOptions } from './libraryFilters';

const PDF = { sha256: 'a'.repeat(64), name: 'a.pdf', bytes: 1, pageCount: 10, addedAt: 1 };

function paper(id: string, overrides: Partial<Paper> = {}): Paper {
  return {
    id,
    title: `Paper ${id}`,
    authors: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const options = (overrides: Partial<LibraryOptions> = {}): LibraryOptions => ({
  query: '',
  sort: 'title',
  scope: 'all',
  status: 'all',
  tag: null,
  projectPaperIds: new Set(),
  annotatedPaperIds: new Set(),
  ...overrides,
});

const alpha = paper('a', { title: 'Alpha', year: 2019, createdAt: 30, tags: ['RL'] });
const beta = paper('b', {
  title: 'Beta',
  year: 2021,
  createdAt: 20,
  pdf: PDF,
  reading: { page: 5, updatedAt: 50 },
  tags: ['Survey'],
});
const gamma = paper('c', { title: 'Gamma', createdAt: 10, status: 'done' });

const names = (papers: readonly Paper[]): string[] => papers.map((entry) => entry.title);

describe('libraryPapers', () => {
  it('sorts by the last reading time, papers never opened last', () => {
    expect(
      names(libraryPapers([alpha, beta, gamma], options({ sort: 'recent-reading' }))),
    ).toStrictEqual(['Beta', 'Alpha', 'Gamma']);
  });

  it('sorts by when papers were added', () => {
    expect(names(libraryPapers([alpha, beta, gamma], options({ sort: 'added' })))).toStrictEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ]);
  });

  it('puts papers without a year last in both year orders', () => {
    expect(
      names(libraryPapers([alpha, beta, gamma], options({ sort: 'year-desc' }))),
    ).toStrictEqual(['Beta', 'Alpha', 'Gamma']);
    expect(names(libraryPapers([alpha, beta, gamma], options({ sort: 'year-asc' })))).toStrictEqual(
      ['Alpha', 'Beta', 'Gamma'],
    );
  });

  it('does not mutate the array it is given', () => {
    const input = [beta, alpha];
    libraryPapers(input, options({ sort: 'title' }));
    expect(input).toStrictEqual([beta, alpha]);
  });

  it('matches a query against the title, authors, identifiers and tags', () => {
    const tagged = paper('d', { title: 'Delta', authors: ['Ada Lovelace'], tags: ['graph'] });
    expect(names(libraryPapers([alpha, tagged], options({ query: 'lovelace' })))).toStrictEqual([
      'Delta',
    ]);
    expect(names(libraryPapers([alpha, tagged], options({ query: 'GRAPH' })))).toStrictEqual([
      'Delta',
    ]);
  });

  it('filters by scope: PDF, project membership and notes', () => {
    const base = [alpha, beta, gamma];
    expect(names(libraryPapers(base, options({ scope: 'has-pdf' })))).toStrictEqual(['Beta']);
    expect(
      names(libraryPapers(base, options({ scope: 'in-project', projectPaperIds: new Set(['c']) }))),
    ).toStrictEqual(['Gamma']);
    expect(
      names(
        libraryPapers(base, options({ scope: 'has-notes', annotatedPaperIds: new Set(['a']) })),
      ),
    ).toStrictEqual(['Alpha']);
  });

  it('treats a paper without a status as unread', () => {
    expect(names(libraryPapers([alpha, beta, gamma], options({ status: 'unread' })))).toStrictEqual(
      ['Alpha', 'Beta'],
    );
    expect(names(libraryPapers([alpha, beta, gamma], options({ status: 'done' })))).toStrictEqual([
      'Gamma',
    ]);
  });

  it('matches a tag regardless of case', () => {
    expect(names(libraryPapers([alpha, beta], options({ tag: 'survey' })))).toStrictEqual(['Beta']);
  });

  it('composes every filter at once', () => {
    expect(
      names(
        libraryPapers(
          [alpha, beta, gamma],
          options({
            query: 'pdf',
            scope: 'has-pdf',
            status: 'unread',
            tag: 'Survey',
          }),
        ),
      ),
    ).toStrictEqual(['Beta']);
  });
});

describe('readingProgress', () => {
  it('reports a whole percentage of the page count', () => {
    expect(readingProgress({ reading: { page: 5, updatedAt: 1 }, pdf: PDF })).toBe(50);
  });

  it('clamps a page beyond the file to 100 percent', () => {
    expect(readingProgress({ reading: { page: 99, updatedAt: 1 }, pdf: PDF })).toBe(100);
  });

  it.each([
    { label: 'no reading position', input: { pdf: PDF } },
    { label: 'no PDF', input: { reading: { page: 3, updatedAt: 1 } } },
    {
      label: 'no page count',
      input: { reading: { page: 3, updatedAt: 1 }, pdf: { ...PDF, pageCount: null } },
    },
  ])('reports null for $label', ({ input }) => {
    expect(readingProgress(input)).toBeNull();
  });
});

describe('collectTags', () => {
  it('lists each tag once, case-insensitively, in reading order', () => {
    const tagged = [paper('a', { tags: ['RL', 'Survey'] }), paper('b', { tags: ['rl', 'Theory'] })];
    expect(collectTags(tagged)).toStrictEqual(['RL', 'Survey', 'Theory']);
  });

  it('returns nothing when no paper has tags', () => {
    expect(collectTags([alpha])).toStrictEqual(['RL']);
    expect(collectTags([gamma])).toStrictEqual([]);
  });
});
