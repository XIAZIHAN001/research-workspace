import { readFileSync } from 'node:fs';
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

  it('refuses a JSON object that carries no answer, rather than showing it as prose', () => {
    const parsed = parseModelOutput('{"other":1}');
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe('malformed');
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

  it('shows a prose answer, and says it has no citable quotes', () => {
    // Prose is the *degraded* shape, not an error: the reader still gets an answer. What they
    // do not get is a citation, because none was offered in a form that could be checked.
    const result = verifyAnswer('这是一段没有任何引用标记的普通回答。', PASSAGES);
    expect(result.status).toBe('recovered');
    expect(result.citations).toEqual([]);
    expect(result.groundedInText).toBeNull();
    expect(result.answer).toBe('这是一段没有任何引用标记的普通回答。');
    expect(result.diagnostics.recovery).toBe('prose');
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

  it('calls a JSON object with no answer field malformed, not empty', () => {
    const result = verifyAnswer(jsonOf({ citations: [], note: 'oops' }), PASSAGES);
    expect(result.answer).toBe('');
    expect(result.status).toBe('malformed');
    expect(result.citations).toEqual([]);
  });

  it.each([
    ['a number', { answer: 42 }],
    ['null', { answer: null }],
    ['an object', { answer: { text: 'x' } }],
    ['an array', { answer: ['x'] }],
  ])('refuses an answer field that is %s', (_label, shape) => {
    // A non-string `answer` is not an answer this service can show, and the JSON it sits in is
    // never displayed in its place. The type mismatch is the whole reason for the refusal.
    const result = verifyAnswer(jsonOf(shape), PASSAGES);
    expect(result.answer).toBe('');
    expect(result.status).toBe('malformed');
    expect(result.citations).toEqual([]);
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
/**
 * The live API produced a 3971-character answer whose every citation was correct and whose JSON
 * envelope did not parse. Rejecting that whole answer and showing the reader raw JSON is a worse
 * outcome than reading the fields out of it — as long as every citation is still checked word for
 * word, which it is.
 */
describe('verifyAnswer: recovering a good answer from a broken envelope', () => {
  it('reads the fields out when a stray trailing comma broke the parse', () => {
    const broken =
      '{"answer": "作者说 [1]。", "groundedInText": true, "citations": [{"n":1,"passageId":"selection","quote":"normalised across the key dimension"}],}';
    const result = verifyAnswer(broken, PASSAGES);
    expect(result.answer).toBe('作者说 [1]。');
    expect(result.groundedInText).toBe(true);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.passageId).toBe('selection');
    expect(result.warnings.join(' ')).toContain('JSON 不完整');
  });

  it('keeps the citations whose own objects are intact when the array is cut off', () => {
    const broken =
      '{"answer": "见 [1]。", "citations": [{"n":1,"passageId":"selection","quote":"normalised across the key dimension"}';
    const result = verifyAnswer(broken, PASSAGES);
    expect(result.answer).toBe('见 [1]。');
    expect(result.citations).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('JSON 不完整');
  });

  it('still refuses a citation that the passages do not contain', () => {
    const broken =
      '{"answer": "见 [1]。", "citations": [{"n":1,"passageId":"selection","quote":"这并不在原文里"}],}';
    const result = verifyAnswer(broken, PASSAGES);
    // Recovery is of the *shape*; the citation still has to earn its place.
    expect(result.citations).toEqual([]);
    expect(result.warnings.join(' ')).toContain('未通过校验');
  });

  it('does not salvage an answer field that is not a string', () => {
    expect(verifyAnswer('{"answer": 42, "citations": []', PASSAGES).answer).toBe('');
    expect(verifyAnswer('{"answer": {"text": "x"}, "citations": []', PASSAGES).answer).toBe('');
  });
});

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
      'diagnostics',
      'groundedInText',
      'status',
      'warnings',
    ]);
  });
});

/**
 * The contract this service asks for now, and the shapes it has to survive when a model does
 * not follow it.
 *
 * The order of these cases is the order `parseModelOutput` tries them, and each names the status
 * the interface keys off. What every case has in common is that a citation still has to be
 * verbatim: recovery is of the shape, never of the evidence.
 */
