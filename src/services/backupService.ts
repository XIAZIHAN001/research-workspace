/**
 * Exporting, inspecting and restoring a whole workspace.
 *
 * The three operations are deliberately separate. Export only reads. Inspection reads the
 * backup, verifies every byte and computes a plan, touching neither LocalStorage nor
 * IndexedDB. Restore is the only writer, and before it writes anything it puts a journal in
 * IndexedDB holding the value each key had before and a digest of the value it will have
 * afterwards; that is what makes a failure recoverable rather than merely reported.
 *
 * The order of writes matters. PDFs go first because the blob store is content-addressed and
 * additive: a copy can never damage an existing file, and abandoning one leaves an unreferenced
 * blob, not a broken paper. LocalStorage goes second, with every key backed by the journal.
 * Verification comes last and reads the data back out of storage; a restore that cannot be
 * read back is rolled back and reported as failed, never as "partly successful".
 */

import type { Paper } from '../domain/papers';
import type { ProjectsState } from '../domain/projectsState';
import type { KnowledgeState } from '../domain/knowledge';
import {
  mergeRestore,
  parseBackupData,
  planRestore,
  type BackupContents,
  type BackupPreferences,
  type MergeStats,
  type RestoreChoice,
  type RestorePlan,
  type RestoreSource,
} from '../domain/backupPlan';
import { parseKnowledgeState } from '../domain/knowledge';
import { migrateStoredPayload, SCHEMA_VERSION, serializeProjects } from '../domain/migrate';
import type { DifficultyPrefs, DifficultyState } from '../domain/difficulty';
import {
  loadDifficulties,
  serializeDifficulties,
  DIFFICULTY_PREFS_KEY,
  DIFFICULTY_STORAGE_KEY,
} from './difficultyStore';
import { KNOWLEDGE_STORAGE_KEY, KNOWLEDGE_VERSION } from './knowledgeStore';
import type { KeyValueStore } from './storage';
import { defaultStore, readItem } from './storage';
import {
  AVATAR_STORAGE_KEY,
  PAPER_STORAGE_KEY,
  PROJECTS_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from '../app/config';
import {
  countData,
  createBackupBlob,
  inspectBackupContainer,
  readBackupFile,
  sha256Hex,
  type BackupHeader,
} from './backupFormat';
import type { PdfBlobStore } from './pdfStore';
import type { RestoreJournal, RestoreJournalStore } from './restoreJournal';

const PREF_THEMES: ReadonlySet<string> = new Set(['system', 'light', 'dark']);
const PREF_PAPER: ReadonlySet<string> = new Set(['auto', 'original', 'warm', 'dark']);
/** Copies kept aside when stored data could not be read; safe to discard, never primary data. */
export const RECOVERY_KEYS = [
  'rw.projects.backup',
  'rw.projects.backup.2',
  'rw.projects.backup.3',
  'rw.projects.corrupt',
  'rw.projects.corrupt.2',
  'rw.projects.corrupt.3',
  'rw.knowledge.corrupt',
] as const;

const KEY_LABEL: Record<string, string> = {
  [PROJECTS_STORAGE_KEY]: '项目与论文',
  [KNOWLEDGE_STORAGE_KEY]: '知识',
  [DIFFICULTY_STORAGE_KEY]: '难点缓存',
  [THEME_STORAGE_KEY]: '外观设置',
  [PAPER_STORAGE_KEY]: '纸张模式',
  [AVATAR_STORAGE_KEY]: '头像',
  [DIFFICULTY_PREFS_KEY]: '难点面板设置',
};

/* ------------------------------------------------------------------ *
 * Reading what this machine currently has
 * ------------------------------------------------------------------ */

export interface BackupSource extends RestoreSource {
  difficulties: DifficultyState;
}

export function readBackupPreferences(
  store: KeyValueStore | null = defaultStore(),
): BackupPreferences {
  const theme = readItem(THEME_STORAGE_KEY, store);
  const paper = readItem(PAPER_STORAGE_KEY, store);
  const avatar = readItem(AVATAR_STORAGE_KEY, store);
  let difficulty: DifficultyPrefs | null = null;
  const rawPrefs = readItem(DIFFICULTY_PREFS_KEY, store);
  if (rawPrefs !== null) {
    try {
      const parsed: unknown = JSON.parse(rawPrefs);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        difficulty = {
          enabled: record.enabled === true,
          markersVisible: record.markersVisible !== false,
        };
      }
    } catch {
      difficulty = null;
    }
  }
  return {
    theme: theme !== null && PREF_THEMES.has(theme) ? theme : null,
    paper: paper !== null && PREF_PAPER.has(paper) ? paper : null,
    avatar: typeof avatar === 'string' && avatar !== '' ? avatar : null,
    difficulty,
  };
}

