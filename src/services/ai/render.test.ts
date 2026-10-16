import { describe, expect, it } from 'vitest';
import { citedInOrder, segmentAnswer, segmentParagraph } from './render';
import type { AiCitation } from './types';

const C1: AiCitation = { n: 1, passageId: 'selection', page: 3, quote: 'alpha', selection: true };
const C2: AiCitation = { n: 2, passageId: 'after', page: 3, quote: 'beta', selection: false };

/** The rendered text of a paragraph, with citations shown as their marker. */
function flatten(pieces: ReturnType<typeof segmentParagraph>): string {
  return pieces
    .map((piece) => (piece.kind === 'text' ? piece.text : `[${String(piece.citation.n)}]`))
    .join('');
}

describe('segmentParagraph', () => {
  it('turns a verified marker into a citation and keeps the prose around it', () => {
    const pieces = segmentParagraph('作者说 [1] 权重归一化。', [C1]);
    expect(pieces).toHaveLength(3);
    expect(pieces[0]).toEqual({ kind: 'text', text: '作者说 ' });
    expect(pieces[1]).toMatchObject({ kind: 'citation', citation: { n: 1, page: 3 } });
    expect(pieces[2]).toEqual({ kind: 'text', text: ' 权重归一化。' });
  });

  it('leaves a marker with nothing behind it as ordinary text', () => {
    // The service already dropped the citation; the number must not become a button.
    expect(segmentParagraph('作者说 [7]。', [C1])).toEqual([
      { kind: 'text', text: '作者说 [7]。' },
    ]);
  });

  it('handles several citations in one paragraph', () => {
    const pieces = segmentParagraph('先 [1] 后 [2]。', [C1, C2]);
    expect(pieces.filter((piece) => piece.kind === 'citation')).toHaveLength(2);
    expect(flatten(pieces)).toBe('先 [1] 后 [2]。');
  });

  it('keeps a marker at the very start and the very end', () => {
    expect(flatten(segmentParagraph('[1]全部[2]', [C1, C2]))).toBe('[1]全部[2]');
  });

  it('reassembles the original text exactly', () => {
    const text = '一点 [1] 两点 [2] 三点，没有别的。';
    expect(flatten(segmentParagraph(text, [C1, C2]))).toBe(text);
  });

  it('does not treat a bracketed number that is not a citation as one', () => {
    expect(segmentParagraph('见 [42]。', [C1])).toEqual([{ kind: 'text', text: '见 [42]。' }]);
  });
});

describe('segmentAnswer', () => {
  it('splits into paragraphs on newlines and drops blank lines', () => {
    const paragraphs = segmentAnswer('第一段。\n\n第二段。\n\n\n第三段。', []);
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs.map((paragraph) => flatten(paragraph.pieces))).toEqual([
      '第一段。',
      '第二段。',
      '第三段。',
    ]);
  });

  it('returns nothing for an empty answer', () => {
    expect(segmentAnswer('', [])).toEqual([]);
    expect(segmentAnswer('   \n  \n', [])).toEqual([]);
  });

  it('keeps markup as literal text, because that is all it is', () => {
    const paragraphs = segmentAnswer('<script>alert(1)</script>', []);
    expect(flatten(paragraphs[0]?.pieces ?? [])).toBe('<script>alert(1)</script>');
  });
});

describe('citedInOrder', () => {
  it('lists the citations the answer actually refers to, in order', () => {
    expect(citedInOrder('先 [2] 后 [1]。', [C1, C2]).map((c) => c.n)).toEqual([2, 1]);
  });

  it('lists a citation once however often it is referred to', () => {
    expect(citedInOrder('[1] 和 [1]', [C1]).map((c) => c.n)).toEqual([1]);
  });

  it('ignores markers that were never verified', () => {
    expect(citedInOrder('[9]', [C1])).toEqual([]);
  });
});
