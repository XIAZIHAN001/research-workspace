import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../../domain/annotation';
import { NotesPanel } from './NotesPanel';

const THIS_FILE = 'a'.repeat(64);
const OTHER_FILE = 'b'.repeat(64);

function annotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'one',
    paperId: 'paper-1',
    pdfSha256: THIS_FILE,
    page: 2,
    quote: 'the rotated attention mechanism',
    prefix: 'we replace ',
    suffix: ' which lets',
    rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }],
    kind: 'question',
    note: '',
    origin: 'user',
    sourceLabel: '',
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  };
}

function setup(annotations: Annotation[], activeId: string | null = null) {
  const user = userEvent.setup();
  const handlers = {
    onJump: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <NotesPanel
      annotations={annotations}
      currentPdfSha256={THIS_FILE}
      activeId={activeId}
      {...handlers}
    />,
  );
  return { user, ...handlers };
}

const panel = () => screen.getByRole('complementary', { name: '论文笔记' });
const items = () => within(panel()).getAllByRole('listitem');

describe('NotesPanel', () => {
  it('says how to make a note when there are none', () => {
    setup([]);
    expect(within(panel()).getByText(/选中文字/)).toBeInTheDocument();
  });

  it('lists a highlight with its page, kind and quote', () => {
    setup([annotation()]);
    expect(within(items()[0] as HTMLElement).getByText('疑问')).toBeInTheDocument();
    expect(within(items()[0] as HTMLElement).getByText('第 2 页')).toBeInTheDocument();
    expect(
      within(items()[0] as HTMLElement).getByText('the rotated attention mechanism'),
    ).toBeInTheDocument();
  });

  it('shows the note text once there is one', () => {
    setup([annotation({ note: '为什么除以根号 d？', kind: 'insight' })]);
    expect(screen.getByText('为什么除以根号 d？')).toBeInTheDocument();
    expect(screen.getByText('理解')).toBeInTheDocument();
  });

  it('orders by page so the panel reads like the paper', () => {
    setup([annotation({ id: 'late', page: 9 }), annotation({ id: 'early', page: 1 })]);
    expect(items().map((item) => within(item).getByText(/第 \d+ 页/).textContent)).toStrictEqual([
      '第 1 页',
      '第 9 页',
    ]);
  });

  it('jumps back to the highlight it belongs to', async () => {
    const only = annotation();
    const { user, onJump } = setup([only]);
    await user.click(within(items()[0] as HTMLElement).getByRole('button', { name: /回到原文/ }));
    expect(onJump).toHaveBeenCalledWith(only);
  });

  it('edits the note and the kind together', async () => {
    const only = annotation();
    const { user, onEdit } = setup([only]);
    await user.click(within(items()[0] as HTMLElement).getByRole('button', { name: /写笔记/ }));
    await user.click(within(items()[0] as HTMLElement).getByRole('button', { name: '理解' }));
    await user.type(within(items()[0] as HTMLElement).getByLabelText('笔记内容'), '缩放点积');
    await user.click(within(items()[0] as HTMLElement).getByRole('button', { name: '保存' }));
    expect(onEdit).toHaveBeenCalledWith('one', { note: '缩放点积', kind: 'insight' });
  });

  it('cancels an edit without saving', async () => {
    const { user, onEdit } = setup([annotation({ note: '原来的想法' })]);
    await user.click(within(items()[0] as HTMLElement).getByRole('button', { name: /编辑/ }));
    await user.type(within(items()[0] as HTMLElement).getByLabelText('笔记内容'), '改了');
    await user.click(within(items()[0] as HTMLElement).getByRole('button', { name: '取消' }));
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByText('原来的想法')).toBeInTheDocument();
  });

  it('asks for confirmation before deleting', async () => {
    const only = annotation();
    const { user, onDelete } = setup([only]);
    await user.click(within(items()[0] as HTMLElement).getByRole('button', { name: /删除/ }));
    expect(onDelete).toHaveBeenCalledWith(only);
  });

  it('marks the highlight the reader is looking at', () => {
    setup([annotation()], 'one');
    expect(items()[0]).toHaveAttribute('data-active', 'true');
  });

  it('keeps notes made on another file, and says why they cannot be jumped to', () => {
    setup([annotation({ id: 'other', pdfSha256: OTHER_FILE, page: 4 })]);
    expect(screen.getByText(/另一份 PDF 上的笔记/)).toBeInTheDocument();
    expect(screen.getByText(/不会画在新文件上/)).toBeInTheDocument();
    expect(
      within(items()[0] as HTMLElement).getByRole('button', { name: /回到原文/ }),
    ).toBeDisabled();
  });
});
