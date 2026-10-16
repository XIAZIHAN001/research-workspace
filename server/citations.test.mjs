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
