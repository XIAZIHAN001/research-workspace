import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from './pdfjs';
import { useDocumentText } from './useDocumentText';
import { usePdfSearch } from './usePdfSearch';

it('closing one consumer does not cancel another or install late results after replacement', async () => {
  let finish!: (value: { items: { str: string }[] }) => void;
  const getTextContent = vi.fn(
    () =>
      new Promise<{ items: { str: string }[] }>((resolve) => {
        finish = resolve;
      }),
  );
  const old = {
    numPages: 2,
    getPage: vi.fn(async () => ({ getTextContent })),
  } as unknown as PDFDocumentProxy;
  const fresh = {
    numPages: 1,
    getPage: vi.fn(async () => ({ getTextContent: async () => ({ items: [{ str: 'fresh' }] }) })),
  } as unknown as PDFDocumentProxy;
  const reader = renderHook(
    ({ doc }: { doc: PDFDocumentProxy | null }) => useDocumentText(doc, 'same'),
    { initialProps: { doc: old as PDFDocumentProxy | null } },
  );
  const search = renderHook(() => usePdfSearch(old, true));
  await waitFor(() => expect(getTextContent).toHaveBeenCalledTimes(1));
  reader.rerender({ doc: null });
  expect(reader.result.current).toEqual({ ready: false, pages: [] });
  reader.rerender({ doc: fresh });
  await waitFor(() => expect(reader.result.current.pages[0]?.text).toBe('fresh'));
  // Search still needs the pending old page; closing the transcript consumer must not abort it.
  await act(async () => finish({ items: [{ str: 'old' }] }));
  await waitFor(() => expect(getTextContent).toHaveBeenCalledTimes(2));
  await act(async () => finish({ items: [{ str: 'second' }] }));
  await waitFor(() => expect(search.result.current.status).toBe('ready'));
  expect(reader.result.current.pages[0]?.text).toBe('fresh');
  expect(old.getPage).toHaveBeenCalledTimes(2);
  search.unmount();
  reader.unmount();
});

it('reuses a bounded transcript when the same validated hash reopens through a new proxy', async () => {
  const getPage = vi.fn(async () => ({
    getTextContent: async () => ({ items: [{ str: 'same bytes' }] }),
  }));
  const a = { numPages: 1, getPage } as unknown as PDFDocumentProxy;
  const b = { numPages: 1, getPage } as unknown as PDFDocumentProxy;
  const first = renderHook(() => useDocumentText(a, 'reopened-hash'));
  await waitFor(() => expect(first.result.current.ready).toBe(true));
  first.unmount();
  const second = renderHook(() => useDocumentText(b, 'reopened-hash'));
  expect(second.result.current.pages[0]?.text).toBe('same bytes');
  expect(second.result.current.ready).toBe(true);
  expect(getPage).toHaveBeenCalledTimes(1);
});

it('does not persist a partial failed transcript across reopen', async () => {
  const getTextContent = vi
    .fn()
    .mockRejectedValueOnce(new Error('temporary'))
    .mockResolvedValue({ items: [{ str: 'recovered' }] });
  const doc = {
    numPages: 1,
    getPage: vi.fn(async () => ({ getTextContent })),
  } as unknown as PDFDocumentProxy;
  const first = renderHook(() => useDocumentText(doc, 'retry-hash'));
  await waitFor(() => expect(first.result.current.ready).toBe(true));
  expect(first.result.current.pages).toEqual([]);
  first.unmount();
  const second = renderHook(() => useDocumentText(doc, 'retry-hash'));
  await waitFor(() => expect(second.result.current.pages[0]?.text).toBe('recovered'));
  expect(getTextContent).toHaveBeenCalledTimes(2);
});

it('reuses a compact 200-page transcript after reopening the same hash', async () => {
  const getPage = vi.fn(async () => ({
    getTextContent: async () => ({ items: [{ str: 'compact thesis' }] }),
  }));
  const a = { numPages: 200, getPage } as unknown as PDFDocumentProxy;
  const first = renderHook(() => useDocumentText(a, 'thesis-hash'));
  await waitFor(() => expect(first.result.current.ready).toBe(true));
  first.unmount();
  const b = { numPages: 200, getPage } as unknown as PDFDocumentProxy;
  const second = renderHook(() => useDocumentText(b, 'thesis-hash'));
  expect(second.result.current.ready).toBe(true);
  expect(getPage).toHaveBeenCalledTimes(200);
});
