import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OutlinePanel } from './OutlinePanel';
import type { OutlineEntry, PdfOutlineState } from './usePdfOutline';

const outline: PdfOutlineState = {
  status: 'ready',
  items: [
    {
      id: '0',
      title: '第一章 引言',
      page: 1,
      children: [
        { id: '0.0', title: '1.1 研究背景', page: 2, children: [] },
        { id: '0.1', title: '1.2 方法', page: 3, children: [] },
      ],
    },
  ],
};

function renderPanel(
  state: PdfOutlineState,
  currentPage: number,
  onJump = vi.fn(),
): ReturnType<typeof render> {
  return render(
    <OutlinePanel outline={state} currentPage={currentPage} onJump={onJump} onClose={vi.fn()} />,
  );
}

describe('OutlinePanel', () => {
  it('says so when the PDF has no outline', () => {
    renderPanel({ status: 'ready', items: [] }, 1);
    expect(screen.getByText('这份 PDF 没有目录。')).toBeTruthy();
  });

  it('shows a loading message while the outline is read', () => {
    renderPanel({ status: 'loading', items: [] }, 1);
    expect(screen.getByText('正在读取目录…')).toBeTruthy();
  });

  it('marks the chapter containing the current page and jumps from an entry', () => {
    const onJump = vi.fn();
    renderPanel(outline, 3, onJump);
    const current = screen.getByRole('button', { name: /1\.2 方法/ });
    expect(current.getAttribute('aria-current')).toBe('location');
    fireEvent.click(current);
    expect(onJump).toHaveBeenCalledWith(3);
  });

  it('collapses a chapter and hides its children', () => {
    renderPanel(outline, 3);
    fireEvent.click(screen.getByRole('button', { name: '收起「第一章 引言」' }));
    expect(screen.queryByRole('button', { name: /1\.2 方法/ })).toBeNull();
    // The collapsed chapter still carries the current-page mark.
    expect(screen.getByRole('button', { name: /^第一章 引言/ }).getAttribute('aria-current')).toBe(
      'location',
    );
  });

  it('shows entries with no resolvable destination but does not jump from them', () => {
    const items: OutlineEntry[] = [{ id: '0', title: '外部链接', page: null, children: [] }];
    renderPanel({ status: 'ready', items }, 1);
    const row = screen.getByRole('button', { name: /外部链接/ });
    expect(row).toHaveProperty('disabled', true);
  });
});
