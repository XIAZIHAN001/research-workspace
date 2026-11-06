import { describe, expect, it, vi } from 'vitest';
import { workspaceAccess } from './workspaceAccess';
import type { KnowledgeState } from '../domain/knowledge';
import type { Paper } from '../domain/papers';
import type { ProjectsState } from '../domain/projectsState';
import { EMPTY_STATE } from '../domain/projectsState';
import type { DifficultyState } from '../domain/difficulty';
import { SCHEMA_VERSION, serializeProjects } from '../domain/migrate';
import type { PdfBlobStore } from './pdfStore';
import type { KeyValueStore } from './storage';
import type { PdfBytes } from '../domain/pdfFile';
import {
  buildBackup,
  executeRestore,
  inspectBackupFile,
  presentPdfHashes,
  readBackupPreferences,
  readPdfReferences,
  readBackupSource,
  readRecoveryCopies,
  recoverInterruptedRestore,
  type BackupSource,
} from './backupService';
import { sha256Hex } from './backupFormat';
import type { RestoreCheckpoint, RestoreJournal, RestoreJournalStore } from './restoreJournal';
import {
  EMPTY_PREFERENCES,
  DEFAULT_RESTORE_CHOICE,
  type RestoreSource,
} from '../domain/backupPlan';
import { KNOWLEDGE_STORAGE_KEY } from './knowledgeStore';
import { DIFFICULTY_PREFS_KEY, DIFFICULTY_STORAGE_KEY } from './difficultyStore';
import { PROJECTS_STORAGE_KEY, REVIEW_STORAGE_KEY, THEME_STORAGE_KEY } from '../app/config';
import { EMPTY_REVIEW_STATE } from '../domain/review';

const bytes = (text: string): PdfBytes =>
  new TextEncoder().encode(`%PDF-1.4\n${text}\n%%EOF`) as PdfBytes;

const PDF_BYTES = bytes('pdf');
const SHA_A = await sha256Hex(PDF_BYTES);
const NOW = new Date('2026-10-17T12:00:00.000Z');

class MemoryStore implements KeyValueStore {
  readonly items = new Map<string, string>();
  readonly failOn = new Set<string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) this.items.set(key, value);
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failOn.has(key)) {
      throw new DOMException('quota', 'QuotaExceededError');
    }
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }
}

function blobStore(initial: Record<string, PdfBytes> = {}): PdfBlobStore & {
  files: Map<string, PdfBytes>;
  failPut: Set<string>;
  usageEstimate: { used: number; quota: number } | null;
} {
  const files = new Map(Object.entries(initial));
  const failPut = new Set<string>();
  const store = {
    files,
    failPut,
    usageEstimate: null as { used: number; quota: number } | null,
    durable: true,
    has: (sha256: string) => Promise.resolve(files.has(sha256)),
    get: (sha256: string) => Promise.resolve(files.get(sha256) ?? null),
    put: async (sha256: string, bytes: PdfBytes) => {
      if (failPut.has(sha256)) throw new DOMException('quota', 'QuotaExceededError');
      files.set(sha256, bytes);
    },
    remove: async (sha256: string) => {
      files.delete(sha256);
    },
    usage: () => Promise.resolve(store.usageEstimate),
  };
  return store;
}

function memoryJournal(): RestoreJournalStore & {
  peek: () => RestoreJournal | null;
  checkpoint: () => RestoreCheckpoint | null;
} {
  let journal: RestoreJournal | null = null;
  let checkpoint: RestoreCheckpoint | null = null;
  return {
    read: () => Promise.resolve(journal),
    write: (next) => {
      journal = next;
      return Promise.resolve();
    },
    clear: () => {
      journal = null;
      return Promise.resolve();
    },
    markConflicted: async (id: string) => {
      if (journal === null || journal.id !== id) throw new Error('journal changed');
      journal = { ...journal, conflicted: true };
    },
    readCheckpoint: async () => checkpoint,
    publishCheckpoint: async (next) => {
      checkpoint = structuredClone(next);
      journal = null;
    },
    retireCheckpoint: async (id) => {
      if (checkpoint === null || checkpoint.id !== id) throw new Error('checkpoint changed');
      checkpoint = { ...checkpoint, retired: true };
    },
    checkpoint: () => checkpoint,
    peek: () => journal,
  };
}

function paper(id: string, title: string, extra: Partial<Paper> = {}): Paper {
  return { id, title, authors: [], createdAt: 1, updatedAt: 1, ...extra };
}

