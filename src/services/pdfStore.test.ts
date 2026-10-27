import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PdfBytes } from '../domain/pdfFile';
import { createPdfBlobStore, PdfStoreError, type PdfBlobStore } from './pdfStore';

/** A fresh, isolated IndexedDB per test, so nothing leaks between cases. */
const freshFactory = (): IDBFactory => new IDBFactory();

const bytesOf = (text: string): PdfBytes => new TextEncoder().encode(text);

async function withStore<T>(run: (store: PdfBlobStore) => Promise<T>): Promise<T> {
  return run(createPdfBlobStore(freshFactory()));
}

/** An IndexedDB whose writes fail with `error`, to prove how failures are reported. */
function failingFactory(error: DOMException): IDBFactory {
  const erroringRequest = (): IDBRequest<unknown> => {
    const request = {
      error: null,
      onsuccess: null,
      onerror: null,
    } as unknown as IDBRequest<unknown>;
    queueMicrotask(() => {
      Object.assign(request, { error });
      (request.onerror as ((this: IDBRequest, ev: Event) => unknown) | null)?.call(
        request,
        new Event('error'),
      );
    });
    return request;
  };
  const database = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const transaction = {
        objectStore: () => ({
          put: erroringRequest,
          get: erroringRequest,
          getKey: erroringRequest,
          delete: erroringRequest,
        }),
        error,
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
      };
      // A failed write aborts the transaction as well as failing its request; the store now
      // waits for the transaction to settle before reporting an outcome.
      queueMicrotask(() => {
        queueMicrotask(() => {
          transaction.onerror?.();
          transaction.onabort?.();
        });
      });
      return transaction;
    },
  } as unknown as IDBDatabase;
  return {
    open: () => {
      const request = {
        result: database,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
      } as unknown as IDBOpenDBRequest;
      queueMicrotask(() => {
        (request.onsuccess as ((this: IDBRequest, ev: Event) => unknown) | null)?.call(
          request,
          new Event('success'),
        );
      });
      return request;
    },
  } as unknown as IDBFactory;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createPdfBlobStore: storing and reading files', () => {
  it('round-trips the exact bytes', async () => {
    await withStore(async (store) => {
      const bytes = bytesOf('%PDF-1.7 a small document');
      await store.put('a'.repeat(64), bytes);
      const loaded = await store.get('a'.repeat(64));
      expect(loaded).not.toBeNull();
      expect(Array.from(loaded ?? [])).toStrictEqual(Array.from(bytes));
    });
  });

  it('hands out a fresh copy each time, so a caller may detach its buffer', async () => {
    await withStore(async (store) => {
      await store.put('b'.repeat(64), bytesOf('content'));
      const first = await store.get('b'.repeat(64));
      const second = await store.get('b'.repeat(64));
      expect(first).not.toBe(second);
      expect(Array.from(second ?? [])).toStrictEqual(Array.from(first ?? []));
    });
  });

  it('returns null for a file it does not have', async () => {
    await withStore(async (store) => {
      expect(await store.get('c'.repeat(64))).toBeNull();
      expect(await store.has('c'.repeat(64))).toBe(false);
    });
  });

  it('reports presence after a write', async () => {
    await withStore(async (store) => {
      await store.put('d'.repeat(64), bytesOf('x'));
      expect(await store.has('d'.repeat(64))).toBe(true);
    });
  });

  it('keeps one record per content hash, whatever is written again', async () => {
    await withStore(async (store) => {
      const key = 'e'.repeat(64);
      await store.put(key, bytesOf('first'));
      await store.put(key, bytesOf('second'));
      const loaded = await store.get(key);
      expect(new TextDecoder().decode(loaded ?? new Uint8Array())).toBe('second');
    });
  });

  it('removes a file', async () => {
    await withStore(async (store) => {
      await store.put('f'.repeat(64), bytesOf('x'));
      await store.remove('f'.repeat(64));
      expect(await store.has('f'.repeat(64))).toBe(false);
    });
  });

  it('survives a second store over the same database', async () => {
    const factory = freshFactory();
    await createPdfBlobStore(factory).put('1'.repeat(64), bytesOf('persisted'));
    const reopened = await createPdfBlobStore(factory).get('1'.repeat(64));
    expect(new TextDecoder().decode(reopened ?? new Uint8Array())).toBe('persisted');
  });
});

describe('createPdfBlobStore: reporting storage problems', () => {
  it('says so instead of pretending, when IndexedDB is missing', async () => {
    const store = createPdfBlobStore(undefined);
    expect(store.durable).toBe(false);
    expect(await store.has('a'.repeat(64))).toBe(false);
    expect(await store.get('a'.repeat(64))).toBeNull();
    await expect(store.put('a'.repeat(64), bytesOf('x'))).rejects.toThrow(PdfStoreError);
    await expect(store.put('a'.repeat(64), bytesOf('x'))).rejects.toThrow(/不支持本地文件库/);
  });

  it('maps a full storage quota to a quota failure', async () => {
    const store = createPdfBlobStore(
      failingFactory(new DOMException('The quota has been exceeded.', 'QuotaExceededError')),
    );
    const error = await store.put('a'.repeat(64), bytesOf('x')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PdfStoreError);
    expect((error as PdfStoreError).failure).toBe('quota');
    expect((error as PdfStoreError).message).toContain('空间不足');
  });

  it('maps any other write failure to a generic storage failure', async () => {
    const store = createPdfBlobStore(
      failingFactory(new DOMException('The database is closing.', 'InvalidStateError')),
    );
    const error = await store.put('a'.repeat(64), bytesOf('x')).catch((e: unknown) => e);
    expect((error as PdfStoreError).failure).toBe('unknown');
  });

  it('reports the browser storage estimate when there is one', async () => {
    vi.stubGlobal('navigator', {
      storage: { estimate: () => Promise.resolve({ usage: 1024, quota: 4096 }) },
    });
    await withStore(async (store) => {
      expect(await store.usage()).toStrictEqual({ used: 1024, quota: 4096 });
    });
  });

  it('reports no estimate when the platform has none', async () => {
    vi.stubGlobal('navigator', {});
    await withStore(async (store) => {
      expect(await store.usage()).toBeNull();
    });
  });
});
