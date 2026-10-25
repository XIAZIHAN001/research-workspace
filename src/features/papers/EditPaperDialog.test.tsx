import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Paper } from '../../domain/papers';
import type { MetadataFetchOutcome } from '../../services/metadataFetch';
import { EditPaperDialog } from './EditPaperDialog';

vi.mock('../../ui/Dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const paper: Paper = {
  id: 'p1',
  title: '从文件名来的标题',
  authors: [],
  doi: '10.1000/xyz',
  createdAt: 0,
  updatedAt: 0,
};

const answer = (outcome: MetadataFetchOutcome) => vi.fn(() => Promise.resolve(outcome));

function renderDialog(fetchMetadata = answer({ status: 'no-identifier' })) {
  render(
    <EditPaperDialog
      open
      paper={paper}
      onClose={vi.fn()}
      onSave={() => null}
      fetchMetadata={fetchMetadata}
    />,
  );
  return { fetchMetadata };
}

describe('EditPaperDialog registry lookup', () => {
  it('fills only the empty fields and says which ones', async () => {
    const fetchMetadata = answer({
      status: 'ok',
      metadata: {
        title: 'The Real Title',
        authors: ['Ada Lovelace'],
        year: 2031,
      },
    });
    renderDialog(fetchMetadata);
    fireEvent.click(screen.getByRole('button', { name: '按标识符补全' }));
    await waitFor(() => {
      // The title was already filled (from the file name), so only authors and year land.
      expect(screen.getByRole('status').textContent).toContain('作者、年份');
    });
    expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('从文件名来的标题');
    expect((screen.getByLabelText('作者（逗号分隔）') as HTMLInputElement).value).toBe(
      'Ada Lovelace',
    );
  });

  it('explains a miss without touching anything', async () => {
    const fetchMetadata = answer({ status: 'not-found' });
    renderDialog(fetchMetadata);
    fireEvent.click(screen.getByRole('button', { name: '按标识符补全' }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('查不到');
    });
    expect(fetchMetadata).toHaveBeenCalledWith({ doi: '10.1000/xyz', arxivId: '' });
  });

  it('is disabled while a lookup is in flight', () => {
    const fetchMetadata = vi.fn(() => new Promise<MetadataFetchOutcome>(() => undefined));
    renderDialog(fetchMetadata);
    const button = screen.getByRole('button', { name: '按标识符补全' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: '查询中…' })).toBeTruthy();
  });
});

describe('EditPaperDialog lookup races', () => {
  it('respects fields the reader filled while the request was in flight', async () => {
    const answers: Array<(value: MetadataFetchOutcome) => void> = [];
    const fetchMetadata = vi.fn(
      () =>
        new Promise<MetadataFetchOutcome>((resolve) => {
          answers.push(resolve);
        }),
    );
    render(
      <EditPaperDialog
        open
        paper={paper}
        onClose={vi.fn()}
        onSave={() => null}
        fetchMetadata={fetchMetadata}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '按标识符补全' }));
    // While the registry is thinking, the reader types their own title and an author.
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '我改过的标题' } });
    fireEvent.change(screen.getByLabelText('作者（逗号分隔）'), {
      target: { value: '某作者' },
    });
    answers[0]?.({
      status: 'ok',
      metadata: { title: 'Registry Title', authors: ['Ada Lovelace'], year: 2031 },
    });
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('年份');
      expect(screen.getByRole('status').textContent).not.toContain('标题');
    });
    expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('我改过的标题');
    expect((screen.getByLabelText('作者（逗号分隔）') as HTMLInputElement).value).toBe('某作者');
    expect((screen.getByLabelText('年份') as HTMLInputElement).value).toBe('2031');
  });

  it('drops an answer that a newer click has superseded', async () => {
    const stale = vi.fn(() => new Promise<MetadataFetchOutcome>(() => undefined));
    const answers: Array<(value: MetadataFetchOutcome) => void> = [];
    const fetchMetadata = vi.fn(
      () =>
        new Promise<MetadataFetchOutcome>((resolve) => {
          answers.push(resolve);
        }),
    );
    void stale;
    const { unmount } = render(
      <EditPaperDialog
        open
        paper={{ ...paper, doi: undefined, arxivId: '2401.12345' }}
        onClose={vi.fn()}
        onSave={() => null}
        fetchMetadata={fetchMetadata}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '按标识符补全' }));
    // The dialog closes (unmount) before the registry answers.
    unmount();
    answers[0]?.({ status: 'ok', metadata: { title: 'Late' } });
    // Nothing to assert on an unmounted tree; the contract is simply "no crash, no write".
    expect(answers).toHaveLength(1);
  });
});

describe('EditPaperDialog identifier snapshot (review round 2)', () => {
  it('drops an answer whose identifiers the reader has since changed', async () => {
    const answers: Array<(value: MetadataFetchOutcome) => void> = [];
    const fetchMetadata = vi.fn(
      () =>
        new Promise<MetadataFetchOutcome>((resolve) => {
          answers.push(resolve);
        }),
    );
    render(
      <EditPaperDialog
        open
        paper={{ ...paper, doi: '10.1000/xyz' }}
        onClose={vi.fn()}
        onSave={() => null}
        fetchMetadata={fetchMetadata}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '按标识符补全' }));
    // While the registry thinks, the reader replaces the DOI with a different paper's.
    fireEvent.change(screen.getByLabelText('DOI（留空表示清除）'), {
      target: { value: '10.9999/other' },
    });
    answers[0]?.({
      status: 'ok',
      metadata: { title: 'Wrong Paper Title', authors: ['Wrong Author'], year: 1999 },
    });
    await waitFor(() => {
      // The status line says the answer was dropped, and nothing was filled.
      expect(screen.getByRole('status').textContent).toContain('已放弃');
    });
    expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('从文件名来的标题');
    expect((screen.getByLabelText('作者（逗号分隔）') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('年份') as HTMLInputElement).value).toBe('');
  });
});
