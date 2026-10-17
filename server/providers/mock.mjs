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
 *
 * Its answers follow the same contract a real provider is asked for — plain text, a sentinel
 * line, then a small JSON citation block — and the scenario switches below reach every output
 * shape the parser distinguishes, including a byte-for-byte replay of a real failure.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderError } from '../errors.mjs';
import { CITATION_SENTINEL } from '../prompt.mjs';

/** Scenario switches, read from the question so the tests can reach every failure path. */
export const MOCK_TRIGGERS = {
  '[[mock:error]]': 'upstream',
  '[[mock:timeout]]': 'timeout',
  '[[mock:bad-citation]]': 'bad-citation',
  '[[mock:plain-text]]': 'plain-text',
  '[[mock:ungrounded]]': 'ungrounded',
  '[[mock:html]]': 'html',
  '[[mock:broken-json]]': 'broken-json',
  /** The live failure, replayed exactly as DeepSeek sent it; see fixtures/. */
  '[[mock:escaped-envelope]]': 'escaped-envelope',
  '[[mock:protocol-only]]': 'protocol-only',
  '[[mock:truncated]]': 'truncated',
  /** A display formula far wider than the panel, to check it scrolls instead of overflowing. */
  '[[mock:wide-formula]]': 'wide-formula',
};

function pickTrigger(question) {
  for (const [token, scenario] of Object.entries(MOCK_TRIGGERS)) {
    if (question.includes(token)) return scenario;
  }
  return null;
}

/**
 * The real reply that broke the old contract, kept as a file rather than retyped.
 *
 * It is 3971 characters of genuine model output whose JSON envelope never closed. Loading it
 * from disk is the point: a test that asserts the recovery works on a hand-written imitation
 * proves nothing about the response that actually failed.
 */
let escapedEnvelopeCache = null;
function escapedEnvelopeReply() {
  if (escapedEnvelopeCache === null) {
    // `import.meta.url` is a file URL when this runs as a Node process and an http one under
    // the jsdom test runner, so the path is resolved both ways rather than assuming one.
    let file;
    try {
      file = fileURLToPath(
        new URL('./fixtures/live-formula-escaped-envelope.json', import.meta.url),
      );
    } catch {
      file = resolve(process.cwd(), 'server/providers/fixtures/live-formula-escaped-envelope.json');
    }
    escapedEnvelopeCache = JSON.parse(readFileSync(file, 'utf8')).raw;
  }
  return escapedEnvelopeCache;
}

function citationBlock(value) {
  return `${CITATION_SENTINEL}\n${JSON.stringify(value)}`;
}

/**
 * The default answer: a fixed frame around the reader's own selection.
 *
 * It echoes the first part of the selected passage and cites it verbatim, so the citation check,
 * the page number on the chip, and the jump back to the page are all genuinely exercised. The
 * formula mode adds LaTeX, so the maths renderer is exercised by the same answer path rather
 * than by a special case.
 */
function describe(mode, passage, question) {
  const excerpt = passage.text.replace(/\s+/g, ' ').trim();
  const quoted = excerpt.length > 160 ? `${excerpt.slice(0, 160)}…` : excerpt;
  const lines = [
    '（本地模拟回答：当前没有连接在线模型，以下内容由 mock provider 生成，仅用于验证流程。）',
    '',
    `你选中的是第 ${String(passage.page)} 页的这段话：`,
    `“${quoted}”`,
    '',
  ];
  if (mode === 'translate') {
    lines.push('译文：这是一段用于验证翻译流程的占位译文，它与左侧英文原文逐段对应显示。');
  } else if (mode === 'formula') {
    lines.push(
      '这里用 $R(u) := \\log \\frac{P_1(u)}{P_0(u)}$ 表示两个分布的对数比，',
      '归一化常数写作 $$Z_\\beta = \\sum_u P_1(u)\\, e^{\\beta R(u)}$$，',
      '其中 $\\beta \\ge 0$ 控制引导强度。这一段文字本身是从 PDF 文字层提取的，不是模型的推断。',
    );
  } else {
    lines.push('这段文字在该页的可见范围内被完整提取，可以作为引用回到原文。');
  }
  if (question !== '') lines.push(`针对你的问题「${question}」，模拟回答不会给出真实结论。`);
  lines.push('', '依据：[1]');
  return {
    answer: lines.join('\n'),
    groundedInText: true,
    citations: [{ n: 1, passageId: passage.id, quote: excerpt }],
  };
}

