import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { buildAskContext } from '../../services/ai/context';
import type { AiAnswer, AiCitation, AiHealth } from '../../services/ai/types';
import { AiPanel } from './AiPanel';
import type { AiSession, AiTurn } from './useAiReading';

const CITATION: AiCitation = {
  n: 1,
  passageId: 'selection',
  page: 7,
  quote: 'the rotated attention mechanism',
  selection: true,
};

function answer(overrides: Partial<AiAnswer> = {}): AiAnswer {
  return {
    provider: 'mock',
    providerLabel: '本地模拟（未连接在线模型）',
    model: 'mock-1',
    online: false,
    mode: 'explain',
    status: 'valid',
    answer: '作者在这里说的是 [1]。',
    groundedInText: true,
    citations: [CITATION],
    warnings: [],
    diagnostics: {
      rawChars: 120,
      recovery: null,
      citationEntries: 1,
      citationsAccepted: 1,
      citationsRejected: 0,
      finishReason: 'stop',
      truncated: false,
    },
    usage: null,
    ...overrides,
  };
}

function session(overrides: Partial<AiTurn> = {}, mode: AiTurn['mode'] = 'explain'): AiSession {
  const source = {
    paperId: 'paper-1',
    title: 'A Paper',
    pdfSha256: 'a'.repeat(64),
    anchor: {
      page: 7,
      quote: 'the rotated attention mechanism',
      prefix: 'we replace ',
      suffix: ' which lets',
      rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }],
      start: 0,
      end: 30,
    },
    page: 7,
    pageText: 'the rotated attention mechanism which lets us drop position embeddings',
    layoutNotice: null,
    fragmentation: null,
  };
  const request = buildAskContext({
    paperId: source.paperId,
    title: source.title,
    pdfSha256: source.pdfSha256,
    page: source.anchor.page,
    pageText: source.pageText,
    start: source.anchor.start,
    end: source.anchor.end,
    mode,
    question: '',
  });
  return {
    source,
    turns: [{ mode, question: '', request, answer: answer({ mode }), failure: null, ...overrides }],
  };
}

const HEALTH: AiHealth = {
  ok: true,
  provider: 'mock',
  label: '本地模拟（未连接在线模型）',
  model: 'mock-1',
  reasoning: null,
  online: false,
  limits: {
    passages: 8,
    passageChars: 2000,
    totalContextChars: 6000,
    questionChars: 1000,
    requestsPerMinute: 30,
    answerTokens: 8192,
  },
};

function setup(overrides: Partial<Parameters<typeof AiPanel>[0]> = {}) {
  const handlers = {
    onAskAboutPage: vi.fn(),
    onFollowUp: vi.fn(),
    onRetry: vi.fn(),
    onCancel: vi.fn(),
    onClear: vi.fn(),
    onSaveNote: vi.fn(),
    onJumpToCitation: vi.fn(),
    onClose: vi.fn(),
  };
  const props = {
    session: session(),
    busy: false,
    health: HEALTH,
    currentPage: 7,
    canSaveNote: true,
    ...handlers,
    ...overrides,
  };
  const view = render(<AiPanel {...props} />);
  return { ...handlers, view };
}

