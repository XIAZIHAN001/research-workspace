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
import { EMPTY_STATE, type ProjectsState } from '../domain/projectsState';
import type { KnowledgeState } from '../domain/knowledge';
import { EMPTY_REVIEW_STATE, parseReviewState, type ReviewState } from '../domain/review';
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
import { EMPTY_KNOWLEDGE, parseKnowledgeState } from '../domain/knowledge';
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
  REVIEW_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from '../app/config';
import {
  countData,
  createBackupBlob,
  inspectBackupContainer,
  readBackupFile,
  sha256Hex,
  type BackupFileInput,
  type BackupHeader,
} from './backupFormat';
import type { PdfBlobStore } from './pdfStore';
import {
  assertRestoreJournal,
  assertRestoreCheckpoint,
  type RestoreCheckpoint,
  type RestoreJournal,
  type RestoreJournalStore,
} from './restoreJournal';
import { workspaceAccess, type WorkspaceWritePermit } from './workspaceAccess';

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
  [REVIEW_STORAGE_KEY]: '复习进度',
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

/** A newer build's schedule is left untouched, exactly as the live store leaves it. */
function reviewIsBlocked(store: KeyValueStore | null): boolean {
  const raw = readItem(REVIEW_STORAGE_KEY, store);
  if (raw === null) return false;
  try {
    return parseReviewState(JSON.parse(raw) as unknown)?.blocked === true;
  } catch {
    return false;
  }
}

/** Reads the schedule the same way the live store does, so a broken key starts empty. */
function readReview(store: KeyValueStore | null): ReviewState {
  const raw = readItem(REVIEW_STORAGE_KEY, store);
  if (raw === null) return EMPTY_REVIEW_STATE;
  try {
    return parseReviewState(JSON.parse(raw) as unknown)?.state ?? EMPTY_REVIEW_STATE;
  } catch {
    return EMPTY_REVIEW_STATE;
  }
}

