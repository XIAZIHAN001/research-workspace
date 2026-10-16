import { describe, expect, it } from 'vitest';
import { parseModelOutput, verifyAnswer } from './citations.mjs';

const PASSAGES = [
  {
    id: 'selection',
    page: 7,
    selection: true,
    text: 'The attention weights are normalised across the key dimension.',
  },
  {
    id: 'ctx-1',
    page: 7,
    selection: false,
    text: 'We use scaled dot-product attention throughout.',
  },
];

function jsonOf(value) {
  return JSON.stringify(value);
}

describe('parseModelOutput', () => {
  it('reads a plain JSON object', () => {
    const parsed = parseModelOutput('{"answer":"hi","citations":[]}');
    expect(parsed.ok).toBe(true);
    expect(parsed.text).toBe('hi');
  });

  it('reads JSON that a provider wrapped in a code fence', () => {
    const parsed = parseModelOutput('```json\n{"answer":"hi","citations":[]}\n```');
    expect(parsed.ok).toBe(true);
    expect(parsed.text).toBe('hi');
  });

  it('reads JSON that a model prefaced with a sentence', () => {
    const parsed = parseModelOutput('Sure, here it is:\n{"answer":"hi","citations":[]}');
    expect(parsed.ok).toBe(true);
  });

  it('falls back to text when there is no answer field', () => {
    const parsed = parseModelOutput('{"other":1}');
    expect(parsed.ok).toBe(false);
    expect(parsed.text).toContain('other');
  });
});

describe('verifyAnswer', () => {
  it('keeps a citation whose quote is verbatim and takes the page from our own record', () => {
    const result = verifyAnswer(
      jsonOf({
        answer: '权重沿 key 维度归一化 [1]。',
        groundedInText: true,
        citations: [{ n: 1, passageId: 'selection', quote: 'normalised across the key dimension' }],
      }),
      PASSAGES,
    );
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].page).toBe(7);
    expect(result.citations[0].passageId).toBe('selection');
    expect(result.warnings).toEqual([]);
  });

  it('ignores a page number the model made up', () => {
    // The model was never asked for a page, and if it offers one it is not read.
    const result = verifyAnswer(
      jsonOf({
        answer: '见 [1]。',
        citations: [
          { n: 1, passageId: 'selection', quote: 'normalised across the key dimension', page: 999 },
        ],
      }),
      PASSAGES,
    );
    expect(result.citations[0].page).toBe(7);
  });

  it('drops a quoted passage that is not in the text it was given', () => {
    const result = verifyAnswer(
      jsonOf({
        answer: '作者指出 [1]。',
        citations: [{ n: 1, passageId: 'selection', quote: 'attention is all you need' }],
      }),
      PASSAGES,
    );
    expect(result.citations).toEqual([]);
    expect(result.warnings.join(' ')).toContain('未通过校验');
  });

  it('drops a citation naming a passage that was never sent', () => {
    const result = verifyAnswer(
      jsonOf({
        answer: '见 [1]。',
        citations: [{ n: 1, passageId: 'page-42', quote: 'scaled dot-product' }],
      }),
      PASSAGES,
    );
    expect(result.citations).toEqual([]);
    expect(result.warnings.join(' ')).toContain('未通过校验');
  });

  it('matches quotes across the whitespace a PDF text layer invents', () => {
    const result = verifyAnswer(
      jsonOf({
        answer: '见 [1]。',
        citations: [{ n: 1, passageId: 'selection', quote: 'weights   are\nnormalised' }],
      }),
      PASSAGES,
    );
    expect(result.citations).toHaveLength(1);
  });

  it('reports a marker in the text that has no verified citation behind it', () => {
    const result = verifyAnswer(
      jsonOf({
        answer: '一句话 [1]，另一句话 [2]。',
        citations: [{ n: 1, passageId: 'selection', quote: 'normalised across the key dimension' }],
      }),
      PASSAGES,
    );
    expect(result.citations).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('编号 2');
  });

  it('reports a verified citation the answer never refers to', () => {
    const result = verifyAnswer(
      jsonOf({
        answer: '没有编号的回答。',
        citations: [{ n: 1, passageId: 'selection', quote: 'normalised across the key dimension' }],
      }),
      PASSAGES,
    );
    expect(result.citations).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('没有在回答正文里被引用');
  });

  it('drops a repeated citation number rather than showing two different passages as [1]', () => {
    const result = verifyAnswer(
      jsonOf({
        answer: '见 [1]。',
        citations: [
          { n: 1, passageId: 'selection', quote: 'normalised across the key dimension' },
          { n: 1, passageId: 'ctx-1', quote: 'scaled dot-product' },
        ],
      }),
      PASSAGES,
    );
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].passageId).toBe('selection');
  });

  it('refuses to invent citations when the model ignored the JSON contract', () => {
    const result = verifyAnswer('这是一段没有任何引用标记的普通回答。', PASSAGES);
    expect(result.citations).toEqual([]);
    expect(result.groundedInText).toBeNull();
    expect(result.answer).toBe('这是一段没有任何引用标记的普通回答。');
    expect(result.warnings.join(' ')).toContain('没有按约定返回 JSON');
  });

  it('passes through a model that says the evidence is not enough', () => {
    const result = verifyAnswer(
      jsonOf({ answer: '提供的原文不足以回答。', groundedInText: false, citations: [] }),
      PASSAGES,
    );
    expect(result.groundedInText).toBe(false);
    expect(result.citations).toEqual([]);
  });

  it('flags a truncated answer instead of presenting it as complete', () => {
    const result = verifyAnswer(jsonOf({ answer: '半句', citations: [] }), PASSAGES, {
      truncated: true,
    });
    expect(result.warnings.join(' ')).toContain('截断');
  });

  it('survives a citations field that is not an array', () => {
    const result = verifyAnswer(jsonOf({ answer: 'ok', citations: 'nope' }), PASSAGES);
    expect(result.citations).toEqual([]);
  });
});

