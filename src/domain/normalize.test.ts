import { describe, expect, it } from 'vitest';
import { MAX_NAME_LENGTH, MAX_TITLE_LENGTH, normalizeName, normalizeTitle } from './normalize';

const NBSP = String.fromCodePoint(0x00a0);
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000);
const GRINNING_FACE = '\u{1F600}';

describe('normalizeName', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalizeName('  Attention Is All You Need \n')).toBe('Attention Is All You Need');
  });

  it('collapses runs of inner whitespace into a single space', () => {
    expect(normalizeName('Deep \t Residual\n\nLearning')).toBe('Deep Residual Learning');
  });

  it('treats non-breaking and ideographic spaces as whitespace', () => {
    const raw = `${NBSP}深度${IDEOGRAPHIC_SPACE}${IDEOGRAPHIC_SPACE}学习${NBSP}`;
    expect(normalizeName(raw)).toBe('深度 学习');
  });

  it.each([
    { label: 'an empty string', raw: '' },
    { label: 'spaces only', raw: '     ' },
    { label: 'mixed whitespace only', raw: ` \t\r\n${NBSP}${IDEOGRAPHIC_SPACE} ` },
  ])('returns null for $label', ({ raw }) => {
    expect(normalizeName(raw)).toBeNull();
  });

  it('keeps names that are exactly the maximum length', () => {
    const name = 'a'.repeat(MAX_NAME_LENGTH);
    expect(normalizeName(name)).toBe(name);
  });

  it('truncates names longer than the maximum length', () => {
    expect(normalizeName('a'.repeat(MAX_NAME_LENGTH + 20))).toBe('a'.repeat(MAX_NAME_LENGTH));
  });

  it('counts code points, so astral characters are never split', () => {
    const result = normalizeName(GRINNING_FACE.repeat(MAX_NAME_LENGTH + 1));
    expect(result).toBe(GRINNING_FACE.repeat(MAX_NAME_LENGTH));
    // Two UTF-16 units per emoji: a split surrogate pair would make this odd.
    expect(result).toHaveLength(MAX_NAME_LENGTH * 2);
  });

  it('trims again when truncation leaves a trailing space', () => {
    const raw = `${'a'.repeat(MAX_NAME_LENGTH - 1)} b`;
    expect(normalizeName(raw)).toBe('a'.repeat(MAX_NAME_LENGTH - 1));
  });

  it('collapses whitespace before measuring the length', () => {
    expect(normalizeName(`x${' '.repeat(500)}y`)).toBe('x y');
  });

  it('is idempotent', () => {
    const samples = [
      '  a   b  ',
      'x'.repeat(200),
      `${GRINNING_FACE} `.repeat(100),
      `${IDEOGRAPHIC_SPACE}深度${IDEOGRAPHIC_SPACE}`,
    ];
    for (const raw of samples) {
      const once = normalizeName(raw);
      expect(once).not.toBeNull();
      expect(normalizeName(once ?? '')).toBe(once);
    }
  });
});

describe('normalizeTitle', () => {
  it('collapses whitespace like a name does', () => {
    expect(normalizeTitle('  Attention   Is\nAll You Need ')).toBe('Attention Is All You Need');
  });

  it('returns null when nothing usable is left', () => {
    expect(normalizeTitle(' \t\n ')).toBeNull();
  });

  it('keeps a real title that a project name would have cut', () => {
    const title =
      'Efficient Verification of Arithmetic Circuits with a Focus on Zero-Knowledge Proofs and Beyond';
    expect(MAX_NAME_LENGTH).toBeLessThan(Array.from(title).length);
    expect(normalizeTitle(title)).toBe(title);
  });

  it('still caps the title, so storage cannot grow without a bound', () => {
    expect(normalizeTitle('a'.repeat(MAX_TITLE_LENGTH + 20))).toBe('a'.repeat(MAX_TITLE_LENGTH));
  });

  it('counts code points, so astral characters are never split', () => {
    expect(normalizeTitle(GRINNING_FACE.repeat(MAX_TITLE_LENGTH + 1))).toHaveLength(
      MAX_TITLE_LENGTH * 2,
    );
  });

  it('is idempotent', () => {
    const raw = `${'word '.repeat(60)}end`;
    const once = normalizeTitle(raw);
    expect(once).not.toBeNull();
    expect(normalizeTitle(once ?? '')).toBe(once);
  });
});
