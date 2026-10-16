import { describe, expect, it } from 'vitest';
import {
  authorCredit,
  createPaper,
  findPaperByExternalId,
  normalizeArxivId,
  normalizeDoi,
  type Paper,
} from './papers';

function sequentialIds(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `paper-${next}`;
  };
}

function paper(id: string, overrides: Partial<Paper> = {}): Paper {
  return { id, title: `Paper ${id}`, authors: [], createdAt: 0, updatedAt: 0, ...overrides };
}

describe('normalizeDoi', () => {
  it('lowercases and trims', () => {
    expect(normalizeDoi('  10.1000/ABC  ')).toBe('10.1000/abc');
  });

  it.each([
    { label: 'resolver URL', raw: 'https://doi.org/10.1234/AbC' },
    { label: 'plain-http resolver', raw: 'http://dx.doi.org/10.1234/AbC' },
    { label: 'doi: prefix', raw: 'doi:10.1234/AbC' },
    { label: 'DOI: prefix in caps', raw: 'DOI: 10.1234/AbC' },
  ])('strips the $label', ({ raw }) => {
    expect(normalizeDoi(raw)).toBe('10.1234/abc');
  });

  it('keeps a suffix that contains punctuation', () => {
    expect(normalizeDoi('10.1109/TSE.2021.3057169')).toBe('10.1109/tse.2021.3057169');
  });

  it.each([
    { label: 'a bare prefix', raw: '10.1000' },
    { label: 'a missing suffix', raw: '10.1000/' },
    { label: 'a wrong registrant', raw: '11.1000/abc' },
    { label: 'a free-text string', raw: 'see the paper' },
    { label: 'an empty string', raw: '   ' },
  ])('rejects $label', ({ raw }) => {
    expect(normalizeDoi(raw)).toBeNull();
  });
});

describe('normalizeArxivId', () => {
  it.each([
    { label: 'the bare id', raw: '2401.12345' },
    { label: 'the arXiv: prefix', raw: 'arXiv:2401.12345' },
    { label: 'an abs URL', raw: 'https://arxiv.org/abs/2401.12345' },
    { label: 'a pdf URL', raw: 'https://arxiv.org/pdf/2401.12345.pdf' },
    { label: 'a versioned id', raw: '2401.12345v2' },
    { label: 'an id with the whole world attached', raw: ' https://arxiv.org/abs/2401.12345v12 ' },
  ])('normalizes $label to the bare id', ({ raw }) => {
    expect(normalizeArxivId(raw)).toBe('2401.12345');
  });

  it.each([
    { label: 'a pre-2007 id', raw: 'hep-th/9901001', expected: 'hep-th/9901001' },
    { label: 'a versioned pre-2007 id', raw: 'hep-th/9901001v3', expected: 'hep-th/9901001' },
    { label: 'a subject-class id', raw: 'math.GT/0309136', expected: 'math.gt/0309136' },
  ])('normalizes $label', ({ raw, expected }) => {
    expect(normalizeArxivId(raw)).toBe(expected);
  });

  it('drops the version, so two revisions are one paper', () => {
    expect(normalizeArxivId('2401.12345v1')).toBe(normalizeArxivId('2401.12345v7'));
  });

  it.each([
    { label: 'a four-digit number', raw: '2401' },
    { label: 'free text', raw: 'attention is all you need' },
    { label: 'an empty string', raw: '' },
  ])('rejects $label', ({ raw }) => {
    expect(normalizeArxivId(raw)).toBeNull();
  });
});

