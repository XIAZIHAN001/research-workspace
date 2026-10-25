import { describe, expect, it } from 'vitest';
import {
  applyGlossaryEdit,
  createGlossaryEntry,
  matchGlossary,
  matchGlossaryAt,
  sortGlossary,
} from './glossary';

describe('createGlossaryEntry', () => {
  it('builds an entry and normalizes the term', () => {
    const entry = createGlossaryEntry(
      { paperId: 'pa', term: '  KZG   scheme ', definition: ' 多项式承诺 ' },
      () => 'id',
      10,
    );
    expect(entry).not.toBeNull();
    expect(entry?.term).toBe('KZG scheme');
    expect(entry?.definition).toBe('多项式承诺');
    expect(entry?.createdAt).toBe(10);
  });

  it('refuses a blank term or a paper-less record', () => {
    expect(createGlossaryEntry({ paperId: 'pa', term: '   ' }, () => 'id', 1)).toBeNull();
    expect(createGlossaryEntry({ paperId: '', term: 'KZG' }, () => 'id', 1)).toBeNull();
  });
});

describe('applyGlossaryEdit', () => {
  const entry = createGlossaryEntry(
    { paperId: 'pa', term: 'KZG', definition: '旧解释' },
    () => 'id',
    10,
  );

  it('changes the definition and stamps the time', () => {
    const edited = applyGlossaryEdit(entry!, { definition: '新解释' }, 20);
    expect(edited?.definition).toBe('新解释');
    expect(edited?.updatedAt).toBe(20);
  });

  it('refuses an edit that would blank the term, and no-ops an unchanged one', () => {
    expect(applyGlossaryEdit(entry!, { term: ' ' }, 20)).toBeNull();
    expect(applyGlossaryEdit(entry!, { definition: '旧解释' }, 20)).toBe(entry);
  });
});

describe('sortGlossary', () => {
  it('sorts alphabetically, ties by creation time', () => {
    const order = sortGlossary([
      { id: 'b', paperId: 'p', term: 'SNARK', definition: '', createdAt: 1, updatedAt: 1 },
      { id: 'a', paperId: 'p', term: 'KZG', definition: '', createdAt: 5, updatedAt: 5 },
      { id: 'c', paperId: 'p', term: 'KZG', definition: '', createdAt: 2, updatedAt: 2 },
    ]);
    expect(order.map((entry) => entry.id)).toStrictEqual(['c', 'a', 'b']);
  });
});

describe('matchGlossary', () => {
  const entries = [
    { id: '1', paperId: 'p', term: 'KZG', definition: '', createdAt: 1, updatedAt: 1 },
    { id: '2', paperId: 'p', term: 'KZG commitment', definition: '', createdAt: 1, updatedAt: 1 },
    { id: '3', paperId: 'p', term: 'x', definition: '', createdAt: 1, updatedAt: 1 },
  ];

  it('finds a term inside a span, case-insensitively, preferring the longest match', () => {
    expect(matchGlossary(entries, 'the kzg commitment scheme')?.id).toBe('2');
    expect(matchGlossary(entries, 'a KZG proof')?.id).toBe('1');
  });

  it('ignores one-character terms and text without any term', () => {
    expect(matchGlossary(entries, 'x marks the spot')?.id).toBeUndefined();
    expect(matchGlossary(entries, 'nothing here')).toBeNull();
  });
});

describe('matchGlossaryAt', () => {
  const entries = [
    { id: '1', paperId: 'p', term: 'KZG', definition: '', createdAt: 1, updatedAt: 1 },
    { id: '2', paperId: 'p', term: 'KZG commitment', definition: '', createdAt: 1, updatedAt: 1 },
  ];
  const text = 'uses a KZG commitment here';

  it('matches only when the caret offset is inside the term occurrence', () => {
    // 'KZG commitment' occupies offsets 7..20; 12 is inside the longer term only.
    expect(matchGlossaryAt(entries, text, 12)?.id).toBe('2');
    // Offset 2 is 'e' of "uses" — no term covers it, even though the span contains one.
    expect(matchGlossaryAt(entries, text, 2)).toBeNull();
  });

  it('prefers the longer term when both cover the offset', () => {
    // Offset 7 is the 'K' of both terms; the longer one wins.
    expect(matchGlossaryAt(entries, text, 7)?.id).toBe('2');
  });

  it('is case-insensitive in the same way as the span match', () => {
    expect(matchGlossaryAt(entries, 'USES kzg HERE', 6)?.id).toBe('1');
  });
});
