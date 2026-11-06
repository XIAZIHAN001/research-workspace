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

/** Puts every written key back to its previous value. Returns false if any write failed. */
function rollback(
  store: KeyValueStore | null,
  previous: ReadonlyMap<string, string | null>,
  written: readonly string[],
): boolean {
  let ok = true;
  for (const key of written) {
    const value = previous.get(key) ?? null;
    try {
      if (readStrict(store, key) === value) continue;
    } catch {
      ok = false;
      continue;
    }
    if (value === null) {
      if (!removeStrict(store, key)) ok = false;
    } else if (writeStrict(store, key, value) !== 'ok') {
      ok = false;
    }
    try {
      if (readStrict(store, key) !== value) ok = false;
    } catch {
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
      const result = await executeRestoreLocked(input, permit);
      if (result.status === 'restored' || (result.status === 'failed' && !result.rolledBack))
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
  let persisted: string;
  try {
    persisted = await sourceFingerprint(
      persistedRestoreSource(storage),
      readBackupPreferences(storage),
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
  const reviewBlocked = reviewIsBlocked(storage);
  const reviewWarning = reviewBlocked
    ? '本机的复习进度由更新版本的应用写入，恢复没有覆盖它。'
    : null;

  /* Build the exact set of LocalStorage writes. Identical values are left alone. */
  const writes: { key: string; value: string; label: string }[] = [];
  const addDataWrite = (key: string, value: string): void => {
    if (readStrict(storage, key) === value) return;
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
    if (readStrict(storage, key) === value) continue;
    let target = key;
    for (let slot = 0; slot < 3 && readStrict(storage, target) !== null; slot += 1) {
      target = `${key}.restored${slot === 0 ? '' : `.${String(slot)}`}`;
    }
    if (readStrict(storage, target) !== null) {
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
  for (const write of normalized) previous.set(write.key, readStrict(storage, write.key));

  input.onStage?.('journal');
  let journal: RestoreJournal = {
    id: crypto.randomUUID(),
    startedAt: input.now,
    keys: Object.fromEntries(
      normalized.map((write) => [
        write.key,
        { previous: previous.get(write.key) ?? null, nextSha256: write.sha256 },
      ]),
    ),
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

  const finishRollback = async (dataRestored: boolean): Promise<boolean> => {
    if (!dataRestored || !(await cleanRestorePdfs(journal, storage, blobs, permit))) return false;
    try {
      await input.journal.clear();
      return true;
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
      const rolledBack = await finishRollback(true);
      return {
        status: 'failed',
        stage: 'pdfs',
        message: `写入 PDF 时失败，项目与知识没有改动：${describe(error)}`,
        rolledBack,
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
    return {
      status: 'failed',
      stage: 'journal',
      message: describe(error),
      rolledBack: await finishRollback(true),
      problems: [],
      pdfsCopied,
    };
  }

  /* 2. LocalStorage, one key at a time, with the journal already on disk. */
  input.onStage?.('data');
  const written: string[] = [];
  for (const write of normalized) {
    const outcome = writeStrict(storage, write.key, write.value);
    if (outcome !== 'ok') {
      const rolledBack = await finishRollback(rollback(storage, previous, [...written, write.key]));
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
    const rolledBack = await finishRollback(rollback(storage, previous, written));
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

  // The data has been read back and verified. Mark the journal committed before removing it:
  // if the clear is lost, the next start must see a finished restore rather than a mixture and
  // must not roll it back.
  try {
    await input.journal.write({ ...journal, committed: true });
    journal = { ...journal, committed: true };
  } catch (error) {
    const rolledBack = await finishRollback(rollback(storage, previous, written));
    return {
      status: 'failed',
      stage: 'verify',
      message: rolledBack
        ? '恢复后的数据已通过回读，但恢复日志无法标记为已提交，已撤销本次恢复。'
        : '恢复后的数据已通过回读，但恢复日志无法标记为已提交，且撤销没有完全成功。',
      rolledBack,
      problems: [describe(error)],
      pdfsCopied,
    };
  }

  let journalWarning: string | null = null;
  try {
    if (!(await cleanRestorePdfs(journal, storage, blobs, permit, true)))
      throw new Error('PDF 清理任务尚未持久化。');
    await input.journal.clear();
  } catch {
    journalWarning =
      '恢复已完成，但恢复日志未能清理；再次启动时会把它识别为已完成并自动清理，不会回滚本次恢复。';
  }

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
 * It answers the only question that matters after a crash: did the restore finish, not start,
 * or stop in the middle? A mixture means the old values go back — the alternative is a
 * workspace where projects point at knowledge that was never written.
 */
interface RecoveryInput {
  storage?: KeyValueStore | null;
  journal?: RestoreJournalStore;
  blobs?: PdfBlobStore;
  onProblem?: (detail: string) => void;
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
    // A failed read is not an empty workspace. Probe before loaders can turn unreadable
    // keys into EMPTY and a later successful write can overwrite the original data.
    for (const key of [...Object.keys(KEY_LABEL), ...RECOVERY_KEYS]) readStrict(storage, key);
    return 'none';
  }
  assertRestoreJournal(journal);
  if (storage === null) return 'blocked';

  if (journal.committed === true) {
    // The restore finished and was verified; only its cleanup was lost. Nothing is rolled back.
    if (await cleanRestorePdfs(journal, storage, input?.blobs, permit, true)) {
      await journalStore.clear().catch(() => undefined);
    }
    return 'completed';
  }

  const keys = Object.keys(journal.keys);
  let allNext = journal.phase !== 'prepared';
  let allPrevious = true;
  for (const key of keys) {
    const entry = journal.keys[key];
    if (entry === undefined) continue;
    const current = storage.getItem(key);
    const matchesNext = current !== null && (await sha256Hex(current)) === entry.nextSha256;
    if (!matchesNext) allNext = false;
    if (current !== entry.previous) {
      allPrevious = false;
      // Older builds do not honour our lock. Preserve an unrecognised edit rather than
      // overwriting it with a rollback snapshot that cannot account for that writer.
      if (!matchesNext) return 'blocked';
    }
  }

  if (allNext) {
    const additions = [...(journal.pdfsAdded ?? []), ...(journal.pdfsPending ?? [])];
    if (additions.length > 0) {
      const references = readPdfReferences(storage);
      if (references === null || input?.blobs === undefined) return 'blocked';
      for (const hash of additions) {
        if (!references.has(hash)) continue;
        const bytes = await input.blobs.get(hash);
        if (bytes === null || (await sha256Hex(bytes)) !== hash) return 'blocked';
      }
    }
    // A lost cleanup must not later roll back subsequent edits. Make the completion durable.
    await journalStore.write({ ...journal, committed: true });
    if (await cleanRestorePdfs(journal, storage, input?.blobs, permit, true)) {
      await journalStore.clear().catch(() => undefined);
    }
    return 'completed';
  }
  if (allPrevious) {
    if (!(await cleanRestorePdfs(journal, storage, input?.blobs, permit))) return 'blocked';
    await journalStore.clear();
    return 'clean';
  }

  let ok = true;
  for (const key of keys) {
    const entry = journal.keys[key];
    if (entry === undefined) continue;
    if (storage.getItem(key) === entry.previous) continue;
    const outcome =
      entry.previous === null
        ? removeStrict(storage, key)
          ? 'ok'
          : 'failed'
        : writeStrict(storage, key, entry.previous);
    if (outcome !== 'ok' || storage.getItem(key) !== entry.previous) ok = false;
  }
  if (!ok || !(await cleanRestorePdfs(journal, storage, input?.blobs, permit))) return 'blocked';
  await journalStore.clear();
  return 'rolled-back';
}
