import { describe, expect, it } from 'vitest';
import {
  applyPaperEdit,
  authorCredit,
  createPaper,
  normalizeArxivId,
  normalizeDoi,
  resolvePaperIdentity,
  type Paper,
  MAX_SUMMARY_LENGTH,
  type PaperSummary,
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

describe('resolvePaperIdentity', () => {
  const byDoi = paper('a', { title: 'Attention', doi: '10.1000/abc' });
  const byArxiv = paper('b', { title: 'Attention', arxivId: '2401.12345' });
  const byNothing = paper('c', { title: 'Attention' });
  const registry: Record<string, Paper> = { a: byDoi, b: byArxiv, c: byNothing };

  it('matches a paper by DOI however the DOI was written', () => {
    expect(resolvePaperIdentity(registry, { doi: 'https://doi.org/10.1000/ABC' })).toStrictEqual({
      kind: 'match',
      paper: byDoi,
    });
  });

  it('matches a paper by arXiv id however the id was written', () => {
    expect(resolvePaperIdentity(registry, { arxivId: 'arXiv:2401.12345v3' })).toStrictEqual({
      kind: 'match',
      paper: byArxiv,
    });
  });

  it('matches when both identifiers point at the same paper', () => {
    const both = paper('both', { doi: '10.1000/abc', arxivId: '2401.12345' });
    const resolved = resolvePaperIdentity(
      { both },
      {
        doi: 'https://doi.org/10.1000/ABC',
        arxivId: 'arXiv:2401.12345v2',
      },
    );
    expect(resolved).toStrictEqual({ kind: 'match', paper: both });
  });

  it('reports a conflict when the identifiers point at different papers', () => {
    const resolved = resolvePaperIdentity(registry, { doi: '10.1000/abc', arxivId: '2401.12345' });
    expect(resolved).toStrictEqual({ kind: 'conflict', papers: [byDoi, byArxiv] });
  });

  it('reports a conflict when the registry files one identifier under two papers', () => {
    const first = paper('one', { doi: '10.1000/abc' });
    const second = paper('two', { doi: '10.1000/abc' });
    expect(resolvePaperIdentity({ first, second }, { doi: '10.1000/abc' })).toStrictEqual({
      kind: 'conflict',
      papers: [first, second],
    });
  });

  it('matches when only one of the two identifiers is known', () => {
    expect(
      resolvePaperIdentity(registry, { doi: '10.1000/abc', arxivId: '2401.99999' }),
    ).toStrictEqual({ kind: 'match', paper: byDoi });
    expect(
      resolvePaperIdentity(registry, { doi: '10.9999/zzz', arxivId: '2401.12345' }),
    ).toStrictEqual({ kind: 'match', paper: byArxiv });
  });

  it('matches nothing without a usable identifier, however familiar the title is', () => {
    expect(resolvePaperIdentity(registry, {})).toStrictEqual({ kind: 'none' });
    expect(resolvePaperIdentity(registry, { doi: '  ', arxivId: null })).toStrictEqual({
      kind: 'none',
    });
  });

  it('matches nothing when the identifiers are unknown', () => {
    expect(resolvePaperIdentity(registry, { doi: '10.9999/zzz' })).toStrictEqual({ kind: 'none' });
    expect(resolvePaperIdentity(registry, { arxivId: '2401.99999' })).toStrictEqual({
      kind: 'none',
    });
  });

  it('never matches a paper that carries no identifier at all', () => {
    // `byNothing` shares the other two papers' title but has nothing to be identified by.
    const resolved = resolvePaperIdentity(registry, { doi: '10.1000/abc', arxivId: '2401.12345' });
    expect(resolved.kind === 'conflict' && resolved.papers.map((p) => p.id)).toStrictEqual([
      'a',
      'b',
    ]);
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

describe('createPaper with a PDF', () => {
  it('records the binding it was given', () => {
    const pdf = { sha256: 'b'.repeat(64), name: 'a.pdf', bytes: 3, pageCount: 2, addedAt: 4 };
    const created = createPaper({ title: 'Attention', pdf }, sequentialIds(), 0);
    expect(created?.pdf).toStrictEqual(pdf);
  });

  it('keeps no binding when none was given', () => {
    expect(createPaper({ title: 'Attention' }, sequentialIds(), 0)).not.toHaveProperty('pdf');
    expect(createPaper({ title: 'Attention', pdf: null }, sequentialIds(), 0)).not.toHaveProperty(
      'pdf',
    );
  });
});

describe('applyPaperEdit', () => {
  const PDF = { sha256: 'c'.repeat(64), name: 'a.pdf', bytes: 9, pageCount: 4, addedAt: 7 };

  function registry(...papers: Paper[]): Record<string, Paper> {
    return Object.fromEntries(papers.map((entry) => [entry.id, entry]));
  }

  const attention = paper('a', { title: 'Attention', authors: ['Ashish Vaswani'], year: 2017 });
  const bert = paper('b', { title: 'BERT', doi: '10.1000/bert' });

  it('applies title, authors and year, and stamps updatedAt', () => {
    const result = applyPaperEdit(
      registry(attention, bert),
      'a',
      {
        title: '  Attention Is All You Need ',
        authors: [' Ashish Vaswani ', ''],
        year: 2018,
      },
      99,
    );
    if (!result.ok) throw new Error(result.failure.reason);
    expect(result.paper).toStrictEqual({
      ...attention,
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani'],
      year: 2018,
      updatedAt: 99,
    });
  });

  it('normalizes an identifier it is given', () => {
    const result = applyPaperEdit(
      registry(attention, bert),
      'a',
      {
        doi: 'https://doi.org/10.1000/ABC',
        arxivId: 'arXiv:2401.12345v2',
      },
      5,
    );
    expect(result.ok && result.paper.doi).toBe('10.1000/abc');
    expect(result.ok && result.paper.arxivId).toBe('2401.12345');
  });

  it('clears a field with null', () => {
    const withAll = paper('c', { year: 2017, doi: '10.1000/x', arxivId: '2401.12345', pdf: PDF });
    const result = applyPaperEdit(
      registry(withAll),
      'c',
      {
        year: null,
        doi: null,
        arxivId: null,
        pdf: null,
      },
      5,
    );
    if (!result.ok) throw new Error(result.failure.reason);
    expect(result.paper).not.toHaveProperty('year');
    expect(result.paper).not.toHaveProperty('doi');
    expect(result.paper).not.toHaveProperty('arxivId');
    expect(result.paper).not.toHaveProperty('pdf');
  });

  it('attaches a PDF and records where reading stopped', () => {
    const result = applyPaperEdit(
      registry(attention),
      'a',
      {
        pdf: PDF,
        reading: { page: 3, updatedAt: 11 },
      },
      5,
    );
    if (!result.ok) throw new Error(result.failure.reason);
    expect(result.paper.pdf).toStrictEqual(PDF);
    expect(result.paper.reading).toStrictEqual({ page: 3, updatedAt: 11 });
  });

  it('refuses a reading position below the first page and clamps instead of failing', () => {
    const result = applyPaperEdit(
      registry(attention),
      'a',
      {
        reading: { page: 0.4, updatedAt: 1 },
      },
      5,
    );
    expect(result.ok && result.paper.reading?.page).toBe(1);
  });

  it.each([
    { label: 'a malformed DOI', edit: { doi: 'not-a-doi' }, field: 'doi' },
    { label: 'a malformed arXiv id', edit: { arxivId: 'nope' }, field: 'arxivId' },
  ])('refuses $label and changes nothing', ({ edit, field }) => {
    const result = applyPaperEdit(registry(attention), 'a', edit, 5);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure).toMatchObject({
      reason: 'invalid-identifier',
      field,
    });
  });

  it('refuses an identifier another paper already owns, naming that paper', () => {
    const result = applyPaperEdit(registry(attention, bert), 'a', { doi: '10.1000/BERT' }, 5);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure).toMatchObject({
      reason: 'identifier-taken',
      field: 'doi',
      paper: { id: 'b' },
    });
  });

  it('does not merge two papers that would end up with the same identifier', () => {
    const papers = registry(attention, bert);
    applyPaperEdit(papers, 'a', { doi: '10.1000/bert' }, 5);
    expect(Object.keys(papers)).toStrictEqual(['a', 'b']);
    expect(papers.b?.title).toBe('BERT');
  });

  it('lets a paper keep an identifier it already has', () => {
    const result = applyPaperEdit(registry(attention, bert), 'b', { doi: '10.1000/bert' }, 5);
    expect(result.ok).toBe(true);
    expect(result.ok && result.paper).toBe(bert);
  });

  it('refuses a blank title', () => {
    const result = applyPaperEdit(registry(attention), 'a', { title: '   ' }, 5);
    expect(result.ok === false && result.failure.reason).toBe('blank-title');
  });

  it('refuses a year that is not a number', () => {
    const result = applyPaperEdit(registry(attention), 'a', { year: Number.NaN }, 5);
    expect(result.ok === false && result.failure.reason).toBe('invalid-year');
  });

  it('reports an unknown paper', () => {
    const result = applyPaperEdit(registry(attention), 'ghost', { title: 'x' }, 5);
    expect(result.ok === false && result.failure.reason).toBe('unknown-paper');
  });

  it('returns the very same object when there is nothing to change', () => {
    const result = applyPaperEdit(
      registry(attention),
      'a',
      {
        title: attention.title,
        authors: attention.authors,
        year: attention.year,
      },
      5,
    );
    expect(result.ok && result.paper).toBe(attention);
  });

  it('never touches the identity or the creation time', () => {
    const result = applyPaperEdit(registry(attention), 'a', { title: 'Renamed', year: 2020 }, 5);
    expect(result.ok && result.paper.id).toBe('a');
    expect(result.ok && result.paper.createdAt).toBe(attention.createdAt);
  });

  it('leaves every other paper untouched', () => {
    const papers = registry(attention, bert);
    applyPaperEdit(papers, 'a', { title: 'Renamed' }, 5);
    expect(papers.b).toBe(bert);
  });

  it('accepts a PDF binding it is asked to replace', () => {
    const withPdf = paper('d', { pdf: PDF });
    const replacement = { ...PDF, sha256: 'd'.repeat(64), name: 'other.pdf' };
    const result = applyPaperEdit(registry(withPdf), 'd', { pdf: replacement }, 5);
    expect(result.ok && result.paper.pdf).toStrictEqual(replacement);
  });

  it('normalizes tags: trims, drops blanks, dedupes case-insensitively', () => {
    const result = applyPaperEdit(
      registry(attention),
      'a',
      { tags: [' RL ', 'rl', '', '  survey  ', 'RL'] },
      5,
    );
    expect(result.ok && result.paper.tags).toStrictEqual(['RL', 'survey']);
  });

  it('clears tags with an empty list', () => {
    const tagged = paper('e', { tags: ['RL'] });
    const result = applyPaperEdit(registry(tagged), 'e', { tags: [] }, 5);
    if (!result.ok) throw new Error(result.failure.reason);
    expect(result.paper).not.toHaveProperty('tags');
  });

  it('sets a reading status and treats unread as its absence', () => {
    const reading = applyPaperEdit(registry(attention), 'a', { status: 'reading' }, 5);
    expect(reading.ok && reading.paper.status).toBe('reading');

    const cleared = applyPaperEdit(
      registry({ ...attention, status: 'done' }),
      'a',
      {
        status: 'unread',
      },
      5,
    );
    expect(cleared.ok && cleared.paper).not.toHaveProperty('status');
  });
});

describe('PaperSummary edits', () => {
  const base: Paper = {
    id: 'p1',
    title: 'A Paper',
    authors: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const card: PaperSummary = {
    text: '问题、方法、结论。',
    provider: 'mock',
    providerLabel: '本地模拟',
    model: 'mock-1',
    online: false,
    createdAt: 5,
  };

  it('sets a card and clears it back to absence', () => {
    const withCard = applyPaperEdit({ p1: base }, 'p1', { summary: card }, 10);
    expect(withCard.ok && withCard.paper.summary).toStrictEqual(card);
    const cleared = applyPaperEdit(
      withCard.ok ? { p1: withCard.paper } : {},
      'p1',
      { summary: null },
      11,
    );
    expect(cleared.ok && 'summary' in (cleared.paper as Paper)).toBe(false);
  });

  it('caps an oversized card instead of refusing it', () => {
    const long = applyPaperEdit(
      { p1: base },
      'p1',
      { summary: { ...card, text: 'x'.repeat(MAX_SUMMARY_LENGTH + 100) } },
      10,
    );
    expect(long.ok && long.paper.summary?.text).toHaveLength(MAX_SUMMARY_LENGTH);
  });

  it('leaves the card alone when the edit does not mention it', () => {
    const withCard = applyPaperEdit({ p1: base }, 'p1', { summary: card }, 10);
    const touched = applyPaperEdit(
      withCard.ok ? { p1: withCard.paper } : {},
      'p1',
      { title: 'Renamed' },
      12,
    );
    expect(touched.ok && touched.paper.summary).toStrictEqual(card);
  });
});