function sampleSource(): BackupSource {
  const projects: ProjectsState = {
    projects: [
      {
        id: 'project-1',
        name: '恢复验收',
        corePaperId: 'paper-1',
        relatedPaperIds: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    papers: {
      'paper-1': paper('paper-1', '一篇论文', {
        pdf: { sha256: SHA_A, name: 'paper.pdf', bytes: 20, pageCount: 1, addedAt: 1 },
      }),
    },
    annotations: [
      {
        id: 'note-1',
        paperId: 'paper-1',
        pdfSha256: SHA_A,
        page: 1,
        quote: 'the reader wrote this down',
        prefix: '',
        suffix: '',
        rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }],
        kind: 'note',
        note: '一条笔记',
        origin: 'user',
        sourceLabel: '',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    bookmarks: [],
    glossary: [],
    selectedId: 'project-1',
  };
  const knowledge: KnowledgeState = {
    version: 2,
    concepts: [
      {
        id: 'concept-1',
        name: 'KZG commitment',
        aliases: [],
        summary: '多项式承诺',
        origin: 'user',
        status: 'confirmed',
        projectIds: ['project-1'],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    evidence: [
      {
        id: 'evidence-1',
        conceptId: 'concept-1',
        paperId: 'paper-1',
        pdfSha256: SHA_A,
        page: 1,
        quote: 'the reader wrote this down',
        prefix: '',
        suffix: '',
        rects: [],
        source: 'annotation',
        annotationId: 'note-1',
        note: '',
        createdAt: 1,
      },
    ],
    relations: [],
    rejections: [],
  };
  const difficulties: DifficultyState = {
    pages: {
      [`${SHA_A}|1|mock|d1`]: {
        paperId: 'paper-1',
        pdfSha256: SHA_A,
        page: 1,
        model: 'mock',
        rulesVersion: 'd1',
        analysedAt: 5,
        suggestions: [],
        rejected: 0,
      },
    },
    ignored: { [SHA_A]: ['s1'] },
  };
  return {
    projects,
    knowledge,
    difficulties,
    review: {
      version: 1,
      cards: {
        'concept-1': {
          conceptId: 'concept-1',
          ease: 2.5,
          intervalDays: 6,
          reps: 2,
          lapses: 0,
          dueAt: 10,
          lastAt: 5,
        },
      },
    },
  };
}

const EMPTY_SOURCE: RestoreSource = {
  projects: EMPTY_STATE,
  knowledge: { version: 2, concepts: [], evidence: [], relations: [], rejections: [] },
  difficulties: { pages: {}, ignored: {} },
  review: EMPTY_REVIEW_STATE,
};

async function backupFile(source: BackupSource, files = blobStore({ [SHA_A]: PDF_BYTES })) {
  const built = await buildBackup({
    source,
    preferences: { theme: 'dark', paper: 'warm', avatar: null, difficulty: null },
    recovery: {},
    blobs: files,
    now: NOW,
  });
  return { built, file: new File([built.blob], 'workspace.rwbackup') };
}

describe('building a backup', () => {
  it('packs the PDF once even when two papers share it', async () => {
    const source = sampleSource();
    source.projects.papers['paper-2'] = paper('paper-2', '另一篇', {
      pdf: { sha256: SHA_A, name: 'paper.pdf', bytes: 20, pageCount: 1, addedAt: 1 },
    });
    const store = blobStore({ [SHA_A]: PDF_BYTES });
    const built = await buildBackup({
      source,
      preferences: { ...EMPTY_PREFERENCES },
      recovery: {},
      blobs: store,
      now: NOW,
    });
    expect(built.header.files).toHaveLength(1);
    expect(built.header.counts.papers).toBe(2);
    expect(built.header.missingFiles).toEqual([]);
  });

  it('records a PDF that is no longer in the blob store instead of pretending', async () => {
    const built = await buildBackup({
      source: sampleSource(),
      preferences: { ...EMPTY_PREFERENCES },
      recovery: {},
      blobs: blobStore(),
      now: NOW,
    });
    expect(built.missingFiles).toEqual([SHA_A]);
    expect(built.missingPapers).toEqual(['一篇论文']);
    expect(built.header.files).toEqual([]);
  });

  it('does not pack bytes that no longer match their content hash', async () => {
    const store = blobStore({ [SHA_A]: bytes('these are different bytes') });
    const built = await buildBackup({
      source: sampleSource(),
      preferences: { ...EMPTY_PREFERENCES },
      recovery: {},
      blobs: store,
      now: NOW,
    });
    expect(built.header.files).toEqual([]);
    expect(built.missingFiles).toEqual([SHA_A]);
  });
});

describe('inspecting a backup', () => {
  it('describes what restoring would add, without writing anything', async () => {
    const { file } = await backupFile(sampleSource());
    const store = new MemoryStore();
    const targetBlobs = blobStore();
    const inspection = await inspectBackupFile(file, {
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      presentPdfHashes: new Set(),
      availableBytes: null,
      now: NOW.getTime(),
    });
    expect(inspection.problems).toEqual([]);
    expect(inspection.plan?.additions).toMatchObject({
      projects: 1,
      papers: 1,
      annotations: 1,
      concepts: 1,
      evidence: 1,
    });
    expect(inspection.plan?.pdfsToCopy).toEqual([SHA_A]);
    expect(store.items.size).toBe(0);
    expect(targetBlobs.files.size).toBe(0);
  });

  it('warns about a paper whose PDF is neither in the file nor on this machine', async () => {
    const source = sampleSource();
    const { file } = await backupFile(source, blobStore());
    const inspection = await inspectBackupFile(file, {
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      presentPdfHashes: new Set(),
      availableBytes: null,
      now: NOW.getTime(),
    });
    expect(inspection.plan?.missingPdfPapers).toHaveLength(1);
    expect(inspection.warnings.join(' ')).toContain('不在备份里');
  });
});

describe('restoring a backup', () => {
  it('writes the PDFs, the records and the preferences, then verifies them', async () => {
    const { file } = await backupFile(sampleSource());
    const inspection = await inspectBackupFile(file, {
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      presentPdfHashes: new Set(),
      availableBytes: null,
      now: NOW.getTime(),
    });
    const storage = new MemoryStore();
    const blobs = blobStore();
    const journal = memoryJournal();
    const result = await executeRestore({
      file,
      inspection,
      choice: DEFAULT_RESTORE_CHOICE,
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      storage,
      blobs,
      journal,
      now: NOW.getTime(),
    });

    expect(result.status).toBe('restored');
    if (result.status !== 'restored') return;
    expect(result.verification).toMatchObject({
      projects: 1,
      papers: 1,
      annotations: 1,
      reviewCards: 1,
      concepts: 1,
      evidence: 1,
    });
    expect(JSON.parse(storage.getItem(REVIEW_STORAGE_KEY) ?? 'null')).toMatchObject({
      version: 1,
      cards: { 'concept-1': { intervalDays: 6 } },
    });
    expect(result.pdfsCopied).toBe(1);
    expect(journal.peek()).toBeNull();
    expect(blobs.files.has(SHA_A)).toBe(true);
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    const projects = JSON.parse(storage.getItem(PROJECTS_STORAGE_KEY) ?? 'null') as {
      version: number;
      annotations: unknown[];
    };
    expect(projects.version).toBe(SCHEMA_VERSION);
    expect(projects.annotations).toHaveLength(1);
    expect(JSON.parse(storage.getItem(KNOWLEDGE_STORAGE_KEY) ?? 'null')).toMatchObject({
      concepts: [{ name: 'KZG commitment' }],
    });
    expect(storage.getItem(DIFFICULTY_STORAGE_KEY)).toContain(SHA_A);
  });

  it('restores a workspace whose ids are Object.prototype property names', async () => {
    const projects: ProjectsState = {
      projects: [
        {
          id: 'project-special',
          name: '特殊 ID',
          corePaperId: 'constructor',
          relatedPaperIds: ['toString'],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      papers: {
        constructor: paper('constructor', '构造器论文', {
          pdf: { sha256: SHA_A, name: 'paper.pdf', bytes: 20, pageCount: 1, addedAt: 1 },
        }),
        toString: paper('toString', '字符串论文'),
      },
      annotations: [
        {
          id: 'note-special',
          paperId: 'constructor',
          pdfSha256: SHA_A,
          page: 1,
          quote: 'the reader wrote this down',
          prefix: '',
          suffix: '',
          rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }],
          kind: 'note',
          note: '一条笔记',
          origin: 'user',
          sourceLabel: '',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      bookmarks: [],
      glossary: [],
      selectedId: 'project-special',
    };
    const source: BackupSource = {
      projects,
      knowledge: EMPTY_SOURCE.knowledge,
      difficulties: EMPTY_SOURCE.difficulties,
      review: EMPTY_SOURCE.review,
    };
    const { file } = await backupFile(source);
    const inspection = await inspectBackupFile(file, {
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      presentPdfHashes: new Set(),
      availableBytes: null,
      now: NOW.getTime(),
    });
    expect(inspection.problems).toEqual([]);

    const storage = new MemoryStore();
    const result = await executeRestore({
      file,
      inspection,
      choice: DEFAULT_RESTORE_CHOICE,
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      storage,
      blobs: blobStore(),
      journal: memoryJournal(),
      now: NOW.getTime(),
    });
    expect(result.status).toBe('restored');
    if (result.status !== 'restored') return;
    expect(result.verification.papers).toBe(2);
    expect(result.verification.annotations).toBe(1);

    const stored = JSON.parse(storage.getItem(PROJECTS_STORAGE_KEY) ?? 'null') as {
      projects: { corePaperId: string; relatedPaperIds: string[] }[];
      papers: Record<string, { id: string }>;
      annotations: { paperId: string }[];
    };
    expect(stored.projects[0]?.corePaperId).toBe('constructor');
    expect(stored.projects[0]?.relatedPaperIds).toEqual(['toString']);
    expect(Object.hasOwn(stored.papers, 'constructor')).toBe(true);
    expect(stored.papers['constructor']?.id).toBe('constructor');
    expect(stored.papers['toString']?.id).toBe('toString');
    expect(stored.annotations[0]?.paperId).toBe('constructor');
  });

  it('leaves a newer local review schedule untouched', async () => {
    const { file } = await backupFile(sampleSource());
    const inspection = await inspectBackupFile(file, {
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      presentPdfHashes: new Set(),
      availableBytes: null,
      now: NOW.getTime(),
    });
    const newer = JSON.stringify({ version: 99, cards: { x: {} } });
    const storage = new MemoryStore({ [REVIEW_STORAGE_KEY]: newer });
    const result = await executeRestore({
      file,
      inspection,
      choice: DEFAULT_RESTORE_CHOICE,
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      storage,
      blobs: blobStore(),
      journal: memoryJournal(),
      now: NOW.getTime(),
    });

    expect(result.status).toBe('restored');
    if (result.status !== 'restored') return;
    expect(result.warnings.join(' ')).toContain('更新版本');
    expect(storage.getItem(REVIEW_STORAGE_KEY)).toBe(newer);
  });

  it('is idempotent when the same backup is restored twice', async () => {
    const { file } = await backupFile(sampleSource());
    const options = {
      currentPreferences: { ...EMPTY_PREFERENCES },
      availableBytes: null,
      now: NOW.getTime(),
    };
    const first = await inspectBackupFile(file, {
      ...options,
      current: EMPTY_SOURCE,
      presentPdfHashes: new Set(),
    });
    const storage = new MemoryStore();
    const blobs = blobStore();
    const journal = memoryJournal();
    await executeRestore({
      file,
      inspection: first,
      choice: DEFAULT_RESTORE_CHOICE,
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      storage,
      blobs,
      journal,
      now: NOW.getTime(),
    });
    const projectsAfterFirst = storage.getItem(PROJECTS_STORAGE_KEY);
    // A completed restore freezes the old live stores; reload retires replay authority.
    expect(await recoverInterruptedRestore({ storage, blobs, journal })).toBe('completed');
    workspaceAccess.allowWrites();

    const second = await inspectBackupFile(file, {
      ...options,
      current: sampleSource(),
      currentPreferences: readBackupPreferences(storage),
      presentPdfHashes: new Set([SHA_A]),
    });
    expect(second.plan?.additions).toMatchObject({ projects: 0, papers: 0, annotations: 0 });
    const again = await executeRestore({
      file,
      inspection: second,
      choice: DEFAULT_RESTORE_CHOICE,
      current: sampleSource(),
      currentPreferences: readBackupPreferences(storage),
      storage,
      blobs,
      journal,
      now: NOW.getTime(),
    });
    expect(again.status).toBe('restored');
    expect(storage.getItem(PROJECTS_STORAGE_KEY)).toBe(projectsAfterFirst);
  });

  it('refuses to import papers whose PDF is missing until the reader says so', async () => {
    const { file } = await backupFile(sampleSource(), blobStore());
    const inspection = await inspectBackupFile(file, {
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      presentPdfHashes: new Set(),
      availableBytes: null,
      now: NOW.getTime(),
    });
    const storage = new MemoryStore();
    const result = await executeRestore({
      file,
      inspection,
      choice: { ...DEFAULT_RESTORE_CHOICE, importMissingPdfs: false },
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      storage,
      blobs: blobStore(),
      journal: memoryJournal(),
      now: NOW.getTime(),
    });
    expect(result.status).toBe('refused');
    expect(storage.items.size).toBe(0);

    const accepted = await executeRestore({
      file,
      inspection,
      choice: { ...DEFAULT_RESTORE_CHOICE, importMissingPdfs: true },
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      storage,
      blobs: blobStore(),
      journal: memoryJournal(),
      now: NOW.getTime(),
    });
    expect(accepted.status).toBe('restored');
    expect(storage.getItem(PROJECTS_STORAGE_KEY)).toContain('一篇论文');
  });

  it('rolls every key back when a write fails halfway through', async () => {
    const existingProjects: ProjectsState = {
      ...EMPTY_STATE,
      projects: [
        {
          id: 'local-project',
          name: '已有的项目',
          corePaperId: 'local-paper',
          relatedPaperIds: [],
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      papers: { 'local-paper': paper('local-paper', '已有的论文') },
      selectedId: 'local-project',
    };
    const existingKnowledge: KnowledgeState = {
      ...EMPTY_SOURCE.knowledge,
      concepts: [
        {
          id: 'local-concept',
          name: '本机概念',
          aliases: [],
          summary: '',
          origin: 'user',
          status: 'confirmed',
          projectIds: ['local-project'],
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    };
    const storage = new MemoryStore({
      [PROJECTS_STORAGE_KEY]: serializeProjects(existingProjects),
      [KNOWLEDGE_STORAGE_KEY]: JSON.stringify(existingKnowledge),
    });
    storage.failOn.add(KNOWLEDGE_STORAGE_KEY);

    const { file } = await backupFile(sampleSource());
    const current: RestoreSource = {
      projects: existingProjects,
      knowledge: existingKnowledge,
      difficulties: EMPTY_SOURCE.difficulties,
      review: EMPTY_SOURCE.review,
    };
    const inspection = await inspectBackupFile(file, {
      current,
      currentPreferences: { ...EMPTY_PREFERENCES },
      presentPdfHashes: new Set(),
      availableBytes: null,
      now: NOW.getTime(),
    });
    const journal = memoryJournal();
    const result = await executeRestore({
      file,
      inspection,
      choice: DEFAULT_RESTORE_CHOICE,
      current,
      currentPreferences: { ...EMPTY_PREFERENCES },
      storage,
      blobs: blobStore(),
      journal,
      now: NOW.getTime(),
    });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.stage).toBe('data');
    expect(result.rolledBack).toBe(true);
    expect(storage.getItem(PROJECTS_STORAGE_KEY)).toBe(serializeProjects(existingProjects));
    expect(JSON.parse(storage.getItem(KNOWLEDGE_STORAGE_KEY) ?? 'null')).toEqual(existingKnowledge);
    expect(storage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(journal.peek()).toBeNull();
  });

  it('refuses a backup whose bytes changed after it was inspected', async () => {
    const { file } = await backupFile(sampleSource());
    const inspection = await inspectBackupFile(file, {
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      presentPdfHashes: new Set(),
      availableBytes: null,
      now: NOW.getTime(),
    });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const last = bytes.length - 10;
    bytes[last] = (bytes[last] ?? 0) ^ 1;
    const changed = new File([bytes], 'changed.rwbackup');
    const storage = new MemoryStore();
    const result = await executeRestore({
      file: changed,
      inspection,
      choice: DEFAULT_RESTORE_CHOICE,
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      storage,
      blobs: blobStore(),
      journal: memoryJournal(),
      now: NOW.getTime(),
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.stage).toBe('pdfs');
    expect(storage.items.size).toBe(0);
  });

  it('does not write anything when the journal cannot be established', async () => {
    const { file } = await backupFile(sampleSource());
    const inspection = await inspectBackupFile(file, {
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      presentPdfHashes: new Set(),
      availableBytes: null,
      now: NOW.getTime(),
    });
    const storage = new MemoryStore();
    const result = await executeRestore({
      file,
      inspection,
      choice: DEFAULT_RESTORE_CHOICE,
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      storage,
      blobs: blobStore(),
      journal: {
        ...memoryJournal(),
        read: () => Promise.resolve(null),
        write: () => Promise.reject(new Error('journal unavailable')),
        clear: () => Promise.resolve(),
      },
      now: NOW.getTime(),
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.stage).toBe('journal');
    expect(storage.items.size).toBe(0);
  });
});

describe('recovering an interrupted restore', () => {
  it('blocks startup if the journal cannot be read, preserving every key', async () => {
    const storage = new MemoryStore({ [THEME_STORAGE_KEY]: 'dark' });
    const journal: RestoreJournalStore = {
      ...memoryJournal(),
      read: async () => {
        throw new Error('blocked IndexedDB');
      },
      write: async () => {
        throw new Error('unexpected write');
      },
      clear: async () => {
        throw new Error('must not discard unreadable evidence');
      },
    };
    await expect(recoverInterruptedRestore({ storage, journal })).resolves.toBe('blocked');
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('blocks startup when no journal store was supplied', async () => {
    await expect(recoverInterruptedRestore()).resolves.toBe('blocked');
  });

  it('blocks startup if LocalStorage cannot be read, without rolling back', async () => {
    const journal = memoryJournal();
    await journal.write(
      await journalFor({ [THEME_STORAGE_KEY]: { previous: 'light', next: 'dark' } }),
    );
    const storage: KeyValueStore = {
      getItem: () => {
        throw new Error('storage access denied');
      },
      setItem: () => {
        throw new Error('must not write');
      },
      removeItem: () => {
        throw new Error('must not remove');
      },
    };
    await expect(recoverInterruptedRestore({ storage, journal })).resolves.toBe('blocked');
    expect(journal.peek() ?? journal.checkpoint()).not.toBeNull();
  });

  async function journalFor(entries: Record<string, { previous: string | null; next: string }>) {
    const keys: RestoreJournal['keys'] = {};
    for (const [key, entry] of Object.entries(entries)) {
      keys[key] = { previous: entry.previous, nextSha256: await sha256Hex(entry.next) };
    }
    return { id: 'journal-1', startedAt: 1, keys } satisfies RestoreJournal;
  }

  it('recognises a restore that finished but lost its cleanup', async () => {
    const journal = memoryJournal();
    await journal.write(
      await journalFor({ [THEME_STORAGE_KEY]: { previous: 'light', next: 'dark' } }),
    );
    const storage = new MemoryStore({ [THEME_STORAGE_KEY]: 'dark' });
    await expect(recoverInterruptedRestore({ storage, journal })).resolves.toBe('completed');
    expect(journal.peek()).toBeNull();
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('preserves and blocks a legacy committed journal with unknown later values', async () => {
    const journal = memoryJournal();
    await journal.write({
      ...(await journalFor({ [THEME_STORAGE_KEY]: { previous: 'light', next: 'dark' } })),
      committed: true,
    });
    // Legacy hashes cannot reconstruct the result or safely classify a later edit.
    const storage = new MemoryStore({ [THEME_STORAGE_KEY]: 'edited-after-restore' });
    await expect(recoverInterruptedRestore({ storage, journal })).resolves.toBe('blocked');
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('edited-after-restore');
    expect(journal.peek()?.committed).toBe(true);
  });

  it('recognises a restore that never wrote', async () => {
    const journal = memoryJournal();
    await journal.write(
      await journalFor({ [THEME_STORAGE_KEY]: { previous: 'light', next: 'dark' } }),
    );
    const storage = new MemoryStore({ [THEME_STORAGE_KEY]: 'light' });
    await expect(recoverInterruptedRestore({ storage, journal })).resolves.toBe('clean');
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('puts the old values back after a partial write', async () => {
    const journal = memoryJournal();
    await journal.write(
      await journalFor({
        [THEME_STORAGE_KEY]: { previous: 'light', next: 'dark' },
        [DIFFICULTY_PREFS_KEY]: { previous: null, next: '{"enabled":true,"markersVisible":true}' },
      }),
    );
    // The theme reached its new value; the preference key never did.
    const storage = new MemoryStore({ [THEME_STORAGE_KEY]: 'dark' });
    await expect(recoverInterruptedRestore({ storage, journal })).resolves.toBe('rolled-back');
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(storage.getItem(DIFFICULTY_PREFS_KEY)).toBeNull();
  });

  it('keeps the journal when rolling back is impossible', async () => {
    const journal = memoryJournal();
    await journal.write(
      await journalFor({
        [THEME_STORAGE_KEY]: { previous: 'light', next: 'dark' },
        [DIFFICULTY_PREFS_KEY]: { previous: null, next: '{"enabled":true,"markersVisible":true}' },
      }),
    );
    const storage = new MemoryStore({ [THEME_STORAGE_KEY]: 'dark' });
    storage.failOn.add(THEME_STORAGE_KEY);
    await expect(recoverInterruptedRestore({ storage, journal })).resolves.toBe('blocked');
    expect(journal.peek() ?? journal.checkpoint()).not.toBeNull();
  });

  it('is a no-op when there is no journal', async () => {
    await expect(
      recoverInterruptedRestore({ storage: new MemoryStore(), journal: memoryJournal() }),
    ).resolves.toBe('none');
  });
});

describe('reading current preferences and recovery copies', () => {
  it('treats missing or invalid values as absent', () => {
    const storage = new MemoryStore({ [THEME_STORAGE_KEY]: 'neon' });
    expect(readBackupPreferences(storage)).toMatchObject({ theme: null, paper: null });
  });

  it('carries recovery copies verbatim and ignores unrelated keys', () => {
    const storage = new MemoryStore({
      'rw.projects.corrupt': '{broken',
      'rw.unrelated': 'x',
    });
    expect(readRecoveryCopies(storage)).toEqual({ 'rw.projects.corrupt': '{broken' });
  });

  it('reads the review schedule from its own key, and starts empty when it is unreadable', () => {
    const knowledge = EMPTY_SOURCE.knowledge;
    const stored = new MemoryStore({
      [REVIEW_STORAGE_KEY]: JSON.stringify({
        version: 1,
        cards: {
          c1: {
            conceptId: 'c1',
            ease: 2.5,
            intervalDays: 1,
            reps: 1,
            lapses: 0,
            dueAt: 1,
            lastAt: 1,
          },
        },
      }),
    });
    expect(
      readBackupSource({ projects: EMPTY_STATE, knowledge }, stored).review.cards.c1,
    ).toBeDefined();

    const broken = new MemoryStore({ [REVIEW_STORAGE_KEY]: '{not json' });
    expect(readBackupSource({ projects: EMPTY_STATE, knowledge }, broken).review.cards).toEqual(
      EMPTY_REVIEW_STATE.cards,
    );
  });

  it('knows which referenced PDFs are actually present', async () => {
    const store = blobStore({ [SHA_A]: PDF_BYTES });
    const present = await presentPdfHashes(
      {
        one: paper('one', '一', {
          pdf: { sha256: SHA_A, name: 'a', bytes: 1, pageCount: 1, addedAt: 1 },
        }),
      },
      store,
    );
    expect([...present]).toEqual([SHA_A]);
  });
});

describe('restore PDF write-ahead tracking and rollback', () => {
  async function restoreFixture(twoFiles = false) {
    const source = sampleSource();
    const hashB = await sha256Hex(bytes('second'));
    if (twoFiles)
      source.projects.papers['paper-2'] = paper('paper-2', 'second', {
        pdf: { sha256: hashB, name: 'second.pdf', bytes: 20, pageCount: 1, addedAt: 1 },
      });
    const { file } = await backupFile(
      source,
      blobStore({ [SHA_A]: PDF_BYTES, [hashB]: bytes('second') }),
    );
    const inspection = await inspectBackupFile(file, {
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      presentPdfHashes: new Set(),
      availableBytes: null,
    });
    return {
      file,
      inspection,
      hashB,
      choice: DEFAULT_RESTORE_CHOICE,
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      now: NOW.getTime(),
    };
  }

  it('removes PDF A after PDF B fails, preserving preexisting blobs', async () => {
    const fixture = await restoreFixture(true);
    const blobs = blobStore({ ['f'.repeat(64)]: bytes('preexisting') });
    blobs.failPut.add(fixture.hashB);
    const journal = memoryJournal();
    const result = await executeRestore({ ...fixture, blobs, journal, storage: new MemoryStore() });
    expect(result.status).toBe('failed');
    expect(blobs.files.has(SHA_A)).toBe(false);
    expect(blobs.files.has('f'.repeat(64))).toBe(true);
    expect(journal.peek()).toBeNull();
  });

  it('cleans newly written PDFs when LocalStorage fails', async () => {
    const fixture = await restoreFixture();
    const blobs = blobStore();
    const storage = new MemoryStore();
    storage.failOn.add(KNOWLEDGE_STORAGE_KEY);
    const result = await executeRestore({ ...fixture, blobs, storage, journal: memoryJournal() });
    expect(result.status).toBe('failed');
    expect(blobs.files.size).toBe(0);
  });

  it('never removes a preexisting PDF, even if a stale plan said to copy it', async () => {
    const fixture = await restoreFixture();
    const blobs = blobStore({ [SHA_A]: PDF_BYTES });
    const storage = new MemoryStore();
    storage.failOn.add(KNOWLEDGE_STORAGE_KEY);
    await executeRestore({ ...fixture, blobs, storage, journal: memoryJournal() });
    expect(blobs.files.has(SHA_A)).toBe(true);
  });

  it('records write intent before storing bytes and actual additions afterwards', async () => {
    const fixture = await restoreFixture();
    const blobs = blobStore();
    const journal = memoryJournal();
    const put = blobs.put;
    let sawIntent = false;
    blobs.put = async (hash, data) => {
      if (!blobs.files.has(hash)) sawIntent = journal.peek()?.pdfsPending?.includes(hash) === true;
      await put(hash, data);
    };
    const result = await executeRestore({ ...fixture, blobs, journal, storage: new MemoryStore() });
    expect(result.status).toBe('restored');
    expect(sawIntent).toBe(true);
  });

  it('preserves journal and blob when reference metadata is unreadable during cleanup', async () => {
    const journal = memoryJournal();
    await journal.write({
      id: 'crash',
      startedAt: 1,
      keys: {},
      phase: 'prepared',
      pdfsPending: [SHA_A],
      pdfsAdded: [],
    });
    const storage = new MemoryStore({ [PROJECTS_STORAGE_KEY]: '{broken' });
    const blobs = blobStore({ [SHA_A]: PDF_BYTES });
    expect(await recoverInterruptedRestore({ storage, journal, blobs })).toBe('blocked');
    expect(blobs.files.has(SHA_A)).toBe(true);
    expect(journal.peek() ?? journal.checkpoint()).not.toBeNull();
  });

  it('recovers a crash after PDF bytes were saved but before addition was acknowledged', async () => {
    const journal = memoryJournal();
    await journal.write({
      id: 'crash',
      startedAt: 1,
      keys: {},
      phase: 'prepared',
      pdfsPending: [SHA_A],
      pdfsAdded: [],
    });
    const blobs = blobStore({ [SHA_A]: PDF_BYTES });
    expect(await recoverInterruptedRestore({ storage: new MemoryStore(), journal, blobs })).toBe(
      'clean',
    );
    expect(blobs.files.has(SHA_A)).toBe(false);
    expect(journal.peek()).toBeNull();
  });

  it('keeps a newly added PDF when either of two papers still references it', async () => {
    const journal = memoryJournal();
    await journal.write({
      id: 'crash',
      startedAt: 1,
      keys: {},
      phase: 'prepared',
      pdfsAdded: [SHA_A],
      pdfsPending: [],
    });
    const projects = sampleSource().projects;
    projects.papers['paper-2'] = paper('paper-2', 'shared', {
      pdf: projects.papers['paper-1']!.pdf,
    });
    const storage = new MemoryStore({ [PROJECTS_STORAGE_KEY]: serializeProjects(projects) });
    const blobs = blobStore({ [SHA_A]: PDF_BYTES });
    expect(await recoverInterruptedRestore({ storage, journal, blobs })).toBe('clean');
    expect(blobs.files.has(SHA_A)).toBe(true);
  });
});

it('refuses a new restore after writes have been frozen for recovery', async () => {
  workspaceAccess.block();
  await expect(executeRestore({} as Parameters<typeof executeRestore>[0])).rejects.toThrow(/暂停/);
});

it('refuses a stale restore snapshot instead of overwriting a newly saved paper', async () => {
  const { file } = await backupFile(sampleSource());
  const inspection = await inspectBackupFile(file, {
    current: EMPTY_SOURCE,
    currentPreferences: { ...EMPTY_PREFERENCES },
    presentPdfHashes: new Set(),
    availableBytes: null,
  });
  const newer = { ...EMPTY_STATE, papers: { recent: paper('recent', 'newly saved') } };
  const storage = new MemoryStore({ [PROJECTS_STORAGE_KEY]: serializeProjects(newer) });
  const journal = memoryJournal();
  const result = await executeRestore({
    file,
    inspection,
    current: EMPTY_SOURCE,
    currentPreferences: { ...EMPTY_PREFERENCES },
    choice: DEFAULT_RESTORE_CHOICE,
    storage,
    journal,
    blobs: blobStore(),
    now: NOW.getTime(),
  });
  expect(result.status).toBe('refused');
  expect(storage.getItem(PROJECTS_STORAGE_KEY)).toBe(serializeProjects(newer));
  expect(journal.peek()).toBeNull();
});

it('requires reinspection when the current snapshot changed after preview', async () => {
  const { file } = await backupFile(sampleSource());
  const inspection = await inspectBackupFile(file, {
    current: EMPTY_SOURCE,
    currentPreferences: { ...EMPTY_PREFERENCES },
    presentPdfHashes: new Set(),
    availableBytes: null,
  });
  const newer = sampleSource();
  const storage = new MemoryStore({
    [PROJECTS_STORAGE_KEY]: serializeProjects(newer.projects),
    [KNOWLEDGE_STORAGE_KEY]: JSON.stringify(newer.knowledge),
    [REVIEW_STORAGE_KEY]: JSON.stringify(newer.review),
    [DIFFICULTY_STORAGE_KEY]: JSON.stringify({ version: 1, ...newer.difficulties }),
  });
  const journal = memoryJournal();
  const result = await executeRestore({
    file,
    inspection,
    current: newer,
    currentPreferences: { ...EMPTY_PREFERENCES },
    choice: { ...DEFAULT_RESTORE_CHOICE, sameIdPolicy: 'prefer-backup' },
    storage,
    journal,
    blobs: blobStore(),
    now: NOW.getTime(),
  });
  expect(result.status).toBe('refused');
  expect(journal.peek()).toBeNull();
});

it('preserves edits from an uncoordinated older tab instead of rolling them back', async () => {
  const journal = memoryJournal();
  await journal.write({
    id: 'crash',
    startedAt: 1,
    keys: {
      [THEME_STORAGE_KEY]: { previous: 'light', nextSha256: await sha256Hex('dark') },
    },
  });
  const storage = new MemoryStore({ [THEME_STORAGE_KEY]: 'newer-external-edit' });
  expect(await recoverInterruptedRestore({ journal, storage })).toBe('blocked');
  expect(storage.getItem(THEME_STORAGE_KEY)).toBe('newer-external-edit');
  expect(journal.peek() ?? journal.checkpoint()).not.toBeNull();
});

it('does not promote matching metadata to committed when an added referenced PDF is missing', async () => {
  const journal = memoryJournal();
  const raw = serializeProjects(sampleSource().projects);
  await journal.write({
    id: 'crash',
    startedAt: 1,
    phase: 'data',
    pdfsAdded: [SHA_A],
    pdfsPending: [],
    keys: {
      [PROJECTS_STORAGE_KEY]: { previous: null, nextSha256: await sha256Hex(raw) },
    },
  });
  const storage = new MemoryStore({ [PROJECTS_STORAGE_KEY]: raw });
  expect(await recoverInterruptedRestore({ journal, storage, blobs: blobStore() })).toBe('blocked');
  expect(journal.peek()?.committed).not.toBe(true);
  expect(storage.getItem(PROJECTS_STORAGE_KEY)).toBe(raw);
});

it('retains recovery evidence when a rollback write silently fails its readback', async () => {
  const journal = memoryJournal();
  await journal.write({
    id: 'crash',
    startedAt: 1,
    keys: {
      [THEME_STORAGE_KEY]: { previous: 'light', nextSha256: await sha256Hex('dark') },
      [DIFFICULTY_PREFS_KEY]: { previous: null, nextSha256: await sha256Hex('prefs') },
    },
  });
  const storage: KeyValueStore = {
    getItem: (key) => (key === THEME_STORAGE_KEY ? 'dark' : null),
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  expect(await recoverInterruptedRestore({ journal, storage })).toBe('blocked');
  expect(journal.peek() ?? journal.checkpoint()).not.toBeNull();
});

it('does not interpret a LocalStorage read failure as a new empty workspace', async () => {
  const storage: KeyValueStore = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  expect(await recoverInterruptedRestore({ storage, journal: memoryJournal() })).toBe('blocked');
});

describe('restore commit and cleanup faults', () => {
  async function request() {
    const { file } = await backupFile(sampleSource());
    const inspection = await inspectBackupFile(file, {
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      presentPdfHashes: new Set(),
      availableBytes: null,
    });
    return {
      file,
      inspection,
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      choice: DEFAULT_RESTORE_CHOICE,
      storage: new MemoryStore(),
      blobs: blobStore(),
      now: NOW.getTime(),
    };
  }

  it('rolls back metadata and only newly added PDFs when final checkpoint publication fails', async () => {
    const input = await request();
    const journal = memoryJournal();
    const publish = journal.publishCheckpoint;
    journal.publishCheckpoint = async (value) => {
      if (value.outcome === 'restored') throw new Error('commit failed');
      await publish(value);
    };
    const result = await executeRestore({ ...input, journal });
    expect(result).toMatchObject({ status: 'failed', stage: 'verify', rolledBack: true });
    expect(input.storage.items.size).toBe(0);
    expect(input.blobs.files.size).toBe(0);
    expect(journal.peek()).toBeNull();
  });

  it('preserves an older-tab edit during PDF copy before the first metadata write', async () => {
    const input = await request();
    const journal = memoryJournal();
    const external = serializeProjects({
      ...EMPTY_STATE,
      papers: { external: paper('external', 'newer work') },
    });
    const put = input.blobs.put;
    input.blobs.put = async (hash, value) => {
      await put(hash, value);
      input.storage.setItem(PROJECTS_STORAGE_KEY, external);
    };
    expect(await executeRestore({ ...input, journal })).toMatchObject({
      status: 'failed',
      rolledBack: false,
      reloadRequired: true,
    });
    expect(input.storage.items).toEqual(new Map([[PROJECTS_STORAGE_KEY, external]]));
    expect(journal.peek()).not.toBeNull();
    expect(input.blobs.files.has(SHA_A)).toBe(true);
    expect(workspaceAccess.canWrite()).toBe(false);
  });

  it('rejects a changed raw baseline before journal creation without capturing it as confirmed', async () => {
    const input = await request();
    const journal = memoryJournal();
    const external = serializeProjects({
      ...EMPTY_STATE,
      papers: { external: paper('external', 'newer work') },
    });
    const result = await executeRestore({
      ...input,
      journal,
      onStage: (stage) => {
        if (stage === 'journal') input.storage.setItem(PROJECTS_STORAGE_KEY, external);
      },
    });
    expect(result).toMatchObject({ status: 'failed', rolledBack: true, reloadRequired: true });
    expect(workspaceAccess.canWrite()).toBe(false);
    expect(input.storage.items).toEqual(new Map([[PROJECTS_STORAGE_KEY, external]]));
    expect(journal.peek()).toBeNull();
    expect(input.blobs.files.size).toBe(0);
  });

  it('durably stops active recovery after an external edit exactly equals the intended next value', async () => {
    const input = await request();
    const journal = memoryJournal();
    const put = input.blobs.put;
    input.blobs.put = async (hash, value) => {
      await put(hash, value);
      input.storage.setItem(THEME_STORAGE_KEY, journal.peek()!.keys[THEME_STORAGE_KEY]!.next!);
    };
    expect(await executeRestore({ ...input, journal })).toMatchObject({
      status: 'failed',
      manualRecoveryRequired: true,
    });
    expect(journal.peek()?.conflicted).toBe(true);
    const before = new Map(input.storage.items);
    expect(await recoverInterruptedRestore({ ...input, journal })).toBe('blocked');
    expect(input.storage.items).toEqual(before);
    expect(input.storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('requires manual recovery when active conflict invalidation cannot persist', async () => {
    const input = await request();
    const journal = memoryJournal();
    journal.markConflicted = async () => {
      throw new Error('disk unavailable');
    };
    const result = await executeRestore({
      ...input,
      journal,
      onStage: (stage) => {
        if (stage === 'data') input.storage.setItem(THEME_STORAGE_KEY, 'dark');
      },
    });
    expect(result).toMatchObject({
      status: 'failed',
      manualRecoveryRequired: true,
      reloadRequired: true,
    });
    expect(journal.peek()?.conflicted).not.toBe(true);
    expect(input.storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(workspaceAccess.canWrite()).toBe(false);
  });

  it('does not report success when an uncoordinated tab edits during final PDF sealing', async () => {
    const input = await request();
    const journal = memoryJournal();
    const put = input.blobs.put;
    let puts = 0;
    input.blobs.put = async (hash, value) => {
      await put(hash, value);
      if (++puts === 2) input.storage.setItem(THEME_STORAGE_KEY, 'older-tab-edit');
    };
    expect(await executeRestore({ ...input, journal })).toMatchObject({
      status: 'failed',
      reloadRequired: true,
    });
    expect(input.storage.getItem(THEME_STORAGE_KEY)).toBe('older-tab-edit');
    expect(journal.peek() ?? journal.checkpoint()).not.toBeNull();
  });

  it('never rolls back a published restore when a tab changes a key during final publication', async () => {
    const input = await request();
    const journal = memoryJournal();
    const publish = journal.publishCheckpoint;
    journal.publishCheckpoint = async (checkpoint) => {
      await publish(checkpoint);
      input.storage.removeItem(PROJECTS_STORAGE_KEY);
    };
    expect(await executeRestore({ ...input, journal })).toMatchObject({
      status: 'failed',
      reloadRequired: true,
    });
    expect(input.storage.getItem(PROJECTS_STORAGE_KEY)).toBeNull();
    expect(input.storage.getItem(KNOWLEDGE_STORAGE_KEY)).toContain('KZG commitment');
    expect(journal.checkpoint()).toMatchObject({ outcome: 'restored', retired: true });
    expect(input.blobs.files.has(SHA_A)).toBe(true);
  });

  it('does not announce success after a concurrent edit during deferred cleanup', async () => {
    const input = await request();
    const journal = memoryJournal();
    const external = serializeProjects({
      ...EMPTY_STATE,
      papers: { external: paper('external', 'newer work') },
    });
    const blobs: PdfBlobStore = {
      ...input.blobs,
      queueCleanup: async () => {
        input.storage.setItem(PROJECTS_STORAGE_KEY, external);
      },
    };
    expect(await executeRestore({ ...input, journal, blobs })).toMatchObject({
      status: 'failed',
      reloadRequired: true,
    });
    expect(input.storage.getItem(PROJECTS_STORAGE_KEY)).toBe(external);
    expect(journal.checkpoint()).toMatchObject({ outcome: 'restored', retired: true });
    expect(workspaceAccess.canWrite()).toBe(false);
  });

  it('keeps final evidence if retirement fails and never overwrites unknown later edits', async () => {
    const input = await request();
    const journal = memoryJournal();
    journal.retireCheckpoint = async () => {
      throw new Error('retirement failed');
    };
    const result = await executeRestore({ ...input, journal });
    expect(result.status).toBe('restored');
    expect(journal.checkpoint()?.retired).toBe(false);
    expect(await recoverInterruptedRestore({ ...input, journal })).toBe('blocked');
    input.storage.setItem(THEME_STORAGE_KEY, 'later-edit');
    expect(
      await recoverInterruptedRestore({ storage: input.storage, journal, blobs: input.blobs }),
    ).toBe('blocked');
    expect(input.storage.getItem(THEME_STORAGE_KEY)).toBe('later-edit');
    expect(input.blobs.files.has(SHA_A)).toBe(true);
  });

  it('does not claim verified rollback after a concurrent edit during rollback cleanup', async () => {
    const input = await request();
    const journal = memoryJournal();
    input.storage.failOn.add(KNOWLEDGE_STORAGE_KEY);
    const remove = input.blobs.remove;
    input.blobs.remove = async (hash) => {
      await remove(hash);
      input.storage.setItem(THEME_STORAGE_KEY, 'concurrent-rollback-edit');
    };
    expect(await executeRestore({ ...input, journal })).toMatchObject({
      status: 'failed',
      rolledBack: false,
      reloadRequired: true,
    });
    expect(input.storage.getItem(THEME_STORAGE_KEY)).toBe('concurrent-rollback-edit');
    expect(journal.checkpoint()).toMatchObject({ outcome: 'rolled-back', retired: true });
  });

  it('retains failed PDF cleanup for the next startup instead of discarding its journal', async () => {
    const input = await request();
    const journal = memoryJournal();
    input.storage.failOn.add(KNOWLEDGE_STORAGE_KEY);
    const remove = input.blobs.remove;
    input.blobs.remove = async () => {
      throw new Error('delete failed');
    };
    const result = await executeRestore({ ...input, journal });
    expect(result).toMatchObject({ status: 'failed', rolledBack: false });
    expect(journal.peek() ?? journal.checkpoint()).not.toBeNull();
    expect(input.blobs.files.has(SHA_A)).toBe(true);
    input.blobs.remove = remove;
    expect(
      await recoverInterruptedRestore({ storage: input.storage, journal, blobs: input.blobs }),
    ).toBe('rolled-back');
    expect(input.blobs.files.has(SHA_A)).toBe(false);
    expect(journal.peek()).toBeNull();
  });

  it('does not accept unavailable PDF storage as proof that a pending file is absent', async () => {
    const journal = memoryJournal();
    await journal.write({
      id: 'pending',
      startedAt: 1,
      keys: {},
      phase: 'prepared',
      pdfsPending: [SHA_A],
    });
    const blobs = { ...blobStore(), durable: false };
    expect(await recoverInterruptedRestore({ storage: new MemoryStore(), journal, blobs })).toBe(
      'blocked',
    );
    expect(journal.peek() ?? journal.checkpoint()).not.toBeNull();
  });

  it('keeps PDF origins recorded only by a summary or a malformed optional binding', () => {
    const p = paper('p', 'provenance', {
      summary: {
        text: 'summary',
        provider: 'mock',
        providerLabel: 'mock',
        model: 'm',
        online: false,
        createdAt: 1,
        pdfSha256: SHA_A,
      },
    });
    const raw = JSON.stringify({
      version: SCHEMA_VERSION,
      ...EMPTY_STATE,
      papers: { p: { ...p, pdf: { sha256: 'a'.repeat(64) } } },
    });
    const hashes = readPdfReferences(new MemoryStore({ [PROJECTS_STORAGE_KEY]: raw }));
    expect(hashes?.has(SHA_A)).toBe(true);
    expect(hashes?.has('a'.repeat(64))).toBe(true);
  });
});

describe('durable final-state checkpoints', () => {
  async function restored() {
    const { file } = await backupFile(sampleSource());
    const inspection = await inspectBackupFile(file, {
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      presentPdfHashes: new Set(),
      availableBytes: null,
    });
    const storage = new MemoryStore();
    const journal = memoryJournal();
    const blobs = blobStore();
    const input = {
      file,
      inspection,
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      choice: DEFAULT_RESTORE_CHOICE,
      storage,
      journal,
      blobs,
      now: NOW.getTime(),
    };
    return { input, result: await executeRestore(input) };
  }

  it('retains exact durable redo bytes after success and repairs browser-process loss before mounting', async () => {
    const { input, result } = await restored();
    expect(result.status).toBe('restored');
    const expected = new Map(input.storage.items);
    expect(input.journal.checkpoint()).not.toBeNull();
    expect(input.journal.checkpoint()?.retired).toBe(false);
    input.storage.items.clear(); // Simulate SIGKILL losing LocalStorage's unflushed batch.
    expect(await recoverInterruptedRestore(input)).toBe('completed');
    expect(input.storage.items).toEqual(expected);
    expect(input.journal.checkpoint()?.retired).toBe(true);
    expect(input.journal.peek()).toBeNull();
  });

  it('never replays a retired checkpoint over later deliberate edits or reverts', async () => {
    const { input } = await restored();
    await recoverInterruptedRestore(input);
    input.storage.setItem(THEME_STORAGE_KEY, 'light');
    const changed = { ...sampleSource().projects, papers: {} };
    const raw = serializeProjects({ ...changed, projects: [], annotations: [] });
    input.storage.setItem(PROJECTS_STORAGE_KEY, raw);
    expect(await recoverInterruptedRestore(input)).not.toBe('blocked');
    expect(input.storage.getItem(PROJECTS_STORAGE_KEY)).toBe(raw);
    expect(input.storage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('fails closed with retained evidence if a second crash loses data after editable resumption', async () => {
    const { input } = await restored();
    await recoverInterruptedRestore(input);
    input.storage.items.clear();
    expect(await recoverInterruptedRestore(input)).toBe('blocked');
    expect(input.storage.items.size).toBe(0);
    expect(input.journal.checkpoint()?.keys[PROJECTS_STORAGE_KEY]?.next).toContain('一篇论文');
  });

  it('preflights every value before repairing any checkpoint key', async () => {
    const { input } = await restored();
    input.storage.items.clear();
    input.storage.setItem(KNOWLEDGE_STORAGE_KEY, 'unknown writer payload');
    const original = new Map(input.storage.items);
    expect(await recoverInterruptedRestore(input)).toBe('blocked');
    expect(input.storage.items).toEqual(original);
    expect(input.journal.checkpoint()?.retired).toBe(true);
  });

  it('rejects corrupted redo bytes without touching LocalStorage', async () => {
    const { input } = await restored();
    const checkpoint = input.journal.checkpoint();
    expect(checkpoint).not.toBeNull();
    if (checkpoint === null) return;
    checkpoint.keys[PROJECTS_STORAGE_KEY]!.next = 'tampered';
    input.storage.items.clear();
    expect(await recoverInterruptedRestore(input)).toBe('blocked');
    expect(input.storage.items.size).toBe(0);
  });
  it.each(['prior', 'mixed'])(
    'replays a fully preflighted checkpoint from %s disk values',
    async (state) => {
      const { input } = await restored();
      const checkpoint = input.journal.checkpoint()!;
      const expected = new Map(input.storage.items);
      let index = 0;
      for (const [key, entry] of Object.entries(checkpoint.keys)) {
        if (state === 'mixed' && index++ % 2 === 0) continue;
        if (entry.previous === null) input.storage.removeItem(key);
        else input.storage.setItem(key, entry.previous);
      }
      expect(await recoverInterruptedRestore(input)).toBe('completed');
      expect(input.storage.items).toEqual(expected);
    },
  );

  it('does not repair any metadata when a required PDF is missing or corrupt', async () => {
    const { input } = await restored();
    input.storage.items.clear();
    input.blobs.files.delete(SHA_A);
    expect(await recoverInterruptedRestore(input)).toBe('blocked');
    expect(input.storage.items.size).toBe(0);
    input.blobs.files.set(SHA_A, bytes('corrupted'));
    expect(await recoverInterruptedRestore(input)).toBe('blocked');
    expect(input.storage.items.size).toBe(0);
    expect(input.journal.checkpoint()?.retired).toBe(false);
  });

  it('keeps a replayable checkpoint after partial recovery and retries idempotently', async () => {
    const { input } = await restored();
    const expected = new Map(input.storage.items);
    input.storage.items.clear();
    input.storage.failOn.add(KNOWLEDGE_STORAGE_KEY);
    expect(await recoverInterruptedRestore(input)).toBe('blocked');
    expect(input.journal.checkpoint()?.retired).toBe(false);
    input.storage.failOn.clear();
    expect(await recoverInterruptedRestore(input)).toBe('completed');
    expect(input.storage.items).toEqual(expected);
  });

  it('detects an older tab editing during asynchronous PDF preflight before any repair', async () => {
    const { input } = await restored();
    input.storage.items.clear();
    const get = input.blobs.get;
    input.blobs.get = async (hash) => {
      input.storage.setItem(THEME_STORAGE_KEY, 'uncoordinated-tab');
      return get(hash);
    };
    expect(await recoverInterruptedRestore(input)).toBe('blocked');
    expect(input.storage.items).toEqual(new Map([[THEME_STORAGE_KEY, 'uncoordinated-tab']]));
    expect(input.journal.checkpoint()?.retired).toBe(true);
  });

  it('blocks writes until strict retirement succeeds, without clearing the recovery copy', async () => {
    const { input } = await restored();
    const retire = input.journal.retireCheckpoint;
    input.journal.retireCheckpoint = async () => {
      throw new Error('strict commit aborted');
    };
    expect(await recoverInterruptedRestore(input)).toBe('blocked');
    expect(workspaceAccess.canWrite()).toBe(false);
    expect(input.journal.checkpoint()?.retired).toBe(false);
    input.journal.retireCheckpoint = retire;
    expect(await recoverInterruptedRestore(input)).toBe('completed');
    expect(input.journal.checkpoint()?.retired).toBe(true);
  });

  it('retains unchanged core data during a no-op merge, not only changed preferences', async () => {
    const { input } = await restored();
    expect(await recoverInterruptedRestore(input)).toBe('completed');
    workspaceAccess.allowWrites();
    const current = sampleSource();
    const preferences = readBackupPreferences(input.storage);
    const inspection = await inspectBackupFile(input.file, {
      current,
      currentPreferences: preferences,
      presentPdfHashes: new Set([SHA_A]),
      availableBytes: null,
    });
    expect(
      (await executeRestore({ ...input, inspection, current, currentPreferences: preferences }))
        .status,
    ).toBe('restored');
    expect(input.journal.checkpoint()?.keys[PROJECTS_STORAGE_KEY]?.next).toBe(
      input.storage.getItem(PROJECTS_STORAGE_KEY),
    );
    const expected = new Map(input.storage.items);
    input.storage.items.clear();
    expect(await recoverInterruptedRestore(input)).toBe('completed');
    expect(input.storage.items).toEqual(expected);
  });

  it('keeps successful rollback replayable through process loss and requires reload', async () => {
    const { file } = await backupFile(sampleSource());
    const storage = new MemoryStore({
      [PROJECTS_STORAGE_KEY]: serializeProjects(EMPTY_STATE),
      [KNOWLEDGE_STORAGE_KEY]: JSON.stringify(EMPTY_SOURCE.knowledge),
    });
    const previous = new Map(storage.items);
    const inspection = await inspectBackupFile(file, {
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      presentPdfHashes: new Set(),
      availableBytes: null,
    });
    const journal = memoryJournal();
    const publish = journal.publishCheckpoint;
    journal.publishCheckpoint = async (checkpoint) => {
      if (checkpoint.outcome === 'restored') throw new Error('commit failed');
      return publish(checkpoint);
    };
    const input = {
      file,
      inspection,
      current: EMPTY_SOURCE,
      currentPreferences: { ...EMPTY_PREFERENCES },
      choice: DEFAULT_RESTORE_CHOICE,
      storage,
      journal,
      blobs: blobStore(),
      now: NOW.getTime(),
    };
    const result = await executeRestore(input);
    expect(result).toMatchObject({ status: 'failed', rolledBack: true, reloadRequired: true });
    expect(workspaceAccess.canWrite()).toBe(false);
    expect(journal.checkpoint()).toMatchObject({ outcome: 'rolled-back', retired: false });
    storage.items.clear();
    expect(await recoverInterruptedRestore(input)).toBe('rolled-back');
    expect(storage.items).toEqual(previous);
    expect(journal.checkpoint()?.retired).toBe(true);
  });
  it('retires replay authority without mounting after a concurrent cleanup edit', async () => {
    const { input } = await restored();
    const blobs: PdfBlobStore = {
      ...input.blobs,
      queueCleanup: async () => {
        input.storage.setItem(THEME_STORAGE_KEY, 'external-cleanup-edit');
      },
    };
    expect(await recoverInterruptedRestore({ ...input, blobs })).toBe('blocked');
    expect(input.storage.getItem(THEME_STORAGE_KEY)).toBe('external-cleanup-edit');
    expect(input.journal.checkpoint()?.retired).toBe(true);
  });

  it('blocks after a concurrent loss during strict retirement without replaying again', async () => {
    const { input } = await restored();
    const retire = input.journal.retireCheckpoint;
    input.journal.retireCheckpoint = async (id) => {
      await retire(id);
      input.storage.removeItem(PROJECTS_STORAGE_KEY);
    };
    expect(await recoverInterruptedRestore(input)).toBe('blocked');
    expect(input.storage.getItem(PROJECTS_STORAGE_KEY)).toBeNull();
    expect(input.journal.checkpoint()?.retired).toBe(true);
    expect(await recoverInterruptedRestore(input)).toBe('blocked');
    expect(input.storage.getItem(PROJECTS_STORAGE_KEY)).toBeNull();
  });
  it('preserves an exact prior value after a detected post-commit conflict and reload', async () => {
    const { input } = await restored();
    const blobs: PdfBlobStore = {
      ...input.blobs,
      queueCleanup: async () => input.storage.removeItem(THEME_STORAGE_KEY),
    };
    expect(await recoverInterruptedRestore({ ...input, blobs })).toBe('blocked');
    expect(input.journal.checkpoint()?.retired).toBe(true);
    expect(await recoverInterruptedRestore(input)).toBe('none');
    expect(input.storage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('signals manual-only recovery if a detected checkpoint conflict cannot be durably retired', async () => {
    const { input } = await restored();
    const manual = vi.fn();
    input.journal.retireCheckpoint = async () => {
      throw new Error('disk unavailable');
    };
    const blobs: PdfBlobStore = {
      ...input.blobs,
      queueCleanup: async () => input.storage.removeItem(THEME_STORAGE_KEY),
    };
    expect(await recoverInterruptedRestore({ ...input, blobs, onManualRecovery: manual })).toBe(
      'blocked',
    );
    expect(manual).toHaveBeenCalled();
    expect(input.journal.checkpoint()?.retired).toBe(false);
    expect(workspaceAccess.canWrite()).toBe(false);
  });
});
