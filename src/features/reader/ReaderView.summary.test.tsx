import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeApi } from '../knowledge/useKnowledgeApi';
import type { AiAskRequest, AiAnswer } from '../../services/ai/types';
import type { Paper, PaperSummary } from '../../domain/papers';
import type { PdfBlobStore } from '../../services/pdfStore';
import { ReaderView } from './ReaderView';

/**
 * The summary card's whole path, with no host-injected assistant.
 *
 * This is the regression guard for the production wiring: `App` never supplies `ai`, so the
 * reader has to arrive at the same default transport the AI panel already uses. The earlier
 * tests only mounted the panel and clicked its two buttons; they could not see that the
 * handler behind them returned immediately.
 */

const { askAiMock, fetchAiHealthMock, pdfState, outlineState, documentState } = vi.hoisted(() => ({
  askAiMock: vi.fn(),
  fetchAiHealthMock: vi.fn(async () => null),
  pdfState: {
    status: 'ready',
    doc: {
      numPages: 2,
      getPage: async () => ({ getViewport: () => ({ width: 600, height: 800 }) }),
    },
    pageCount: 2,
  },
  outlineState: { status: 'ready', items: [] },
  documentState: {
    pages: [
      { page: 1, text: 'first page text' },
      { page: 2, text: 'second page text' },
    ],
    ready: true,
  },
}));

vi.mock('../../services/ai/client', () => ({
  DEFAULT_TIMEOUT_MS: 60_000,
  askAi: askAiMock,
  fetchAiHealth: fetchAiHealthMock,
  analyzeDifficulties: vi.fn(),
  analyzeKnowledge: vi.fn(),
}));

vi.mock('./usePdfDocument', () => ({
  PDF_FAILURE_MESSAGE: {},
  usePdfDocument: () => pdfState,
}));

vi.mock('./useDocumentText', () => ({
  useDocumentText: () => documentState,
}));

vi.mock('./usePdfOutline', () => ({
  usePdfOutline: () => outlineState,
  activeOutlineId: () => null,
  countOutlineEntries: () => 0,
}));

vi.mock('./PdfPage', () => ({
  PdfPage: ({ pageNumber }: { pageNumber: number }) => (
    <div className="pdf-page" data-page={pageNumber}>
      <div className="textLayer">
        <span>{pageNumber === 1 ? 'first page text' : 'second page text'}</span>
      </div>
    </div>
  ),
}));

const paper: Paper = {
  id: 'paper-1',
  title: 'A Study of Summaries',
  authors: [],
  createdAt: 1,
  updatedAt: 1,
  pdf: {
    sha256: 'a'.repeat(64),
    name: 'summary.pdf',
    bytes: 100,
    pageCount: 2,
    addedAt: 1,
  },
};

const blobs: PdfBlobStore = {
  durable: true,
  has: async () => false,
  get: async () => null,
  put: async () => undefined,
  remove: async () => undefined,
  usage: async () => null,
};

const knowledge = {
  state: { version: 2, concepts: [], evidence: [], relations: [], rejections: [] },
} as unknown as KnowledgeApi;

const answer: AiAnswer = {
  provider: 'mock',
  providerLabel: '本地模拟',
  model: 'mock-1',
  online: false,
  mode: 'summarize',
  status: 'valid',
  answer: '摘要正文',
  groundedInText: true,
  citations: [],
  warnings: [],
  diagnostics: null,
  usage: null,
};

function readerElement(
  current: Paper,
  props: {
    onSaveSummary?: (summary: PaperSummary) => void;
    onClearSummary?: () => void;
  } = {},
): ReactElement {
  return (
    <ReaderView
      paper={current}
      blobs={blobs}
      annotations={[]}
      bookmarks={[]}
      knowledge={knowledge}
      projects={[]}
      projectId={null}
      theme="light"
      layoutPreset="research"
      onClose={vi.fn()}
      onReadingPosition={vi.fn()}
      onReplaceFile={vi.fn()}
      onAddBookmark={vi.fn()}
      onRenameBookmark={vi.fn()}
      onDeleteBookmark={vi.fn()}
      onCreateAnnotation={vi.fn()}
      onSaveAiNote={vi.fn()}
      onSaveConcept={vi.fn()}
      onOpenConceptInProject={vi.fn()}
      onEditAnnotation={vi.fn()}
      onDeleteAnnotation={vi.fn()}
      onSaveSummary={props.onSaveSummary}
      onClearSummary={props.onClearSummary}
    />
  );
}