export function readBackupSource(
  input: { projects: ProjectsState; knowledge: KnowledgeState },
  store: KeyValueStore | null = defaultStore(),
): BackupSource {
  return {
    projects: input.projects,
    knowledge: input.knowledge,
    difficulties: loadDifficulties(store),
    review: readReview(store),
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

  const files: BackupFileInput[] = [];
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
    // Hand the bytes to a Blob now and drop the Uint8Array reference. `createBackupBlob` only
    // needs a Blob-like source, and the browser can keep it out of the JavaScript heap instead
    // of holding every PDF in this array until the container is assembled.
    files.push({ sha256, name, bytes: new Blob([bytes], { type: 'application/pdf' }) });
  }

  const data = {
    projects: JSON.parse(serializeProjects(input.source.projects)) as unknown,
    knowledge: input.source.knowledge,
    difficulties: JSON.parse(serializeDifficulties(input.source.difficulties)) as unknown,
    review: input.source.review,
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
  /** Binds preview/confirmation to the exact workspace snapshot the reader inspected. */
  sourceSha256: string;
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
    sourceSha256: await sourceFingerprint(input.current, input.currentPreferences),
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
  bookmarks: number;
  glossary: number;
  reviewCards: number;
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
      /** Final LocalStorage visibility is protected by a retained checkpoint until reload. */
      reloadRequired?: boolean;
      /** Manual reconciliation or failed durable invalidation: do not offer a safe reload. */
      manualRecoveryRequired?: boolean;
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

/** Recovery must distinguish unavailable storage from a truly absent key. */
function readStrict(store: KeyValueStore | null, key: string): string | null {
  if (store === null) throw new Error('LocalStorage 不可用，已暂停恢复。');
  return store.getItem(key);
}

/** Unknown/corrupt/newer metadata is never treated as an empty reference set. */
export function readPdfReferences(
  storage: KeyValueStore | null = defaultStore(),
): ReadonlySet<string> | null {
  try {
    const raw = readStrict(storage, PROJECTS_STORAGE_KEY);
    if (raw === null) {
      // Without a registry, a surviving knowledge graph could still hold PDF references.
      const knowledgeRaw = readStrict(storage, KNOWLEDGE_STORAGE_KEY);
      if (knowledgeRaw === null) return new Set();
      const knowledge = parseKnowledgeState(JSON.parse(knowledgeRaw) as unknown);
      return knowledge === null
        ? null
        : new Set(
            [
              ...knowledge.evidence,
              ...knowledge.rejections.flatMap((rejection) => rejection.evidence),
            ].map((evidence) => evidence.pdfSha256),
          );
    }
    const parsed = migrateStoredPayload(raw);
    if (!parsed.ok) return null;
    const hashes = new Set(
      Object.values(parsed.state.papers).flatMap((paper) =>
        paper.pdf === undefined ? [] : [paper.pdf.sha256],
      ),
    );
    // The normal loader tolerates and drops malformed optional PDF metadata. GC cannot:
    // even a binding with a missing filename can still be the only reference to these bytes.
    const original = JSON.parse(raw) as Record<string, unknown>;
    if (typeof original.papers === 'object' && original.papers !== null) {
      for (const paper of Object.values(original.papers)) {
        if (typeof paper !== 'object' || paper === null) return null;
        const pdf: unknown = (paper as Record<string, unknown>).pdf;
        if (pdf === undefined) continue;
        if (typeof pdf !== 'object' || pdf === null) return null;
        const hash: unknown = (pdf as Record<string, unknown>).sha256;
        if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return null;
        hashes.add(hash);
      }
    }
    for (const note of parsed.state.annotations) hashes.add(note.pdfSha256);
    for (const paper of Object.values(parsed.state.papers)) {
      if (paper.summary?.pdfSha256 !== undefined) hashes.add(paper.summary.pdfSha256);
    }
    const knowledgeRaw = readStrict(storage, KNOWLEDGE_STORAGE_KEY);
    if (knowledgeRaw !== null) {
      const knowledge = parseKnowledgeState(JSON.parse(knowledgeRaw) as unknown);
      if (knowledge === null) return null;
      for (const evidence of knowledge.evidence) hashes.add(evidence.pdfSha256);
      for (const rejection of knowledge.rejections) {
        for (const evidence of rejection.evidence) hashes.add(evidence.pdfSha256);
      }
    }
    return hashes;
  } catch {
    return null;
  }
}

/** Only restore-owned additions are eligible. Recheck references after every async read. */
async function cleanRestorePdfs(
  journal: RestoreJournal,
  storage: KeyValueStore | null,
  blobs: PdfBlobStore | undefined,
  permit: WorkspaceWritePermit,
  defer = false,
): Promise<boolean> {
  const candidates = [...new Set([...(journal.pdfsAdded ?? []), ...(journal.pdfsPending ?? [])])];
  if (candidates.length === 0) return true;
  if (blobs === undefined || !blobs.durable) return false;
  try {
    const references = readPdfReferences(storage);
    if (references === null) return false;
    const orphans = candidates.filter((hash) => !references.has(hash));
    if (blobs.queueCleanup !== undefined) {
      await blobs.queueCleanup(orphans, permit);
      if (defer) return true;
    }
    for (const hash of orphans) {
      const bytes = await blobs.get(hash);
      if (bytes === null) continue;
      if ((await sha256Hex(bytes)) !== hash) return false;
      const latest = readPdfReferences(storage);
      if (latest === null) return false;
      if (!latest.has(hash)) await blobs.remove(hash, permit);
    }
    return true;
  } catch {
    return false;
  }
}

const CORE_CHECKPOINT_KEYS = [
  PROJECTS_STORAGE_KEY,
  KNOWLEDGE_STORAGE_KEY,
  REVIEW_STORAGE_KEY,
  DIFFICULTY_STORAGE_KEY,
];

/** Snapshot unchanged core keys too: LocalStorage may not have flushed any of them yet. */
async function checkpointFor(
  journal: RestoreJournal,
  outcome: RestoreCheckpoint['outcome'],
  storage: KeyValueStore | null,
  blobs: PdfBlobStore | undefined,
  permit: WorkspaceWritePermit,
  required: ReadonlySet<string> = new Set(),
): Promise<RestoreCheckpoint> {
  const keys: RestoreCheckpoint['keys'] = {};
  for (const key of new Set([...Object.keys(KEY_LABEL), ...Object.keys(journal.keys)])) {
    const entry = journal.keys[key];
    let previous = readStrict(storage, key);
    let next = previous;
    if (entry !== undefined) {
      if (outcome === 'restored') {
        next = Object.hasOwn(entry, 'next') ? entry.next! : previous;
        if (
          (!Object.hasOwn(entry, 'next') && next === null) ||
          (await sha256Hex(next ?? '')) !== entry.nextSha256
        ) {
          throw new Error('恢复记录缺少可验证的最终数据，已保留恢复证据。');
        }
        previous = entry.previous;
      } else {
        previous = Object.hasOwn(entry, 'next') ? entry.next! : previous;
        next = entry.previous;
      }
    }
    keys[key] = { previous, next, nextSha256: await sha256Hex(next ?? '') };
  }
  const target: KeyValueStore = {
    getItem: (key) => (Object.hasOwn(keys, key) ? keys[key]!.next : readStrict(storage, key)),
    setItem: () => {
      throw new Error('read-only snapshot');
    },
    removeItem: () => {
      throw new Error('read-only snapshot');
    },
  };
  const references = readPdfReferences(target);
  if (references === null) throw new Error('无法验证最终快照的 PDF 引用。');
  const pdfsRequired: string[] = [];
  for (const hash of references) {
    if (blobs === undefined || !blobs.durable) throw new Error('无法确认 PDF 持久化状态。');
    const bytes = await blobs.get(hash);
    if (bytes === null) {
      if (required.has(hash)) throw new Error('最终快照所需 PDF 不可用。');
      continue; // A PDF already acknowledged as missing is not promised by this checkpoint.
    }
    if ((await sha256Hex(bytes)) !== hash) throw new Error('最终快照的 PDF 校验失败。');
    // A file written by an older relaxed-durability build also needs a strict barrier.
    await blobs.put(hash, bytes, permit);
    pdfsRequired.push(hash);
  }
  return {
    id: journal.id,
    startedAt: journal.startedAt,
    keys,
    outcome,
    retired: false,
    pdfsRequired,
    pdfsToClean: [...new Set([...(journal.pdfsAdded ?? []), ...(journal.pdfsPending ?? [])])],
  };
}

const UNSAFE_RELOAD_DETAIL =
  '无法将恢复冲突状态安全写入磁盘。当前窗口已暂停写入，请勿重新载入或关闭应用；保留浏览器配置目录并联系维护人员。若强制退出，无法保证下次启动不会重放旧恢复记录。';
const ACTIVE_CONFLICT_DETAIL =
  '恢复日志已标记为冲突，自动恢复已暂停。请先关闭其他工作区窗口，并由维护人员比对当前数据和恢复日志；不要清除任何副本。';

async function activeConflictResult(
  store: RestoreJournalStore,
  journal: RestoreJournal,
  stage: RestoreStage,
  pdfsCopied: number,
): Promise<RestoreResult> {
  let durable = false;
  try {
    await store.markConflicted(journal.id);
    durable = true;
  } catch {
    /* Preserve all evidence. */
  }
  return {
    status: 'failed',
    stage,
    message: durable ? ACTIVE_CONFLICT_DETAIL : UNSAFE_RELOAD_DETAIL,
    rolledBack: false,
    reloadRequired: true,
    manualRecoveryRequired: true,
    problems: [],
    pdfsCopied,
  };
}

async function retireConflictedCheckpoint(
  store: RestoreJournalStore,
  checkpoint: RestoreCheckpoint,
  onManualRecovery?: (detail: string) => void,
): Promise<boolean> {
  try {
    await store.retireCheckpoint(checkpoint.id);
    return true;
  } catch {
    onManualRecovery?.(UNSAFE_RELOAD_DETAIL);
    return false;
  }
}

function checkpointMatchesStorage(
  checkpoint: RestoreCheckpoint,
  storage: KeyValueStore | null,
): boolean {
  return Object.entries(checkpoint.keys).every(
    ([key, entry]) => readStrict(storage, key) === entry.next,
  );
}

/** Validate the complete retained outcome before the first LocalStorage change. */
async function applyCheckpoint(
  checkpoint: RestoreCheckpoint,
  storage: KeyValueStore | null,
  blobs: PdfBlobStore | undefined,
): Promise<'applied' | 'failed' | 'changed'> {
  assertRestoreCheckpoint(checkpoint);
  const observed = new Map<string, string | null>();
  for (const [key, entry] of Object.entries(checkpoint.keys)) {
    if ((await sha256Hex(entry.next ?? '')) !== entry.nextSha256) return 'failed';
    const current = readStrict(storage, key);
    if (current !== null && current !== entry.previous && current !== entry.next) return 'changed';
    observed.set(key, current);
  }
  for (const hash of checkpoint.pdfsRequired) {
    if (blobs === undefined || !blobs.durable) return 'failed';
    const bytes = await blobs.get(hash);
    if (bytes === null || (await sha256Hex(bytes)) !== hash) return 'failed';
  }
  // Old builds do not honour the lease. Detect edits during asynchronous hash/PDF checks.
  for (const [key, value] of observed) if (readStrict(storage, key) !== value) return 'changed';
  for (const [key, entry] of Object.entries(checkpoint.keys)) {
    if (readStrict(storage, key) === entry.next) continue;
    if (
      entry.next === null
        ? !removeStrict(storage, key)
        : writeStrict(storage, key, entry.next) !== 'ok'
    )
      return 'failed';
  }
  return checkpointMatchesStorage(checkpoint, storage) ? 'applied' : 'failed';
}

async function cleanupCheckpoint(
  checkpoint: RestoreCheckpoint,
  storage: KeyValueStore | null,
  blobs: PdfBlobStore | undefined,
  permit: WorkspaceWritePermit,
  defer = false,
): Promise<boolean> {
  return cleanRestorePdfs(
    {
      id: checkpoint.id,
      startedAt: checkpoint.startedAt,
      keys: {},
      pdfsAdded: checkpoint.pdfsToClean,
    },
    storage,
    blobs,
    permit,
    defer,
  );
}

async function recoverCheckpoint(
  checkpoint: RestoreCheckpoint,
  storage: KeyValueStore | null,
  store: RestoreJournalStore,
  blobs: PdfBlobStore | undefined,
  permit: WorkspaceWritePermit,
  onManualRecovery?: (detail: string) => void,
): Promise<RestoreRecovery> {
  assertRestoreCheckpoint(checkpoint);
  for (const entry of Object.values(checkpoint.keys)) {
    if ((await sha256Hex(entry.next ?? '')) !== entry.nextSha256) return 'blocked';
  }
  if (checkpoint.retired) {
    // Once ordinary writes were allowed, even a deliberate revert may match the old value.
    // Never replay a retired copy. Missing core data is ambiguous and must not become EMPTY.
    for (const key of CORE_CHECKPOINT_KEYS) {
      if (checkpoint.keys[key]?.next != null && readStrict(storage, key) === null) return 'blocked';
    }
    return 'none';
  }
  const applied = await applyCheckpoint(checkpoint, storage, blobs);
  if (applied === 'changed') {
    await retireConflictedCheckpoint(store, checkpoint, onManualRecovery);
    return 'blocked';
  }
  if (applied !== 'applied') return 'blocked';
  const cleaned = await cleanupCheckpoint(checkpoint, storage, blobs, permit);
  if (!checkpointMatchesStorage(checkpoint, storage)) {
    await retireConflictedCheckpoint(store, checkpoint, onManualRecovery);
    return 'blocked';
  }
  if (!cleaned) return 'blocked';
  // Retirement is durable before startup can instantiate migration writers or editable stores.
  // Keep the copy for diagnostics; there is still no LocalStorage fsync primitive.
  await store.retireCheckpoint(checkpoint.id);
  if (!checkpointMatchesStorage(checkpoint, storage)) return 'blocked';
  return checkpoint.outcome === 'restored' ? 'completed' : 'rolled-back';
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

/** Stable key ordering: loader reconstruction must not create false stale-snapshot errors. */
function sourceFingerprint(source: RestoreSource, preferences: BackupPreferences): Promise<string> {
  return sha256Hex(
    JSON.stringify({ source, preferences }, (_key, value: unknown) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }),
  );
}

/** Read only. Never invoke migration/quarantine writers while establishing the restore base. */
function persistedRestoreSource(storage: KeyValueStore | null): RestoreSource {
  const projectsRaw = readStrict(storage, PROJECTS_STORAGE_KEY);
  const migrated = projectsRaw === null ? null : migrateStoredPayload(projectsRaw);
  if (migrated !== null && !migrated.ok)
    throw new Error('现有项目数据无法完整读取，已保留原始数据。');
  const knowledgeRaw = readStrict(storage, KNOWLEDGE_STORAGE_KEY);
  const knowledge =
    knowledgeRaw === null
      ? EMPTY_KNOWLEDGE
      : parseKnowledgeState(JSON.parse(knowledgeRaw) as unknown);
  if (knowledge === null) throw new Error('现有知识数据损坏或来自更新版本，已保留原始数据。');
  for (const key of [
    REVIEW_STORAGE_KEY,
    DIFFICULTY_STORAGE_KEY,
    THEME_STORAGE_KEY,
    PAPER_STORAGE_KEY,
    AVATAR_STORAGE_KEY,
    DIFFICULTY_PREFS_KEY,
  ])
    readStrict(storage, key);
  return {
    projects: migrated?.ok === true ? migrated.state : EMPTY_STATE,
    knowledge,
    difficulties: loadDifficulties(storage),
    review: readReview(storage),
  };
}

/**
 * Restores a backup that has already been inspected and confirmed.
 *
 * `choice` is the reader's answer to the two questions the file cannot answer: what to do
 * about same-id objects whose content differs, and whether to restore papers whose PDF is
 * missing. Everything else was decided during inspection.
 */
interface RestoreInput {
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
}

export async function executeRestore(input: RestoreInput): Promise<RestoreResult> {
  workspaceAccess.assertWritable();
  return workspaceAccess.exclusive(async (permit) => {
    try {
      const outstanding = await input.journal.read();
      if (outstanding !== null) throw new Error('尚有未清理的恢复日志，请先重新载入完成恢复检查。');
      const checkpoint = await input.journal.readCheckpoint();
      if (checkpoint !== null && !checkpoint.retired)
        throw new Error('最终恢复检查点尚未完成启动确认，请先重新载入。');
      const result = await executeRestoreLocked(input, permit);
      if (
        result.status === 'restored' ||
        (result.status === 'failed' && (!result.rolledBack || result.reloadRequired === true))
      )
        workspaceAccess.block();
      return result;
    } catch (error) {
      workspaceAccess.block();
      throw error;
    }
  });
}

async function executeRestoreLocked(
  input: RestoreInput,
  permit: WorkspaceWritePermit,
): Promise<RestoreResult> {
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

  // The preview is a confirmation of a particular source, not permission to overwrite
  // changes made afterwards. Re-read under the lease, after draining all in-flight writes.
  const captured = await sourceFingerprint(input.current, input.currentPreferences);
  // One raw baseline owns both the source confirmation and journal.previous. Re-reading a
  // newer baseline after an await could silently combine old merge choices with newer edits.
  const baseline = new Map<string, string | null>();
  const snapshot: KeyValueStore = {
    getItem: (key) => baseline.get(key) ?? null,
    setItem: () => {
      throw new Error('read-only restore baseline');
    },
    removeItem: () => {
      throw new Error('read-only restore baseline');
    },
  };
  const baselineUnchanged = (): boolean =>
    [...baseline].every(([key, value]) => readStrict(storage, key) === value);
  let persisted: string;
  try {
    const managed = new Set([
      ...Object.keys(KEY_LABEL),
      ...RECOVERY_KEYS.flatMap((key) => [
        key,
        `${key}.restored`,
        `${key}.restored.1`,
        `${key}.restored.2`,
      ]),
    ]);
    for (const key of managed) baseline.set(key, readStrict(storage, key));
    persisted = await sourceFingerprint(
      persistedRestoreSource(snapshot),
      readBackupPreferences(snapshot),
    );
  } catch (error) {
    return { status: 'refused', reason: describe(error), problems: [] };
  }
  if (captured !== inspection.sourceSha256 || captured !== persisted) {
    return {
      status: 'refused',
      reason:
        '工作区在备份预览后发生变化，或仍有未保存内容。请重新选择备份以检查最新冲突，再确认恢复。',
      problems: [],
    };
  }

  const merged = mergeRestore(input.current, contents, choice, input.currentPreferences, input.now);
  const reviewBlocked = reviewIsBlocked(snapshot);
  const reviewWarning = reviewBlocked
    ? '本机的复习进度由更新版本的应用写入，恢复没有覆盖它。'
    : null;

  /* Build the exact set of LocalStorage writes. Identical values are left alone. */
  const writes: { key: string; value: string; label: string }[] = [];
  const addDataWrite = (key: string, value: string): void => {
    if (readStrict(snapshot, key) === value) return;
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
  if (!reviewBlocked) addDataWrite(REVIEW_STORAGE_KEY, JSON.stringify(merged.review));
  for (const entry of preferenceWrites(merged.preferences)) addDataWrite(entry.key, entry.value);

  /* Recovery copies never overwrite one already on this machine. */
  const recoveryWarnings: string[] = [];
  for (const [key, value] of Object.entries(contents.recovery)) {
    if (readStrict(snapshot, key) === value) continue;
    let target = key;
    for (let slot = 0; slot < 3 && readStrict(snapshot, target) !== null; slot += 1) {
      target = `${key}.restored${slot === 0 ? '' : `.${String(slot)}`}`;
    }
    if (readStrict(snapshot, target) !== null) {
      recoveryWarnings.push(`本机已经有多份「${key}」的副本，这一份没有写入。`);
      continue;
    }
    writes.push({ key: target, value, label: '恢复副本' });
  }

  const normalized: KeyWrite[] = [];
  for (const write of writes) {
    normalized.push({ ...write, sha256: await sha256Hex(write.value) });
  }
  const expected = new Map(normalized.map((write) => [write.key, write.value]));
  const journalKeys: RestoreJournal['keys'] = {};
  for (const key of new Set([...Object.keys(KEY_LABEL), ...RECOVERY_KEYS, ...expected.keys()])) {
    const previous = readStrict(snapshot, key);
    const next = expected.get(key) ?? previous;
    journalKeys[key] = { previous, next, nextSha256: await sha256Hex(next ?? '') };
  }

  input.onStage?.('journal');
  if (!baselineUnchanged())
    return {
      status: 'failed',
      stage: 'journal',
      message: '工作区在准备恢复期间发生变化，没有写入恢复数据；请重新载入后再检查备份。',
      rolledBack: true,
      reloadRequired: true,
      problems: [],
      pdfsCopied: 0,
    };
  let journal: RestoreJournal = {
    id: crypto.randomUUID(),
    startedAt: input.now,
    keys: journalKeys,
    committed: false,
    phase: 'prepared',
    pdfsAdded: [],
    pdfsPending: [],
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

  let manualRecoveryRequired = false;
  const finishRollback = async (): Promise<boolean> => {
    try {
      const checkpoint = await checkpointFor(journal, 'rolled-back', storage, blobs, permit);
      // Publish rollback intent before changing LocalStorage; a second crash can finish it.
      await input.journal.publishCheckpoint(checkpoint);
      const applied = await applyCheckpoint(checkpoint, storage, blobs);
      if (applied === 'changed') {
        manualRecoveryRequired = !(await retireConflictedCheckpoint(input.journal, checkpoint));
        return false;
      }
      if (applied !== 'applied') return false;
      const cleaned = await cleanupCheckpoint(checkpoint, storage, blobs, permit);
      if (!checkpointMatchesStorage(checkpoint, storage)) {
        manualRecoveryRequired = !(await retireConflictedCheckpoint(input.journal, checkpoint));
        return false;
      }
      return cleaned;
    } catch {
      return false;
    }
  };

  /* 1. PDFs: additive and content-addressed, so they cannot damage anything already here. */
  input.onStage?.('pdfs');
  let pdfsCopied = 0;
  for (const hash of plan.pdfsToCopy) {
    try {
      // Recheck under the native lease: inspection may be old, and an existing blob must
      // never be recorded as newly added or removed by rollback.
      if (await blobs.has(hash)) continue;
      const bytes = await readBackupFile(input.file, header, payloadOffset, hash);
      if (bytes === null) throw new Error('备份里找不到这个文件。');
      if ((await sha256Hex(bytes)) !== hash) {
        throw new Error('备份文件在检查之后发生了变化，已停止恢复。');
      }
      journal = { ...journal, pdfsPending: [hash] };
      await input.journal.write(journal);
      await blobs.put(hash, bytes, permit);
      pdfsCopied += 1;
      journal = { ...journal, pdfsPending: [], pdfsAdded: [...(journal.pdfsAdded ?? []), hash] };
      await input.journal.write(journal);
    } catch (error) {
      const rolledBack = await finishRollback();
      return {
        status: 'failed',
        stage: 'pdfs',
        message: manualRecoveryRequired
          ? UNSAFE_RELOAD_DETAIL
          : `写入 PDF 时失败，项目与知识没有改动：${describe(error)}`,
        rolledBack,
        reloadRequired: true,
        manualRecoveryRequired,
        problems: [],
        pdfsCopied,
      };
    }
  }

  // Persist the phase boundary before the first LocalStorage write. A PDF-only crash is
  // therefore distinguishable even when no LocalStorage value needed changing.
  journal = { ...journal, phase: 'data' };
  try {
    await input.journal.write(journal);
  } catch (error) {
    const rolledBack = await finishRollback();
    return {
      status: 'failed',
      stage: 'journal',
      message: manualRecoveryRequired ? UNSAFE_RELOAD_DETAIL : describe(error),
      rolledBack,
      reloadRequired: true,
      manualRecoveryRequired,
      problems: [],
      pdfsCopied,
    };
  }

  /* 2. LocalStorage, one key at a time, with the journal already on disk. */
  input.onStage?.('data');
  if (!baselineUnchanged()) return activeConflictResult(input.journal, journal, 'data', pdfsCopied);
  for (const write of normalized) {
    const outcome = writeStrict(storage, write.key, write.value);
    if (outcome !== 'ok') {
      const rolledBack = await finishRollback();
      return {
        status: 'failed',
        stage: 'data',
        message: manualRecoveryRequired
          ? UNSAFE_RELOAD_DETAIL
          : outcome === 'quota'
            ? `写入「${write.label}」时本地存储空间不足，已撤销本次恢复写入的内容。`
            : `写入「${write.label}」时失败，已撤销本次恢复写入的内容。`,
        rolledBack,
        reloadRequired: true,
        manualRecoveryRequired,
        problems: rolledBack ? [] : ['撤销没有完全成功，恢复证据已保留。'],
        pdfsCopied,
      };
    }
  }

  /* 3. Read it back out of storage. Only a restore that can be read back counts as done. */
  input.onStage?.('verify');
  const problems: string[] = [];
  for (const write of normalized) {
    const current = readStrict(storage, write.key);
    if (current === null || (await sha256Hex(current)) !== write.sha256) {
      problems.push(`「${write.label}」没有按预期写入。`);
    }
  }
  const projectsRaw = readStrict(storage, PROJECTS_STORAGE_KEY);
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
    if (migrated.state.glossary.length !== merged.projects.glossary.length) {
      problems.push('恢复后的术语数量与计划不一致。');
    }
    if (migrated.state.bookmarks.length !== merged.projects.bookmarks.length) {
      problems.push('恢复后的书签数量与计划不一致。');
    }
  }
  const reviewRaw = readStrict(storage, REVIEW_STORAGE_KEY);
  let reviewNow: ReviewState | null = null;
  if (reviewRaw !== null) {
    try {
      reviewNow = parseReviewState(JSON.parse(reviewRaw) as unknown)?.state ?? null;
    } catch {
      reviewNow = null;
    }
  }
  if (
    !reviewBlocked &&
    (reviewNow === null ||
      Object.keys(reviewNow.cards).length !== Object.keys(merged.review.cards).length)
  ) {
    problems.push('恢复后的复习进度无法读回，或数量与计划不一致。');
  }
  const knowledgeRaw = readStrict(storage, KNOWLEDGE_STORAGE_KEY);
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
  const expectedFiles = new Set([...plan.pdfsToCopy, ...plan.pdfsPresent]);
  for (const hash of expectedFiles) {
    const stored = await blobs.get(hash);
    if (stored === null || (await sha256Hex(stored)) !== hash) {
      problems.push('有论文的 PDF 没有成功写入本地文件库，或内容校验失败。');
    }
  }

  if (problems.length > 0) {
    const rolledBack = await finishRollback();
    return {
      status: 'failed',
      stage: 'verify',
      message: manualRecoveryRequired
        ? UNSAFE_RELOAD_DETAIL
        : rolledBack
          ? '恢复后的数据没有通过回读校验，已还原到恢复前的状态。'
          : '恢复后的数据没有通过回读校验，且还原没有完全成功。',
      rolledBack,
      reloadRequired: true,
      manualRecoveryRequired,
      problems,
      pdfsCopied,
    };
  }

  // LocalStorage readback is visibility, not a disk-flush barrier. Keep exact final bytes
  // in a strict IndexedDB checkpoint until pre-mount recovery has retired replay authority.
  let checkpoint: RestoreCheckpoint;
  let changedBeforeCommit = false;
  try {
    checkpoint = await checkpointFor(journal, 'restored', storage, blobs, permit, expectedFiles);
    if (!checkpointMatchesStorage(checkpoint, storage)) {
      changedBeforeCommit = true;
      throw new Error('建立持久化检查点期间数据发生变化，已暂停恢复。');
    }
    await input.journal.publishCheckpoint(checkpoint);
  } catch (error) {
    if (changedBeforeCommit)
      return activeConflictResult(input.journal, journal, 'verify', pdfsCopied);
    const rolledBack = await finishRollback();
    return {
      status: 'failed',
      stage: 'verify',
      manualRecoveryRequired,
      message: manualRecoveryRequired
        ? UNSAFE_RELOAD_DETAIL
        : '最终数据无法建立严格持久化检查点，已停止恢复，请重新载入完成恢复检查。',
      rolledBack,
      reloadRequired: true,
      problems: [describe(error)],
      pdfsCopied,
    };
  }
  // Publication commits the restore outcome. A later external edit must never turn that
  // committed checkpoint back into rollback authority, even if it matches an older value.
  const changedAfterCommit = async (): Promise<RestoreResult> => {
    const durable = await retireConflictedCheckpoint(input.journal, checkpoint);
    return {
      status: 'failed',
      stage: 'verify',
      message: durable
        ? '检测到其他窗口修改，旧检查点已停止自动重放，当前数据与恢复副本均已保留。请关闭其他工作区窗口后重新载入。'
        : UNSAFE_RELOAD_DETAIL,
      rolledBack: false,
      reloadRequired: true,
      manualRecoveryRequired: !durable,
      problems: [],
      pdfsCopied,
    };
  };
  if (!checkpointMatchesStorage(checkpoint, storage)) return changedAfterCommit();
  const journalWarning = (await cleanupCheckpoint(checkpoint, storage, blobs, permit, true))
    ? null
    : '最终数据已保存在恢复检查点中；PDF 清理将在重新载入后重试。';
  if (!checkpointMatchesStorage(checkpoint, storage)) return changedAfterCommit();

  const pdfCount = new Set(
    Object.values(merged.projects.papers)
      .map((paper) => paper.pdf?.sha256)
      .filter((hash): hash is string => hash !== undefined),
  ).size;

  return {
    status: 'restored',
    stats: merged.stats,
    warnings: [
      ...merged.warnings,
      ...recoveryWarnings,
      ...(reviewWarning === null ? [] : [reviewWarning]),
      ...(journalWarning === null ? [] : [journalWarning]),
    ],
    pdfsCopied,
    verification: {
      keys: normalized.length,
      pdfs: pdfCount,
      projects: merged.projects.projects.length,
      papers: Object.keys(merged.projects.papers).length,
      annotations: merged.projects.annotations.length,
      bookmarks: merged.projects.bookmarks.length,
      glossary: merged.projects.glossary.length,
      reviewCards: Object.keys(merged.review.cards).length,
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
 * Active journals settle an interrupted attempt. Retained final checkpoints replay exact
 * outcomes after LocalStorage process-loss, then durably relinquish replay authority before
 * ordinary stores mount. Retired copies never overwrite later user edits.
 */
interface RecoveryInput {
  storage?: KeyValueStore | null;
  journal?: RestoreJournalStore;
  blobs?: PdfBlobStore;
  onProblem?: (detail: string) => void;
  /** Runtime presentation only; never claimed to survive a process crash. */
  onManualRecovery?: (detail: string) => void;
}

export async function recoverInterruptedRestore(input?: RecoveryInput): Promise<RestoreRecovery> {
  try {
    return await workspaceAccess.exclusive(async (permit) => {
      const result = await recoverRestoreLocked(input, permit);
      if (result === 'blocked') workspaceAccess.block();
      return result;
    });
  } catch (error) {
    input?.onProblem?.(describe(error));
    workspaceAccess.block();
    return 'blocked';
  }
}

async function recoverRestoreLocked(
  input: RecoveryInput | undefined,
  permit: WorkspaceWritePermit,
): Promise<RestoreRecovery> {
  const storage = input?.storage === undefined ? defaultStore() : input.storage;
  const journalStore = input?.journal;
  if (journalStore === undefined) return 'blocked';

  let journal: RestoreJournal | null;
  try {
    journal = await journalStore.read();
  } catch (error) {
    input?.onProblem?.(describe(error));
    return 'blocked';
  }
  if (journal === null) {
    for (const key of [...Object.keys(KEY_LABEL), ...RECOVERY_KEYS]) readStrict(storage, key);
    const checkpoint = await journalStore.readCheckpoint();
    return checkpoint === null
      ? 'none'
      : recoverCheckpoint(
          checkpoint,
          storage,
          journalStore,
          input?.blobs,
          permit,
          input?.onManualRecovery,
        );
  }
  assertRestoreJournal(journal);
  if (journal.conflicted === true) {
    input?.onManualRecovery?.(ACTIVE_CONFLICT_DETAIL);
    return 'blocked';
  }
  if (storage === null) return 'blocked';

  let allNext = journal.phase !== 'prepared';
  let allPrevious = true;
  const observed = new Map<string, string | null>();
  for (const [key, entry] of Object.entries(journal.keys)) {
    if (Object.hasOwn(entry, 'next') && (await sha256Hex(entry.next ?? '')) !== entry.nextSha256)
      return 'blocked';
    const current = readStrict(storage, key);
    observed.set(key, current);
    const matchesNext = Object.hasOwn(entry, 'next')
      ? current === entry.next
      : current !== null && (await sha256Hex(current)) === entry.nextSha256;
    if (!matchesNext) allNext = false;
    if (current !== entry.previous) {
      allPrevious = false;
      if (!matchesNext && current !== null) return 'blocked';
    }
  }
  // Hash-only committed legacy journals cannot reconstruct lost bytes or override later edits.
  if (journal.committed === true && !allNext) return 'blocked';
  const outcome = allNext ? 'restored' : 'rolled-back';
  const required =
    outcome === 'restored'
      ? new Set([...(journal.pdfsAdded ?? []), ...(journal.pdfsPending ?? [])])
      : new Set<string>();
  const checkpoint = await checkpointFor(journal, outcome, storage, input?.blobs, permit, required);
  for (const [key, value] of observed) {
    if (readStrict(storage, key) !== value) {
      try {
        await journalStore.markConflicted(journal.id);
        input?.onManualRecovery?.(ACTIVE_CONFLICT_DETAIL);
      } catch {
        input?.onManualRecovery?.(UNSAFE_RELOAD_DETAIL);
      }
      return 'blocked';
    }
  }
  await journalStore.publishCheckpoint(checkpoint);
  const recovered = await recoverCheckpoint(
    checkpoint,
    storage,
    journalStore,
    input?.blobs,
    permit,
    input?.onManualRecovery,
  );
  return recovered === 'rolled-back' && allPrevious ? 'clean' : recovered;
}