describe('AiPanel', () => {
  it('is named, so it can be found and read as a landmark', () => {
    setup();
    expect(screen.getByRole('complementary', { name: 'AI 精读助手' })).toBeInTheDocument();
  });

  it('invites a question about the page before anything has been asked', () => {
    const { onAskAboutPage } = setup({ session: null });
    expect(screen.getByText(/可以直接问这一页的任何问题/)).toBeInTheDocument();
    // The assistant is not locked behind a selection: the box works straight away.
    const box = screen.getByRole('textbox', { name: '继续提问' });
    expect(box).toBeEnabled();
    expect(box).toHaveAttribute('placeholder', '就这一页提个问题…');
    expect(onAskAboutPage).not.toHaveBeenCalled();
  });

  it('starts a page conversation from the opener chips', async () => {
    const { onAskAboutPage } = setup({ session: null });
    await userEvent.click(screen.getByRole('button', { name: '这一页讲了什么' }));
    expect(onAskAboutPage).toHaveBeenCalledTimes(1);
    expect(onAskAboutPage.mock.calls[0]?.[0]).toContain('这一页');
  });

  it('says which provider answered, and whether it costs money', () => {
    setup();
    // Once above (which provider is answering) and once under the answer (where it came from).
    expect(screen.getAllByText(/本地模拟/).length).toBeGreaterThan(0);
    expect(screen.getByText(/不会发起任何在线调用/)).toBeInTheDocument();
  });

  it('warns before anything is read that an online provider is in use', () => {
    setup({
      health: { ...HEALTH, provider: 'deepseek', label: 'DeepSeek deepseek-flash', online: true },
    });
    expect(screen.getByText(/会调用在线模型，可能产生费用/)).toBeInTheDocument();
  });

  it('says the local service is not running rather than pretending to be offline-safe', () => {
    setup({ health: null });
    expect(screen.getByText(/没有连上本地 AI 服务/)).toBeInTheDocument();
  });

  it('shows the answer and turns a verified citation into something clickable', async () => {
    const { onJumpToCitation } = setup();
    // Two ways to the same place: the marker in the prose, and the entry in the list below it.
    const chips = screen.getAllByRole('button', { name: /\[1\] 第 7 页/ });
    expect(chips.length).toBeGreaterThan(0);
    await userEvent.click(chips[0]!);
    expect(onJumpToCitation).toHaveBeenCalledWith(CITATION);
    expect(screen.getByText(/作者在这里说的是/)).toBeInTheDocument();
  });

  it('lists the citations with the page number the service verified', () => {
    setup();
    const list = screen.getByRole('list');
    expect(within(list).getByText(/the rotated attention mechanism/)).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: /第 7 页/ })).toBeInTheDocument();
  });

  it('surfaces every warning the service produced', () => {
    setup({
      session: session({
        answer: answer({ warnings: ['有 1 条引用未通过校验（引文与提供的原文不符），已丢弃。'] }),
      }),
    });
    expect(screen.getByText(/未通过校验/)).toBeInTheDocument();
  });

  it('says so when the model itself judged the evidence insufficient', () => {
    setup({ session: session({ answer: answer({ groundedInText: false, citations: [] }) }) });
    expect(screen.getByText(/原文不足以完整回答/)).toBeInTheDocument();
    // It must read as the model's own claim, never as something this app checked.
    expect(screen.getByText(/这是它的自述，不是被核对过的事实/)).toBeInTheDocument();
  });

  it('offers to save an answer as a note, and confirms it did', async () => {
    const { onSaveNote } = setup();
    await userEvent.click(screen.getByRole('button', { name: /保存为笔记/ }));
    expect(onSaveNote).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /已保存为笔记/ })).toBeInTheDocument();
  });

  it('shows the failure and offers a retry, without hiding the rest of the conversation', async () => {
    const { onRetry } = setup({
      session: session({
        answer: null,
        failure: { kind: 'timeout', message: '模型在限定时间内没有返回。' },
      }),
    });
    expect(screen.getByRole('alert')).toHaveTextContent('模型在限定时间内没有返回。');
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('lets the reader cancel a request that is still running', async () => {
    const { onCancel } = setup({ busy: true });
    const status = screen.getByRole('status');
    await userEvent.click(within(status).getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('sends a follow-up question and clears the box', async () => {
    const { onFollowUp } = setup({ session: session({}, 'explain') });
    const input = screen.getByRole('textbox', { name: '继续提问' });
    await userEvent.type(input, '那这里为什么可以省略？');
    await userEvent.click(screen.getByRole('button', { name: '提问' }));
    expect(onFollowUp).toHaveBeenCalledWith('那这里为什么可以省略？');
    expect(input).toHaveValue('');
  });

  it('will not send an empty follow-up', async () => {
    const { onFollowUp } = setup();
    await userEvent.type(screen.getByRole('textbox', { name: '继续提问' }), '   ');
    expect(screen.getByRole('button', { name: '提问' })).toBeDisabled();
    expect(onFollowUp).not.toHaveBeenCalled();
  });

  describe('translation', () => {
    it('puts the original next to the translation', () => {
      const { view } = setup({ session: session({}, 'translate') });
      const original = view.container.querySelector('.ai-original');
      expect(original?.textContent).toContain('the rotated attention mechanism');
      expect(screen.getByText('英文原文')).toBeInTheDocument();
      expect(screen.getByText('中文译文')).toBeInTheDocument();
    });

    it('can be collapsed so the panel stops covering the page', async () => {
      const { view } = setup({ session: session({}, 'translate') });
      await userEvent.click(screen.getByRole('button', { name: '隐藏译文' }));
      expect(screen.queryByText(/作者在这里说的是/)).not.toBeInTheDocument();
      // The original stays: it is the thing the reader is reading.
      expect(view.container.querySelector('.ai-original')?.textContent).toContain(
        'the rotated attention mechanism',
      );
      await userEvent.click(screen.getByRole('button', { name: '显示译文' }));
      expect(screen.getByText(/作者在这里说的是/)).toBeInTheDocument();
    });
  });

  describe('the range that will be sent', () => {
    it('is disclosed only when the reader asks to see it', async () => {
      setup();
      expect(screen.queryByText('选中的原文')).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /查看会发送的范围/ }));
      expect(screen.getByText('选中的原文')).toBeInTheDocument();
      // The fixture selects from the very start of the page, so only a following side exists.
      expect(screen.getByText('同页下文')).toBeInTheDocument();
      expect(screen.getByText(/合计/)).toBeInTheDocument();
    });

    it('shows the layout warning when the page order could not be trusted', async () => {
      const withNotice = session();
      withNotice.turns[0]!.request.layoutNotice = '这一页的文字提取顺序与版面顺序不一致。';
      setup({ session: withNotice });
      await userEvent.click(screen.getByRole('button', { name: /查看会发送的范围/ }));
      expect(screen.getByText(/提取顺序与版面顺序不一致/)).toBeInTheDocument();
    });
  });

  it('never renders model output as markup', () => {
    const injected = '<img src=x onerror="window.__aiInjected = true">';
    setup({ session: session({ answer: answer({ answer: injected, citations: [] }) }) });
    expect(screen.getByText(injected)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  /**
   * What the reader is shown when the reply did not come back in one piece.
   *
   * The governing rule is that the interface shows either the answer or a sentence about why
   * there is none — never the protocol that carried it.
   */
  describe('when the reply could not be read', () => {
    const malformed = () =>
      answer({
        status: 'malformed',
        answer: '',
        citations: [],
        groundedInText: null,
        diagnostics: {
          rawChars: 41,
          recovery: 'protocol-text',
          citationEntries: 0,
          citationsAccepted: 0,
          citationsRejected: 0,
          finishReason: 'stop',
          truncated: false,
        },
      });

    it('says so instead of printing the protocol', () => {
      setup({ session: session({ answer: malformed() }) });
      expect(screen.getByRole('alert')).toHaveTextContent(/没法还原成回答/);
      expect(screen.queryByText(/"answer"/)).not.toBeInTheDocument();
      expect(document.querySelector('.ai-answer-body')).toBeNull();
    });

    it('offers a manual retry, and does not offer to save an empty note', async () => {
      const { onRetry } = setup({ session: session({ answer: malformed() }) });
      await userEvent.click(screen.getByRole('button', { name: '重试' }));
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: /保存为笔记/ })).not.toBeInTheDocument();
    });

    it('says a cut-off answer is cut off', () => {
      setup({
        session: session({
          answer: answer({ status: 'incomplete', answer: '写到这里', citations: [] }),
        }),
      });
      expect(screen.getByText(/没有写完/)).toBeInTheDocument();
      expect(screen.getByText('写到这里')).toBeInTheDocument();
    });

    it('says there is no citation to check when the reply carried no block', () => {
      setup({
        session: session({
          answer: answer({
            status: 'recovered',
            answer: '一段没有引用的回答。',
            citations: [],
            diagnostics: { rawChars: 30, recovery: 'prose' } as never,
          }),
        }),
      });
      expect(screen.getByText(/没有给出引用块/)).toBeInTheDocument();
    });

    it('keeps the diagnostics behind a disclosure that starts closed', () => {
      const { view } = setup({ session: session({ answer: malformed() }) });
      const details = view.container.querySelector('details.ai-diagnostics');
      expect(details).not.toBeNull();
      expect(details?.hasAttribute('open')).toBe(false);
      expect(details?.querySelector('summary')).toHaveTextContent('技术细节');
    });
  });

  describe('mathematics in an answer', () => {
    it('typesets a formula and leaves its source available', () => {
      const { view } = setup({
        session: session({
          answer: answer({
            answer: '对数比 $R(u) := \\log \\frac{P_1(u)}{P_0(u)}$ 是核心。',
            citations: [],
          }),
        }),
      });
      const maths = view.container.querySelectorAll('.ai-math');
      expect(maths.length).toBe(1);
      expect(maths[0]?.getAttribute('data-latex')).toBe('R(u) := \\log \\frac{P_1(u)}{P_0(u)}');
      // KaTeX produced real markup, so the formula is typeset rather than shown as source. The
      // `<annotation>` element inside it deliberately still carries the LaTeX: that is what makes
      // the formula copyable and readable to a screen reader.
      expect(maths[0]?.querySelector('.katex-html')).not.toBeNull();
      expect(maths[0]?.querySelector('annotation')?.textContent).toBe(
        'R(u) := \\log \\frac{P_1(u)}{P_0(u)}',
      );
    });

    it('says the formula is the model’s typesetting, not text from the paper', () => {
      setup({
        session: session({
          answer: answer({ answer: '见 $x^2$。', citations: [] }),
        }),
      });
      expect(screen.getByText(/不是从 PDF 里提取出来的原文/)).toBeInTheDocument();
    });

    it('falls back to the visible LaTeX when KaTeX cannot read it', () => {
      const { view } = setup({
        session: session({
          answer: answer({ answer: '坏公式 $\\frac{$ 在这里。', citations: [] }),
        }),
      });
      expect(view.container.querySelector('.ai-math-fallback')).not.toBeNull();
    });

    it('never lets KaTeX reach outside the formula', () => {
      const { view } = setup({
        session: session({
          answer: answer({ answer: '$\\href{javascript:alert(1)}{x}$', citations: [] }),
        }),
      });
      expect(view.container.querySelector('a')).toBeNull();
    });
  });
});
