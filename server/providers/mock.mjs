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
  /** Knowledge-analysis boundary cases. The trigger is read from the reader's focus text. */
  '[[mock:knowledge-broken]]': 'knowledge-broken',
  '[[mock:knowledge-truncated]]': 'knowledge-truncated',
  '[[mock:knowledge-empty]]': 'knowledge-empty',
  '[[mock:knowledge-bad-quote]]': 'knowledge-bad-quote',
  '[[mock:knowledge-wrong-page]]': 'knowledge-wrong-page',
  '[[mock:knowledge-wrong-direction]]': 'knowledge-wrong-direction',
  '[[mock:knowledge-duplicate]]': 'knowledge-duplicate',
  '[[mock:knowledge-cycle]]': 'knowledge-cycle',
  '[[mock:knowledge-bypass]]': 'knowledge-bypass',
  '[[mock:knowledge-formula]]': 'knowledge-formula',
  '[[mock:knowledge-invalid-kind]]': 'knowledge-invalid-kind',
  /** Phase 8.2: relation semantics, coined names, short context, existing-concept reuse. */
  '[[mock:knowledge-new-kinds]]': 'knowledge-new-kinds',
  '[[mock:knowledge-coined-name]]': 'knowledge-coined-name',
  '[[mock:knowledge-many]]': 'knowledge-many',
  '[[mock:knowledge-existing]]': 'knowledge-existing',
  '[[mock:knowledge-existing-alias]]': 'knowledge-existing-alias',
  '[[mock:knowledge-ambiguous]]': 'knowledge-ambiguous',
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
  if (mode === 'summarize') {
    lines.push(
      '问题：这份摘要卡由本地模拟生成，用于验证摘要流程。',
      '方法：离线 mock 会按请求附带的页数返回固定结构，不产生任何费用。',
      '结论：接入在线模型后，这里会是依据全文三段式摘要。',
    );
  } else if (mode === 'draft') {
    lines.push(
      '## 论点一（模拟）',
      '这是由你的笔记整理出的占位草稿段落，引用对应关系由 [1] 标注。',
      '在线模型接入后，这里会按论点组织你的全部笔记并逐条溯源。',
    );
  } else if (mode === 'translate') {
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

/**
 * The offline answer to "what knowledge does this passage connect to".
 *
 * Like the difficulty mock, everything it proposes is derived from the passages it was given,
 * quotes are copied verbatim so the service's check is genuinely exercised, and every label says
 * it is simulated. The scenario triggers reach the boundary cases the interface has to handle;
 * the default reply is deliberately clean — two concepts, two relations — because a mock that
 * fails on every call would make the ordinary path impossible to see.
 */
function knowledgeReply(meta, scenario) {
  const passages = Array.isArray(meta.passages) ? meta.passages : [];
  const selection = passages.find((passage) => passage.selection) ??
    passages[0] ?? { text: '', page: 1, id: 'selection' };
  const text = String(selection.text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = text
    .split(/(?<=[.!?。；])\s*/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 30);
  // The reader's own selection is the most meaningful quotation available: it is verbatim in the
  // passage and it is the text the reader was actually looking at. Fall back to the first clean
  // sentence when the panel was opened on a page without a selection.
  const focus = String(meta.focus ?? '')
    .replace(/\[\[mock:[a-z-]+\]\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const firstQuote = focus.length >= 8 ? focus : (sentences[0] ?? text);
  const quoteOne = firstQuote.slice(0, 200);
  const secondSentence = sentences.find(
    (sentence) => sentence !== quoteOne && /^[A-Z0-9(]/.test(sentence),
  );
  const quoteTwo = (secondSentence ?? quoteOne).slice(0, 200);
  // One alias is literally in the passage, so the default mock still exercises the "verbatim
  // name keeps direct support" path. The concept's display name is deliberately the mock label.
  const words = text.split(/\s+/).filter((word) => word !== '');
  const anchor = words.length >= 4 ? words.slice(0, 4).join(' ') : text.slice(0, 16);

  const conceptA = {
    name: '模拟概念 A',
    aliases: anchor.length >= 4 ? [anchor, 'Mock idea A'] : ['Mock idea A'],
    summary: '（本地模拟）这是一个用于验证知识建议数据流的占位概念，不是对论文内容的学术判断。',
    support: 'direct',
    evidence: [{ passageId: selection.id, quote: quoteOne }],
  };
  const conceptB = {
    name: '模拟概念 B',
    aliases: [],
    summary: '（本地模拟）第二个占位概念；它没有逐字引文，因此会显示为待验证。',
    support: 'inferred',
    evidence: [],
  };
  const relationAB = {
    from: conceptA.name,
    to: conceptB.name,
    kind: 'prerequisite',
    direction: 'from-first',
    support: 'direct',
    explanation:
      '（本地模拟）A 需要先理解 B。这条解释由 mock provider 生成，用来验证建议的展示与确认流程。',
    evidence: [{ passageId: selection.id, quote: quoteOne }],
  };
  const relationRelated = {
    from: conceptB.name,
    to: conceptA.name,
    kind: 'related',
    direction: 'undirected',
    support: 'external',
    explanation: '（本地模拟）B 与 A 相关；这是外部知识的示例，不是原文的陈述。',
    evidence: [{ passageId: selection.id, quote: quoteTwo }],
  };

  const payload = {
    groundedInText: true,
    concepts: [conceptA, conceptB],
    relations: [relationAB, relationRelated],
  };

  if (scenario === 'knowledge-empty') {
    payload.groundedInText = false;
    payload.concepts = [];
    payload.relations = [];
  }
  if (scenario === 'knowledge-bad-quote') {
    conceptA.evidence = [
      { passageId: selection.id, quote: '这段话并不存在于本次提供的任何段落里。' },
    ];
    relationAB.evidence = [{ passageId: selection.id, quote: '这段关系引文也不存在于原文里。' }];
  }
  if (scenario === 'knowledge-wrong-page') {
    conceptA.evidence = [
      { passageId: selection.id, page: Number(selection.page) + 7, quote: quoteOne },
    ];
    relationAB.evidence = [{ passageId: selection.id, page: 99, quote: quoteOne }];
  }
  if (scenario === 'knowledge-wrong-direction') {
    relationAB.direction = 'to-first';
  }
  if (scenario === 'knowledge-duplicate') {
    payload.concepts = [conceptA, { ...conceptA, summary: '（本地模拟）重复的概念。' }, conceptB];
    payload.relations = [relationAB, { ...relationAB, explanation: '（本地模拟）重复的关系。' }];
  }
  if (scenario === 'knowledge-cycle') {
    payload.relations = [
      relationAB,
      {
        ...relationAB,
        from: conceptB.name,
        to: conceptA.name,
        kind: 'prerequisite',
        direction: 'from-first',
      },
    ];
  }
  if (scenario === 'knowledge-bypass') {
    conceptA.status = 'confirmed';
    conceptA.id = 'model-chosen-id';
    payload.concepts = [conceptA, conceptB];
    payload.relations = [{ ...relationAB, id: 'model-relation-id', status: 'confirmed' }];
    payload.doi = '10.0000/not-a-real-doi';
    payload.arxivId = 'arXiv:0000.00000';
    payload.paperId = 'model-chosen-paper';
  }
  if (scenario === 'knowledge-invalid-kind') {
    relationAB.kind = 'depends-on';
  }
  if (scenario === 'knowledge-formula') {
    conceptA.summary =
      '（本地模拟）原文的公式在文字层里是碎片；下面补写的 LaTeX 是模型解释，不是 PDF 原文。';
    relationAB.explanation =
      '（本地模拟）模型补写的公式 $$R(u) := \\log \\frac{P_1(u)}{P_0(u)}$$ 只是对碎片的重建，属于模型解释。';
  }
  if (scenario === 'knowledge-new-kinds') {
    const conceptC = {
      name: '模拟概念 C',
      aliases: [],
      summary: '（本地模拟）第三个占位概念，用于展示非前置的学术关系。',
      support: 'inferred',
      evidence: [],
    };
    payload.concepts = [conceptA, conceptB, conceptC];
    payload.relations = [
      {
        from: conceptA.name,
        to: conceptB.name,
        kind: 'definition',
        direction: 'from-first',
        support: 'inferred',
        explanation: '（本地模拟）A 的定义依赖 B；这是定义依赖，不是学习前置。',
        evidence: [],
      },
      {
        from: conceptB.name,
        to: conceptA.name,
        kind: 'approximates',
        direction: 'from-first',
        support: 'inferred',
        explanation: '（本地模拟）B 是 A 的近似实现；这是近似，不是扩展。',
        evidence: [],
      },
      {
        from: conceptA.name,
        to: conceptC.name,
        kind: 'replaces',
        direction: 'from-first',
        support: 'inferred',
        explanation: '（本地模拟）A 替代/对照 C；这不是扩展。',
        evidence: [],
      },
      {
        from: conceptC.name,
        to: conceptB.name,
        kind: 'extends',
        direction: 'from-first',
        support: 'inferred',
        explanation: '（本地模拟）C 扩展了 B 的能力。',
        evidence: [],
      },
    ];
  }
  if (scenario === 'knowledge-coined-name') {
    // No alias occurs in the passage: the reader should see direct support lowered to inferred,
    // with a warning that the name is the model's own wording.
    conceptA.aliases = ['Mock idea A'];
    payload.concepts = [conceptA, conceptB];
    payload.relations = [relationAB, relationRelated];
  }
  if (scenario === 'knowledge-many') {
    const names = Array.from({ length: 6 }, (_, index) => `模拟概念 ${String(index + 1)}`);
    payload.concepts = names.map((name) => ({
      name,
      aliases: [],
      summary: '（本地模拟）用于验证短上下文建议数量上限。',
      support: 'inferred',
      evidence: [],
    }));
    const pairs = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [0, 2],
      [0, 3],
    ];
    payload.relations = pairs.map(([from, to]) => ({
      from: names[from],
      to: names[to],
      kind: 'related',
      direction: 'undirected',
      support: 'inferred',
      explanation: '（本地模拟）两个占位概念相关。',
      evidence: [],
    }));
  }
  if (scenario === 'knowledge-existing') {
    const existing = Array.isArray(meta.existingConcepts) ? meta.existingConcepts[0] : undefined;
    if (existing !== undefined && typeof existing.name === 'string') {
      payload.concepts = [
        {
          name: existing.name,
          aliases: [],
          summary: '',
          support: 'direct',
          evidence: [{ passageId: selection.id, quote: quoteOne }],
        },
        conceptA,
      ];
      payload.relations = [
        {
          from: existing.name,
          to: conceptA.name,
          kind: 'related',
          direction: 'undirected',
          support: 'inferred',
          explanation: '（本地模拟）读者已有的概念与本次概念相关。',
          evidence: [],
        },
      ];
    }
  }
  if (scenario === 'knowledge-existing-alias') {
    const existing = Array.isArray(meta.existingConcepts) ? meta.existingConcepts[0] : undefined;
    const alias = Array.isArray(existing?.aliases) ? existing.aliases[0] : undefined;
    if (typeof alias === 'string' && alias !== '') {
      // Deliberately a different case from the stored alias, so normalisation is exercised.
      const spelled = alias.toLowerCase();
      payload.concepts = [
        {
          name: spelled,
          aliases: [],
          summary: '',
          support: 'direct',
          evidence: [{ passageId: selection.id, quote: quoteOne }],
        },
        conceptB,
      ];
      payload.relations = [
        {
          from: spelled,
          to: conceptB.name,
          kind: 'related',
          direction: 'undirected',
          support: 'inferred',
          explanation: '（本地模拟）通过别名复用了已有概念。',
          evidence: [],
        },
      ];
    }
  }
  if (scenario === 'knowledge-ambiguous') {
    payload.concepts = [
      {
        name: 'KZG',
        aliases: [],
        summary: '（本地模拟）一个同时匹配多个已有概念的名称。',
        support: 'inferred',
        evidence: [],
      },
      conceptB,
    ];
    payload.relations = [
      {
        from: 'KZG',
        to: conceptB.name,
        kind: 'related',
        direction: 'undirected',
        support: 'inferred',
        explanation: '（本地模拟）这条关系的一端名称有歧义，应当被跳过。',
        evidence: [],
      },
    ];
  }

  const body = JSON.stringify(payload);
  if (scenario === 'knowledge-broken') {
    return {
      text: '{"concepts":[{"name":"broken"',
      usage: null,
      truncated: false,
      finishReason: 'stop',
    };
  }
  if (scenario === 'knowledge-truncated') {
    return {
      text: body.slice(0, Math.max(0, body.length - 24)),
      usage: null,
      truncated: true,
      finishReason: 'length',
    };
  }
  return { text: body, usage: null, truncated: false, finishReason: 'stop' };
}

export function createMockProvider({ model = 'mock-1' } = {}) {
  return {
    name: 'mock',
    model,
    /** Says plainly that answers here are not model output; the UI shows this verbatim. */
    label: '本地模拟（未连接在线模型）',

    async complete({ system, messages, meta, signal }) {
      if (meta.task === 'knowledge') {
        void system;
        void messages;
        void signal;
        return knowledgeReply(meta, pickTrigger(`${String(meta.focus ?? '')}`));
      }
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