const SENTINEL = '<<<CITATIONS>>>';

function sentinelReply(answer, block) {
  return `${answer}\n${SENTINEL}\n${block}`;
}

describe('parseModelOutput: the agreed contract', () => {
  it('reads plain text followed by a citation block', () => {
    const parsed = parseModelOutput(
      sentinelReply('作者说 [1]。', '{"groundedInText": true, "citations": []}'),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe('valid');
    expect(parsed.text).toBe('作者说 [1]。');
    expect(parsed.value.groundedInText).toBe(true);
  });

  it('keeps the answer byte for byte, LaTeX and all', () => {
    // The whole point of taking the answer out of JSON: nothing escapes it, so nothing is lost.
    const answer =
      '这里 $R(u) := \\log \\frac{P_1(u)}{P_0(u)}$ 是对数比，$\\beta \\ge 0$ 控制强度。';
    const parsed = parseModelOutput(sentinelReply(answer, '{"citations": []}'));
    expect(parsed.text).toBe(answer);
  });

  it('accepts a bare array as the citation block', () => {
    const parsed = parseModelOutput(
      sentinelReply('见 [1]。', '[{"n":1,"passageId":"selection","quote":"normalised"}]'),
    );
    expect(parsed.status).toBe('valid');
    expect(parsed.value.citations).toHaveLength(1);
  });

  it('separates the answer from a broken block without losing the answer', () => {
    const parsed = parseModelOutput(sentinelReply('作者说 [1]。', '{"citations": [{"n":1,'));
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe('recovered');
    expect(parsed.text).toBe('作者说 [1]。');
    expect(parsed.value.citations).toEqual([]);
    expect(parsed.recovery).toBe('sentinel-broken-block');
  });

  it('shows an answer that simply has no block', () => {
    const parsed = parseModelOutput('只是普通的一段回答，没有引用。');
    expect(parsed.status).toBe('recovered');
    expect(parsed.recovery).toBe('prose');
  });

  it('refuses a reply that is only the sentinel and metadata', () => {
    // There is no answer body. The block is protocol, and showing it would be showing JSON.
    const parsed = parseModelOutput(sentinelReply('', '{"citations": []}'));
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe('malformed');
  });

  it('takes the last sentinel, so a quotation of it cannot split the answer early', () => {
    const answer = `模型在正文里提到了 ${SENTINEL} 这个词。`;
    const parsed = parseModelOutput(`${answer}\n${SENTINEL}\n{"citations": []}`);
    expect(parsed.text).toBe(answer.trim());
  });
});

describe('parseModelOutput: the shapes that are not the contract', () => {
  it('still reads the JSON envelope the old contract asked for', () => {
    const parsed = parseModelOutput(jsonOf({ answer: '旧格式', citations: [] }));
    expect(parsed.status).toBe('valid');
    expect(parsed.recovery).toBe('legacy-json');
  });

  it('survives complex LaTeX inside a legacy JSON envelope', () => {
    const latex = '$$Z_\\beta = \\sum_u P_1(u)\\, e^{\\beta R(u)}$$';
    const parsed = parseModelOutput(jsonOf({ answer: latex, citations: [] }));
    expect(parsed.text).toBe(latex);
  });

  it('never returns protocol text as an answer', () => {
    // Every one of these is something a model plausibly returns when it tries to answer in
    // JSON and gets it wrong. None of them may reach the reader as prose.
    for (const text of [
      '{"answer": 42, "citations": []}',
      '{"answer": null, "citations": []}',
      '{"answer": {"text": "x"}, "citations": []}',
      '{"citations": [], "note": "oops"}',
    ]) {
      const parsed = parseModelOutput(text);
      expect(parsed.ok).toBe(false);
      expect(parsed.text).toBe('');
    }
  });

  it('refuses output that is not a string at all', () => {
    expect(parseModelOutput(undefined).ok).toBe(false);
    expect(parseModelOutput('').ok).toBe(false);
  });
});

describe('the real reply that broke the old contract', () => {
  const saved = JSON.parse(
    readFileSync('server/providers/fixtures/live-formula-escaped-envelope.json', 'utf8'),
  );

  it('is the saved response, not a retyped imitation', () => {
    expect(saved.raw.length).toBe(saved.chars);
    expect(saved.raw.length).toBeGreaterThan(3900);
    expect(saved.raw).toContain('\\"groundedInText\\"');
    // The failure, stated as a fact about the bytes: the model escaped its own protocol into
    // the answer string, so the envelope never closes.
    expect(saved.raw.startsWith('{"answer": "')).toBe(true);
    expect(saved.finishReason).toBe(null);
  });

  it('is recovered deterministically, with no guessing', () => {
    const parsed = parseModelOutput(saved.raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe('recovered');
    expect(parsed.recovery).toBe('escaped-envelope');
    expect(parsed.text.startsWith('先说明提取质量')).toBe(true);
    expect(parsed.text.length).toBe(2829);
    expect(parsed.value.citations).toHaveLength(7);
    expect(parsed.value.groundedInText).toBe(true);
  });

  it('shows no protocol, no escapes and no JSON in what the reader would see', () => {
    const parsed = parseModelOutput(saved.raw);
    for (const leak of ['"citations"', '"groundedInText"', '"passageId"', '\\"', '{"answer"']) {
      expect(parsed.text).not.toContain(leak);
    }
  });

  it('keeps the LaTeX, rather than eating the backslashes', () => {
    const parsed = parseModelOutput(saved.raw);
    // Un-escaping structural quotes must leave `\log` and `\frac` alone: they are `\\` in the
    // JSON source and become a single backslash in the decoded string, which is the right one.
    expect(parsed.text).toContain('\\log');
    expect(parsed.text).toContain('\\frac');
  });

  it('still verifies every citation against the passages it was given', () => {
    // The passages that went with this reply were not saved, so nothing can match — and that is
    // exactly the point: recovery does not certify anything. All seven are refused.
    const result = verifyAnswer(saved.raw, PASSAGES);
    expect(result.status).toBe('recovered');
    expect(result.diagnostics.citationEntries).toBe(7);
    expect(result.diagnostics.citationsAccepted).toBe(0);
    expect(result.diagnostics.citationsRejected).toBe(7);
    expect(result.citations).toEqual([]);
    expect(result.warnings.join(' ')).toContain('未通过校验');
  });

  it('accepts one of them when the passage it quotes is supplied', () => {
    const quote = 'where β ≥ 0 controls guidance strength and Zβ is the normalizing constant';
    const result = verifyAnswer(saved.raw, [
      { id: 'selection', page: 7, selection: true, text: quote },
    ]);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].n).toBe(5);
    expect(result.citations[0].page).toBe(7);
  });
});

