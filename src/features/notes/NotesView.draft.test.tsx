import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../../domain/annotation';
import type { Paper } from '../../domain/papers';
import { NotesView } from './NotesView';

function note(id: string, paperId: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id,
    paperId,
    pdfSha256: 'a'.repeat(64),
    page: 1,
    quote: `Quote ${id}`,
    prefix: '',
    suffix: '',
    rects: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.02 }],
    kind: 'note',
    note: '',
    origin: 'user',
    sourceLabel: '',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const papers = { p1: { id: 'p1', title: 'Attention', authors: [], createdAt: 0, updatedAt: 0 } };

const two = [
  note('a1', 'p1', { kind: 'insight', quote: 'softmax 近似' }),
  note('b1', 'p1', { kind: 'question', quote: '为什么除以 √d', page: 2 }),
];

describe('NotesView AI draft flow', () => {
  it('confirms before calling, sends the notes as passages, and shows the result', async () => {
    const ask = vi.fn((request: { mode: string }) =>
      Promise.resolve({
        ok: true as const,
        echo: request,
        answer: {
          provider: 'mock',
          providerLabel: '本地模拟',
          model: 'mock-1',
          online: false,
          mode: 'draft' as const,
          status: 'valid' as const,
          answer: '## 论点一（模拟草稿）',
          groundedInText: true,
          citations: [],
          warnings: [],
          diagnostics: null,
          usage: null,
        },
      }),
    );
    render(
      <NotesView
        annotations={two}
        papers={papers as Record<string, Paper>}
        onOpenPaper={vi.fn()}
        ai={{ ask }}
      />,
    );

    // Two clicks, not one: the disclosure sits between them.
    fireEvent.click(screen.getByRole('button', { name: 'AI 整理成稿' }));
    expect(ask).not.toHaveBeenCalled();
    expect(screen.getByText(/将发送这 2 条笔记/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '开始整理' }));
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '笔记草稿' })).toBeTruthy();
    });
    expect(ask).toHaveBeenCalledTimes(1);
    const request = ask.mock.calls[0]?.[0] as Record<string, never> & {
      mode: string;
      passages: Array<{ id: string; text: string; selection: boolean }>;
      paper: { pdfSha256: string };
    };
    expect(request.mode).toBe('draft');
    expect(request.passages).toHaveLength(2);
    expect(request.passages[0]).toMatchObject({ id: 'n1', text: 'softmax 近似', selection: true });
    expect(request.passages[1]).toMatchObject({
      id: 'n2',
      text: '为什么除以 √d',
      selection: false,
    });
    expect(request.paper.pdfSha256).toBe('a'.repeat(64));
    expect(screen.getByText('## 论点一（模拟草稿）')).toBeTruthy();
  });

  it('reports a failure without pretending a draft exists', async () => {
    const ask = vi.fn((request: unknown) =>
      Promise.resolve({
        ok: false as const,
        echo: request,
        failure: { kind: 'offline' as const, message: '服务未启动' },
      }),
    );
    render(
      <NotesView
        annotations={two}
        papers={papers as Record<string, Paper>}
        onOpenPaper={vi.fn()}
        ai={{ ask }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'AI 整理成稿' }));
    fireEvent.click(screen.getByRole('button', { name: '开始整理' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('整理失败');
    });
    expect(screen.queryByRole('dialog', { name: '笔记草稿' })).toBeNull();
  });

  it('offers nothing without a client, or with a single note', () => {
    const { rerender } = render(
      <NotesView
        annotations={two}
        papers={papers as Record<string, Paper>}
        onOpenPaper={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'AI 整理成稿' })).toBeNull();
    rerender(
      <NotesView
        annotations={[two[0]!]}
        papers={papers as Record<string, Paper>}
        onOpenPaper={vi.fn()}
        ai={{ ask: vi.fn() }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'AI 整理成稿' })).toBeNull();
  });
});
