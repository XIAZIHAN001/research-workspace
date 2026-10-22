import { describe, expect, it } from 'vitest';
import { bibtexKey, escapeBibtex, toBibtex } from './citation';
import type { Paper } from './papers';

function paper(overrides: Partial<Paper> = {}): Paper {
  return {
    id: 'paper-1',
    title: 'An Analytical Engine',
    authors: ['Ada Lovelace'],
    year: 1843,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('escapeBibtex', () => {
  it('escapes the characters a LaTeX entry cannot take raw', () => {
    expect(escapeBibtex('A & B: 100% #1 _x_ $5 ^ ~ \\')).toBe(
      'A \\& B: 100\\% \\#1 \\_x\\_ \\$5 \\textasciicircum{} \\textasciitilde{} \\textbackslash{}',
    );
  });
});

describe('bibtexKey', () => {
  it("uses the first author's surname, the year and the first meaningful title word", () => {
    expect(bibtexKey(paper())).toBe('lovelace1843analytical');
  });

  it('reads a surname written before the given name', () => {
    expect(bibtexKey(paper({ authors: ['Lovelace, Ada'] }))).toBe('lovelace1843analytical');
  });

  it('writes nd when there is no year', () => {
    expect(bibtexKey(paper({ year: undefined }))).toBe('lovelacendanalytical');
  });

  it('appends the paper id when the key is already taken', () => {
    expect(bibtexKey(paper(), ['lovelace1843analytical'])).toBe('lovelace1843analytical-paper1');
  });

  it('falls back to something printable for an untitled, anonymous paper', () => {
    expect(bibtexKey(paper({ title: '???', authors: [] }))).toBe('paper1843paper');
  });
});

describe('toBibtex', () => {
  it('writes an article with its DOI and a resolver URL', () => {
    const entry = toBibtex(paper({ doi: '10.1000/xyz' }));
    expect(entry).toContain('@article{lovelace1843analytical,');
    expect(entry).toContain('  title = {An Analytical Engine}');
    expect(entry).toContain('  author = {Ada Lovelace}');
    expect(entry).toContain('  year = {1843}');
    expect(entry).toContain('  doi = {10.1000/xyz}');
    expect(entry).toContain('  url = {https://doi.org/10.1000/xyz}');
  });

  it('joins several authors with and', () => {
    const entry = toBibtex(paper({ authors: ['Ada Lovelace', 'Alan Turing'] }));
    expect(entry).toContain('  author = {Ada Lovelace and Alan Turing}');
  });

  it('uses misc and an arXiv link when there is no year', () => {
    const entry = toBibtex(paper({ year: undefined, arxivId: '2401.12345' }));
    expect(entry).toContain('@misc{lovelacendanalytical,');
    expect(entry).toContain('  eprint = {2401.12345}');
    expect(entry).toContain('  archivePrefix = {arXiv}');
    expect(entry).toContain('  url = {https://arxiv.org/abs/2401.12345}');
  });

  it('escapes the title without escaping the fields it builds itself', () => {
    const entry = toBibtex(paper({ title: 'A & B' }));
    expect(entry).toContain('  title = {A \\& B}');
  });
});
