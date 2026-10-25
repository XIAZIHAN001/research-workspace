import { describe, expect, it } from 'vitest';
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
  readRecoveryCopies,
  recoverInterruptedRestore,
  type BackupSource,
} from './backupService';
import { sha256Hex } from './backupFormat';
import type { RestoreJournal, RestoreJournalStore } from './restoreJournal';
import {
  EMPTY_PREFERENCES,
  DEFAULT_RESTORE_CHOICE,
  type RestoreSource,
} from '../domain/backupPlan';
import { KNOWLEDGE_STORAGE_KEY } from './knowledgeStore';
import { DIFFICULTY_PREFS_KEY, DIFFICULTY_STORAGE_KEY } from './difficultyStore';
import { PROJECTS_STORAGE_KEY, THEME_STORAGE_KEY } from '../app/config';

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

function memoryJournal(): RestoreJournalStore & { peek: () => RestoreJournal | null } {
  let journal: RestoreJournal | null = null;
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
  return { projects, knowledge, difficulties };
}

const EMPTY_SOURCE: RestoreSource = {
  projects: EMPTY_STATE,
  knowledge: { version: 2, concepts: [], evidence: [], relations: [], rejections: [] },
  difficulties: { pages: {}, ignored: {} },
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
      concepts: 1,
      evidence: 1,
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

    const second = await inspectBackupFile(file, {
      ...options,
      current: sampleSource(),
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
    expect(journal.peek()).not.toBeNull();
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
