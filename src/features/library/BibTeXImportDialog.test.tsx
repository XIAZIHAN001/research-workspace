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

it('indexes the registry once for a multi-entry preview and preserves DOI-first display', async () => {
  let enumerations = 0;
  const makePaper = (id: string, ids: { doi?: string; arxivId?: string }) => ({
    id,
    title: id,
    authors: [],
    createdAt: 0,
    updatedAt: 0,
    ...ids,
  });
  const papers = new Proxy(
    {
      arxiv: makePaper('Arxiv owner', { arxivId: '2401.12345' }),
      doi: makePaper('DOI owner', { doi: '10.1000/shared' }),
      duplicate: makePaper('Duplicate DOI', { doi: '10.1000/shared' }),
    },
    {
      ownKeys(target) {
        enumerations += 1;
        return Reflect.ownKeys(target);
      },
    },
  );
  const { container } = render(
    <BibTeXImportDialog open papers={papers} onClose={vi.fn()} onImport={vi.fn()} />,
  );
  pick(
    container,
    new File(
      [
        '@article{both,title={Both},doi={10.1000/shared},eprint={2401.12345},archivePrefix={arXiv}}\n' +
          '@article{new,title={New}}\n@article{sameTitle,title={DOI owner}}',
      ],
      'refs.bib',
      { type: 'text/plain' },
    ),
  );
  expect(await screen.findByText(/3 条可导入/)).toBeTruthy();
  expect(screen.getByText(/库里已有《DOI owner》/)).toBeTruthy();
  const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
  expect(checkboxes.map((checkbox) => checkbox.disabled)).toEqual([true, false, false]);
  expect(checkboxes.map((checkbox) => checkbox.checked)).toEqual([false, true, true]);
  expect(enumerations).toBe(1);
});
