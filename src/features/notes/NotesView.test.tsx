import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
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

const attention: Paper = { id: 'p1', title: 'Attention', authors: [], createdAt: 0, updatedAt: 0 };
const bert: Paper = { id: 'p2', title: 'BERT', authors: [], createdAt: 0, updatedAt: 0 };
const papers = { p1: attention, p2: bert };

const a1 = note('a1', 'p1', { kind: 'insight', note: '关键想法', page: 4, quote: 'Softmax' });
const b1 = note('b1', 'p2', { kind: 'question', quote: 'Why masked?', page: 2 });

function renderView(annotations: Annotation[] = [a1, b1]) {
  const onOpenPaper = vi.fn();
  render(<NotesView annotations={annotations} papers={papers} onOpenPaper={onOpenPaper} />);
  return { onOpenPaper };
}

describe('NotesView', () => {
  it('says so when there are no notes', () => {
    renderView([]);
    expect(screen.getByText(/还没有笔记/)).toBeTruthy();
  });

  it('groups notes under their paper and shows what each says', () => {
    renderView();
    expect(screen.getByRole('heading', { name: 'Attention' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'BERT' })).toBeTruthy();
    expect(screen.getAllByText('理解').length).toBeGreaterThan(0);
    expect(screen.getAllByText('疑问').length).toBeGreaterThan(0);
    expect(screen.getByText('关键想法')).toBeTruthy();
    expect(screen.getByText('Softmax')).toBeTruthy();
  });

  it('opens the paper at the note page and quote', () => {
    const { onOpenPaper } = renderView();
    fireEvent.click(screen.getByText('关键想法').closest('button')!);
    expect(onOpenPaper).toHaveBeenCalledWith('p1', { page: 4, quote: 'Softmax' });
  });

  it('filters by a search term', () => {
    renderView();
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索笔记' }), {
      target: { value: 'masked' },
    });
    expect(screen.queryByText('关键想法')).toBeNull();
    expect(screen.getByText('masked', { selector: 'mark' })).toBeTruthy();
  });

  it('filters by note kind', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: '疑问' }));
    expect(screen.queryByText('关键想法')).toBeNull();
    expect(screen.getByText('Why masked?')).toBeTruthy();
  });

  it('filters by paper', () => {
    renderView();
    fireEvent.change(screen.getByRole('combobox', { name: '按论文筛选' }), {
      target: { value: 'p2' },
    });
    expect(screen.queryByText('关键想法')).toBeNull();
    expect(screen.getByText('Why masked?')).toBeTruthy();
  });

  it('says so when filters match nothing', () => {
    renderView();
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索笔记' }), {
      target: { value: 'nothing here' },
    });
    expect(screen.getByText('没有符合筛选条件的笔记。')).toBeTruthy();
  });

  it('marks a question resolved and reopens it, through the callback', () => {
    const seen: Array<[string, number | null]> = [];
    function Harness() {
      const [annotations, setAnnotations] = useState<Annotation[]>([b1]);
      return (
        <NotesView
          annotations={annotations}
          papers={papers}
          onOpenPaper={vi.fn()}
          onResolveQuestion={(id, resolvedAt) => {
            seen.push([id, resolvedAt]);
            setAnnotations((current) =>
              current.map((annotation) => ({
                ...annotation,
                ...(resolvedAt === null
                  ? { resolvedAt: undefined }
                  : { resolvedAt: resolvedAt ?? undefined }),
              })),
            );
          }}
        />
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '标记已解决' }));
    expect(seen[0]).toStrictEqual([b1.id, expect.any(Number)]);
    // The badge says the question is closed, and the action offers to undo it. The filter
    // chip also reads 已解决, so the badge is counted rather than matched alone.
    expect(screen.getAllByText('已解决').length).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: '重新打开' }));
    expect(seen[1]).toStrictEqual([b1.id, null]);
    expect(screen.getAllByText('已解决').length).toBe(1);
  });

  it('shows the open-question count and filters by resolution', () => {
    renderView();
    expect(screen.getByText(/1 个未解决疑问/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^未解决/ }));
    expect(screen.getByText('Why masked?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '已解决' }));
    expect(screen.getByText('没有符合筛选条件的笔记。')).toBeTruthy();
  });

  it('still opens the paper from inside a question card', () => {
    const onOpenPaper = vi.fn();
    render(
      <NotesView
        annotations={[b1]}
        papers={papers}
        onOpenPaper={onOpenPaper}
        onResolveQuestion={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Why masked?').closest('button')!);
    expect(onOpenPaper).toHaveBeenCalledWith('p2', { page: 2, quote: 'Why masked?' });
  });
});