describe('createPaper', () => {
  it('keeps the normalized title and stamps both timestamps', () => {
    const created = createPaper({ title: '  Deep   Learning ' }, sequentialIds(), 42);
    expect(created).toStrictEqual({
      id: 'paper-1',
      title: 'Deep Learning',
      authors: [],
      createdAt: 42,
      updatedAt: 42,
    });
  });

  it('returns null for a blank title without consuming an id', () => {
    const makeId = sequentialIds();
    expect(createPaper({ title: '  ' }, makeId, 0)).toBeNull();
    expect(createPaper({ title: 'x' }, makeId, 0)?.id).toBe('paper-1');
  });

  it('trims authors and drops blank entries', () => {
    const created = createPaper(
      { title: 'T', authors: ['  Ada Lovelace ', '', '  '] },
      () => 'p',
      0,
    );
    expect(created?.authors).toStrictEqual(['Ada Lovelace']);
  });

  it('stores normalized external identifiers', () => {
    const created = createPaper(
      { title: 'T', doi: 'https://doi.org/10.1000/XYZ', arxivId: 'arXiv:2401.12345v2' },
      () => 'p',
      0,
    );
    expect(created?.doi).toBe('10.1000/xyz');
    expect(created?.arxivId).toBe('2401.12345');
  });

  it('drops an identifier that does not normalize instead of storing it as typed', () => {
    const created = createPaper({ title: 'T', doi: 'not-a-doi', arxivId: 'nope' }, () => 'p', 0);
    expect(created).not.toHaveProperty('doi');
    expect(created).not.toHaveProperty('arxivId');
  });

  it('omits an empty year rather than storing NaN', () => {
    expect(createPaper({ title: 'T' }, () => 'p', 0)).not.toHaveProperty('year');
    expect(createPaper({ title: 'T', year: Number.NaN }, () => 'p', 0)).not.toHaveProperty('year');
    expect(createPaper({ title: 'T', year: 2017 }, () => 'p', 0)?.year).toBe(2017);
  });
});

describe('findPaperByExternalId', () => {
  const registry: Record<string, Paper> = {
    a: paper('a', { title: 'Attention', doi: '10.1000/abc' }),
    b: paper('b', { title: 'Attention', arxivId: '2401.12345' }),
    c: paper('c', { title: 'Attention' }),
  };

  it('finds a paper by DOI however the DOI was written', () => {
    expect(findPaperByExternalId(registry, { doi: 'https://doi.org/10.1000/ABC' })?.id).toBe('a');
  });

  it('finds a paper by arXiv id however the id was written', () => {
    expect(findPaperByExternalId(registry, { arxivId: 'arXiv:2401.12345v3' })?.id).toBe('b');
  });

  it('prefers the DOI match when both identifiers point at different papers', () => {
    const found = findPaperByExternalId(registry, {
      doi: '10.1000/abc',
      arxivId: '2401.12345',
    });
    expect(found?.id).toBe('a');
  });

  it('matches nothing without a usable identifier, however familiar the title is', () => {
    expect(findPaperByExternalId(registry, {})).toBeNull();
    expect(findPaperByExternalId(registry, { doi: '  ', arxivId: null })).toBeNull();
  });

  it('matches nothing when the identifiers are unknown', () => {
    expect(findPaperByExternalId(registry, { doi: '10.9999/zzz' })).toBeNull();
    expect(findPaperByExternalId(registry, { arxivId: '2401.99999' })).toBeNull();
  });

  it('is not fooled by a paper that only shares the identifier of a different kind', () => {
    // `c` has neither identifier, so nothing can ever match it automatically.
    const found = findPaperByExternalId(registry, { doi: '10.1000/abc', arxivId: '2401.12345' });
    expect(found?.id).not.toBe('c');
  });
});

describe('authorCredit', () => {
  const ref = (authors: string[]): Pick<Paper, 'authors'> => ({ authors });

  it('returns null when there are no authors', () => {
    expect(authorCredit(ref([]))).toBeNull();
  });

  it('returns the surname of a single author', () => {
    expect(authorCredit(ref(['Kaiming He']))).toBe('He');
  });

  it('returns a single-token name as is', () => {
    expect(authorCredit(ref(['Hinton']))).toBe('Hinton');
  });

  it('appends the 等 suffix when there are several authors', () => {
    expect(authorCredit(ref(['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar']))).toBe('Vaswani 等');
  });

  it('uses the 等 suffix for exactly two authors too', () => {
    expect(authorCredit(ref(['Ian Goodfellow', 'Yoshua Bengio']))).toBe('Goodfellow 等');
  });

  it('takes the last whitespace-separated token of the first author only', () => {
    expect(authorCredit(ref(['  Geoffrey   E.  Hinton  ']))).toBe('Hinton');
  });

  it('returns null when every author entry is blank', () => {
    expect(authorCredit(ref(['']))).toBeNull();
    expect(authorCredit(ref(['  ', '\t\n']))).toBeNull();
  });

  it('skips blank entries instead of crediting an empty name', () => {
    expect(authorCredit(ref(['  ', 'Kaiming He']))).toBe('He');
    expect(authorCredit(ref(['', 'Ian Goodfellow', 'Yoshua Bengio']))).toBe('Goodfellow 等');
  });
});
