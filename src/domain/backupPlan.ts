/**
 * What a backup contains, whether it can be restored, and exactly what restoring it would do.
 *
 * This module is the part of portability that must be right before a single byte is written.
 * It is pure: it reads plain objects and returns a plan or a merged state, so the dangerous
 * questions — is this file from a build we understand, do its references resolve, would this
 * overwrite something the reader edited, would two papers become one — are answered by tests
 * rather than by a script that happens to run in the right order.
 *
 * The rules that shape everything here:
 *
 * - a backup never overwrites silently: a same-id object that differs is a conflict the reader
 *   chooses about, and the default keeps what is already on this machine;
 * - identity is matched only by stable identifiers (DOI, arXiv id) or by the same id — never by
 *   a title;
 * - restoring is additive where it can be: unknown projects are added, projects that already
 *   exist gain the papers the backup knew about, and nothing is ever deleted;
 * - a concept is global: its project links travel with it, and a link to a project that is not
 *   part of the restore is dropped rather than invented.
 */

import type { Annotation } from './annotation';
import type { Bookmark } from './bookmark';
import type { GlossaryEntry } from './glossary';
import {
  parseDifficultyState,
  trimDifficultyPages,
  type DifficultyPrefs,
  type DifficultyState,
} from './difficulty';
import {
  parseKnowledgeState,
  relationSuggestionFingerprint,
  wouldCycle,
  type Concept,
  type ConceptEvidence,
  type ConceptRelation,
  type KnowledgeState,
  type RejectedRelationSuggestion,
} from './knowledge';
import { migrateStoredPayload, SCHEMA_VERSION } from './migrate';
import type { Paper } from './papers';
import type { Project } from './project';
import type { ProjectsState } from './projectsState';

/* ------------------------------------------------------------------ *
 * The data section of a backup
 * ------------------------------------------------------------------ */

/** Preferences travel with the knowledge base, but never override this device's own. */
export interface BackupPreferences {
  /** `system` | `light` | `dark`, or null when the backup did not record one. */
  theme: string | null;
  /** `auto` | `original` | `warm` | `dark`, or null. */
  paper: string | null;
  /** A data URL for the avatar, or null. */
  avatar: string | null;
  difficulty: DifficultyPrefs | null;
}

export const EMPTY_PREFERENCES: BackupPreferences = {
  theme: null,
  paper: null,
  avatar: null,
  difficulty: null,
};

export interface BackupContents {
  projects: ProjectsState;
  knowledge: KnowledgeState;
  difficulties: DifficultyState;
  preferences: BackupPreferences;
  /** Verbatim copies of payloads a previous build set aside. Restored, never overwritten. */
  recovery: Record<string, string>;
  /** File hashes the exporting device no longer had. Papers may still reference them. */
  missingFiles: string[];
}

