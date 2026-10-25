import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PaperSummary } from '../../domain/papers';
import { OutlinePanel } from './OutlinePanel';

const summary: PaperSummary = {
  text: '问题：怎样并行化序列建模。\n方法：自注意力。\n结论：可行且更快。',
  provider: 'mock',
  providerLabel: '本地模拟',
  model: 'mock-1',
  online: false,
  createdAt: Date.parse('2026-10-25T08:00:00Z'),
};

function renderPanel(props: Record<string, unknown> = {}) {
  const onGenerate = vi.fn();
  const onClear = vi.fn();
  render(
    <OutlinePanel
      outline={{ status: 'idle', items: [] }}
      currentPage={1}
      summary={undefined}
      onJump={vi.fn()}
      onClose={vi.fn()}
      onGenerateSummary={onGenerate}
      onClearSummary={onClear}
      {...props}
    />,
  );
  return { onGenerate, onClear };
}

describe('OutlinePanel summary card', () => {
  it('needs two clicks: the disclosure names the scope and the cost first', () => {
    const { onGenerate } = renderPanel({
      summaryScope: { pagesSent: 12, pagesTotal: 12, truncated: false },
      summaryOnline: true,
    });
    fireEvent.click(screen.getByRole('button', { name: '生成摘要卡' }));
    expect(onGenerate).not.toHaveBeenCalled();
    expect(screen.getByText(/整篇论文 12\/12 页/)).toBeTruthy();
    expect(screen.getByText(/将调用在线模型，可能产生费用/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '开始生成' }));
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  it('shows a stored card with its provenance, and regenerates on the same confirm path', () => {
    const { onGenerate, onClear } = renderPanel({ summary });
    expect(screen.getByText(/问题：怎样并行化序列建模/)).toBeTruthy();
    expect(screen.getByText(/本地模拟 · mock-1 · 本地模拟/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重新生成' }));
    fireEvent.click(screen.getByRole('button', { name: '开始生成' }));
    expect(onGenerate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '移除' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when no generation is offered and no card exists', () => {
    render(
      <OutlinePanel
        outline={{ status: 'idle', items: [] }}
        currentPage={1}
        onJump={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole('region', { name: '摘要卡' })).toBeNull();
  });

  it('says what a failure said, in place', () => {
    renderPanel({ summaryNotice: '生成失败：服务未启动' });
    fireEvent.click(screen.getByRole('button', { name: '生成摘要卡' }));
    expect(screen.getByText('生成失败：服务未启动')).toBeTruthy();
  });
});

describe('OutlinePanel summary staleness', () => {
  it('warns when the card came from a different PDF file, and stays quiet when it matches', () => {
    const { rerender } = render(
      <OutlinePanel
        outline={{ status: 'idle', items: [] }}
        currentPage={1}
        summary={{ ...summary, pdfSha256: 'b'.repeat(64) }}
        summaryStale
        onJump={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/生成自另一个 PDF 版本/)).toBeTruthy();
    rerender(
      <OutlinePanel
        outline={{ status: 'idle', items: [] }}
        currentPage={1}
        summary={{ ...summary, pdfSha256: 'b'.repeat(64) }}
        summaryStale={false}
        onJump={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText(/生成自另一个 PDF 版本/)).toBeNull();
  });

  it('a pre-v10 card without an origin hash claims nothing either way', () => {
    render(
      <OutlinePanel
        outline={{ status: 'idle', items: [] }}
        currentPage={1}
        summary={summary}
        summaryStale={false}
        onJump={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText(/另一个 PDF 版本/)).toBeNull();
  });
});
