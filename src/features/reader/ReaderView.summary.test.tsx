import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeApi } from '../knowledge/useKnowledgeApi';
import type { AiAskRequest, AiAnswer } from '../../services/ai/types';
import type { Paper } from '../../domain/papers';
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

function renderReader(onSaveSummary: (summary: unknown) => void) {
  return render(
    <ReaderView
      paper={paper}
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
      onSaveSummary={onSaveSummary}
    />,
  );
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
    expect(onSaveSummary).toHaveBeenCalledWith(
      expect.objectContaining({ text: '摘要正文', pdfSha256: paper.pdf?.sha256 }),
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
});
