/**
 * The write-ahead journal for a restore.
 *
 * LocalStorage and IndexedDB cannot participate in one transaction, so a restore that touches
 * both has a window in which it can stop halfway. The journal is written before the first
 * change and holds, for every key the restore will touch, the value that key had before it and
 * a digest of the value it is supposed to have afterwards. PDF intent and completed additions
 * let recovery account for file writes as well as LocalStorage changes.
 *
 * It lives in IndexedDB rather than LocalStorage because duplicating the workspace inside the
 * same quota it is about to fill is exactly the wrong place for a recovery copy. Unrecognised
 * journals are preserved and reported, never silently interpreted as "nothing to recover".
 */

const DB_NAME = 'rw.restore';
const DB_VERSION = 1;
const STORE = 'journal';
const KEY = 'current';
const OPEN_TIMEOUT_MS = 5_000;
const MAX_KEYS = 64;
const MAX_PDFS = 10_000;
/** Bound the retained LocalStorage strings to 16 MiB of UTF-16 code units. */
const MAX_PREVIOUS_BYTES = 16 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

// Only the keys restoreWorkspace actually writes may ever be used for automatic rollback.
// Keep this allowlist aligned with its data/preference writes and RECOVERY_KEYS. Recovery
// copies may use only the three collision slots restoreWorkspace allocates, not arbitrary rw.*.
const RESTORE_KEYS: ReadonlySet<string> = new Set([
  'rw.projects',
  'rw.knowledge',
  'rw.difficulties',
  'rw.theme',
  'rw.paper',
  'rw.avatar',
  'rw.difficulties.prefs',
  'rw.review',
  ...[
    'rw.projects.backup',
    'rw.projects.backup.2',
    'rw.projects.backup.3',
    'rw.projects.corrupt',
    'rw.projects.corrupt.2',
    'rw.projects.corrupt.3',
    'rw.knowledge.corrupt',
  ].flatMap((key) => [key, `${key}.restored`, `${key}.restored.1`, `${key}.restored.2`]),
]);
const JOURNAL_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'startedAt',
  'keys',
  'committed',
  'phase',
  'pdfsAdded',
  'pdfsPending',
]);

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
  /** Prepared journals have not started LocalStorage writes, even if all keys already match. */
  phase?: 'prepared' | 'data';
  /** Files confirmed to have been newly added by this restore, never pre-existing files. */
  pdfsAdded?: string[];
  /** Write-ahead intent for new files whose write outcome may still be unknown after a crash. */
  pdfsPending?: string[];
}

export type RestoreJournalFailure = 'corrupt' | 'unavailable' | 'read' | 'write' | 'blocked';

export class RestoreJournalError extends Error {
  readonly reason: RestoreJournalFailure;

  constructor(reason: RestoreJournalFailure, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'RestoreJournalError';
    this.reason = reason;
  }
}

export interface RestoreJournalStore {
  read: () => Promise<RestoreJournal | null>;
  write: (journal: RestoreJournal) => Promise<void>;
  clear: () => Promise<void>;
}

function corrupt(): never {
  throw new RestoreJournalError(
    'corrupt',
    '恢复日志损坏或格式不受支持，已保留原始日志，请勿继续恢复。',
  );
}

/** Reject inherited fields, symbols and accessors before reading any recovery instructions. */
function assertPlainRecord(
  value: unknown,
  maxFields: number,
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) corrupt();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) corrupt();
  const keys = Reflect.ownKeys(value);
  if (keys.length > maxFields) corrupt();
  for (const key of keys) {
    if (typeof key !== 'string') corrupt();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) corrupt();
  }
}

function assertPdfHashes(value: unknown): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_PDFS ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    corrupt();
  // A dense array has exactly its indices plus the built-in length property. Inspect each
  // descriptor rather than invoking an accessor or a caller-provided iterator.
  if (Reflect.ownKeys(value).length !== value.length + 1) corrupt();
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) corrupt();
    const hash: unknown = descriptor.value;
    if (typeof hash !== 'string' || !SHA256.test(hash) || seen.has(hash)) corrupt();
    seen.add(hash);
  }
}

