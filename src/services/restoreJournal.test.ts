import { IDBFactory, IDBObjectStore as FakeObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertRestoreJournal,
  createIndexedDbJournal,
  RestoreJournalError,
  type RestoreJournal,
} from './restoreJournal';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function validJournal(): RestoreJournal {
  return {
    id: 'crash',
    startedAt: 1,
    keys: { 'rw.projects': { previous: 'previous data', nextSha256: SHA_A } },
  };
}

async function rawDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open('rw.restore', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('journal');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeRaw(factory: IDBFactory, value: unknown): Promise<void> {
  const database = await rawDatabase(factory);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('journal', 'readwrite');
      transaction.objectStore('journal').put(value, 'current');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

async function readRaw(factory: IDBFactory): Promise<unknown> {
  const database = await rawDatabase(factory);
  try {
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction('journal', 'readonly')
        .objectStore('journal')
        .get('current');
      request.onsuccess = () => resolve(request.result as unknown);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

const invalidJournals: { name: string; value: unknown }[] = [
  { name: 'null', value: null },
  { name: 'a scalar', value: 'journal' },
  { name: 'an array', value: [] },
  { name: 'a missing id', value: { startedAt: 1, keys: {} } },
  { name: 'an empty id', value: { ...validJournal(), id: '' } },
  { name: 'a whitespace id', value: { ...validJournal(), id: '  ' } },
  { name: 'an oversized id', value: { ...validJournal(), id: 'x'.repeat(129) } },
  ...[0, -1, 1.1, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((startedAt) => ({
    name: `an invalid timestamp ${String(startedAt)}`,
    value: { ...validJournal(), startedAt },
  })),
  { name: 'null keys', value: { ...validJournal(), keys: null } },
  { name: 'array keys', value: { ...validJournal(), keys: [] } },
  {
    name: 'an unknown storage key',
    value: { ...validJournal(), keys: { 'rw.unrelated': { previous: null, nextSha256: SHA_A } } },
  },
  {
    name: 'a prototype storage key',
    value: {
      ...validJournal(),
      keys: JSON.parse(`{"__proto__":{"previous":null,"nextSha256":"${SHA_A}"}}`) as unknown,
    },
  },
  {
    name: 'an unbounded recovery suffix',
    value: {
      ...validJournal(),
      keys: { 'rw.projects.corrupt.restored.3': { previous: null, nextSha256: SHA_A } },
    },
  },
  {
    name: 'too many keys',
    value: {
      ...validJournal(),
      keys: Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [
          `rw.projects.backup.restored.${String(index)}`,
          { previous: null, nextSha256: SHA_A },
        ]),
      ),
    },
  },
  { name: 'a null entry', value: { ...validJournal(), keys: { 'rw.projects': null } } },
  { name: 'an array entry', value: { ...validJournal(), keys: { 'rw.projects': [] } } },
  {
    name: 'a missing previous value',
    value: { ...validJournal(), keys: { 'rw.projects': { nextSha256: SHA_A } } },
  },
  {
    name: 'a non-string previous value',
    value: { ...validJournal(), keys: { 'rw.projects': { previous: 1, nextSha256: SHA_A } } },
  },
  ...['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)].map((nextSha256) => ({
    name: `an invalid digest ${nextSha256 || '(empty)'}`,
    value: { ...validJournal(), keys: { 'rw.projects': { previous: null, nextSha256 } } },
  })),
  {
    name: 'an unknown entry field',
    value: {
      ...validJournal(),
      keys: { 'rw.projects': { previous: null, nextSha256: SHA_A, extra: true } },
    },
  },
  { name: 'an unknown top-level field', value: { ...validJournal(), extra: true } },
  ...[null, undefined, 'complete', '', 1, {}].map((phase) => ({
    name: `an invalid phase ${String(phase)}`,
    value: { ...validJournal(), phase },
  })),
  ...[null, undefined, 'true', 1].map((committed) => ({
    name: `an invalid committed value ${String(committed)}`,
    value: { ...validJournal(), committed },
  })),
  ...['pdfsAdded', 'pdfsPending'].flatMap((field) =>
    [null, undefined, {}, [SHA_A, SHA_A], ['short'], [1], Array<string>(1)].map((value, index) => ({
      name: `invalid ${field} case ${String(index)}`,
      value: { ...validJournal(), [field]: value },
    })),
  ),
];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('restore journal validation', () => {
  it('returns null only when IndexedDB has no journal value', async () => {
    await expect(createIndexedDbJournal(new IDBFactory()).read()).resolves.toBeNull();
  });

  it('rejects a present undefined record without erasing it or treating it as absent', async () => {
    const factory = new IDBFactory();
    await storeRaw(factory, undefined);
    const store = createIndexedDbJournal(factory);
    await expect(store.read()).rejects.toMatchObject({ reason: 'corrupt' });
    const database = await rawDatabase(factory);
    try {
      const key = await new Promise((resolve, reject) => {
        const request = database
          .transaction('journal', 'readonly')
          .objectStore('journal')
          .getKey('current');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      expect(key).toBe('current');
    } finally {
      database.close();
    }
    await expect(store.read()).rejects.toMatchObject({ reason: 'corrupt' });
  });

  it('round-trips valid legacy and PDF-aware journals', async () => {
    const factory = new IDBFactory();
    const store = createIndexedDbJournal(factory);
    await store.write(validJournal());
    await expect(store.read()).resolves.toEqual(validJournal());
    const journal = {
      ...validJournal(),
      committed: false,
      pdfsAdded: [SHA_A],
      pdfsPending: [SHA_B],
    };
    await store.write(journal);
    await expect(store.read()).resolves.toEqual(journal);
    await store.clear();
    await expect(store.read()).resolves.toBeNull();
  });

  it.each(['prepared', 'data'] as const)('round-trips the %s recovery phase', async (phase) => {
    const store = createIndexedDbJournal(new IDBFactory());
    const journal = { ...validJournal(), phase, pdfsAdded: [], pdfsPending: [] };
    await store.write(journal);
    await expect(store.read()).resolves.toEqual(journal);
  });

  it.each(invalidJournals)(
    'rejects stored $name without clearing the evidence',
    async ({ value }) => {
      const factory = new IDBFactory();
      await storeRaw(factory, value);
      await expect(createIndexedDbJournal(factory).read()).rejects.toMatchObject({
        reason: 'corrupt',
      });
      expect(await readRaw(factory)).toEqual(value);
    },
  );

  it.each(invalidJournals)(
    'rejects writing $name without replacing a valid journal',
    async ({ value }) => {
      const factory = new IDBFactory();
      const store = createIndexedDbJournal(factory);
      await store.write(validJournal());
      await expect(store.write(value as RestoreJournal)).rejects.toMatchObject({
        reason: 'corrupt',
      });
      expect(await readRaw(factory)).toEqual(validJournal());
    },
  );

  it('accepts every restore data key and bounded recovery-copy suffix', async () => {
    const primary = [
      'rw.projects',
      'rw.knowledge',
      'rw.difficulties',
      'rw.theme',
      'rw.paper',
      'rw.avatar',
      'rw.difficulties.prefs',
      'rw.review',
    ];
    const recovery = [
      'rw.projects.backup',
      'rw.projects.backup.2',
      'rw.projects.backup.3',
      'rw.projects.corrupt',
      'rw.projects.corrupt.2',
      'rw.projects.corrupt.3',
      'rw.knowledge.corrupt',
    ];
    const keys = [
      ...primary,
      ...recovery.flatMap((key) => [
        key,
        `${key}.restored`,
        `${key}.restored.1`,
        `${key}.restored.2`,
      ]),
    ];
    const journal = {
      ...validJournal(),
      keys: Object.fromEntries(keys.map((key) => [key, { previous: null, nextSha256: SHA_A }])),
    };
    const store = createIndexedDbJournal(new IDBFactory());
    await store.write(journal);
    await expect(store.read()).resolves.toEqual(journal);
  });

  it('rejects custom prototypes and accessors before invoking or cloning them', async () => {
    const accessor = vi.fn(() => 'crash');
    const withAccessor = { ...validJournal() };
    Object.defineProperty(withAccessor, 'id', { enumerable: true, get: accessor });
    const withHidden = { ...validJournal() };
    Object.defineProperty(withHidden, 'hidden', { value: true });
    const unsafe = [
      Object.assign(Object.create({ inherited: true }) as object, validJournal()),
      {
        ...validJournal(),
        keys: Object.create({ 'rw.projects': { previous: null, nextSha256: SHA_A } }) as unknown,
      },
      {
        ...validJournal(),
        keys: {
          'rw.projects': Object.assign(Object.create({ extra: true }) as object, {
            previous: null,
            nextSha256: SHA_A,
          }),
        },
      },
      withAccessor,
      withHidden,
      { ...validJournal(), [Symbol('hidden')]: true },
    ];
    const store = createIndexedDbJournal(new IDBFactory());
    for (const journal of unsafe) {
      await expect(store.write(journal as RestoreJournal)).rejects.toMatchObject({
        reason: 'corrupt',
      });
    }
    expect(accessor).not.toHaveBeenCalled();
    await expect(store.read()).resolves.toBeNull();
  });

  it('exposes the same strict validator to caller-supplied journal stores', () => {
    expect(() => assertRestoreJournal(validJournal())).not.toThrow();
    expect(() => assertRestoreJournal(null)).toThrow(RestoreJournalError);
    expect(() => assertRestoreJournal({ ...validJournal(), keys: [] })).toThrow(
      RestoreJournalError,
    );
  });

  it.each(['pdfsAdded', 'pdfsPending'])(
    'rejects unexpected %s array properties and accessors',
    async (field) => {
      const accessor = vi.fn(() => SHA_A);
      const withAccessor = [SHA_A];
      Object.defineProperty(withAccessor, '0', { enumerable: true, get: accessor });
      const withPrototype = [SHA_A];
      Object.setPrototypeOf(withPrototype, Object.create(Array.prototype) as object);
      const malformed = [
        Object.assign([SHA_A], { extra: true }),
        Object.assign([SHA_A], { [Symbol('hidden')]: true }),
        withAccessor,
        withPrototype,
      ];
      const store = createIndexedDbJournal(new IDBFactory());
      for (const hashes of malformed) {
        await expect(store.write({ ...validJournal(), [field]: hashes })).rejects.toMatchObject({
          reason: 'corrupt',
        });
      }
      expect(accessor).not.toHaveBeenCalled();
      await expect(store.read()).resolves.toBeNull();
    },
  );

  it('revalidates a journal changed while its connection is opening', async () => {
    const store = createIndexedDbJournal(new IDBFactory());
    const journal = validJournal();
    const writing = store.write(journal);
    journal.id = '';
    await expect(writing).rejects.toMatchObject({ reason: 'corrupt' });
    await expect(store.read()).resolves.toBeNull();
  });

  it('bounds total previous values to 16 MiB of UTF-16 storage', async () => {
    const previous = 'x'.repeat(4 * 1024 * 1024);
    const journal = {
      ...validJournal(),
      keys: {
        'rw.projects': { previous, nextSha256: SHA_A },
        'rw.knowledge': { previous, nextSha256: SHA_B },
      },
    };
    const store = createIndexedDbJournal(new IDBFactory());
    await store.write(journal);
    journal.keys['rw.knowledge'].previous += 'x';
    await expect(store.write(journal)).rejects.toMatchObject({ reason: 'corrupt' });
    expect((await store.read())?.keys['rw.knowledge']?.previous?.length).toBe(previous.length);
  });

  it.each(['pdfsAdded', 'pdfsPending'])('bounds %s to 10,000 unique PDF hashes', async (field) => {
    const hashes = Array.from({ length: 10_000 }, (_, index) =>
      index.toString(16).padStart(64, '0'),
    );
    const store = createIndexedDbJournal(new IDBFactory());
    await store.write({ ...validJournal(), [field]: hashes });
    await expect(store.read()).resolves.toMatchObject({ [field]: hashes });
    await expect(
      store.write({ ...validJournal(), [field]: [...hashes, SHA_A] }),
    ).rejects.toMatchObject({ reason: 'corrupt' });
  });
});

describe('restore journal IndexedDB lifecycle', () => {
  it('reports unavailable storage instead of returning an absent journal', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(createIndexedDbJournal().read()).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('recovers from an open failure without caching its rejected connection', async () => {
    const factory = new IDBFactory();
    vi.spyOn(factory, 'open').mockImplementationOnce(() => {
      throw new DOMException('Storage is blocked', 'SecurityError');
    });
    const store = createIndexedDbJournal(factory);
    await expect(store.read()).rejects.toMatchObject({ reason: 'unavailable' });
    await store.write(validJournal());
    await expect(store.read()).resolves.toEqual(validJournal());
  });

  it('reports read failures without clearing persisted recovery evidence', async () => {
    const factory = new IDBFactory();
    const store = createIndexedDbJournal(factory);
    await store.write(validJournal());
    const get = FakeObjectStore.prototype.get;
    const failingGet = vi.spyOn(FakeObjectStore.prototype, 'get').mockImplementation(function (
      this: IDBObjectStore,
      key,
    ) {
      const request = get.call(this, key);
      request.addEventListener('success', () => request.transaction?.abort());
      return request;
    });
    await expect(store.read()).rejects.toMatchObject({ reason: 'read' });
    failingGet.mockRestore();
    await expect(store.read()).resolves.toEqual(validJournal());
  });

  it('waits for durable commit and rejects a write aborted after request success', async () => {
    const factory = new IDBFactory();
    const store = createIndexedDbJournal(factory);
    await store.write(validJournal());
    const put = FakeObjectStore.prototype.put;
    const failingPut = vi.spyOn(FakeObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      const request = put.call(this, value, key);
      request.addEventListener('success', () => request.transaction?.abort());
      return request;
    });
    await expect(store.write({ ...validJournal(), id: 'new' })).rejects.toMatchObject({
      reason: 'write',
    });
    failingPut.mockRestore();
    await expect(store.read()).resolves.toEqual(validJournal());
  });

  it('closes on versionchange and opens a new connection afterwards', async () => {
    const factory = new IDBFactory();
    const store = createIndexedDbJournal(factory);
    await store.write(validJournal());
    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase('rw.restore');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Journal connection prevented deletion'));
    });
    await expect(store.read()).resolves.toBeNull();
    await store.write(validJournal());
    await expect(store.read()).resolves.toEqual(validJournal());
  });

  it('closes a late connection after a blocked open has already failed', async () => {
    const factory = new IDBFactory();
    const database = await rawDatabase(factory);
    const request = { result: database } as IDBOpenDBRequest;
    const blockedFactory = { open: () => request } as unknown as IDBFactory;
    const read = createIndexedDbJournal(blockedFactory).read();
    request.onblocked?.call(request, new Event('blocked') as IDBVersionChangeEvent);
    await expect(read).rejects.toMatchObject({ reason: 'blocked' });
    request.onsuccess?.call(request, new Event('success'));
    try {
      await new Promise<void>((resolve, reject) => {
        const upgrade = factory.open('rw.restore', 2);
        upgrade.onsuccess = () => {
          upgrade.result.close();
          resolve();
        };
        upgrade.onerror = () => reject(upgrade.error);
        upgrade.onblocked = () => reject(new Error('Failed open leaked a live connection'));
      });
    } finally {
      database.close();
    }
  });

  it('bounds an open that never emits an event and closes its late result', async () => {
    const factory = new IDBFactory();
    const database = await rawDatabase(factory);
    vi.useFakeTimers();
    const request = { result: database } as IDBOpenDBRequest;
    const stalledFactory = { open: () => request } as unknown as IDBFactory;
    const outcome = createIndexedDbJournal(stalledFactory)
      .read()
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    const sentinel = Symbol('still pending');
    expect(await Promise.race([outcome, Promise.resolve(sentinel)])).toMatchObject({
      reason: 'blocked',
    });
    request.onsuccess?.call(request, new Event('success'));
    vi.useRealTimers();
    try {
      await new Promise<void>((resolve, reject) => {
        const remove = factory.deleteDatabase('rw.restore');
        remove.onsuccess = () => resolve();
        remove.onerror = () => reject(remove.error);
        remove.onblocked = () => reject(new Error('Timed-out open leaked a live connection'));
      });
    } finally {
      database.close();
    }
  });
});
