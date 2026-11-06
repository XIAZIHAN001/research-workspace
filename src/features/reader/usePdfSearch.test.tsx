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