/** Payloads a previous build set aside. They are part of what the reader has, so they travel. */
export function readRecoveryCopies(
  store: KeyValueStore | null = defaultStore(),
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const key of RECOVERY_KEYS) {
    const raw = readItem(key, store);
    if (raw !== null) kept[key] = raw;
  }
  return kept;
}

export function readBackupSource(
  input: { projects: ProjectsState; knowledge: KnowledgeState },
  store: KeyValueStore | null = defaultStore(),
): BackupSource {
  return {
    projects: input.projects,
    knowledge: input.knowledge,
    difficulties: loadDifficulties(store),
  };
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

export interface ExportResult {
  blob: Blob;
  header: BackupHeader;
  /** Hashes known at export time but no longer in the blob store. */
  missingFiles: string[];
  /** Papers whose file could not be read back and verified. */
  missingPapers: string[];
}

/**
 * Assembles the backup in memory, reading each PDF once.
 *
 * A stored blob whose bytes no longer hash to its key is treated as missing rather than packed
 * under a hash it does not match: the backup's whole integrity story is that a file's name *is*
 * its content.
 */
export async function buildBackup(input: {
  source: BackupSource;
  preferences: BackupPreferences;
  recovery: Record<string, string>;
  blobs: PdfBlobStore;
  now: Date;
}): Promise<ExportResult> {
  const byHash = new Map<string, string>();
  const missingPapers: string[] = [];
  for (const paper of Object.values(input.source.projects.papers)) {
    const pdf = paper.pdf;
    if (pdf === undefined) continue;
    if (!byHash.has(pdf.sha256)) byHash.set(pdf.sha256, pdf.name);
  }

  const files = [];
  const missingFiles: string[] = [];
  for (const [sha256, name] of byHash) {
    const bytes = await input.blobs.get(sha256);
    if (bytes === null) {
      missingFiles.push(sha256);
      for (const paper of Object.values(input.source.projects.papers)) {
        if (paper.pdf?.sha256 === sha256) missingPapers.push(paper.title);
      }
      continue;
    }
    const digest = await sha256Hex(bytes);
    if (digest !== sha256) {
      missingFiles.push(sha256);
      for (const paper of Object.values(input.source.projects.papers)) {
        if (paper.pdf?.sha256 === sha256) missingPapers.push(paper.title);
      }
      continue;
    }
    files.push({ sha256, name, bytes });
  }

  const data = {
    projects: JSON.parse(serializeProjects(input.source.projects)) as unknown,
    knowledge: input.source.knowledge,
    difficulties: JSON.parse(serializeDifficulties(input.source.difficulties)) as unknown,
    preferences: input.preferences,
    recovery: input.recovery,
    missingFiles,
  };

  const { blob, header } = await createBackupBlob({
    data,
    files,
    missingFiles,
    createdAt: input.now.toISOString(),
    app: {
      name: '论文阅读解构',
      projectsSchema: SCHEMA_VERSION,
      knowledgeVersion: KNOWLEDGE_VERSION,
    },
  });
  return { blob, header, missingFiles, missingPapers };
}

/* ------------------------------------------------------------------ *
 * Inspection
 * ------------------------------------------------------------------ */

export interface BackupInspection {
  fileName: string;
  fileSize: number;
  problems: string[];
  warnings: string[];
  unsupportedVersion: boolean;
  createdAt: string | null;
  /** Counts as recorded in the file, before any merge with what is already here. */
  summary: Record<string, number> | null;
  header: BackupHeader | null;
  /** Where the payload starts. Needed to read a file during the restore itself. */
  payloadOffset: number | null;
  contents: BackupContents | null;
  plan: RestorePlan | null;
}

/** Every PDF the current registry refers to that is actually present in the blob store. */
export async function presentPdfHashes(
  papers: Record<string, Paper>,
  blobs: PdfBlobStore,
): Promise<Set<string>> {
  const hashes = new Set<string>();
  for (const paper of Object.values(papers)) {
    const sha = paper.pdf?.sha256;
    if (sha !== undefined) hashes.add(sha);
  }
  const present = new Set<string>();
  for (const sha of hashes) {
    if (await blobs.has(sha)) present.add(sha);
  }
  return present;
}

export async function availableBytes(blobs: PdfBlobStore): Promise<number | null> {
  const usage = await blobs.usage();
  if (usage === null) return null;
  return Math.max(0, usage.quota - usage.used);
}

/**
 * Reads a picked file and works out what restoring it would mean — without writing anything.
 *
 * This is where "don't trust the file" lives: framing, version, shape, every file's hash and
 * PDF signature, every cross-object reference, and the merge against this machine's current
 * workspace. The result is either a list of reasons it cannot be used or a plan the reader can
 * inspect and confirm.
 */
export async function inspectBackupFile(
  file: File,
  input: {
    current: RestoreSource;
    currentPreferences: BackupPreferences;
    presentPdfHashes: ReadonlySet<string>;
    availableBytes: number | null;
    now?: number;
    onProgress?: (done: number, total: number) => void;
  },
): Promise<BackupInspection> {
  const base: BackupInspection = {
    fileName: file.name,
    fileSize: file.size,
    problems: [],
    warnings: [],
    unsupportedVersion: false,
    createdAt: null,
    summary: null,
    header: null,
    payloadOffset: null,
    contents: null,
    plan: null,
  };

  const container = await inspectBackupContainer(file, input.onProgress);
  if (!container.ok) {
    return {
      ...base,
      problems: container.problems,
      unsupportedVersion: container.kind === 'unsupported-version',
    };
  }

  const parsed = parseBackupData(container.header.data);
  if (!parsed.ok) {
    return {
      ...base,
      header: container.header,
      payloadOffset: container.payloadOffset,
      problems: parsed.problems,
      warnings: container.warnings,
    };
  }

  const plan = planRestore({
    current: input.current,
    currentPreferences: input.currentPreferences,
    contents: parsed.contents,
    fileHashes: container.fileHashes,
    fileBytes: container.fileBytes,
    presentPdfHashes: input.presentPdfHashes,
    availableBytes: input.availableBytes,
    now: input.now ?? Date.now(),
  });

  return {
    ...base,
    warnings: [...container.warnings, ...parsed.warnings, ...plan.warnings],
    createdAt: typeof container.header.createdAt === 'string' ? container.header.createdAt : null,
    summary: countData(container.header.data),
    header: container.header,
    payloadOffset: container.payloadOffset,
    contents: parsed.contents,
    plan,
  };
}

/* ------------------------------------------------------------------ *
 * Restore
 * ------------------------------------------------------------------ */

export type RestoreStage = 'journal' | 'pdfs' | 'data' | 'verify';

export interface RestoreVerification {
  keys: number;
  pdfs: number;
  projects: number;
  papers: number;
  annotations: number;
  concepts: number;
  evidence: number;
  relations: number;
  rejections: number;
}

export type RestoreResult =
  | {
      status: 'restored';
      stats: MergeStats;
      verification: RestoreVerification;
      warnings: string[];
      pdfsCopied: number;
    }
  | { status: 'refused'; reason: string; problems: string[] }
  | {
      status: 'failed';
      stage: RestoreStage;
      message: string;
      rolledBack: boolean;
      problems: string[];
      pdfsCopied: number;
    };

interface KeyWrite {
  key: string;
  value: string;
  label: string;
  sha256: string;
}

function labelOf(key: string): string {
  return KEY_LABEL[key] ?? key;
}

function isQuotaError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === 'QuotaExceededError' || code === 22;
}