export type BackupParse =
  { ok: true; contents: BackupContents; warnings: string[] } | { ok: false; problems: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const RECOVERY_KEYS: ReadonlySet<string> = new Set([
  'rw.projects.backup',
  'rw.projects.backup.2',
  'rw.projects.backup.3',
  'rw.projects.corrupt',
  'rw.projects.corrupt.2',
  'rw.projects.corrupt.3',
  'rw.knowledge.corrupt',
]);

/** A single recovery payload larger than this is not something this build wrote. */
const MAX_RECOVERY_VALUE_CHARS = 8 * 1024 * 1024;
const MAX_RECOVERY_TOTAL_CHARS = 16 * 1024 * 1024;
const MAX_AVATAR_CHARS = 2_800_000;
const AVATAR_DATA_URL = /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

const THEMES: ReadonlySet<string> = new Set(['system', 'light', 'dark']);
const PAPER_MODES: ReadonlySet<string> = new Set(['auto', 'original', 'warm', 'dark']);

function parsePreferences(value: unknown, warnings: string[]): BackupPreferences {
  if (!isRecord(value)) return { ...EMPTY_PREFERENCES };
  const theme = typeof value.theme === 'string' && THEMES.has(value.theme) ? value.theme : null;
  const paper =
    typeof value.paper === 'string' && PAPER_MODES.has(value.paper) ? value.paper : null;
  let avatar: string | null = null;
  if (typeof value.avatar === 'string') {
    // Only an embedded image is a valid avatar. Anything else — a remote URL, a script, a
    // `javascript:` string — is dropped rather than carried into an <img src>.
    if (value.avatar.length <= MAX_AVATAR_CHARS && AVATAR_DATA_URL.test(value.avatar)) {
      avatar = value.avatar;
    } else {
      warnings.push('备份中的头像不是本应用保存的格式，已跳过。');
    }
  }
  let difficulty: DifficultyPrefs | null = null;
  if (isRecord(value.difficulty)) {
    difficulty = {
      enabled: value.difficulty.enabled === true,
      markersVisible: value.difficulty.markersVisible !== false,
    };
  }
  return { theme, paper, avatar, difficulty };
}

function parseRecovery(value: unknown, warnings: string[]): Record<string, string> {
  if (!isRecord(value)) return {};
  const kept: Record<string, string> = {};
  let total = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (!RECOVERY_KEYS.has(key)) {
      warnings.push('备份里有一项无法识别的恢复副本，已跳过。');
      continue;
    }
    if (typeof entry !== 'string' || entry.length > MAX_RECOVERY_VALUE_CHARS) {
      warnings.push('备份里有一项恢复副本过大或格式不对，已跳过。');
      continue;
    }
    if (total + entry.length > MAX_RECOVERY_TOTAL_CHARS) {
      warnings.push('备份里的恢复副本总量超出上限，其余已跳过。');
      break;
    }
    kept[key] = entry;
    total += entry.length;
  }
  return kept;
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Reads the data section of a backup without touching storage.
 *
 * Project data goes through the same migration chain as the live key, so a backup written by
 * an older build restores into this one exactly as that build's own data would. Knowledge,
 * which has a single version today, is read strictly: an entry this build cannot interpret is
 * a reason to refuse, not to keep half a graph.
 */
export function parseBackupData(value: unknown): BackupParse {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(value)) return { ok: false, problems: ['备份里没有可读取的数据。'] };

  if (!isRecord(value.projects)) {
    return { ok: false, problems: ['备份缺少项目与论文数据。'] };
  }
  const migrated = migrateStoredPayload(JSON.stringify(value.projects));
  if (!migrated.ok) {
    let reason = '备份中的项目数据无法读取。';
    switch (migrated.reason) {
      case 'unreadable':
        reason = '备份中的项目数据不是有效的 JSON。';
        break;
      case 'invalid':
        reason = '备份中的项目数据结构不正确。';
        break;
      case 'unsupported-version':
        reason = `备份由更新版本的应用写入（项目数据 v${String(migrated.found)}，当前应用读取 v${String(SCHEMA_VERSION)}）。`;
        break;
      case 'migration-failed':
        reason = '备份中的项目数据无法升级到当前版本。';
        break;
    }
    problems.push(reason);
  }

  const knowledge = parseKnowledgeState(value.knowledge);
  if (knowledge === null) {
    problems.push('备份中的知识数据无法读取，或版本不受当前应用支持。');
  }

  const difficulties = parseDifficultyState(value.difficulties);
  if (difficulties === null) {
    warnings.push('备份中的难点缓存无法读取，将跳过它；论文、笔记与知识不受影响。');
  }

  const preferences = parsePreferences(value.preferences, warnings);
  const recovery = parseRecovery(value.recovery, warnings);
  const missingFiles = Array.isArray(value.missingFiles)
    ? value.missingFiles.filter(
        (entry): entry is string => typeof entry === 'string' && SHA256.test(entry),
      )
    : [];

  if (problems.length > 0 || !migrated.ok || knowledge === null) {
    return { ok: false, problems };
  }

  const projects = migrated.state;
  const projectIds = new Set(projects.projects.map((project) => project.id));
  const paperIds = new Set(Object.keys(projects.papers));

  // Cross-object references. A restore writes all of this in one go, so a reference that
  // cannot resolve is a defect in the backup: refusing is honest, repairing would invent data.
  for (const concept of knowledge.concepts) {
    for (const projectId of concept.projectIds) {
      if (!projectIds.has(projectId)) {
        problems.push(`概念《${concept.name}》指向备份里不存在的项目。`);
        break;
      }
    }
  }
  for (const entry of knowledge.evidence) {
    if (!paperIds.has(entry.paperId)) {
      problems.push('备份里有一条出处指向不存在的论文。');
      break;
    }
  }
  for (const relation of knowledge.relations) {
    if (relation.from === relation.to) {
      problems.push('备份里有一条关系指向概念自己。');
      break;
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    warnings,
    contents: {
      projects,
      knowledge,
      difficulties: difficulties ?? { pages: {}, ignored: {} },
      preferences,
      recovery,
      missingFiles,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Planning a restore
 * ------------------------------------------------------------------ */

export type RestoreChoice = {
  /** What to do with an object whose id is already here but whose content differs. */
  sameIdPolicy: 'keep-existing' | 'prefer-backup';
  /** Whether to restore papers whose PDF is not in the backup and not on this machine. */
  importMissingPdfs: boolean;
};

export const DEFAULT_RESTORE_CHOICE: RestoreChoice = {
  sameIdPolicy: 'keep-existing',
  importMissingPdfs: false,
};

export type ConflictKind = 'project' | 'paper' | 'annotation' | 'concept' | 'evidence' | 'relation';

export interface RestoreConflict {
  kind: ConflictKind;
  id: string;
  /** What to show the reader: a project name, a paper title, a quotation… */
  label: string;
}

export interface MissingPdfPaper {
  paperId: string;
  title: string;
  sha256: string;
}

export interface IdentifierMerge {
  incomingPaperId: string;
  incomingTitle: string;
  existingPaperId: string;
  existingTitle: string;
  field: 'doi' | 'arxivId';
}

export interface RestoreAdditions {
  projects: number;
  papers: number;
  annotations: number;
  concepts: number;
  evidence: number;
  relations: number;
}

export interface RestorePlan {
  additions: RestoreAdditions;
  conflicts: RestoreConflict[];
  identifierMerges: IdentifierMerge[];
  pdfsToCopy: string[];
  pdfsPresent: string[];
  missingPdfPapers: MissingPdfPaper[];
  neededBytes: number;
  availableBytes: number | null;
  /** Kept below the estimate on purpose: a restore should not fill the disk to its last byte. */
  storageSufficient: boolean;
  warnings: string[];
  blockers: string[];
}

export interface RestoreSource {
  projects: ProjectsState;
  knowledge: KnowledgeState;
  /** Present so a merge can decide what to do with cached pages. */
  difficulties: DifficultyState;
}

export interface PlanInput {
  current: RestoreSource;
  currentPreferences: BackupPreferences;
  contents: BackupContents;
  /** Every file entry the backup actually carries. */
  fileHashes: ReadonlySet<string>;
  fileBytes: ReadonlyMap<string, number>;
  /** File hashes already in the local blob store. */
  presentPdfHashes: ReadonlySet<string>;
  availableBytes: number | null;
  now: number;
}

const sameJson = (one: unknown, other: unknown): boolean =>
  JSON.stringify(one) === JSON.stringify(other);

/**
 * What "the same object" means for a conflict.
 *
 * Only fields that carry identity or a decision the reader made are compared. Timestamps and
 * reading progress are left out on purpose: having read a restored paper must not turn the
 * next import of the same backup into a question about which copy to keep.
 */
function projectKey(project: Project): unknown[] {
  return [project.name, project.corePaperId, project.relatedPaperIds];
}

function paperKey(paper: Paper): unknown[] {
  return [
    paper.title,
    paper.authors,
    paper.year ?? null,
    paper.doi ?? null,
    paper.arxivId ?? null,
    paper.pdf?.sha256 ?? null,
  ];
}

function annotationKey(annotation: Annotation): unknown[] {
  return [
    annotation.paperId,
    annotation.pdfSha256,
    annotation.page,
    annotation.quote,
    annotation.prefix,
    annotation.suffix,
    annotation.rects,
    annotation.kind,
    annotation.note,
    annotation.origin,
    annotation.sourceLabel,
  ];
}

function conceptKey(concept: Concept): unknown[] {
  return [
    concept.name,
    concept.aliases,
    concept.summary,
    concept.origin,
    concept.status,
    concept.projectIds,
  ];
}

function evidenceKey(entry: ConceptEvidence): unknown[] {
  return [
    entry.conceptId,
    entry.paperId,
    entry.pdfSha256,
    entry.page,
    entry.quote,
    entry.prefix,
    entry.suffix,
    entry.rects,
    entry.source,
    entry.annotationId ?? null,
    entry.suggestionId ?? null,
    entry.relationId ?? null,
    entry.verification ?? null,
    entry.note,
  ];
}

function relationKey(relation: ConceptRelation): unknown[] {
  return [
    relation.from,
    relation.to,
    relation.kind,
    relation.status,
    relation.origin,
    relation.note,
    relation.support ?? null,
    relation.rationale ?? null,
    relation.provider ?? null,
    relation.providerLabel ?? null,
    relation.model ?? null,
    relation.rulesVersion ?? null,
    relation.evidenceIds ?? [],
  ];
}

/** Objects whose id exists on both sides but whose content differs. */
export function collectConflicts(
  current: RestoreSource,
  contents: BackupContents,
): RestoreConflict[] {
  const conflicts: RestoreConflict[] = [];

  for (const project of contents.projects.projects) {
    const existing = current.projects.projects.find((entry) => entry.id === project.id);
    if (existing !== undefined && !sameJson(projectKey(existing), projectKey(project))) {
      conflicts.push({ kind: 'project', id: project.id, label: project.name });
    }
  }
  for (const paper of Object.values(contents.projects.papers)) {
    const existing = current.projects.papers[paper.id];
    if (existing !== undefined && !sameJson(paperKey(existing), paperKey(paper))) {
      conflicts.push({ kind: 'paper', id: paper.id, label: paper.title });
    }
  }
  for (const annotation of contents.projects.annotations) {
    const existing = current.projects.annotations.find((entry) => entry.id === annotation.id);
    if (existing !== undefined && !sameJson(annotationKey(existing), annotationKey(annotation))) {
      conflicts.push({
        kind: 'annotation',
        id: annotation.id,
        label:
          annotation.note === '' ? annotation.quote.slice(0, 32) : annotation.note.slice(0, 32),
      });
    }
  }
  for (const concept of contents.knowledge.concepts) {
    const existing = current.knowledge.concepts.find((entry) => entry.id === concept.id);
    if (existing !== undefined && !sameJson(conceptKey(existing), conceptKey(concept))) {
      conflicts.push({ kind: 'concept', id: concept.id, label: concept.name });
    }
  }
  for (const entry of contents.knowledge.evidence) {
    const existing = current.knowledge.evidence.find((item) => item.id === entry.id);
    if (existing !== undefined && !sameJson(evidenceKey(existing), evidenceKey(entry))) {
      conflicts.push({ kind: 'evidence', id: entry.id, label: entry.quote.slice(0, 32) });
    }
  }
  for (const relation of contents.knowledge.relations) {
    const existing = current.knowledge.relations.find((item) => item.id === relation.id);
    if (existing !== undefined && !sameJson(relationKey(existing), relationKey(relation))) {
      conflicts.push({ kind: 'relation', id: relation.id, label: relation.kind });
    }
  }
  return conflicts;
}

function identifierMatches(papers: Record<string, Paper>, incoming: Paper): Paper[] {
  const matches: Paper[] = [];
  const add = (paper: Paper | undefined): void => {
    if (paper !== undefined && !matches.some((seen) => seen.id === paper.id)) matches.push(paper);
  };
  for (const paper of Object.values(papers)) {
    if (incoming.doi !== undefined && paper.doi === incoming.doi) add(paper);
    if (incoming.arxivId !== undefined && paper.arxivId === incoming.arxivId) add(paper);
  }
  return matches;
}

export function planRestore(input: PlanInput): RestorePlan {
  const merged = mergeRestore(
    input.current,
    input.contents,
    { ...DEFAULT_RESTORE_CHOICE, importMissingPdfs: true },
    input.currentPreferences,
    input.now,
  );
  const warnings = [...merged.warnings];
  const blockers: string[] = [];

  // An incoming paper whose identifier already points at two different local papers cannot be
  // merged without picking a winner. That is exactly the choice this module refuses to make.
  for (const incoming of Object.values(input.contents.projects.papers)) {
    if (input.current.projects.papers[incoming.id] !== undefined) continue;
    if (identifierMatches(input.current.projects.papers, incoming).length > 1) {
      blockers.push(
        `《${incoming.title}》的 DOI/arXiv ID 在本机同时指向两篇论文，无法自动判断该并入哪一篇。`,
      );
    }
  }

  for (const merge of merged.identifierMerges) {
    warnings.push(
      `《${merge.incomingTitle}》与已有论文《${merge.existingTitle}》标识符相同，将并入已有论文（不会覆盖它的元数据）。`,
    );
  }

  const missingPdfPapers: MissingPdfPaper[] = [];
  const seenPaper = new Set<string>();
  for (const paper of Object.values(input.contents.projects.papers)) {
    const pdf = paper.pdf;
    if (pdf === undefined) continue;
    if (input.fileHashes.has(pdf.sha256) || input.presentPdfHashes.has(pdf.sha256)) continue;
    if (seenPaper.has(paper.id)) continue;
    seenPaper.add(paper.id);
    missingPdfPapers.push({ paperId: paper.id, title: paper.title, sha256: pdf.sha256 });
  }
  if (input.contents.missingFiles.length > 0) {
    warnings.push(
      `备份时本机已经找不到 ${String(input.contents.missingFiles.length)} 个 PDF 文件；依赖它们的论文只能恢复记录，读不了原文。`,
    );
  }
  if (missingPdfPapers.length > 0) {
    warnings.push(`${String(missingPdfPapers.length)} 篇论文的 PDF 不在备份里，也不在本机。`);
  }

  const pdfsToCopy: string[] = [];
  let neededBytes = 0;
  for (const hash of input.fileHashes) {
    if (input.presentPdfHashes.has(hash)) continue;
    pdfsToCopy.push(hash);
    neededBytes += input.fileBytes.get(hash) ?? 0;
  }
  const pdfsPresent = [...input.fileHashes].filter((hash) => input.presentPdfHashes.has(hash));
  const storageSufficient =
    input.availableBytes === null || neededBytes <= Math.floor(input.availableBytes * 0.8);

  return {
    additions: {
      projects: merged.stats.projectsAdded,
      papers: merged.stats.papersAdded,
      annotations: merged.stats.annotationsAdded,
      concepts: merged.stats.conceptsAdded,
      evidence: merged.stats.evidenceAdded,
      relations: merged.stats.relationsAdded,
    },
    conflicts: collectConflicts(input.current, input.contents),
    identifierMerges: merged.identifierMerges,
    pdfsToCopy,
    pdfsPresent,
    missingPdfPapers,
    neededBytes,
    availableBytes: input.availableBytes,
    storageSufficient,
    warnings,
    blockers,
  };
}

/* ------------------------------------------------------------------ *
 * Merging
 * ------------------------------------------------------------------ */

export interface MergeStats {
  projectsAdded: number;
  projectsMerged: number;
  papersAdded: number;
  papersMatchedById: number;
  papersMergedByIdentifier: number;
  annotationsAdded: number;
  annotationsSkipped: number;
  annotationsUpdated: number;
  conceptsAdded: number;
  conceptsSkipped: number;
  conceptsUpdated: number;
  evidenceAdded: number;
  evidenceSkipped: number;
  evidenceUpdated: number;
  relationsAdded: number;
  relationsSkipped: number;
  relationsUpdated: number;
  rejectionsAdded: number;
  rejectionsSkipped: number;
  rejectionsUpdated: number;
  preferencesApplied: string[];
}

export interface PreferencesPatch {
  theme?: string;
  paper?: string;
  avatar?: string;
  difficulty?: DifficultyPrefs;
}

export interface MergeResult {
  projects: ProjectsState;
  knowledge: KnowledgeState;
  difficulties: DifficultyState;
  preferences: PreferencesPatch;
  stats: MergeStats;
  identifierMerges: IdentifierMerge[];
  warnings: string[];
}

const emptyStats = (): MergeStats => ({
  projectsAdded: 0,
  projectsMerged: 0,
  papersAdded: 0,
  papersMatchedById: 0,
  papersMergedByIdentifier: 0,
  annotationsAdded: 0,
  annotationsSkipped: 0,
  annotationsUpdated: 0,
  conceptsAdded: 0,
  conceptsSkipped: 0,
  conceptsUpdated: 0,
  evidenceAdded: 0,
  evidenceSkipped: 0,
  evidenceUpdated: 0,
  relationsAdded: 0,
  relationsSkipped: 0,
  relationsUpdated: 0,
  rejectionsAdded: 0,
  rejectionsSkipped: 0,
  rejectionsUpdated: 0,
  preferencesApplied: [],
});

/**
 * Computes the workspace that a restore would leave behind, without writing anything.
 *
 * It never mutates its inputs. The merged `selectedId` keeps this machine's selection when it
 * still resolves, and otherwise falls back to the backup's (or the first project), because a
 * selection is a view state, not data worth arguing about.
 */
export function mergeRestore(
  current: RestoreSource,
  contents: BackupContents,
  choice: RestoreChoice,
  currentPreferences: BackupPreferences,
  now: number,
): MergeResult {
  const stats = emptyStats();
  const warnings: string[] = [];
  const preferBackup = choice.sameIdPolicy === 'prefer-backup';

  /* Papers: same id wins, then an external identifier, then a new record. */
  const papers: Record<string, Paper> = { ...current.projects.papers };
  const paperIdMap = new Map<string, string>();
  const identifierMerges: IdentifierMerge[] = [];

  for (const incoming of Object.values(contents.projects.papers)) {
    const sameId = papers[incoming.id];
    if (sameId !== undefined) {
      paperIdMap.set(incoming.id, incoming.id);
      stats.papersMatchedById += 1;
      if (preferBackup && !sameJson(sameId, incoming)) papers[incoming.id] = incoming;
      continue;
    }
    const matches = identifierMatches(papers, incoming);
    if (matches.length > 1) {
      warnings.push(`《${incoming.title}》的标识符在本机指向多篇论文，已按独立论文导入。`);
    }
    const match = matches[0];
    if (match !== undefined) {
      paperIdMap.set(incoming.id, match.id);
      stats.papersMergedByIdentifier += 1;
      identifierMerges.push({
        incomingPaperId: incoming.id,
        incomingTitle: incoming.title,
        existingPaperId: match.id,
        existingTitle: match.title,
        field: incoming.doi !== undefined && match.doi === incoming.doi ? 'doi' : 'arxivId',
      });
      // Metadata belongs to the record already here; a file it was missing is worth taking.
      if (match.pdf === undefined && incoming.pdf !== undefined) {
        papers[match.id] = { ...match, pdf: incoming.pdf, updatedAt: now };
      }
      continue;
    }
    paperIdMap.set(incoming.id, incoming.id);
    papers[incoming.id] = incoming;
    stats.papersAdded += 1;
  }

  /* Projects: known ids merge their paper links; unknown ids are added whole. */
  const projects: Project[] = [...current.projects.projects];
  for (const incoming of contents.projects.projects) {
    const mappedCore = paperIdMap.get(incoming.corePaperId) ?? incoming.corePaperId;
    const mappedRelated = incoming.relatedPaperIds
      .map((id) => paperIdMap.get(id))
      .filter((id): id is string => id !== undefined);
    const relatedPaperIds = [...new Set(mappedRelated)].filter(
      (id) => id !== mappedCore && papers[id] !== undefined,
    );
    const index = projects.findIndex((project) => project.id === incoming.id);
    if (index >= 0) {
      const existing = projects[index];
      if (existing === undefined) continue;
      const related = [...existing.relatedPaperIds];
      for (const id of relatedPaperIds) {
        if (id !== existing.corePaperId && !related.includes(id)) related.push(id);
      }
      const corePaperId = preferBackup ? mappedCore : existing.corePaperId;
      projects[index] = {
        ...existing,
        ...(preferBackup && incoming.name.trim() !== '' ? { name: incoming.name } : {}),
        corePaperId: papers[corePaperId] === undefined ? existing.corePaperId : corePaperId,
        relatedPaperIds: related,
        updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
      };
      stats.projectsMerged += 1;
      continue;
    }
    if (papers[mappedCore] === undefined) {
      warnings.push(`项目《${incoming.name}》的核心论文不在备份里，已跳过这个项目。`);
      continue;
    }
    projects.push({ ...incoming, corePaperId: mappedCore, relatedPaperIds });
    stats.projectsAdded += 1;
  }
  const knownProjectIds = new Set(projects.map((project) => project.id));

  /* Annotations follow their paper through an identifier merge. */
  const annotations: Annotation[] = [...current.projects.annotations];
  for (const incoming of contents.projects.annotations) {
    const mappedPaperId = paperIdMap.get(incoming.paperId) ?? incoming.paperId;
    const mapped: Annotation =
      mappedPaperId === incoming.paperId ? incoming : { ...incoming, paperId: mappedPaperId };
    const index = annotations.findIndex((entry) => entry.id === incoming.id);
    if (index >= 0) {
      if (preferBackup && !sameJson(annotations[index], mapped)) {
        annotations[index] = mapped;
        stats.annotationsUpdated += 1;
      } else {
        stats.annotationsSkipped += 1;
      }
      continue;
    }
    if (papers[mappedPaperId] === undefined) {
      stats.annotationsSkipped += 1;
      continue;
    }
    annotations.push(mapped);
    stats.annotationsAdded += 1;
  }

  /* Bookmarks follow their paper the same way; a clash by id keeps the local name. */
  const bookmarks: Bookmark[] = [...current.projects.bookmarks];
  for (const incoming of contents.projects.bookmarks) {
    const mappedPaperId = paperIdMap.get(incoming.paperId) ?? incoming.paperId;
    const mapped: Bookmark =
      mappedPaperId === incoming.paperId ? incoming : { ...incoming, paperId: mappedPaperId };
    const index = bookmarks.findIndex((entry) => entry.id === incoming.id);
    if (index >= 0) {
      if (preferBackup && !sameJson(bookmarks[index], mapped)) bookmarks[index] = mapped;
      continue;
    }
    if (papers[mappedPaperId] === undefined) continue;
    bookmarks.push(mapped);
  }

  /* Glossary entries are paper-scoped records like bookmarks and follow the same rules. */
  const glossary: GlossaryEntry[] = [...current.projects.glossary];
  for (const incoming of contents.projects.glossary) {
    const mappedPaperId = paperIdMap.get(incoming.paperId) ?? incoming.paperId;
    const mapped: GlossaryEntry =
      mappedPaperId === incoming.paperId ? incoming : { ...incoming, paperId: mappedPaperId };
    const index = glossary.findIndex((entry) => entry.id === incoming.id);
    if (index >= 0) {
      if (preferBackup && !sameJson(glossary[index], mapped)) glossary[index] = mapped;
      continue;
    }
    if (papers[mappedPaperId] === undefined) continue;
    glossary.push(mapped);
  }

  /* Concepts are global: keep every one, and keep only project links that resolve. */
  const concepts: Concept[] = [...current.knowledge.concepts];
  for (const incoming of contents.knowledge.concepts) {
    const next: Concept = {
      ...incoming,
      projectIds: incoming.projectIds.filter((id) => knownProjectIds.has(id)),
    };
    const index = concepts.findIndex((concept) => concept.id === incoming.id);
    if (index >= 0) {
      if (preferBackup && !sameJson(concepts[index], next)) {
        concepts[index] = next;
        stats.conceptsUpdated += 1;
      } else {
        stats.conceptsSkipped += 1;
      }
      continue;
    }
    concepts.push(next);
    stats.conceptsAdded += 1;
  }
  const knownConceptIds = new Set(concepts.map((concept) => concept.id));

  /* Evidence: a new record needs both of its references to exist after the merge. */
  const evidence: ConceptEvidence[] = [...current.knowledge.evidence];
  for (const incoming of contents.knowledge.evidence) {
    const mapped: ConceptEvidence = {
      ...incoming,
      paperId: paperIdMap.get(incoming.paperId) ?? incoming.paperId,
    };
    const index = evidence.findIndex((entry) => entry.id === incoming.id);
    if (index >= 0) {
      if (preferBackup && !sameJson(evidence[index], mapped)) {
        evidence[index] = mapped;
        stats.evidenceUpdated += 1;
      } else {
        stats.evidenceSkipped += 1;
      }
      continue;
    }
    if (!knownConceptIds.has(mapped.conceptId) || papers[mapped.paperId] === undefined) {
      stats.evidenceSkipped += 1;
      continue;
    }
    evidence.push(mapped);
    stats.evidenceAdded += 1;
  }

  /* Relations: never accepted if they would make the dependency graph loop. */
  const knowledge: KnowledgeState = {
    version: 2,
    concepts,
    evidence,
    relations: [...current.knowledge.relations],
    rejections: [...current.knowledge.rejections],
  };
  for (const incoming of contents.knowledge.relations) {
    const index = knowledge.relations.findIndex((relation) => relation.id === incoming.id);
    if (index >= 0) {
      if (preferBackup && !sameJson(knowledge.relations[index], incoming)) {
        knowledge.relations[index] = incoming;
        stats.relationsUpdated += 1;
      } else {
        stats.relationsSkipped += 1;
      }
      continue;
    }
    if (
      !knownConceptIds.has(incoming.from) ||
      !knownConceptIds.has(incoming.to) ||
      incoming.from === incoming.to
    ) {
      stats.relationsSkipped += 1;
      continue;
    }
    const needsCycleCheck = incoming.kind === 'prerequisite';
    if (needsCycleCheck && wouldCycle(knowledge, incoming.from, incoming.to, incoming.kind)) {
      warnings.push('备份里有一条前置关系会在本机形成循环依赖，已跳过。');
      stats.relationsSkipped += 1;
      continue;
    }
    knowledge.relations = [...knowledge.relations, incoming];
    stats.relationsAdded += 1;
  }

  /* Rejections are decisions, not suggestions: merge them by stable fingerprint. */
  for (const incoming of contents.knowledge.rejections) {
    const mappedEvidence = incoming.evidence.map((entry) => ({
      ...entry,
      paperId: paperIdMap.get(entry.paperId) ?? entry.paperId,
    }));
    if (
      !knownConceptIds.has(incoming.from) ||
      !knownConceptIds.has(incoming.to) ||
      incoming.from === incoming.to
    ) {
      stats.rejectionsSkipped += 1;
      continue;
    }
    const mapped: RejectedRelationSuggestion = {
      ...incoming,
      evidence: mappedEvidence,
      fingerprint: relationSuggestionFingerprint({
        from: incoming.from,
        to: incoming.to,
        kind: incoming.kind,
        rationale: incoming.rationale,
        evidence: mappedEvidence,
      }),
    };
    const index = knowledge.rejections.findIndex((entry) => entry.id === incoming.id);
    if (index >= 0) {
      if (preferBackup && !sameJson(knowledge.rejections[index], mapped)) {
        knowledge.rejections[index] = mapped;
        stats.rejectionsUpdated += 1;
      } else {
        stats.rejectionsSkipped += 1;
      }
      continue;
    }
    if (knowledge.rejections.some((entry) => entry.fingerprint === mapped.fingerprint)) {
      stats.rejectionsSkipped += 1;
      continue;
    }
    knowledge.rejections = [...knowledge.rejections, mapped];
    stats.rejectionsAdded += 1;
  }

  // Phase 8 adds an optional link from an occurrence to the relation it grounds. A relation can
  // be skipped by the cycle check above, and an occurrence can be skipped because its paper is
  // missing; after the merge both sides are reconciled so no stored link dangles. An occurrence
  // whose relation did not survive is kept as concept evidence rather than deleted — its
  // quotation is still a real place in the paper.
  const keptRelationIds = new Set(knowledge.relations.map((relation) => relation.id));
  knowledge.evidence = knowledge.evidence.map((entry) =>
    entry.relationId !== undefined && !keptRelationIds.has(entry.relationId)
      ? { ...entry, relationId: undefined }
      : entry,
  );
  const keptEvidenceIds = new Set(knowledge.evidence.map((entry) => entry.id));
  const evidenceByRelation = new Map<string, string[]>();
  for (const entry of knowledge.evidence) {
    if (entry.relationId === undefined) continue;
    const list = evidenceByRelation.get(entry.relationId) ?? [];
    list.push(entry.id);
    evidenceByRelation.set(entry.relationId, list);
  }
  knowledge.relations = knowledge.relations.map((relation) => {
    const linked = evidenceByRelation.get(relation.id);
    const declared = (relation.evidenceIds ?? []).filter((id) => keptEvidenceIds.has(id));
    const merged = [...new Set([...declared, ...(linked ?? [])])];
    if (
      merged.length === (relation.evidenceIds ?? []).length &&
      merged.every((id, index) => (relation.evidenceIds ?? [])[index] === id)
    ) {
      return relation;
    }
    return { ...relation, evidenceIds: merged };
  });

  /* Difficulties: a disposable cache, merged without ever discarding a dismissal. */
  const pages = { ...current.difficulties.pages };
  for (const [key, record] of Object.entries(contents.difficulties.pages)) {
    if (pages[key] === undefined || preferBackup) pages[key] = record;
  }
  const ignored: Record<string, string[]> = { ...current.difficulties.ignored };
  for (const [hash, ids] of Object.entries(contents.difficulties.ignored)) {
    ignored[hash] = [...new Set([...(ignored[hash] ?? []), ...ids])];
  }
  const difficulties: DifficultyState = { pages: trimDifficultyPages(pages), ignored };

  /* Preferences: only fill gaps. The theme of this machine is this machine's decision. */
  const preferences: PreferencesPatch = {};
  if (currentPreferences.theme === null && contents.preferences.theme !== null) {
    preferences.theme = contents.preferences.theme;
    stats.preferencesApplied.push('外观');
  }
  if (currentPreferences.paper === null && contents.preferences.paper !== null) {
    preferences.paper = contents.preferences.paper;
    stats.preferencesApplied.push('纸张模式');
  }
  if (currentPreferences.avatar === null && contents.preferences.avatar !== null) {
    preferences.avatar = contents.preferences.avatar;
    stats.preferencesApplied.push('头像');
  }
  if (currentPreferences.difficulty === null && contents.preferences.difficulty !== null) {
    preferences.difficulty = contents.preferences.difficulty;
    stats.preferencesApplied.push('难点面板设置');
  }

  const selectedExists = projects.some((project) => project.id === current.projects.selectedId);
  const incomingSelected = contents.projects.selectedId;
  const selectedId = selectedExists
    ? current.projects.selectedId
    : incomingSelected !== null && projects.some((project) => project.id === incomingSelected)
      ? incomingSelected
      : (projects[0]?.id ?? null);

  return {
    projects: { projects, papers, annotations, bookmarks, glossary, selectedId },
    knowledge,
    difficulties,
    preferences,
    stats,
    identifierMerges,
    warnings,
  };
}
