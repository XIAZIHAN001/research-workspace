/**
 * The write-ahead journal for a restore.
 *
 * LocalStorage and IndexedDB cannot participate in one transaction, so a restore that touches
 * both has a window in which it can stop halfway. The journal is written before the first
 * change and holds, for every key the restore will touch, the value that key had before it and
 * a digest of the value it is supposed to have afterwards. That is enough to tell the next
 * start what happened:
 *
 * - every key already holds the new value → the restore finished; only the cleanup was lost;
 * - every key still holds the old value → nothing was applied;
 * - a mixture → write the old values back.
 *
 * It lives in IndexedDB rather than LocalStorage because duplicating the workspace inside the
 * same quota it is about to fill is exactly the wrong place for a recovery copy.
 */

const DB_NAME = 'rw.restore';
const DB_VERSION = 1;
const STORE = 'journal';
const KEY = 'current';

export interface RestoreJournalEntry {
  previous: string | null;
  nextSha256: string;
}

export interface RestoreJournal {
  id: string;
  startedAt: number;
  keys: Record<string, RestoreJournalEntry>;
  /**
   * Set only after every written key has been read back and verified.
   *
   * A committed journal describes a finished restore whose cleanup was lost. It must never be
   * treated as half-written: rolling it back would undo a restore the reader was told succeeded.
   */
  committed?: boolean;
}

export interface RestoreJournalStore {
  read: () => Promise<RestoreJournal | null>;
  write: (journal: RestoreJournal) => Promise<void>;
  clear: () => Promise<void>;
}

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('无法打开恢复日志。'));
    };
    request.onblocked = () => {
      reject(new Error('另一个标签页正在使用本地存储，恢复日志打不开。'));
    };
  });
}

function run<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, mode);
    const request = work(transaction.objectStore(STORE));
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
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    // The journal is what makes a restore recoverable. Resolving on request success would let
    // the restore start writing data before the journal itself is durable.
    request.onsuccess = () => {
      result = request.result;
    };
    request.onerror = () => {
      fail(request.error ?? new Error('恢复日志读写失败。'));
    };
    transaction.oncomplete = succeed;
    transaction.onerror = () => {
      fail(transaction.error ?? new Error('恢复日志事务失败。'));
    };
    transaction.onabort = () => {
      fail(transaction.error ?? new Error('恢复日志事务被中止。'));
    };
  });
}

function isJournal(value: unknown): value is RestoreJournal {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.startedAt !== 'number') return false;
  if (typeof record.keys !== 'object' || record.keys === null) return false;
  return Object.values(record.keys as Record<string, unknown>).every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      ((entry as Record<string, unknown>).previous === null ||
        typeof (entry as Record<string, unknown>).previous === 'string') &&
      typeof (entry as Record<string, unknown>).nextSha256 === 'string',
  );
}

/** Reading `indexedDB` can throw (sandboxed frames, a blocked-storage context); this cannot. */
function availableFactory(): IDBFactory | undefined {
  try {
    return globalThis.indexedDB ?? undefined;
  } catch {
    return undefined;
  }
}

export function createIndexedDbJournal(
  factory: IDBFactory | undefined = availableFactory(),
): RestoreJournalStore {
  let connection: Promise<IDBDatabase> | null = null;
  const database = (): Promise<IDBDatabase> => {
    if (factory === undefined) return Promise.reject(new Error('IndexedDB 不可用。'));
    connection ??= open(factory).catch((error: unknown) => {
      connection = null;
      throw error;
    });
    return connection;
  };

  return {
    async read() {
      const db = await database();
      const value = await run<unknown>(db, 'readonly', (store) => store.get(KEY));
      return isJournal(value) ? value : null;
    },
    async write(journal) {
      const db = await database();
      await run(db, 'readwrite', (store) => store.put(journal, KEY));
    },
    async clear() {
      const db = await database();
      await run(db, 'readwrite', (store) => store.delete(KEY));
    },
  };
}
