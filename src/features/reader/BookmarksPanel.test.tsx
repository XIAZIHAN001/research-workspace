import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Bookmark } from '../../domain/bookmark';
import { BookmarksPanel } from './BookmarksPanel';

const bookmark = (id: string, page: number, label = ''): Bookmark => ({
  id,
  paperId: 'p1',
  page,
  label,
  createdAt: 1,
});

function renderPanel(overrides: Partial<Parameters<typeof BookmarksPanel>[0]> = {}) {
  const props = {
    bookmarks: [] as readonly Bookmark[],
    currentPage: 3,
    onJump: vi.fn(),
    onAdd: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<BookmarksPanel {...props} />);
  return props;
}

describe('BookmarksPanel', () => {
  it('says so when there are no bookmarks', () => {
    renderPanel();
    expect(screen.getByText('还没有书签。翻到想记住的页面，添加一个。')).toBeTruthy();
  });

  it('adds a bookmark for the current page and clears the field', () => {
    const { onAdd } = renderPanel();
    const input = screen.getByRole('textbox', { name: '书签名称' });
    fireEvent.change(input, { target: { value: '方法' } });
    fireEvent.click(screen.getByRole('button', { name: /添加/ }));
    expect(onAdd).toHaveBeenCalledWith('方法');
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('adds an unnamed bookmark as an empty label', () => {
    const { onAdd } = renderPanel();
    fireEvent.submit(screen.getByRole('textbox', { name: '书签名称' }).closest('form')!);
    expect(onAdd).toHaveBeenCalledWith('');
  });

  it('lists bookmarks in page order and jumps from one', () => {
    const first = bookmark('b', 8, '结论');
    const second = bookmark('a', 2, '方法');
    const { onJump } = renderPanel({ bookmarks: [first, second], currentPage: 2 });
    const links = screen.getAllByRole('button', { name: /^(方法|结论)/ });
    expect(links[0]?.textContent).toContain('方法');
    expect(links[1]?.textContent).toContain('结论');
    expect(links[0]?.getAttribute('aria-current')).toBe('location');
    fireEvent.click(links[1]!);
    expect(onJump).toHaveBeenCalledWith(first);
  });

  it('shows the page number for an unnamed bookmark', () => {
    renderPanel({ bookmarks: [bookmark('a', 6)], currentPage: 1 });
    expect(screen.getByRole('button', { name: /^第 6 页/ })).toBeTruthy();
  });

  it('renames a bookmark', () => {
    const entry = bookmark('a', 6, '旧名字');
    const { onRename } = renderPanel({ bookmarks: [entry] });
    fireEvent.click(screen.getByRole('button', { name: '重命名「旧名字」' }));
    const input = screen.getAllByRole('textbox', { name: '书签名称' })[1]!;
    fireEvent.change(input, { target: { value: '新名字' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onRename).toHaveBeenCalledWith('a', '新名字');
  });

  it('deletes a bookmark', () => {
    const entry = bookmark('a', 6, '旧名字');
    const { onDelete } = renderPanel({ bookmarks: [entry] });
    fireEvent.click(screen.getByRole('button', { name: '删除「旧名字」' }));
    expect(onDelete).toHaveBeenCalledWith(entry);
  });
});
