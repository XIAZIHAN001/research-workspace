import { describe, expect, it } from 'vitest';
import { findMatches, foldForFind, nextHitIndex, pageTextFromItems } from './findText';

describe('pageTextFromItems', () => {
  it('joins items in order without inventing spaces', () => {
    expect(pageTextFromItems([{ str: 'Machine' }, { str: 'learning' }])).toBe('Machinelearning');
  });

  it('adds a space where pdf.js marks an end of line', () => {
    expect(pageTextFromItems([{ str: 'Machine', hasEOL: true }, { str: 'learning' }])).toBe(
      'Machine learning',
    );
  });

  it('collapses runs of whitespace', () => {
    expect(pageTextFromItems([{ str: 'one   two\nthree' }])).toBe('one two three');
  });

  it('ignores items that are not text', () => {
    expect(
      pageTextFromItems([{ type: 'beginMarkedContent' }, { str: 'real' }, { type: 'end' }]),
    ).toBe('real');
  });

  it('does not put spaces between adjacent Chinese characters', () => {
    expect(pageTextFromItems([{ str: '机器' }, { str: '学习' }])).toBe('机器学习');
  });
});

describe('foldForFind', () => {
  it('lower-cases and collapses whitespace', () => {
    expect(foldForFind('  Machine   Learning \n').text).toBe('machine learning');
  });

  it('drops whitespace between Chinese characters', () => {
    expect(foldForFind('机 器 学 习').text).toBe('机器学习');
  });

  it('keeps a space between Chinese and Latin words', () => {
    expect(foldForFind('机器 learning').text).toBe('机器 learning');
  });

  it('maps folded characters back to the original offsets', () => {
    const folded = foldForFind('A  machine');
    const at = folded.text.indexOf('machine');
    expect(at).toBeGreaterThanOrEqual(0);
    expect('A  machine'.slice(folded.map[at] ?? 0)).toBe('machine');
  });
});

describe('findMatches', () => {
  it('finds every occurrence across pages, in reading order', () => {
    const hits = findMatches(['First machine learning paper', 'Machine learning again'], 'machine');
    expect(hits.map((hit) => hit.page)).toEqual([1, 2]);
    expect(hits.map((hit) => hit.snippet)).toEqual(['machine', 'Machine']);
  });

  it('is case insensitive but quotes the page spelling', () => {
    const hits = findMatches(['A Machine at work'], 'MACHINE');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toBe('Machine');
    expect(hits[0]?.start).toBe(2);
    expect(hits[0]?.end).toBe(9);
  });

  it('numbers repeated occurrences on one page', () => {
    const hits = findMatches(['cat cat cat'], 'cat');
    expect(hits.map((hit) => hit.ordinal)).toEqual([0, 1, 2]);
  });

  it('matches Chinese phrases that the text layer split with spaces', () => {
    const hits = findMatches(['机 器 学 习 的 方 法'], '机器学习');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.page).toBe(1);
  });

  it('returns nothing for an empty or blank query', () => {
    expect(findMatches(['text'], '')).toEqual([]);
    expect(findMatches(['text'], '   ')).toEqual([]);
  });

  it('stops at the limit without scanning the rest', () => {
    const hits = findMatches(['a a a a a', 'a a a a a'], 'a', 3);
    expect(hits).toHaveLength(3);
    expect(hits.map((hit) => hit.page)).toEqual([1, 1, 1]);
  });
});

describe('nextHitIndex', () => {
  it('wraps forward and backward', () => {
    expect(nextHitIndex(0, 3, 1)).toBe(1);
    expect(nextHitIndex(2, 3, 1)).toBe(0);
    expect(nextHitIndex(0, 3, -1)).toBe(2);
  });

  it('starts at the first or last result when nothing is current', () => {
    expect(nextHitIndex(-1, 3, 1)).toBe(0);
    expect(nextHitIndex(-1, 3, -1)).toBe(2);
  });

  it('reports no result when the list is empty', () => {
    expect(nextHitIndex(-1, 0, 1)).toBe(-1);
  });
});
