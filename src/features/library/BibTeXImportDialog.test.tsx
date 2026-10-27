import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BibTeXImportDialog } from './BibTeXImportDialog';

const BIB = '@article{one, title={A Paper}, author={Ada Lovelace}, year={2017}}';

function pick(container: HTMLElement, file: File): void {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('file input not found');
  fireEvent.change(input, { target: { files: [file] } });
}

describe('BibTeXImportDialog', () => {
  it('starts from the file picker after a close, not from the previous preview', async () => {
    const onClose = vi.fn();
    const props = { open: true, papers: {}, onClose, onImport: vi.fn() };
    const { container, rerender } = render(<BibTeXImportDialog {...props} />);

    pick(container, new File([BIB], 'refs.bib', { type: 'text/plain' }));
    expect(await screen.findByText(/1 条可导入/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<BibTeXImportDialog {...props} />);
    expect(screen.queryByText(/1 条可导入/)).toBeNull();
    expect(screen.getByText(/每一条会先列出/)).toBeTruthy();
  });

  it('refuses a bibliography larger than the import bound before reading it', async () => {
    const { container } = render(
      <BibTeXImportDialog open papers={{}} onClose={vi.fn()} onImport={vi.fn()} />,
    );
    const oversized = new File(['x'], 'huge.bib', { type: 'text/plain' });
    Object.defineProperty(oversized, 'size', { value: 5 * 1024 * 1024 + 1 });

    pick(container, oversized);
    expect(await screen.findByText(/超过 5 MB/)).toBeTruthy();
  });
});
