import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DifficultySuggestion } from '../../domain/difficulty';
import { DifficultyPanel } from './DifficultyPanel';
import { SuggestionCard } from './SuggestionCard';
import type { DifficultyScan } from './useDifficultyScan';

function suggestion(overrides: Partial<DifficultySuggestion> = {}): DifficultySuggestion {
  return {
    id: 'd1',
    paperId: 'paper-1',
    pdfSha256: 'a'.repeat(64),
    page: 3,
    kind: 'concept',
    title: '多目标少样本提示',
    quote: 'multi-target few-shot prompting',
    why: '这是这一页的主线。',
    quick: '一次在多个位置填空，而不是一个一个来。',
    deeper: '它和普通 few-shot 有什么区别？',
    location: 'found',
    anchor: {
      quote: 'multi-target few-shot prompting',
      prefix: '',
      suffix: '',
      rects: [],
      start: 0,
      end: 10,
    },
    model: 'mock-1',
    analysedAt: 1,
    ...overrides,
  };
}

function scan(overrides: Partial<DifficultyScan> = {}): DifficultyScan {
  return {
    enabled: true,
    markersVisible: true,
    status: 'idle',
    error: null,
    analysedPages: 1,
    current: [suggestion()],
    all: [suggestion()],
    setEnabled: vi.fn(),
    setMarkersVisible: vi.fn(),
    analyse: vi.fn(),
    reanalyse: vi.fn(),
    ignore: vi.fn(),
    ...overrides,
  };
}

describe('DifficultyPanel', () => {
  it('says what will be sent, what it costs and how much is covered before it is turned on', () => {
    render(
      <DifficultyPanel
        scan={scan({ enabled: false, current: [], all: [] })}
        online={false}
        currentPage={3}
        onShow={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/会把当前这一页的正文交给模型/)).toBeInTheDocument();
    expect(screen.getByText(/不会扫描整篇论文/)).toBeInTheDocument();
    expect(screen.getByText(/不产生任何费用/)).toBeInTheDocument();
    expect(screen.getByText(/不会写入你的笔记/)).toBeInTheDocument();
  });

  it('warns about the cost before enabling an online provider', () => {
    render(
      <DifficultyPanel
        scan={scan({ enabled: false, current: [], all: [] })}
        online
        currentPage={3}
        onShow={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/会调用在线模型，每一次分析都可能产生费用/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /会调用在线模型/ })).not.toBeInTheDocument();
  });

  it('needs one confirming click, and the button says what it will do', async () => {
    const setEnabled = vi.fn();
    render(
      <DifficultyPanel
        scan={scan({ enabled: false, current: [], all: [], setEnabled })}
        online
        currentPage={3}
        onShow={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '启用智能难点标注' }));
    expect(setEnabled).not.toHaveBeenCalled();
    const confirm = screen.getByRole('button', { name: '开始分析（会调用在线模型）' });
    await userEvent.click(confirm);
    expect(setEnabled).toHaveBeenCalledWith(true);
  });

  it('lists this page’s suggestions with the quick explanation first', async () => {
    const onShow = vi.fn();
    render(
      <DifficultyPanel
        scan={scan()}
        online={false}
        currentPage={3}
        onShow={onShow}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('多目标少样本提示')).toBeInTheDocument();
    expect(screen.getByText('一次在多个位置填空，而不是一个一个来。')).toBeInTheDocument();
    expect(screen.getByText('核心概念')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /多目标少样本提示/ }));
    expect(onShow).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }));
  });

  it('marks a suggestion it could not locate instead of pretending it is on the page', () => {
    render(
      <DifficultyPanel
        scan={scan({ current: [suggestion({ location: 'ambiguous', anchor: null })], all: [] })}
        online={false}
        currentPage={3}
        onShow={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('位置有歧义，未标注')).toBeInTheDocument();
  });

  it('shows a failure without taking the page away, and offers a retry', async () => {
    const analyse = vi.fn();
    render(
      <DifficultyPanel
        scan={scan({ status: 'error', error: '连接不上本地的 AI 服务。', analyse })}
        online={false}
        currentPage={3}
        onShow={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/连接不上本地的 AI 服务/)).toBeInTheDocument();
    expect(screen.getByText(/阅读与批注不受影响/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重试这一页' }));
    expect(analyse).toHaveBeenCalledWith(3);
  });

  it('can hide the markers without turning the feature off', async () => {
    const setMarkersVisible = vi.fn();
    render(
      <DifficultyPanel
        scan={scan({ setMarkersVisible })}
        online={false}
        currentPage={3}
        onShow={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('checkbox', { name: /在页面上显示标记/ }));
    expect(setMarkersVisible).toHaveBeenCalledWith(false);
  });

  it('says the suggestions are not the paper and are not citation-checked', () => {
    render(
      <DifficultyPanel
        scan={scan()}
        online={false}
        currentPage={3}
        onShow={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/不是论文原文/)).toBeInTheDocument();
    expect(screen.getByText(/逐字出现在这一页/)).toBeInTheDocument();
  });
});

describe('SuggestionCard', () => {
  const props = {
    suggestion: suggestion(),
    spot: { x: 400, y: 400 },
    canSaveNote: true,
    onExplain: vi.fn(),
    onSaveNote: vi.fn(),
    onIgnore: vi.fn(),
    onDismiss: vi.fn(),
  };

  it('shows the short explanation, and says what it is', () => {
    render(<SuggestionCard {...props} />);
    expect(screen.getByRole('dialog', { name: /难点：多目标少样本提示/ })).toBeInTheDocument();
    expect(screen.getByText('一次在多个位置填空，而不是一个一个来。')).toBeInTheDocument();
    expect(screen.getByText(/AI 建议，不是原文/)).toBeInTheDocument();
  });

  it('offers to go deeper, save it, or ignore it', async () => {
    const onExplain = vi.fn();
    const onSaveNote = vi.fn();
    const onIgnore = vi.fn();
    render(
      <SuggestionCard
        {...props}
        onExplain={onExplain}
        onSaveNote={onSaveNote}
        onIgnore={onIgnore}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /深入理解/ }));
    await userEvent.click(screen.getByRole('button', { name: /存为笔记/ }));
    await userEvent.click(screen.getByRole('button', { name: '忽略' }));
    expect(onExplain).toHaveBeenCalledTimes(1);
    expect(onSaveNote).toHaveBeenCalledTimes(1);
    expect(onIgnore).toHaveBeenCalledTimes(1);
  });

  it('cannot save a note for a suggestion with nowhere to anchor it', () => {
    render(
      <SuggestionCard
        {...props}
        suggestion={suggestion({ anchor: null, location: 'missing' })}
        canSaveNote={false}
      />,
    );
    expect(screen.getByRole('button', { name: /存为笔记/ })).toBeDisabled();
    expect(screen.getByText(/原文中找不到/)).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const onDismiss = vi.fn();
    render(<SuggestionCard {...props} onDismiss={onDismiss} />);
    await userEvent.keyboard('{Escape}');
    expect(onDismiss).toHaveBeenCalled();
  });
});