describe('verifyAnswer: status says what happened', () => {
  it('marks a truncated reply incomplete instead of complete', () => {
    const result = verifyAnswer(sentinelReply('写了一半', '{"citations": []}'), PASSAGES, {
      truncated: true,
    });
    expect(result.status).toBe('incomplete');
    expect(result.answer).toBe('写了一半');
    expect(result.warnings.join(' ')).toContain('截断');
  });

  it('marks a truncated reply that also failed to parse as incomplete, not malformed', () => {
    // The cut is the explanation for the breakage; saying "malformed" alone would hide it.
    const result = verifyAnswer('{"answer": "写了一半', PASSAGES, { truncated: true });
    expect(result.status).toBe('incomplete');
    expect(result.answer).toBe('');
  });

  it('marks unreadable output malformed', () => {
    const result = verifyAnswer('{"answer": 42}', PASSAGES);
    expect(result.status).toBe('malformed');
    expect(result.answer).toBe('');
  });

  it('records what happened in diagnostics, and nothing about the text', () => {
    const result = verifyAnswer(sentinelReply('见 [1]。', '{"citations": []}'), PASSAGES);
    expect(Object.keys(result.diagnostics).sort()).toEqual([
      'citationEntries',
      'citationsAccepted',
      'citationsRejected',
      'rawChars',
      'recovery',
    ]);
    expect(result.diagnostics.rawChars).toBeGreaterThan(0);
    // Numbers and enums only: no prompt, no paper text, no key.
    for (const value of Object.values(result.diagnostics)) {
      expect(['number', 'string'].includes(typeof value) || value === null).toBe(true);
    }
  });
});