describe('verifyAnswer: answers that cannot be used', () => {
  it('says an empty answer is empty rather than showing a blank panel', () => {
    const result = verifyAnswer(jsonOf({ answer: '', citations: [] }), PASSAGES);
    expect(result.answer).toBe('');
    expect(result.warnings.join(' ')).toContain('空的回答');
  });

  it('says when the JSON had no answer field at all', () => {
    const result = verifyAnswer(jsonOf({ citations: [], note: 'oops' }), PASSAGES);
    expect(result.answer).toBe('');
    expect(result.warnings.join(' ')).toContain('没有可用的 answer');
    expect(result.citations).toEqual([]);
  });

  it.each([
    ['a number', { answer: 42 }],
    ['null', { answer: null }],
    ['an object', { answer: { text: 'x' } }],
    ['an array', { answer: ['x'] }],
  ])('refuses an answer field that is %s', (_label, shape) => {
    const result = verifyAnswer(jsonOf(shape), PASSAGES);
    expect(result.answer).toBe('');
    expect(result.citations).toEqual([]);
    expect(result.warnings.join(' ')).toContain('没有可用的 answer');
  });

  it('treats a non-boolean groundedInText as no claim rather than as false', () => {
    // `false` means the model said the text was insufficient; `"no"` means nothing usable at
    // all. Reporting the second as the first would put words in the model's mouth.
    expect(
      verifyAnswer(jsonOf({ answer: 'x', groundedInText: 'no' }), PASSAGES).groundedInText,
    ).toBe(null);
    expect(
      verifyAnswer(jsonOf({ answer: 'x', groundedInText: false }), PASSAGES).groundedInText,
    ).toBe(false);
  });

  it.each([
    ['a bare string', ['nope']],
    ['an empty object', [{}]],
    ['a string citation number', [{ n: '1', passageId: 'selection', quote: 'scaled dot-product' }]],
    ['a missing quote', [{ n: 1, passageId: 'selection' }]],
    ['a non-string quote', [{ n: 1, passageId: 'selection', quote: 7 }]],
  ])('drops a citation entry that is %s', (_label, citations) => {
    const result = verifyAnswer(jsonOf({ answer: '见 [1]。', citations }), PASSAGES);
    expect(result.citations).toEqual([]);
  });
});

/**
 * What this module does *not* check, written down as tests so the boundary cannot quietly move.
 *
 * Three different questions get asked about an answer, and only the first one is machine-checked
 * here:
 *
 *   1. Is the quotation real?          — checked, byte for byte, against the passages sent.
 *   2. Does the text support the claim? — not checked. Judging that needs a reader, or a second
 *                                         model whose judgement would itself be unverified.
 *   3. Is the claim true?               — not checked, and not checkable by this service.
 *
 * The tests below are the honest measure of that: answers that cite genuine text while drawing a
 * conclusion it does not support come back fully "verified", because from this layer's point of
 * view they are. The interface says so in as many words — see the caveat asserted in
 * `AiPanel.test.tsx`.
 */
describe('verifyAnswer: what citation checking does not claim', () => {
  it('accepts a real quotation attached to a conclusion the passage never makes', () => {
    const result = verifyAnswer(
      jsonOf({
        answer: '作者证明注意力机制在所有任务上都优于卷积 [1]。',
        groundedInText: true,
        citations: [{ n: 1, passageId: 'selection', quote: 'normalised across the key dimension' }],
      }),
      PASSAGES,
    );
    // The quotation is genuinely there, so nothing here objects — and the passage says nothing
    // about convolutions at all. Only a reader can catch this.
    expect(result.citations).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it('accepts a real quotation attached to a derivation that is nowhere in the text', () => {
    const result = verifyAnswer(
      jsonOf({
        answer: '由此可得 Var(x) = E[x²] − (E[x])²，代入即得方差不随序列长度增长 [1]。',
        groundedInText: true,
        citations: [{ n: 1, passageId: 'ctx-1', quote: 'scaled dot-product attention' }],
      }),
      PASSAGES,
    );
    expect(result.citations).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it('is pure by construction, so there is nowhere to call a grader from', () => {
    const result = verifyAnswer(jsonOf({ answer: 'x', citations: [] }), PASSAGES);
    // A plain value, not a promise: nothing in this module reaches outside the process, which is
    // what makes "no second model call grades the first" a property rather than a promise.
    expect(result).not.toBeInstanceOf(Promise);
    expect(Object.keys(result).sort()).toEqual([
      'answer',
      'citations',
      'groundedInText',
      'warnings',
    ]);
  });
});