/**
 * The offline answer to "what is difficult on this page".
 *
 * Deterministic and derived from the page it was given: the first few sentences long enough to
 * be a quotation become suggestions, each quoting the page verbatim so the service's check and
 * the browser's anchor matching are both genuinely exercised. One suggestion quotes text that
 * is *not* on the page on purpose — the boundary that drops it is the point of this feature, and
 * a mock that never trips it would leave that path untested.
 */
function difficultyReply(meta) {
  const text = String(meta.pageText ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = text
    .split(/(?<=[.!?。；])\s*/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 40 && sentence.length <= 200);

  const picks = sentences.slice(0, 3);
  const kinds = ['concept', 'formula', 'prerequisite'];
  const titles = ['这一页的核心概念', '关键的公式或符号', '阅读这一页需要的前置知识'];
  const suggestions = picks.map((quote, index) => ({
    kind: kinds[index] ?? 'concept',
    title: titles[index] ?? '这一页的难点',
    quote,
    why: '（本地模拟）这一条由 mock provider 生成，用于验证难点标记从分析到定位的整条链路。',
    quick: `（本地模拟）第 ${String(index + 1)} 处：这句话里有值得停下来理解的内容，先看清它在说什么，再想它为什么出现在这里。`,
    deeper: '（本地模拟）可以继续追问：它为什么在这里成立？依赖什么前提？',
  }));

  suggestions.push({
    kind: 'concept',
    title: '一条应该被丢弃的建议',
    quote: '这段原文并不在本次提供的页面文字里。',
    why: '（本地模拟）用来验证服务端会丢掉不在原文里的引文。',
    quick: '（本地模拟）这条不应该出现在界面上。',
    deeper: null,
  });

  return {
    text: JSON.stringify({ suggestions }),
    usage: null,
    truncated: false,
    finishReason: 'stop',
  };
}

export function createMockProvider({ model = 'mock-1' } = {}) {
  return {
    name: 'mock',
    model,
    /** Says plainly that answers here are not model output; the UI shows this verbatim. */
    label: '本地模拟（未连接在线模型）',

    async complete({ system, messages, meta, signal }) {
      if (meta.task === 'difficulty') {
        void system;
        void messages;
        void signal;
        return difficultyReply(meta);
      }
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
          text: '模拟回答：这次故意不返回引用块，用来验证没有引用可校验时的降级路径。',
          usage: null,
          truncated: false,
          finishReason: 'stop',
        };
      }
      if (scenario === 'escaped-envelope') {
        // Byte for byte what the live API returned; the parser has to recover it.
        return {
          text: escapedEnvelopeReply(),
          usage: null,
          truncated: false,
          finishReason: 'stop',
        };
      }
      if (scenario === 'broken-json') {
        return {
          text: `{"answer": "旧格式的回答，引用数组被截断了 [1]。", "groundedInText": true, "citations": [{"n":1,"passageId":"${passage.id}","quote":"${excerpt.slice(0, 40)}"`,
          usage: null,
          truncated: false,
          finishReason: 'stop',
        };
      }
      if (scenario === 'protocol-only') {
        // An object with no answer field at all: there is nothing to show and nothing to guess.
        return {
          text: '{"answer": 42, "groundedInText": true, "citations": []}',
          usage: null,
          truncated: false,
          finishReason: 'stop',
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
      if (scenario === 'wide-formula') {
        answer.answer =
          '下面这个公式比面板宽得多：\n\n$$\\sum_{i=1}^{N}\\frac{P_1(u_i)\\log P_1(u_i)}{P_0(u_i)}' +
          ' + \\int_{0}^{\\infty} e^{-\\beta R(u)}\\,\\mathrm{d}u' +
          ' + \\sum_{j=1}^{M}\\left(\\frac{a_j+b_j}{c_j-d_j}\\right)^{2}' +
          ' + \\prod_{k \\in K} \\left(1 - \\frac{1}{k^{2}}\\right) = Z_{\\beta}$$';
      }

      void system;
      void messages;

      const truncated = scenario === 'truncated';
      return {
        text: `${answer.answer}\n${citationBlock({
          groundedInText: answer.groundedInText,
          citations: answer.citations,
        })}`,
        usage: null,
        truncated,
        finishReason: truncated ? 'length' : 'stop',
      };
    },
  };
}
