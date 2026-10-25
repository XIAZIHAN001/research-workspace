import { describe, expect, it } from 'vitest';
import { toBibtex } from './citation';
import { parseBibtex } from './bibtexImport';

describe('parseBibtex', () => {
  it('reads a plain article with authors, year and a DOI', () => {
    const result = parseBibtex(
      '@article{vaswani2017attention,\n  title = {Attention Is All You Need},\n  author = {Ashish Vaswani and Noam Shazeer},\n  year = {2017},\n  doi = {10.5555/3295222},\n}',
    );
    expect(result.skipped).toStrictEqual([]);
    expect(result.entries).toStrictEqual([
      {
        key: 'vaswani2017attention',
        title: 'Attention Is All You Need',
        authors: ['Ashish Vaswani', 'Noam Shazeer'],
        year: 2017,
        doi: '10.5555/3295222',
      },
    ]);
  });

  it('reads an arXiv eprint and normalizes the id, dropping the version', () => {
    const result = parseBibtex(
      '@misc{xue2026multi,\n  title = {Multi-Target Few-Shot Prompting},\n  author = {Xue, Yi and others},\n  eprint = {2610.22294v2},\n  archivePrefix = {arXiv},\n  year = {2026},\n}',
    );
    expect(result.entries[0]?.arxivId).toBe('2610.22294');
    expect(result.entries[0]?.authors).toStrictEqual(['Xue, Yi', 'others']);
  });

  it('takes the DOI or arXiv id out of a url when the fields do not carry it', () => {
    const doi = parseBibtex('@misc{a, title={T}, url = {https://doi.org/10.1000/abc}}');
    expect(doi.entries[0]?.doi).toBe('10.1000/abc');
    const arxiv = parseBibtex('@misc{a, title={T}, url = {https://arxiv.org/abs/2401.12345v2}}');
    expect(arxiv.entries[0]?.arxivId).toBe('2401.12345');
  });

  it('keeps the title the exporter protected with braces, and unescapes LaTeX', () => {
    const result = parseBibtex('@article{k, title = {The {BERT} \\& Friends 100\\% Model}}');
    expect(result.entries[0]?.title).toBe('The BERT & Friends 100% Model');
  });

  it('survives braces inside a field value and values with commas', () => {
    const result = parseBibtex(
      '@inproceedings{key,\n  title = {A, B {and} C},\n  author = "{One, Two and Three}",\n}',
    );
    expect(result.entries[0]?.title).toBe('A, B and C');
    expect(result.entries[0]?.authors).toStrictEqual(['One, Two', 'Three']);
  });

  it('reads paren-delimited entries with braces inside', () => {
    const result = parseBibtex('@article(key, title = {X (Y)}, year = 2020)');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.title).toBe('X (Y)');
    expect(result.entries[0]?.year).toBe(2020);
  });

  it('skips an entry without a title and says so, but keeps reading the file', () => {
    const result = parseBibtex(
      '@article{noTitle, author = {A}, year = {2001}},\n@article{good, title = {Good}}',
    );
    expect(result.entries.map((entry) => entry.key)).toStrictEqual(['good']);
    expect(result.skipped).toStrictEqual([{ key: 'noTitle', reason: '没有可用的标题' }]);
  });

  it('reports a truncated file instead of inventing an entry', () => {
    const result = parseBibtex('@article{broken, title = {Never closed');
    expect(result.entries).toStrictEqual([]);
    expect(result.skipped[0]?.reason).toContain('没有闭合');
  });

  it('ignores @comment, @string and @preamble blocks', () => {
    const result = parseBibtex(
      '@comment{anything at all}\n@string{me = {Myself}}\n@preamble{"\\usepackage{x}"}\n@misc{k, title={Real}}',
    );
    expect(result.entries.map((entry) => entry.key)).toStrictEqual(['k']);
    expect(result.skipped).toStrictEqual([]);
  });

  it('glues concatenated values and drops a malformed year rather than storing it', () => {
    const result = parseBibtex('@misc{k, title = {T} # {wins}, year = {spring}}');
    expect(result.entries[0]?.title).toBe('Twins');
    expect(result.entries[0]?.year).toBeUndefined();
    expect('year' in (result.entries[0] ?? {})).toBe(false);
  });

  it('round-trips against the exporter: our own .bib reads back cleanly', () => {
    const paper = {
      id: 'p1',
      title: 'A Title With {Braces} & Symbols',
      authors: ['Ada Lovelace', 'Grace Hopper'],
      year: 2042,
      doi: '10.1000/rt',
      createdAt: 0,
      updatedAt: 0,
    };
    const result = parseBibtex(toBibtex(paper));
    // The exporter escapes the title's braces as literals, so the reader keeps them: only
    // unescaped protection braces are stripped on the way in.
    expect(result.entries[0]?.title).toBe('A Title With {Braces} & Symbols');
    expect(result.entries[0]?.doi).toBe('10.1000/rt');
  });
});
