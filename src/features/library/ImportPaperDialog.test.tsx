import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PdfBlobStore } from '../../services/pdfStore';
import type { PdfMetadata } from '../reader/pdfjs';
import { ImportPaperDialog } from './ImportPaperDialog';

/** The metadata path never touches the blob store; a stub keeps the test honest about that. */
const blobs: PdfBlobStore = {
  durable: true,
  has: async () => false,
  get: async () => null,
  put: async () => undefined,
  remove: async () => undefined,
  usage: async () => null,
};

function renderDialog(metadata: PdfMetadata) {
  const readMetadata = vi.fn(async () => metadata);
  render(
    <ImportPaperDialog
      open
      onClose={() => undefined}
      mode="new"
      targetPaper={null}
      projects={[]}
      initialProjectId={null}
      papers={{}}
      blobs={blobs}
      probe={async () => ({ pageCount: 1 })}
      readMetadata={readMetadata}
      onCommit={() => ({ status: 'refused' as const, message: 'not under test' })}
      onCommitted={() => undefined}
    />,
  );
  return { readMetadata };
}

/**
 * The file's own metadata is read asynchronously after it is chosen, and the token that
 * guards the read used to compare against a stale render closure — so every read saw itself
 * as outdated, applied nothing, and left the "reading" hint up forever. This is the
 * regression: the fields must fill, and the hint must settle.
 */
describe('ImportPaperDialog metadata autofill', () => {
  it('fills the empty title, authors, year and DOI from the PDF metadata', async () => {
    const user = userEvent.setup();
    renderDialog({
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer'],
      year: 2017,
      doi: '10.48550/arXiv.1706.03762',
    });

    const input = screen
      .getByRole('dialog', { name: '导入论文' })
      .querySelector('input[data-autofocus]');
    expect(input).not.toBeNull();
    await user.upload(input as HTMLInputElement, new File(['x'], 'paper.pdf'));

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: '标题' })).toHaveValue(
        'Attention Is All You Need',
      );
    });
    expect(screen.getByRole('textbox', { name: '作者（逗号分隔）' })).toHaveValue(
      'Ashish Vaswani, Noam Shazeer',
    );
    expect(screen.getByRole('textbox', { name: '年份' })).toHaveValue('2017');
    expect(screen.getByRole('textbox', { name: 'DOI（可留空）' })).toHaveValue(
      '10.48550/arXiv.1706.03762',
    );
    // The "reading" hint must clear once the read has landed.
    await waitFor(() => {
      expect(screen.queryByText('正在读取标题、作者与年份…')).not.toBeInTheDocument();
    });
  });

  it('keeps what the reader already typed instead of overwriting it', async () => {
    const user = userEvent.setup();
    renderDialog({ title: 'From The File', authors: ['Someone'], year: 2020 });

    const title = screen.getByRole('textbox', { name: '标题' });
    await user.clear(title);
    await user.type(title, 'Typed By Hand');
    const year = screen.getByRole('textbox', { name: '年份' });
    await user.clear(year);
    await user.type(year, '1999');

    const input = screen
      .getByRole('dialog', { name: '导入论文' })
      .querySelector('input[data-autofocus]');
    await user.upload(input as HTMLInputElement, new File(['x'], 'paper.pdf'));

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: '作者（逗号分隔）' })).toHaveValue('Someone');
    });
    expect(screen.getByRole('textbox', { name: '标题' })).toHaveValue('Typed By Hand');
    expect(screen.getByRole('textbox', { name: '年份' })).toHaveValue('1999');
  });
});
