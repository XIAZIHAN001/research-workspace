import {
  IDBFactory,
  IDBDatabase as FakeDatabase,
  IDBObjectStore as FakeObjectStore,
} from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertRestoreJournal,
  assertRestoreCheckpoint,
  type RestoreCheckpoint,
  createIndexedDbJournal,
  RestoreJournalError,
  type RestoreJournal,
} from './restoreJournal';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

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
  ...[false, null, undefined, 'true', 1, {}, []].map((conflicted) => ({
    name: `an invalid conflicted value ${String(conflicted)}`,
    value: { ...validJournal(), conflicted },
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

function validCheckpoint(): RestoreCheckpoint {
  return {
    id: 'checkpoint-1',
    startedAt: 1,
    keys: {
      'rw.projects': { previous: null, next: null, nextSha256: SHA_EMPTY },
      'rw.knowledge': { previous: null, next: null, nextSha256: SHA_EMPTY },
      'rw.review': { previous: null, next: null, nextSha256: SHA_EMPTY },
      'rw.difficulties': { previous: null, next: null, nextSha256: SHA_EMPTY },
    },
    outcome: 'restored',
    retired: false,
    pdfsRequired: [SHA_A],
    pdfsToClean: [SHA_B],
  };
}

async function checkpointRaw(factory: IDBFactory, value: unknown): Promise<void> {
  const database = await rawDatabase(factory);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('journal', 'readwrite');
      transaction.objectStore('journal').put(value, 'checkpoint');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

describe('restore journal replay values', () => {
  it.each(['new value', null])(
    'accepts the optional exact next value %s alongside legacy entries',
    async (next) => {
      const store = createIndexedDbJournal(new IDBFactory());
      const journal = {
        ...validJournal(),
        keys: {
          'rw.projects': { previous: 'old', next, nextSha256: SHA_A },
          'rw.knowledge': { previous: null, nextSha256: SHA_B },
        },
      };
      await store.write(journal);
      await expect(store.read()).resolves.toEqual(journal);
    },
  );

  it.each([undefined, 1, {}, []])('rejects malformed explicit next value %j', async (next) => {
    const store = createIndexedDbJournal(new IDBFactory());
    const journal = {
      ...validJournal(),
      keys: { 'rw.projects': { previous: null, next, nextSha256: SHA_A } },
    };
    await expect(store.write(journal as RestoreJournal)).rejects.toMatchObject({
      reason: 'corrupt',
    });
  });

  it('allows 16 MiB each of previous and next values but rejects either aggregate growing', () => {
    const half = 'x'.repeat(4 * 1024 * 1024);
    const journal = {
      ...validJournal(),
      keys: {
        'rw.projects': { previous: half, next: half, nextSha256: SHA_A },
        'rw.knowledge': { previous: half, next: half, nextSha256: SHA_B },
      },
    };
    expect(() => assertRestoreJournal(journal)).not.toThrow();
    journal.keys['rw.projects'].next += 'x';
    expect(() => assertRestoreJournal(journal)).toThrow(RestoreJournalError);
    journal.keys['rw.projects'].next = half;
    journal.keys['rw.projects'].previous += 'x';
    expect(() => assertRestoreJournal(journal)).toThrow(RestoreJournalError);
  });
});

const invalidCheckpoints: { name: string; value: unknown }[] = [
  { name: 'null', value: null },
  { name: 'undefined', value: undefined },
  { name: 'scalar', value: 'checkpoint' },
  { name: 'array', value: [] },
  ...['id', 'startedAt', 'keys', 'outcome', 'retired', 'pdfsRequired', 'pdfsToClean'].map(
    (field) => {
      const value = { ...validCheckpoint() } as Record<string, unknown>;
      delete value[field];
      return { name: `missing ${field}`, value };
    },
  ),
  ...['', ' ', 'x'.repeat(129)].map((id) => ({
    name: `invalid id ${id}`,
    value: { ...validCheckpoint(), id },
  })),
  ...[0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((startedAt) => ({
    name: `invalid timestamp ${String(startedAt)}`,
    value: { ...validCheckpoint(), startedAt },
  })),
  ...[undefined, null, 'pending', 1].map((outcome) => ({
    name: `invalid outcome ${String(outcome)}`,
    value: { ...validCheckpoint(), outcome },
  })),
  ...[undefined, null, 'true', 1].map((retired) => ({
    name: `invalid retired ${String(retired)}`,
    value: { ...validCheckpoint(), retired },
  })),
  { name: 'unknown root field', value: { ...validCheckpoint(), committed: true } },
  { name: 'array keys', value: { ...validCheckpoint(), keys: [] } },
  { name: 'empty keys', value: { ...validCheckpoint(), keys: {} } },
  ...['rw.projects', 'rw.knowledge', 'rw.review', 'rw.difficulties'].map((key) => {
    const value = validCheckpoint();
    delete value.keys[key];
    return { name: `missing core key ${key}`, value };
  }),
  {
    name: 'unknown storage key',
    value: {
      ...validCheckpoint(),
      keys: {
        ...validCheckpoint().keys,
        unsafe: { previous: null, next: null, nextSha256: SHA_A },
      },
    },
  },
  {
    name: 'legacy entry without next',
    value: { ...validCheckpoint(), keys: { ...validCheckpoint().keys, ...validJournal().keys } },
  },
  ...[undefined, 1, {}, []].map((next) => ({
    name: `invalid next ${String(next)}`,
    value: {
      ...validCheckpoint(),
      keys: {
        ...validCheckpoint().keys,
        'rw.projects': { previous: null, next, nextSha256: SHA_A },
      },
    },
  })),
  {
    name: 'unknown entry field',
    value: {
      ...validCheckpoint(),
      keys: {
        ...validCheckpoint().keys,
        'rw.projects': { previous: null, next: null, nextSha256: SHA_A, extra: true },
      },
    },
  },
  {
    name: 'invalid digest',
    value: {
      ...validCheckpoint(),
      keys: {
        ...validCheckpoint().keys,
        'rw.projects': { previous: null, next: null, nextSha256: 'bad' },
      },
    },
  },
  ...[undefined, null, {}, ['bad'], [SHA_A, SHA_A], Array<string>(1)].map(
    (pdfsRequired, index) => ({
      name: `invalid pdfsRequired ${String(index)}`,
      value: { ...validCheckpoint(), pdfsRequired },
    }),
  ),
];

for (const [index, pdfsToClean] of [
  undefined,
  null,
  {},
  ['bad'],
  [SHA_A, SHA_A],
  Array<string>(1),
].entries()) {
  invalidCheckpoints.push({
    name: `invalid pdfsToClean ${String(index)}`,
    value: { ...validCheckpoint(), pdfsToClean },
  });
}

describe('durable restore checkpoints', () => {
  it('returns null only for an absent checkpoint', async () => {
    const store = createIndexedDbJournal(new IDBFactory());
    await expect(store.readCheckpoint()).resolves.toBeNull();
    await store.write(validJournal());
    await expect(store.readCheckpoint()).resolves.toBeNull();
    await expect(store.read()).resolves.toEqual(validJournal());
  });

  it.each(invalidCheckpoints)(
    'rejects a stored $name checkpoint and preserves it',
    async ({ value }) => {
      const factory = new IDBFactory();
      await checkpointRaw(factory, value);
      const store = createIndexedDbJournal(factory);
      await expect(store.readCheckpoint()).rejects.toMatchObject({ reason: 'corrupt' });
      await expect(store.readCheckpoint()).rejects.toMatchObject({ reason: 'corrupt' });
    },
  );

  it.each(invalidCheckpoints)(
    'rejects publishing $name without altering prior state',
    async ({ value }) => {
      const store = createIndexedDbJournal(new IDBFactory());
      await store.publishCheckpoint(validCheckpoint());
      await store.write(validJournal());
      await expect(store.publishCheckpoint(value as RestoreCheckpoint)).rejects.toMatchObject({
        reason: 'corrupt',
      });
      await expect(store.readCheckpoint()).resolves.toEqual(validCheckpoint());
      await expect(store.read()).resolves.toEqual(validJournal());
    },
  );

  it.each(['restored', 'rolled-back'] as const)(
    'publishes a %s checkpoint and removes only the active journal',
    async (outcome) => {
      const store = createIndexedDbJournal(new IDBFactory());
      await store.write(validJournal());
      const checkpoint = { ...validCheckpoint(), outcome };
      await store.publishCheckpoint(checkpoint);
      await expect(store.read()).resolves.toBeNull();
      await expect(store.readCheckpoint()).resolves.toEqual(checkpoint);
      await store.write(validJournal());
      await store.clear();
      await expect(store.readCheckpoint()).resolves.toEqual(checkpoint);
    },
  );

  it('round-trips null next values distinctly from the empty string', async () => {
    const store = createIndexedDbJournal(new IDBFactory());
    const checkpoint = {
      ...validCheckpoint(),
      keys: {
        ...validCheckpoint().keys,
        'rw.projects': { previous: null, next: null, nextSha256: SHA_A },
        'rw.knowledge': { previous: '', next: '', nextSha256: SHA_B },
      },
    };
    await store.publishCheckpoint(checkpoint);
    await expect(store.readCheckpoint()).resolves.toEqual(checkpoint);
  });

  it('rejects non-plain checkpoints and accessors without invoking them', () => {
    const accessor = vi.fn(() => 'checkpoint');
    const checkpoint = validCheckpoint();
    Object.defineProperty(checkpoint, 'id', { enumerable: true, get: accessor });
    expect(() => assertRestoreCheckpoint(checkpoint)).toThrow(RestoreJournalError);
    expect(accessor).not.toHaveBeenCalled();
    expect(() =>
      assertRestoreCheckpoint(
        Object.assign(Object.create({ extra: true }) as object, validCheckpoint()),
      ),
    ).toThrow(RestoreJournalError);
  });

  it('bounds checkpoint values and required PDF hashes', () => {
    const half = 'x'.repeat(4 * 1024 * 1024);
    const checkpoint = {
      ...validCheckpoint(),
      keys: {
        ...validCheckpoint().keys,
        'rw.projects': { previous: half, next: half, nextSha256: SHA_A },
        'rw.knowledge': { previous: half, next: half, nextSha256: SHA_B },
      },
      pdfsRequired: Array.from({ length: 10_000 }, (_, index) =>
        index.toString(16).padStart(64, '0'),
      ),
    };
    expect(() => assertRestoreCheckpoint(checkpoint)).not.toThrow();
    checkpoint.keys['rw.projects'].next += 'x';
    expect(() => assertRestoreCheckpoint(checkpoint)).toThrow(RestoreJournalError);
    checkpoint.keys['rw.projects'].next = half;
    checkpoint.pdfsRequired.push(SHA_A);
    expect(() => assertRestoreCheckpoint(checkpoint)).toThrow(RestoreJournalError);
  });

  it('bounds cleanup obligations independently from required PDF hashes', () => {
    const checkpoint = {
      ...validCheckpoint(),
      pdfsToClean: Array.from({ length: 10_000 }, (_, index) =>
        index.toString(16).padStart(64, '0'),
      ),
    };
    expect(() => assertRestoreCheckpoint(checkpoint)).not.toThrow();
    checkpoint.pdfsToClean.push(SHA_A);
    expect(() => assertRestoreCheckpoint(checkpoint)).toThrow(RestoreJournalError);
  });

  it('revalidates a checkpoint changed while its database opens', async () => {
    const store = createIndexedDbJournal(new IDBFactory());
    const checkpoint = validCheckpoint();
    const publishing = store.publishCheckpoint(checkpoint);
    checkpoint.id = '';
    await expect(publishing).rejects.toMatchObject({ reason: 'corrupt' });
    await expect(store.readCheckpoint()).resolves.toBeNull();
  });

  it('preserves the previous checkpoint and active journal if promotion aborts after both requests succeed', async () => {
    const store = createIndexedDbJournal(new IDBFactory());
    await store.publishCheckpoint(validCheckpoint());
    await store.write(validJournal());
    const remove = FakeObjectStore.prototype.delete;
    const abort = vi.spyOn(FakeObjectStore.prototype, 'delete').mockImplementation(function (
      this: IDBObjectStore,
      key,
    ) {
      const request = remove.call(this, key);
      request.addEventListener('success', () => request.transaction?.abort());
      return request;
    });
    await expect(
      store.publishCheckpoint({ ...validCheckpoint(), id: 'replacement' }),
    ).rejects.toMatchObject({ reason: 'write' });
    abort.mockRestore();
    await expect(store.readCheckpoint()).resolves.toEqual(validCheckpoint());
    await expect(store.read()).resolves.toEqual(validJournal());
  });

  it('retires only a matching checkpoint without removing its replay data or the active journal', async () => {
    const store = createIndexedDbJournal(new IDBFactory());
    await store.publishCheckpoint(validCheckpoint());
    await store.write(validJournal());
    await store.retireCheckpoint('checkpoint-1');
    await expect(store.readCheckpoint()).resolves.toEqual({ ...validCheckpoint(), retired: true });
    await expect(store.read()).resolves.toEqual(validJournal());
    await store.retireCheckpoint('checkpoint-1');
    await expect(store.readCheckpoint()).resolves.toMatchObject({ retired: true });
  });

  it('rejects retiring missing or mismatched checkpoints without creating or changing them', async () => {
    const store = createIndexedDbJournal(new IDBFactory());
    await expect(store.retireCheckpoint('missing')).rejects.toMatchObject({ reason: 'write' });
    await expect(store.readCheckpoint()).resolves.toBeNull();
    await store.publishCheckpoint(validCheckpoint());
    await expect(store.retireCheckpoint('wrong')).rejects.toMatchObject({ reason: 'write' });
    await expect(store.readCheckpoint()).resolves.toEqual(validCheckpoint());
  });

  it('preserves a corrupt checkpoint when retirement cannot validate it', async () => {
    const factory = new IDBFactory();
    await checkpointRaw(factory, undefined);
    const store = createIndexedDbJournal(factory);
    await expect(store.retireCheckpoint('checkpoint-1')).rejects.toMatchObject({
      reason: 'corrupt',
    });
    await expect(store.readCheckpoint()).rejects.toMatchObject({ reason: 'corrupt' });
  });

  it('preserves retirement state when its transaction aborts after the write request succeeds', async () => {
    const store = createIndexedDbJournal(new IDBFactory());
    await store.publishCheckpoint(validCheckpoint());
    const put = FakeObjectStore.prototype.put;
    const abort = vi.spyOn(FakeObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      const request = put.call(this, value, key);
      request.addEventListener('success', () => request.transaction?.abort());
      return request;
    });
    await expect(store.retireCheckpoint('checkpoint-1')).rejects.toMatchObject({ reason: 'write' });
    abort.mockRestore();
    await expect(store.readCheckpoint()).resolves.toEqual(validCheckpoint());
  });
});

describe('restore journal strict transaction durability', () => {
  it('requests and verifies strict durability on every mutation but not readonly transactions', async () => {
    const transactions: {
      mode: IDBTransactionMode;
      requested?: IDBTransactionDurability;
      accepted: IDBTransactionDurability;
    }[] = [];
    const original = FakeDatabase.prototype.transaction;
    vi.spyOn(FakeDatabase.prototype, 'transaction').mockImplementation(function (
      this: IDBDatabase,
      names,
      mode,
      options,
    ) {
      const transaction = original.call(this, names, mode, options);
      transactions.push({
        mode: transaction.mode,
        requested: options?.durability,
        accepted: transaction.durability,
      });
      return transaction;
    });
    const store = createIndexedDbJournal(new IDBFactory());
    await store.write(validJournal());
    await store.read();
    await store.markConflicted('crash');
    await store.publishCheckpoint(validCheckpoint());
    await store.readCheckpoint();
    await store.retireCheckpoint('checkpoint-1');
    await store.clear();
    const writes = transactions.filter((transaction) => transaction.mode === 'readwrite');
    expect(writes).toHaveLength(5);
    expect(
      writes.every(
        (transaction) => transaction.requested === 'strict' && transaction.accepted === 'strict',
      ),
    ).toBe(true);
    expect(
      transactions
        .filter((transaction) => transaction.mode === 'readonly')
        .every((transaction) => transaction.requested === undefined),
    ).toBe(true);
  });

  it.each(['ignored', 'unsupported'] as const)(
    'fails closed when strict durability is %s',
    async (behavior) => {
      const store = createIndexedDbJournal(new IDBFactory());
      await store.write(validJournal());
      const original = FakeDatabase.prototype.transaction;
      const substitute = vi
        .spyOn(FakeDatabase.prototype, 'transaction')
        .mockImplementation(function (this: IDBDatabase, names, mode, options) {
          if (mode === 'readwrite') {
            if (behavior === 'unsupported' && options?.durability === 'strict')
              throw new TypeError('Strict durability unsupported');
            return original.call(this, names, mode);
          }
          return original.call(this, names, mode, options);
        });
      await expect(store.write({ ...validJournal(), id: 'replacement' })).rejects.toMatchObject({
        reason: 'write',
      });
      await expect(store.clear()).rejects.toMatchObject({ reason: 'write' });
      await expect(store.markConflicted('crash')).rejects.toMatchObject({ reason: 'write' });
      substitute.mockRestore();
      await expect(store.read()).resolves.toEqual(validJournal());
    },
  );
});

describe('restore journal conflict evidence', () => {
  it('round-trips the true-only conflict marker', async () => {
    const store = createIndexedDbJournal(new IDBFactory());
    const journal = { ...validJournal(), conflicted: true as const };
    await store.write(journal);
    await expect(store.read()).resolves.toEqual(journal);
  });

  it('marks only the matching active journal and preserves all recovery evidence', async () => {
    const store = createIndexedDbJournal(new IDBFactory());
    await store.publishCheckpoint(validCheckpoint());
    const journal: RestoreJournal = {
      ...validJournal(),
      keys: {
        'rw.projects': { previous: 'before', next: 'after', nextSha256: SHA_A },
        'rw.knowledge': { previous: null, next: null, nextSha256: SHA_EMPTY },
      },
      phase: 'data',
      committed: false,
      pdfsAdded: [SHA_A],
      pdfsPending: [SHA_B],
    };
    await store.write(journal);
    await store.markConflicted('crash');
    await expect(store.read()).resolves.toEqual({ ...journal, conflicted: true });
    await expect(store.readCheckpoint()).resolves.toEqual(validCheckpoint());
    await store.markConflicted('crash');
    await expect(store.read()).resolves.toEqual({ ...journal, conflicted: true });
  });

  it('rejects a missing active journal without creating one or changing the checkpoint', async () => {
    const store = createIndexedDbJournal(new IDBFactory());
    await store.publishCheckpoint(validCheckpoint());
    await expect(store.markConflicted('crash')).rejects.toMatchObject({ reason: 'write' });
    await expect(store.read()).resolves.toBeNull();
    await expect(store.readCheckpoint()).resolves.toEqual(validCheckpoint());
  });

  it('rejects a mismatched active journal without changing either record', async () => {
    const store = createIndexedDbJournal(new IDBFactory());
    await store.publishCheckpoint(validCheckpoint());
    await store.write(validJournal());
    await expect(store.markConflicted('another-restore')).rejects.toMatchObject({
      reason: 'write',
    });
    await expect(store.read()).resolves.toEqual(validJournal());
    await expect(store.readCheckpoint()).resolves.toEqual(validCheckpoint());
  });

  it.each([undefined, null, { ...validJournal(), conflicted: false }])(
    'preserves corrupt active evidence %j without marking it',
    async (value) => {
      const factory = new IDBFactory();
      const store = createIndexedDbJournal(factory);
      await store.publishCheckpoint(validCheckpoint());
      await storeRaw(factory, value);
      await expect(store.markConflicted('crash')).rejects.toMatchObject({ reason: 'corrupt' });
      expect(await readRaw(factory)).toEqual(value);
      await expect(store.read()).rejects.toMatchObject({ reason: 'corrupt' });
      await expect(store.readCheckpoint()).resolves.toEqual(validCheckpoint());
    },
  );

  it.each(['', ' ', 'x'.repeat(129)])('rejects an invalid conflict id %j', async (id) => {
    const store = createIndexedDbJournal(new IDBFactory());
    await store.write(validJournal());
    await expect(store.markConflicted(id)).rejects.toMatchObject({ reason: 'corrupt' });
    await expect(store.read()).resolves.toEqual(validJournal());
  });

  it('preserves the original active journal if marking aborts after its write succeeds', async () => {
    const store = createIndexedDbJournal(new IDBFactory());
    await store.publishCheckpoint(validCheckpoint());
    await store.write(validJournal());
    const put = FakeObjectStore.prototype.put;
    const abort = vi.spyOn(FakeObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      const request = put.call(this, value, key);
      request.addEventListener('success', () => request.transaction?.abort());
      return request;
    });
    await expect(store.markConflicted('crash')).rejects.toMatchObject({ reason: 'write' });
    abort.mockRestore();
    await expect(store.read()).resolves.toEqual(validJournal());
    await expect(store.readCheckpoint()).resolves.toEqual(validCheckpoint());
  });
});