/** Validate both persisted journals and journal implementations supplied by callers. */
export function assertRestoreJournal(value: unknown): asserts value is RestoreJournal {
  assertPlainRecord(value, JOURNAL_FIELDS.size);
  if (Object.keys(value).some((field) => !JOURNAL_FIELDS.has(field))) corrupt();
  if (typeof value.id !== 'string' || value.id.trim().length === 0 || value.id.length > 128)
    corrupt();
  if (
    typeof value.startedAt !== 'number' ||
    !Number.isSafeInteger(value.startedAt) ||
    value.startedAt <= 0
  )
    corrupt();
  if (Object.hasOwn(value, 'committed') && typeof value.committed !== 'boolean') corrupt();
  if (Object.hasOwn(value, 'phase') && value.phase !== 'prepared' && value.phase !== 'data')
    corrupt();
  for (const field of ['pdfsAdded', 'pdfsPending']) {
    if (Object.hasOwn(value, field)) assertPdfHashes(value[field]);
  }
  assertPlainRecord(value.keys, MAX_KEYS);
  const entries = Object.entries(value.keys);
  let previousBytes = 0;
  for (const [key, entry] of entries) {
    if (!RESTORE_KEYS.has(key)) corrupt();
    assertPlainRecord(entry, 2);
    if (
      Object.keys(entry).length !== 2 ||
      !Object.hasOwn(entry, 'previous') ||
      !Object.hasOwn(entry, 'nextSha256')
    )
      corrupt();
    if (entry.previous !== null && typeof entry.previous !== 'string') corrupt();
    if (typeof entry.nextSha256 !== 'string' || !SHA256.test(entry.nextSha256)) corrupt();
    previousBytes += entry.previous === null ? 0 : entry.previous.length * 2;
    if (previousBytes > MAX_PREVIOUS_BYTES) corrupt();
  }
}

function open(factory: IDBFactory, onClosed: () => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      fail(new RestoreJournalError('blocked', '打开恢复日志超时，请关闭其他标签页后重试。'));
    }, OPEN_TIMEOUT_MS);
    const fail = (error: RestoreJournalError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch (error) {
      fail(new RestoreJournalError('unavailable', '无法打开恢复日志。', error));
      return;
    }
    request.onupgradeneeded = () => {
      // An open cannot be cancelled, but it must not retain a connection or apply an upgrade
      // after the caller has already been told that opening failed.
      if (settled) {
        request.transaction?.abort();
        request.result.close();
        return;
      }
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
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
        onClosed();
      };
      database.onclose = onClosed;
      resolve(database);
    };
    request.onerror = () => {
      fail(new RestoreJournalError('unavailable', '无法打开恢复日志。', request.error));
    };
    request.onblocked = () => {
      fail(new RestoreJournalError('blocked', '另一个标签页正在使用本地存储，恢复日志打不开。'));
    };
  });
}

function run<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction | undefined;
    let result!: T;
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(
        new RestoreJournalError(
          mode === 'readonly' ? 'read' : 'write',
          '恢复日志读写失败。',
          error,
        ),
      );
    };
    try {
      transaction = database.transaction(STORE, mode);
      // The journal is what makes a restore recoverable. Resolve only after the transaction,
      // not its request, succeeds so callers cannot change workspace data before durability.
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      transaction.onerror = () => fail(transaction?.error);
      transaction.onabort = () => fail(transaction?.error);
      const request = work(transaction.objectStore(STORE));
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => fail(request.error);
    } catch (error) {
      try {
        transaction?.abort();
      } catch {
        // The transaction may already have finished; preserve the original failure.
      }
      fail(error);
    }
  });
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
    if (factory === undefined)
      return Promise.reject(new RestoreJournalError('unavailable', 'IndexedDB 不可用。'));
    if (connection === null) {
      const pending = open(factory, () => {
        if (connection === pending) connection = null;
      }).catch((error: unknown) => {
        if (connection === pending) connection = null;
        throw error;
      });
      connection = pending;
    }
    return connection;
  };

  return {
    async read() {
      const db = await database();
      let exists = false;
      const value = await run<unknown>(db, 'readonly', (store) => {
        // get() returns undefined for both a missing key and a stored undefined value. Read
        // presence in the same transaction, so only true absence can bypass validation.
        const key = store.getKey(KEY);
        key.onsuccess = () => {
          exists = key.result !== undefined;
        };
        return store.get(KEY);
      });
      if (!exists) return null;
      assertRestoreJournal(value);
      return value;
    },
    async write(journal) {
      assertRestoreJournal(journal);
      const db = await database();
      // Opening is asynchronous; a caller may have changed the same object while it waited.
      assertRestoreJournal(journal);
      await run(db, 'readwrite', (store) => store.put(journal, KEY));
    },
    async clear() {
      const db = await database();
      await run(db, 'readwrite', (store) => store.delete(KEY));
    },
  };
}