function renderReader(onSaveSummary: (summary: PaperSummary) => void) {
  return render(readerElement(paper, { onSaveSummary }));
}

/**
 * A host that actually owns the summary, the way `App` does.
 *
 * Saving and clearing round-trip through a new `paper` prop: that is what the reader uses to
 * notice that the card it was writing changed while its request was running.
 */
function readerHost(initial?: PaperSummary) {
  const saved: PaperSummary[] = [];
  function Host(): ReactElement {
    const [summary, setSummary] = useState<PaperSummary | undefined>(initial);
    return readerElement(
      { ...paper, summary },
      {
        onSaveSummary: (next) => {
          saved.push(next);
          setSummary(next);
        },
        onClearSummary: () => {
          setSummary(undefined);
        },
      },
    );
  }
  return { Host, saved };
}

/** A summary request the test still owes the reader. */
function pendingAsk() {
  let settle!: (value: { ok: true; answer: AiAnswer }) => void;
  const promise = new Promise<{ ok: true; answer: AiAnswer }>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

beforeEach(() => {
  window.localStorage.clear();
  askAiMock.mockReset();
  fetchAiHealthMock.mockReset();
  fetchAiHealthMock.mockResolvedValue(null);
  askAiMock.mockResolvedValue({ ok: true, answer });
});

describe('ReaderView summary card', () => {
  it('works without a host-injected ai client, and does not call an unchecked service free', async () => {
    const onSaveSummary = vi.fn();
    renderReader(onSaveSummary);

    fireEvent.click(await screen.findByRole('button', { name: '生成摘要卡' }));
    expect(fetchAiHealthMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/尚未确认 AI 服务状态/)).toBeTruthy();
    expect(screen.queryByText(/不产生任何费用/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '开始生成' }));

    await waitFor(() => {
      expect(onSaveSummary).toHaveBeenCalledTimes(1);
    });
    expect(askAiMock).toHaveBeenCalledTimes(1);
    const request = askAiMock.mock.calls[0]?.[0] as AiAskRequest;
    expect(request.mode).toBe('summarize');
    expect(request.scope).toBe('document');
    expect(request.passages.some((passage) => passage.page === 2)).toBe(true);
    // The request is cancellable: leaving the reader must stop it, not let it finish unseen.
    expect(askAiMock.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
    expect(onSaveSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '摘要正文',
        pdfSha256: paper.pdf?.sha256,
        provider: 'mock',
        providerLabel: '本地模拟',
        model: 'mock-1',
        online: false,
        createdAt: expect.any(Number),
      }),
    );
  });

  it('refuses an empty answer instead of saving a card that a reload would drop', async () => {
    askAiMock.mockResolvedValue({ ok: true, answer: { ...answer, answer: '   ' } });
    const onSaveSummary = vi.fn();
    renderReader(onSaveSummary);

    fireEvent.click(await screen.findByRole('button', { name: '生成摘要卡' }));
    fireEvent.click(screen.getByRole('button', { name: '开始生成' }));

    expect(await screen.findByText(/模型没有返回可保存的内容/)).toBeTruthy();
    expect(onSaveSummary).not.toHaveBeenCalled();
  });

  /**
   * The reader can empty the card while a generation is running. A late answer must not put the
   * old text back over that decision.
   */
  it('does not overwrite a card the reader cleared while it was being generated', async () => {
    const existing: PaperSummary = {
      text: '读者自己保留的旧摘要',
      pdfSha256: paper.pdf?.sha256,
      provider: 'mock',
      providerLabel: '本地模拟',
      model: 'mock-1',
      online: false,
      createdAt: 1,
    };
    const { Host, saved } = readerHost(existing);
    const pending = pendingAsk();
    askAiMock.mockReturnValue(pending.promise);
    render(<Host />);

    fireEvent.click(await screen.findByRole('button', { name: '重新生成' }));
    fireEvent.click(screen.getByRole('button', { name: '开始生成' }));

    fireEvent.click(screen.getByRole('button', { name: '移除' }));
    fireEvent.click(screen.getByRole('button', { name: '确定移除' }));
    expect(screen.queryByText('读者自己保留的旧摘要')).toBeNull();

    await act(async () => {
      pending.settle({ ok: true, answer: { ...answer, answer: '迟到的生成结果' } });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saved).toEqual([]);
    expect(screen.queryByText('迟到的生成结果')).toBeNull();
    expect(screen.getByText(/没有覆盖/)).toBeTruthy();
  });

  it('does not save a late success after the reader is closed', async () => {
    const pending = pendingAsk();
    askAiMock.mockReturnValue(pending.promise);
    const onSaveSummary = vi.fn();
    const { unmount } = renderReader(onSaveSummary);

    fireEvent.click(await screen.findByRole('button', { name: '生成摘要卡' }));
    fireEvent.click(screen.getByRole('button', { name: '开始生成' }));
    const signal = askAiMock.mock.calls[0]?.[1]?.signal as AbortSignal | undefined;
    unmount();
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      pending.settle({ ok: true, answer });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onSaveSummary).not.toHaveBeenCalled();
  });

  it('does not save a result for a PDF that was replaced while it was generating', async () => {
    const pending = pendingAsk();
    askAiMock.mockReturnValue(pending.promise);
    const onSaveSummary = vi.fn();
    const { rerender } = renderReader(onSaveSummary);

    fireEvent.click(await screen.findByRole('button', { name: '生成摘要卡' }));
    fireEvent.click(screen.getByRole('button', { name: '开始生成' }));
    const signal = askAiMock.mock.calls[0]?.[1]?.signal as AbortSignal | undefined;

    const replaced: Paper = {
      ...paper,
      pdf: { ...(paper.pdf as NonNullable<Paper['pdf']>), sha256: 'b'.repeat(64) },
    };
    rerender(readerElement(replaced, { onSaveSummary }));
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      pending.settle({ ok: true, answer });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onSaveSummary).not.toHaveBeenCalled();
  });

  it('keeps only the newest generation when two overlap and the older returns last', async () => {
    const first = pendingAsk();
    const second = pendingAsk();
    askAiMock
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const onSaveSummary = vi.fn();
    renderReader(onSaveSummary);

    fireEvent.click(await screen.findByRole('button', { name: '生成摘要卡' }));
    const start = screen.getByRole('button', { name: '开始生成' });
    // Two triggers in one batch: the second generation starts before React has painted the
    // first one's busy state, which is exactly the overlap the sequence guard exists for.
    act(() => {
      start.click();
      start.click();
    });
    expect(askAiMock).toHaveBeenCalledTimes(2);
    const firstSignal = askAiMock.mock.calls[0]?.[1]?.signal as AbortSignal | undefined;
    expect(firstSignal?.aborted).toBe(true);

    await act(async () => {
      second.settle({ ok: true, answer: { ...answer, answer: '第二份摘要' } });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(onSaveSummary).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      first.settle({ ok: true, answer: { ...answer, answer: '第一份摘要' } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onSaveSummary).toHaveBeenCalledTimes(1);
    expect(onSaveSummary).toHaveBeenLastCalledWith(expect.objectContaining({ text: '第二份摘要' }));
  });

  it('recovers the busy state after a failure and can generate again', async () => {
    askAiMock
      .mockResolvedValueOnce({
        ok: false,
        failure: { kind: 'upstream', message: '模型服务返回了错误。' },
      })
      .mockResolvedValueOnce({ ok: true, answer });
    const onSaveSummary = vi.fn();
    renderReader(onSaveSummary);

    fireEvent.click(await screen.findByRole('button', { name: '生成摘要卡' }));
    fireEvent.click(screen.getByRole('button', { name: '开始生成' }));
    expect(await screen.findByText(/生成失败/)).toBeTruthy();
    expect(onSaveSummary).not.toHaveBeenCalled();

    // The failed request released the busy state; the card can be asked for again.
    fireEvent.click(screen.getByRole('button', { name: '生成摘要卡' }));
    fireEvent.click(screen.getByRole('button', { name: '开始生成' }));
    await waitFor(() => {
      expect(onSaveSummary).toHaveBeenCalledTimes(1);
    });
    expect(askAiMock).toHaveBeenCalledTimes(2);
  });
});
