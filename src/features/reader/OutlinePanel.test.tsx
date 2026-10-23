import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createAnnotation } from '../../domain/annotation';
import { createBookmark } from '../../domain/bookmark';
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

  it('lists bookmarks and notes under the chapter that contains them', () => {
    const onJump = vi.fn();
    const onAddBookmark = vi.fn();
    const bookmark = createBookmark(
      { paperId: 'paper-1', page: 3, label: '方法在这里' },
      () => 'b1',
      1000,
    );
    const note = createAnnotation(
      {
        paperId: 'paper-1',
        pdfSha256: 'a'.repeat(64),
        page: 2,
        quote: 'The proof reduces the protocol to a polynomial commitment.',
        prefix: '',
        suffix: '',
        rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }],
        kind: 'question',
        note: '这一步为什么成立？',
      },
      () => 'n1',
      2000,
    );
    if (bookmark === null || note === null) throw new Error('fixtures must be valid');

    render(
      <OutlinePanel
        outline={outline}
        currentPage={3}
        onJump={onJump}
        onClose={vi.fn()}
        bookmarks={[bookmark]}
        annotations={[note]}
        onAddBookmark={onAddBookmark}
        onRenameBookmark={vi.fn()}
        onDeleteBookmark={vi.fn()}
        onJumpToNote={vi.fn()}
        onEditNote={vi.fn()}
        onDeleteNote={vi.fn()}
      />,
    );

    // The row's own title is unique; its aria-label is empty because the row reads as text.
    const bookmarkRow = screen.getByTitle('方法在这里');
    expect(bookmarkRow.closest('.outline-mark')?.getAttribute('data-kind')).toBe('bookmark');
    fireEvent.click(bookmarkRow);
    expect(onJump).toHaveBeenCalledWith(3);

    const noteRow = screen.getByTitle('这一步为什么成立？');
    expect(noteRow.closest('.outline-mark')?.getAttribute('data-kind')).toBe('note');
    expect(screen.getByText('疑问')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '为第 3 页添加书签' }));
    expect(onAddBookmark).toHaveBeenCalledWith('');
  });
});
