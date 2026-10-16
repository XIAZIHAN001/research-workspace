/**
 * The offline provider.
 *
 * It exists so that the whole path — browser, origin checks, prompt assembly, citation
 * verification, answer rendering — can be exercised and asserted on without a network call, a
 * credential, or a bill. Its answers are a deterministic function of the request, which is what
 * makes them usable as test fixtures.
 *
 * It is not a model and does not pretend to be: every answer it produces is labelled as coming
 * from the mock provider, and the reader sees that label.
 */

import { ProviderError } from '../errors.mjs';

/** Scenario switches, read from the question so the tests can reach every failure path. */
export const MOCK_TRIGGERS = {
  '[[mock:error]]': 'upstream',
  '[[mock:timeout]]': 'timeout',
  '[[mock:bad-citation]]': 'bad-citation',
  '[[mock:plain-text]]': 'plain-text',
  '[[mock:ungrounded]]': 'ungrounded',
  '[[mock:html]]': 'html',
};

function pickTrigger(question) {
  for (const [token, scenario] of Object.entries(MOCK_TRIGGERS)) {
    if (question.includes(token)) return scenario;
  }
  return null;
}

function escapeForJson(value) {
  return JSON.stringify(value);
}

/**
 * The default answer: a fixed frame around the reader's own selection.
 *
 * It echoes the first part of the selected passage and cites it verbatim, so the citation check,
 * the page number on the chip, and the jump back to the page are all genuinely exercised.
 */
function describe(mode, passage, question) {
  const excerpt = passage.text.replace(/\s+/g, ' ').trim();
  const quoted = excerpt.length > 160 ? `${excerpt.slice(0, 160)}…` : excerpt;
  const body = [
    `（本地模拟回答：当前没有连接在线模型，以下内容由 mock provider 生成，仅用于验证流程。）`,
    '',
    `你选中的是第 ${String(passage.page)} 页的这段话：`,
    `“${quoted}”`,
    '',
    mode === 'translate'
      ? '译文：这是一段用于验证翻译流程的占位译文，它与左侧英文原文逐段对应显示。'
      : '这段文字在该页的可见范围内被完整提取，可以作为引用回到原文。',
    question === '' ? '' : `针对你的问题「${question}」，模拟回答不会给出真实结论。`,
    '',
    '依据：[1]',
  ]
    .filter((line) => line !== '')
    .join('\n');
  return {
    answer: body,
    groundedInText: true,
    citations: [{ n: 1, passageId: passage.id, quote: passage.text.replace(/\s+/g, ' ').trim() }],
  };
}

export function createMockProvider({ model = 'mock-1' } = {}) {
  return {
    name: 'mock',
    model,
    /** Says plainly that answers here are not model output; the UI shows this verbatim. */
    label: '本地模拟（未连接在线模型）',

    async complete({ system, messages, meta, signal }) {
      const scenario = pickTrigger(meta.question ?? '');
      if (scenario === 'upstream') {
        throw new ProviderError('upstream', '模拟的模型服务错误（用于验证错误恢复）。');
      }
      if (scenario === 'timeout') {
        // Waits for the caller to give up, which is what a stalled upstream looks like.
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 30_000);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new ProviderError('timeout', '模拟的模型超时（用于验证超时恢复）。'));
          });
        });
      }

      const passage = meta.passages.find((entry) => entry.selection) ?? meta.passages[0];
      const excerpt = passage.text.replace(/\s+/g, ' ').trim();
      const answer = describe(meta.mode, passage, meta.question ?? '');

      if (scenario === 'plain-text') {
        return {
          text: '模拟回答：这次故意不返回 JSON，用来验证引用无法校验时的降级路径。',
          usage: null,
          truncated: false,
        };
      }
      if (scenario === 'bad-citation') {
        answer.citations = [
          { n: 1, passageId: passage.id, quote: '这段文字并不存在于提供的原文里。' },
          { n: 2, passageId: 'not-a-real-passage', quote: excerpt },
          { n: 3, passageId: passage.id, quote: excerpt },
        ];
      }
      if (scenario === 'ungrounded') {
        answer.groundedInText = false;
        answer.answer =
          '提供的原文不足以回答这个问题：这里只有一段被选中的文字，缺少它所在的完整论证。';
        answer.citations = [];
      }
      if (scenario === 'html') {
        answer.answer =
          '下面这段应被当作纯文本显示：\n<img src=x onerror="window.__aiInjected = true">\n<script>window.__aiInjected = true;</script>';
      }

      void system;
      void messages;
      return { text: escapeForJson(answer), usage: null, truncated: false };
    },
  };
}
