import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from './pdfjs';
import { usePdfSearch } from './usePdfSearch';
import { useDocumentText } from './useDocumentText';
import { extractPageText } from './paperRetrieval';

function makeDoc(text = '机器') {
  const getTextContent = vi.fn(async () => ({ items: [{ str: text }, { str: '学习' }] }));
  return {
    doc: {
      numPages: 1,
      getPage: vi.fn(async () => ({ getTextContent })),
    } as unknown as PDFDocumentProxy,
    getTextContent,
  };
}

describe('shared reader text consumers', () => {
  it('shares overlapping AI, retrieval and search extraction with distinct strings', async () => {
    const { doc, getTextContent } = makeDoc();
    const { result } = renderHook(() => ({
      ai: useDocumentText(doc, 'shared'),
      search: usePdfSearch(doc, true),
    }));
    const retrieval = extractPageText(doc, 1);
    await waitFor(() => expect(result.current.search.status).toBe('ready'));
    await waitFor(() => expect(result.current.ai.ready).toBe(true));
    expect((await retrieval)?.text).toBe('机器 学习');
    expect(result.current.ai.pages[0]?.text).toBe('机器 学习');
    act(() => result.current.search.setQuery('机器学习'));
    await waitFor(() => expect(result.current.search.hits[0]?.snippet).toBe('机器学习'));
    expect(getTextContent).toHaveBeenCalledTimes(1);
  });
  it('does not expose the old transcript for a different content hash', async () => {
    const a = makeDoc('old');
    const b = makeDoc('new');
    const { result, rerender } = renderHook(({ doc, key }) => useDocumentText(doc, key), {
      initialProps: { doc: a.doc, key: 'old-hash' },
    });
    await waitFor(() => expect(result.current.ready).toBe(true));
    rerender({ doc: b.doc, key: 'new-hash' });
    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(result.current.pages[0]?.text).toBe('new 学习'));
  });
});

it('keeps a complete long-document index when search is closed and reopened', async () => {
  const getTextContent = vi.fn(async () => ({ items: [{ str: 'text' }] }));
  const doc = {
    numPages: 200,
    getPage: vi.fn(async () => ({ getTextContent })),
  } as unknown as PDFDocumentProxy;
  const hook = renderHook(({ enabled }) => usePdfSearch(doc, enabled), {
    initialProps: { enabled: true },
  });
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  hook.rerender({ enabled: false });
  hook.rerender({ enabled: true });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  expect(getTextContent).toHaveBeenCalledTimes(200);
});

function deferredContent() {
  let resolve!: (value: { items: { str: string }[] }) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<{ items: { str: string }[] }>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

it('retries a failed search build on close/reopen and retains the recovered index', async () => {
  vi.useFakeTimers();
  try {
    const failed = deferredContent();
    const recovered = deferredContent();
    const getTextContent = vi
      .fn()
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(recovered.promise);
    const doc = {
      numPages: 1,
      getPage: vi.fn(async () => ({ getTextContent })),
    } as unknown as PDFDocumentProxy;
    const hook = renderHook(({ enabled }) => usePdfSearch(doc, enabled), {
      initialProps: { enabled: true },
    });
    act(() => hook.result.current.setQuery('recovered'));
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(getTextContent).toHaveBeenCalledTimes(1);
    await act(async () => {
      failed.reject(new Error('temporary extraction failure'));
      await vi.runAllTimersAsync();
    });
    expect(hook.result.current.status).toBe('ready');
    expect(hook.result.current.hits).toEqual([]);
    hook.rerender({ enabled: false });
    expect(hook.result.current.status).toBe('idle');
    hook.rerender({ enabled: true });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(getTextContent).toHaveBeenCalledTimes(2);
    await act(async () => {
      recovered.resolve({ items: [{ str: 'recovered text' }] });
      await vi.runAllTimersAsync();
    });
    // The ready-index render installs the query debounce after the extraction act commits.
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(hook.result.current.hits).toEqual([
      { page: 1, start: 0, end: 9, snippet: 'recovered', ordinal: 0 },
    ]);
    hook.rerender({ enabled: false });
    hook.rerender({ enabled: true });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(getTextContent).toHaveBeenCalledTimes(2);
    expect(hook.result.current.hits[0]?.snippet).toBe('recovered');
  } finally {
    vi.useRealTimers();
  }
});

it.each(['before', 'after'] as const)(
  'isolates a replacement document when old extraction completes %s the replacement',
  async (completionOrder) => {
    vi.useFakeTimers();
    try {
      const oldContent = deferredContent();
      const newContent = deferredContent();
      const oldGetPage = vi.fn(async () => ({ getTextContent: () => oldContent.promise }));
      const newGetPage = vi.fn(async () => ({ getTextContent: () => newContent.promise }));
      const oldDoc = { numPages: 2, getPage: oldGetPage } as unknown as PDFDocumentProxy;
      const newDoc = { numPages: 1, getPage: newGetPage } as unknown as PDFDocumentProxy;
      const hook = renderHook(({ doc }) => usePdfSearch(doc, true), {
        initialProps: { doc: oldDoc },
      });
      act(() => hook.result.current.setQuery('document'));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(oldGetPage).toHaveBeenCalledTimes(1);
      hook.rerender({ doc: newDoc });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(hook.result.current.status).toBe('indexing');
      expect(hook.result.current.hits).toEqual([]);
      expect(hook.result.current.total).toBe(1);
      const finishOld = async () => {
        await act(async () => {
          oldContent.resolve({ items: [{ str: 'OLD DOCUMENT' }] });
          await vi.runAllTimersAsync();
        });
      };
      if (completionOrder === 'before') {
        await finishOld();
        expect(hook.result.current.status).toBe('indexing');
        expect(hook.result.current.scanned).toBe(0);
        expect(hook.result.current.hits).toEqual([]);
      }
      await act(async () => {
        newContent.resolve({ items: [{ str: 'new document' }] });
        await vi.runAllTimersAsync();
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      if (completionOrder === 'after') await finishOld();
      expect(hook.result.current.status).toBe('ready');
      expect(hook.result.current.hits).toEqual([
        { page: 1, start: 4, end: 12, snippet: 'document', ordinal: 0 },
      ]);
      expect(hook.result.current.scanned).toBe(1);
      expect(hook.result.current.total).toBe(1);
      expect(oldGetPage).toHaveBeenCalledTimes(1);
      expect(newGetPage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  },
);
