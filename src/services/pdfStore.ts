import { sha256Hex } from './hash';
import { workspaceAccess, type WorkspaceWritePermit } from './workspaceAccess';
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
  put(sha256: string, bytes: PdfBytes, permit?: WorkspaceWritePermit): Promise<void>;
  remove(sha256: string, permit?: WorkspaceWritePermit): Promise<void>;
  /** Durable retry queue, containing only hashes proven absent before a restore write. */
  queueCleanup?(hashes: readonly string[], permit?: WorkspaceWritePermit): Promise<void>;
  /** Small, exclusive batches. Null references mean unknown, never an empty registry. */
  collectGarbage?(
    readReferences: () => ReadonlySet<string> | null,
  ): Promise<{ removed: number; more: boolean }>;
  /** Browser storage estimate, when the platform offers one. */
  usage(): Promise<{ used: number; quota: number } | null>;
}

const DB_NAME = 'rw.pdfs';
const STORE_NAME = 'files';
const DB_VERSION = 2;
const GC_STORE = 'restore-gc';
const GC_BATCH = 1;

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

function openDatabase(factory: IDBFactory, invalidate: () => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => fail(new PdfStoreError('unavailable', 'PDF 文件库打开超时。')),
      5000,
    );
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(toStoreError(error));
    };
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch (error) {
      fail(error);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
      if (!database.objectStoreNames.contains(GC_STORE)) database.createObjectStore(GC_STORE);
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      database.onversionchange = () => {
        database.close();
        invalidate();
      };
      resolve(database);
    };
    request.onerror = () => {
      fail(request.error);
    };
    request.onblocked = () => {
      fail(new PdfStoreError('unavailable', '另一个标签页正在使用本地文件库，请关闭后重试。'));
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
    connection ??= openDatabase(factory, () => {
      connection = null;
    }).catch((error: unknown) => {
      connection = null;
      throw toStoreError(error);
    });
    return connection;
  };

  async function run<T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => IDBRequest<T>,
    storeName = STORE_NAME,
  ): Promise<T> {
    try {
      const db = await database();
      return await new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const request = work(transaction.objectStore(storeName));
        let result!: T;
        let settled = false;
        const succeed = (): void => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        const fail = (error: unknown): void => {
          if (settled) return;
          settled = true;
          reject(toStoreError(error));
        };
        // A request succeeding is not a transaction committing. The caller writes the paper
        // reference (import) or the next restore step only after this promise resolves, so a
        // later abort must not look like success.
        request.onsuccess = () => {
          result = request.result;
        };
        request.onerror = () => {
          fail(request.error ?? new Error('PDF 文件库读写失败。'));
        };
        transaction.oncomplete = succeed;
        transaction.onerror = () => {
          fail(transaction.error ?? new Error('PDF 文件库事务失败。'));
        };
        transaction.onabort = () => {
          fail(transaction.error ?? new Error('PDF 文件库事务已中止。'));
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

    async put(sha256, bytes, permit) {
      // A copy, so the caller (pdf.js in particular) may transfer or detach its buffer.
      const record: StoredFile = { sha256, bytes: bytes.slice(), savedAt: Date.now() };
      await workspaceAccess.writeAsync(
        () => run('readwrite', (store) => store.put(record, sha256)),
        permit,
      );
    },

    async remove(sha256, permit) {
      await workspaceAccess.writeAsync(
        () => run('readwrite', (store) => store.delete(sha256)),
        permit,
      );
    },

    async queueCleanup(hashes, permit) {
      if (hashes.length > 10_000 || hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
        throw new Error('PDF 清理任务无效。');
      }
      await workspaceAccess.writeAsync(async () => {
        const existing = await run(
          'readonly',
          (store) => store.getAllKeys(undefined, 10_001),
          GC_STORE,
        );
        if (existing.length > 10_000 || new Set([...existing, ...hashes]).size > 10_000) {
          throw new Error('PDF 清理任务过多，已保留恢复日志。');
        }
        for (const hash of new Set(hashes)) {
          await run('readwrite', (store) => store.put({ queuedAt: Date.now() }, hash), GC_STORE);
        }
      }, permit);
    },

    async collectGarbage(readReferences) {
      if (workspaceAccess.canWrite()) throw new Error('PDF 垃圾回收只能在启动检查期间运行。');
      return workspaceAccess.exclusive(async (permit) => {
        const candidates = await run(
          'readonly',
          (store) => store.getAllKeys(undefined, GC_BATCH),
          GC_STORE,
        );
        let removed = 0;
        for (const candidate of candidates) {
          if (typeof candidate !== 'string' || !/^[a-f0-9]{64}$/.test(candidate)) {
            throw new Error('PDF 清理任务损坏，已保留文件。');
          }
          const references = readReferences();
          if (references === null) return { removed, more: false };
          if (!references.has(candidate)) {
            const stored = await run<StoredFile | undefined>('readonly', (store) =>
              store.get(candidate),
            );
            if (stored !== undefined && (await sha256Hex(stored.bytes)) !== candidate) {
              throw new Error('PDF 清理校验失败，已保留文件。');
            }
            // Read again after the asynchronous byte/hash check, immediately before deletion.
            const latest = readReferences();
            if (latest === null) return { removed, more: false };
            if (!latest.has(candidate) && stored !== undefined) {
              await workspaceAccess.writeAsync(
                () => run('readwrite', (store) => store.delete(candidate)),
                permit,
              );
              removed += 1;
            }
          }
          await workspaceAccess.writeAsync(
            () => run('readwrite', (store) => store.delete(candidate), GC_STORE),
            permit,
          );
        }
        return { removed, more: candidates.length === GC_BATCH };
      });
    },

    async usage() {
      const estimate = await globalThis.navigator?.storage?.estimate?.();
      if (estimate?.usage === undefined || estimate.quota === undefined) return null;
      return { used: estimate.usage, quota: estimate.quota };
    },
  };
}
