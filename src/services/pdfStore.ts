import type { PdfBytes } from '../domain/pdfFile';

/** What went wrong when talking to the PDF blob store. */
export type PdfStoreFailure = 'unavailable' | 'quota' | 'unknown';

/** Raised by the blob store; `failure` says which kind of problem it was. */
export class PdfStoreError extends Error {
  readonly failure: PdfStoreFailure;

  constructor(failure: PdfStoreFailure, message: string) {
    super(message);
    this.name = 'PdfStoreError';
    this.failure = failure;
  }
}

/**
 * Where PDF bytes live. Kept behind an interface so the import pipeline can be tested
 * without a browser database, and so a desktop build could swap the implementation.
 */
export interface PdfBlobStore {
  /** Whether a real browser database was reachable when the store was created. */
  readonly durable: boolean;
  has(sha256: string): Promise<boolean>;
  /** Returns a fresh copy of the stored bytes, or null when this file is not stored here. */
  get(sha256: string): Promise<PdfBytes | null>;
  put(sha256: string, bytes: PdfBytes): Promise<void>;
  remove(sha256: string): Promise<void>;
  /** Browser storage estimate, when the platform offers one. */
  usage(): Promise<{ used: number; quota: number } | null>;
}

const DB_NAME = 'rw.pdfs';
const STORE_NAME = 'files';
const DB_VERSION = 1;

interface StoredFile {
  sha256: string;
  bytes: PdfBytes;
  savedAt: number;
}

function safeIndexedDb(): IDBFactory | undefined {
  try {
    return globalThis.indexedDB ?? undefined;
  } catch {
    // Accessing indexedDB itself can throw in sandboxed frames.
    return undefined;
  }
}

/** The `name`/`code` a DOMException carries, without relying on its prototype chain. */
function errorName(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const { name } = error as { name?: unknown };
  return typeof name === 'string' ? name : '';
}

function isQuotaError(error: unknown): boolean {
  if (errorName(error) === 'QuotaExceededError') return true;
  // Older engines only set the legacy numeric code (22 = QUOTA_EXCEEDED_ERR).
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 22;
}

function describe(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { message } = error as { message?: unknown };
    if (typeof message === 'string' && message !== '') return message;
  }
  return String(error);
}

function toStoreError(error: unknown): PdfStoreError {
  if (error instanceof PdfStoreError) return error;
  if (isQuotaError(error)) {
    return new PdfStoreError('quota', '浏览器存储空间不足，文件没有保存。');
  }
  return new PdfStoreError('unknown', `PDF 文件存储失败：${describe(error)}`);
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(toStoreError(error));
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(toStoreError(request.error));
    };
    request.onblocked = () => {
      reject(new PdfStoreError('unavailable', '另一个标签页正在使用本地文件库，请关闭后重试。'));
    };
  });
}

/** A store that keeps nothing and says so, used when IndexedDB is missing. */
function unavailableStore(): PdfBlobStore {
  return {
    durable: false,
    has: () => Promise.resolve(false),
    get: () => Promise.resolve(null),
    put: () =>
      Promise.reject(
        new PdfStoreError('unavailable', '这个浏览器环境不支持本地文件库（IndexedDB 不可用）。'),
      ),
    remove: () => Promise.resolve(),
    usage: () => Promise.resolve(null),
  };
}

/**
 * IndexedDB-backed blob store, keyed by content hash: the same file stored twice occupies
 * one record, and `put` of identical bytes is a no-op for practical purposes.
 */
export function createPdfBlobStore(
  factory: IDBFactory | undefined = safeIndexedDb(),
): PdfBlobStore {
  if (factory === undefined) return unavailableStore();

  let connection: Promise<IDBDatabase> | null = null;
  const database = (): Promise<IDBDatabase> => {
    connection ??= openDatabase(factory).catch((error: unknown) => {
      connection = null;
      throw toStoreError(error);
    });
    return connection;
  };

  async function run<T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    try {
      const db = await database();
      return await new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, mode);
        const request = work(transaction.objectStore(STORE_NAME));
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(toStoreError(request.error));
        };
        transaction.onabort = () => {
          reject(toStoreError(transaction.error));
        };
      });
    } catch (error) {
      throw toStoreError(error);
    }
  }

  return {
    durable: true,

    async has(sha256) {
      const key = await run('readonly', (store) => store.getKey(sha256));
      return key !== undefined;
    },

    async get(sha256) {
      const stored = await run<StoredFile | undefined>('readonly', (store) => store.get(sha256));
      if (stored === undefined) return null;
      return stored.bytes;
    },

    async put(sha256, bytes) {
      // A copy, so the caller (pdf.js in particular) may transfer or detach its buffer.
      const record: StoredFile = { sha256, bytes: bytes.slice(), savedAt: Date.now() };
      await run('readwrite', (store) => store.put(record, sha256));
    },

    async remove(sha256) {
      await run('readwrite', (store) => store.delete(sha256));
    },

    async usage() {
      const estimate = await globalThis.navigator?.storage?.estimate?.();
      if (estimate?.usage === undefined || estimate.quota === undefined) return null;
      return { used: estimate.usage, quota: estimate.quota };
    },
  };
}
