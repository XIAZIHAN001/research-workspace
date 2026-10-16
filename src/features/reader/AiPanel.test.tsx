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
    answer: '作者在这里说的是 [1]。',
    groundedInText: true,
    citations: [CITATION],
    warnings: [],
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
    pageText: 'the rotated attention mechanism which lets us drop position embeddings',
    layoutNotice: null,
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

  it('explains how to start when there is no question yet', () => {
    setup({ session: null });
    expect(screen.getByText(/选中论文里的一段原文/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '继续提问' })).toBeDisabled();
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
});