function writeStrict(
  store: KeyValueStore | null,
  key: string,
  value: string,
): 'ok' | 'quota' | 'failed' {
  if (store === null) return 'failed';
  try {
    store.setItem(key, value);
    return 'ok';
  } catch (error) {
    return isQuotaError(error) ? 'quota' : 'failed';
  }
}

function removeStrict(store: KeyValueStore | null, key: string): boolean {
  if (store === null) return false;
  try {
    store.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** Puts every written key back to its previous value. Returns false if any write failed. */
function rollback(
  store: KeyValueStore | null,
  previous: ReadonlyMap<string, string | null>,
  written: readonly string[],
): boolean {
  let ok = true;
  for (const key of written) {
    const value = previous.get(key) ?? null;
    if (value === null) {
      if (!removeStrict(store, key)) ok = false;
    } else if (writeStrict(store, key, value) !== 'ok') {
      ok = false;
    }
  }
  return ok;
}

function preferenceWrites(
  patch: ReturnType<typeof mergeRestore>['preferences'],
): { key: string; value: string }[] {
  const writes: { key: string; value: string }[] = [];
  if (patch.theme !== undefined) writes.push({ key: THEME_STORAGE_KEY, value: patch.theme });
  if (patch.paper !== undefined) writes.push({ key: PAPER_STORAGE_KEY, value: patch.paper });
  if (patch.avatar !== undefined) writes.push({ key: AVATAR_STORAGE_KEY, value: patch.avatar });
  if (patch.difficulty !== undefined) {
    writes.push({ key: DIFFICULTY_PREFS_KEY, value: JSON.stringify(patch.difficulty) });
  }
  return writes;
}

/**
 * Restores a backup that has already been inspected and confirmed.
 *
 * `choice` is the reader's answer to the two questions the file cannot answer: what to do
 * about same-id objects whose content differs, and whether to restore papers whose PDF is
 * missing. Everything else was decided during inspection.
 */
export async function executeRestore(input: {
  file: File;
  inspection: BackupInspection;
  choice: RestoreChoice;
  current: RestoreSource;
  currentPreferences: BackupPreferences;
  storage: KeyValueStore | null;
  blobs: PdfBlobStore;
  journal: RestoreJournalStore;
  now: number;
  onStage?: (stage: RestoreStage, detail?: string) => void;
}): Promise<RestoreResult> {
  const { inspection, choice, storage, blobs } = input;
  const contents = inspection.contents;
  const plan = inspection.plan;
  const header = inspection.header;
  const payloadOffset = inspection.payloadOffset;
  if (contents === null || plan === null || header === null || payloadOffset === null) {
    return { status: 'refused', reason: '这个备份还没有完成检查。', problems: [] };
  }
  if (plan.blockers.length > 0) {
    return {
      status: 'refused',
      reason: '备份里存在无法自动判断的身份冲突，没有写入任何数据。',
      problems: plan.blockers,
    };
  }
  if (plan.missingPdfPapers.length > 0 && !choice.importMissingPdfs) {
    return {
      status: 'refused',
      reason: '有论文的 PDF 不在备份里，请先确认是否仍然恢复这些记录。',
      problems: plan.missingPdfPapers.map((paper) => `《${paper.title}》缺少 PDF。`),
    };
  }
  if (!plan.storageSufficient) {
    return {
      status: 'refused',
      reason: '本机可用空间不足以存放备份里的 PDF，没有写入任何数据。',
      problems: [
        `需要约 ${String(Math.ceil(plan.neededBytes / 1024 / 1024))} MB，本机可用约 ${String(
          Math.floor((plan.availableBytes ?? 0) / 1024 / 1024),
        )} MB。`,
      ],
    };
  }

  const merged = mergeRestore(input.current, contents, choice, input.currentPreferences, input.now);

  /* Build the exact set of LocalStorage writes. Identical values are left alone. */
  const writes: { key: string; value: string; label: string }[] = [];
  const addDataWrite = (key: string, value: string): void => {
    if (readItem(key, storage) === value) return;
    writes.push({ key, value, label: labelOf(key) });
  };
  addDataWrite(PROJECTS_STORAGE_KEY, serializeProjects(merged.projects));
  addDataWrite(KNOWLEDGE_STORAGE_KEY, JSON.stringify(merged.knowledge));
  if (
    Object.keys(contents.difficulties.pages).length > 0 ||
    Object.keys(contents.difficulties.ignored).length > 0
  ) {
    addDataWrite(DIFFICULTY_STORAGE_KEY, serializeDifficulties(merged.difficulties));
  }
  for (const entry of preferenceWrites(merged.preferences)) addDataWrite(entry.key, entry.value);

  /* Recovery copies never overwrite one already on this machine. */
  const recoveryWarnings: string[] = [];
  for (const [key, value] of Object.entries(contents.recovery)) {
    if (readItem(key, storage) === value) continue;
    let target = key;
    for (let slot = 0; slot < 3 && readItem(target, storage) !== null; slot += 1) {
      target = `${key}.restored${slot === 0 ? '' : `.${String(slot)}`}`;
    }
    if (readItem(target, storage) !== null) {
      recoveryWarnings.push(`本机已经有多份「${key}」的副本，这一份没有写入。`);
      continue;
    }
    writes.push({ key: target, value, label: '恢复副本' });
  }

  const normalized: KeyWrite[] = [];
  for (const write of writes) {
    normalized.push({ ...write, sha256: await sha256Hex(write.value) });
  }
  const previous = new Map<string, string | null>();
  for (const write of normalized) previous.set(write.key, readItem(write.key, storage));

  input.onStage?.('journal');
  const journal: RestoreJournal = {
    id: crypto.randomUUID(),
    startedAt: input.now,
    keys: Object.fromEntries(
      normalized.map((write) => [
        write.key,
        { previous: previous.get(write.key) ?? null, nextSha256: write.sha256 },
      ]),
    ),
  };
  try {
    await input.journal.write(journal);
  } catch (error) {
    return {
      status: 'failed',
      stage: 'journal',
      message: `无法建立恢复日志，没有写入任何数据：${describe(error)}`,
      rolledBack: true,
      problems: [],
      pdfsCopied: 0,
    };
  }

  /* 1. PDFs: additive and content-addressed, so they cannot damage anything already here. */
  input.onStage?.('pdfs');
  let pdfsCopied = 0;
  for (const hash of plan.pdfsToCopy) {
    try {
      const bytes = await readBackupFile(input.file, header, payloadOffset, hash);
      if (bytes === null) throw new Error('备份里找不到这个文件。');
      if ((await sha256Hex(bytes)) !== hash) {
        throw new Error('备份文件在检查之后发生了变化，已停止恢复。');
      }
      await blobs.put(hash, bytes);
      pdfsCopied += 1;
    } catch (error) {
      await input.journal.clear().catch(() => undefined);
      return {
        status: 'failed',
        stage: 'pdfs',
        message: `写入 PDF 时失败，项目与知识没有改动：${describe(error)}`,
        rolledBack: true,
        problems: [],
        pdfsCopied,
      };
    }
  }

  /* 2. LocalStorage, one key at a time, with the journal already on disk. */
  input.onStage?.('data');
  const written: string[] = [];
  for (const write of normalized) {
    const outcome = writeStrict(storage, write.key, write.value);
    if (outcome !== 'ok') {
      const rolledBack = rollback(storage, previous, written);
      if (rolledBack) await input.journal.clear().catch(() => undefined);
      return {
        status: 'failed',
        stage: 'data',
        message:
          outcome === 'quota'
            ? `写入「${write.label}」时本地存储空间不足，已撤销本次恢复写入的内容。`
            : `写入「${write.label}」时失败，已撤销本次恢复写入的内容。`,
        rolledBack,
        problems: rolledBack ? [] : ['撤销没有完全成功，下次启动应用时会再尝试还原。'],
        pdfsCopied,
      };
    }
    written.push(write.key);
  }

  /* 3. Read it back out of storage. Only a restore that can be read back counts as done. */
  input.onStage?.('verify');
  const problems: string[] = [];
  for (const write of normalized) {
    const current = readItem(write.key, storage);
    if (current === null || (await sha256Hex(current)) !== write.sha256) {
      problems.push(`「${write.label}」没有按预期写入。`);
    }
  }
  const projectsRaw = readItem(PROJECTS_STORAGE_KEY, storage);
  const migrated = projectsRaw === null ? null : migrateStoredPayload(projectsRaw);
  if (migrated === null || !migrated.ok) {
    problems.push('恢复后的项目数据无法读回。');
  } else {
    if (migrated.state.projects.length !== merged.projects.projects.length) {
      problems.push('恢复后的项目数量与计划不一致。');
    }
    if (Object.keys(migrated.state.papers).length !== Object.keys(merged.projects.papers).length) {
      problems.push('恢复后的论文数量与计划不一致。');
    }
    if (migrated.state.annotations.length !== merged.projects.annotations.length) {
      problems.push('恢复后的笔记数量与计划不一致。');
    }
  }
  const knowledgeRaw = readItem(KNOWLEDGE_STORAGE_KEY, storage);
  let knowledgeNow: KnowledgeState | null = null;
  if (knowledgeRaw !== null) {
    try {
      knowledgeNow = parseKnowledgeState(JSON.parse(knowledgeRaw));
    } catch {
      knowledgeNow = null;
    }
  }
  if (
    knowledgeNow === null ||
    knowledgeNow.concepts.length !== merged.knowledge.concepts.length ||
    knowledgeNow.evidence.length !== merged.knowledge.evidence.length ||
    knowledgeNow.relations.length !== merged.knowledge.relations.length ||
    knowledgeNow.rejections.length !== merged.knowledge.rejections.length
  ) {
    problems.push('恢复后的知识数据无法读回，或数量与计划不一致。');
  }
  // Only the files this restore was supposed to copy are required afterwards. A paper whose
  // PDF was acknowledged as missing is restored as a record, and its absent file is not a
  // verification failure — the result already says the file is missing.
  const expectedFiles = new Set(plan.pdfsToCopy);
  for (const hash of expectedFiles) {
    if (!(await blobs.has(hash))) problems.push('有论文的 PDF 没有成功写入本地文件库。');
  }

  if (problems.length > 0) {
    const rolledBack = rollback(storage, previous, written);
    if (rolledBack) await input.journal.clear().catch(() => undefined);
    return {
      status: 'failed',
      stage: 'verify',
      message: rolledBack
        ? '恢复后的数据没有通过回读校验，已还原到恢复前的状态。'
        : '恢复后的数据没有通过回读校验，且还原没有完全成功。',
      rolledBack,
      problems,
      pdfsCopied,
    };
  }

  await input.journal.clear().catch(() => undefined);

  const pdfCount = new Set(
    Object.values(merged.projects.papers)
      .map((paper) => paper.pdf?.sha256)
      .filter((hash): hash is string => hash !== undefined),
  ).size;

  return {
    status: 'restored',
    stats: merged.stats,
    warnings: [...merged.warnings, ...recoveryWarnings],
    pdfsCopied,
    verification: {
      keys: normalized.length,
      pdfs: pdfCount,
      projects: merged.projects.projects.length,
      papers: Object.keys(merged.projects.papers).length,
      annotations: merged.projects.annotations.length,
      concepts: merged.knowledge.concepts.length,
      evidence: merged.knowledge.evidence.length,
      relations: merged.knowledge.relations.length,
      rejections: merged.knowledge.rejections.length,
    },
  };
}

/**
 * The header and payload offset the inspection already validated are carried on the
 * inspection itself, so the PDF step never re-parses a file it has already verified.
 */

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ *
 * Recovering a restore that was interrupted
 * ------------------------------------------------------------------ */

export type RestoreRecovery = 'none' | 'completed' | 'clean' | 'rolled-back' | 'blocked';

/**
 * Called once at start-up, before the stores are created.
 *
 * It answers the only question that matters after a crash: did the restore finish, not start,
 * or stop in the middle? A mixture means the old values go back — the alternative is a
 * workspace where projects point at knowledge that was never written.
 */
export async function recoverInterruptedRestore(input?: {
  storage?: KeyValueStore | null;
  journal?: RestoreJournalStore;
}): Promise<RestoreRecovery> {
  const storage = input?.storage ?? defaultStore();
  const journalStore = input?.journal;
  if (journalStore === undefined) return 'none';

  let journal: RestoreJournal | null;
  try {
    journal = await journalStore.read();
  } catch {
    // No journal store is reachable. A restore cannot have written one in this context, and
    // nothing else can be recovered from it; the dialog itself will refuse to start a restore.
    return 'none';
  }
  if (journal === null) return 'none';

  const keys = Object.keys(journal.keys);
  let allNext = true;
  let allPrevious = true;
  for (const key of keys) {
    const entry = journal.keys[key];
    if (entry === undefined) continue;
    const current = readItem(key, storage);
    if (current === null || (await sha256Hex(current)) !== entry.nextSha256) allNext = false;
    if (current !== entry.previous) allPrevious = false;
  }

  if (allNext) {
    await journalStore.clear().catch(() => undefined);
    return 'completed';
  }
  if (allPrevious) {
    await journalStore.clear().catch(() => undefined);
    return 'clean';
  }

  let ok = true;
  for (const key of keys) {
    const entry = journal.keys[key];
    if (entry === undefined) continue;
    if (readItem(key, storage) === entry.previous) continue;
    const outcome =
      entry.previous === null
        ? removeStrict(storage, key)
          ? 'ok'
          : 'failed'
        : writeStrict(storage, key, entry.previous);
    if (outcome !== 'ok') ok = false;
  }
  if (!ok) return 'blocked';
  await journalStore.clear().catch(() => undefined);
  return 'rolled-back';
}
