import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createPaper } from '../../domain/papers';
import { GlobalSearchDialog } from './GlobalSearchDialog';
import type { WorkspaceSearchSource } from './searchWorkspace';

function source(): WorkspaceSearchSource {
  let sequence = 0;
  const paper = createPaper(
    { title: 'Attention Is All You Need', authors: ['Ashish Vaswani'], year: 2017 },
    () => `id-${String(++sequence)}`,
    1,
  );
  if (paper === null) throw new Error('fixture paper');
  return { papers: [paper], annotations: [], concepts: [], evidence: [] };
}

function renderDialog(
  overrides: Partial<{
    onOpenPaper: (paperId: string, focus?: { page: number; quote: string }) => void;
    onOpenConcept: (conceptId: string, projectId: string) => void;
  }> = {},
): ReturnType<typeof render> {
  return render(
    <GlobalSearchDialog
      open
      source={source()}
      onClose={vi.fn()}
      onOpenPaper={overrides.onOpenPaper ?? vi.fn()}
      onOpenConcept={overrides.onOpenConcept ?? vi.fn()}
    />,
  );
}

describe('GlobalSearchDialog', () => {
  it('searches as the reader types and opens a result with Enter', () => {
    const onOpenPaper = vi.fn();
    renderDialog({ onOpenPaper });
    const input = screen.getByRole('textbox', { name: '搜索工作区' });
    fireEvent.change(input, { target: { value: 'attention' } });
    expect(screen.getByText('论文')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onOpenPaper).toHaveBeenCalledWith('id-1', undefined);
  });

  it('says when nothing matches', () => {
    renderDialog();
    fireEvent.change(screen.getByRole('textbox', { name: '搜索工作区' }), {
      target: { value: '不存在的词' },
    });
    expect(screen.getByText('没有找到匹配的内容。')).toBeTruthy();
  });

  it('opens a result by click', () => {
    const onOpenPaper = vi.fn();
    renderDialog({ onOpenPaper });
    fireEvent.change(screen.getByRole('textbox', { name: '搜索工作区' }), {
      target: { value: 'vaswani' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Attention Is All You Need/ }));
    expect(onOpenPaper).toHaveBeenCalledWith('id-1', undefined);
  });
});
