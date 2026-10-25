import {
  ANNOTATION_KINDS,
  ANNOTATION_ORIGINS,
  type Annotation,
  type AnnotationKind,
  type AnnotationOrigin,
} from './annotation';
import type { Bookmark } from './bookmark';
import { isReadingStatus, normalizeTags, type Paper, type ReadingStatus } from './papers';
import type { PaperPdf, PaperReading } from './pdfFile';
import type { Project } from './project';
import type { ProjectsState } from './projectsState';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/* ------------------------------------------------------------------ *
 * Current shape (schema version 6)
 * ------------------------------------------------------------------ */

/**
 * Where a note's text came from.
 *
 * A payload written before assistant notes existed has no `origin` at all, and everything in it
 * is the reader's own work — so a missing field means `user`, which is what the 4→5 migration
 * writes anyway. A field that is present but wrong is corruption, not an older shape.
 */
function parseOrigins(
  value: unknown,
  sourceLabel: unknown,
): { origin: AnnotationOrigin; sourceLabel: string } | null {
  let origin: AnnotationOrigin = 'user';
  if (value !== undefined) {
    if (typeof value !== 'string' || !ANNOTATION_ORIGINS.includes(value as AnnotationOrigin)) {
      return null;
    }
    origin = value as AnnotationOrigin;
  }
  let label = '';
  if (sourceLabel !== undefined) {
    if (typeof sourceLabel !== 'string') return null;
    label = sourceLabel;
  }
  // An assistant note without a label would be indistinguishable in the panel; the migration
  // and the save path both always set one, so this combination means the payload is wrong.
  if (origin === 'assistant' && label === '') return null;
  return { origin, sourceLabel: label };
}

/** A highlight whose shape does not survive validation is rejected, not guessed at. */
function parseAnnotation(value: unknown): Annotation | null {
  if (!isRecord(value)) return null;
  const {
    id,
    paperId,
    pdfSha256,
    page,
    quote,
    prefix,
    suffix,
    rects,
    kind,
    note,
    origin,
    sourceLabel,
    resolvedAt,
    createdAt,
    updatedAt,
  } = value;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof paperId !== 'string' || paperId === '') return null;
  if (typeof pdfSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(pdfSha256)) return null;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) return null;
  if (typeof quote !== 'string' || quote === '') return null;
  if (typeof prefix !== 'string' || typeof suffix !== 'string') return null;
  if (typeof kind !== 'string' || !ANNOTATION_KINDS.includes(kind as AnnotationKind)) return null;
  if (typeof note !== 'string') return null;
  if (typeof createdAt !== 'number' || typeof updatedAt !== 'number') return null;
  const provenance = parseOrigins(origin, sourceLabel);
  if (provenance === null) return null;
  // Absence means the note is still open (every payload from before v7); a value that is
  // present but not a timestamp is corruption, same rule as every other field here.
  let parsedResolvedAt: number | undefined;
  if (resolvedAt !== undefined) {
    if (typeof resolvedAt !== 'number' || !Number.isFinite(resolvedAt) || resolvedAt < 0) {
      return null;
    }
    parsedResolvedAt = resolvedAt;
  }
  if (!Array.isArray(rects)) return null;
  const parsedRects: Annotation['rects'] = [];
  for (const rect of rects) {
    if (!isRecord(rect)) return null;
    const { x, y, width, height } = rect;
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    if (typeof width !== 'number' || typeof height !== 'number') return null;
    parsedRects.push({ x, y, width, height });
  }
  if (parsedRects.length === 0) return null;
  return {
    id,
    paperId,
    pdfSha256,
    page,
    quote,
    prefix,
    suffix,
    rects: parsedRects,
    kind: kind as AnnotationKind,
    note,
    ...provenance,
    ...(parsedResolvedAt === undefined ? {} : { resolvedAt: parsedResolvedAt }),
    createdAt,
    updatedAt,
  };
}

/** A malformed bookmark is rejected, like a malformed highlight. */
function parseBookmark(value: unknown): Bookmark | null {
  if (!isRecord(value)) return null;
  const { id, paperId, page, label, createdAt } = value;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof paperId !== 'string' || paperId === '') return null;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) return null;
  if (typeof label !== 'string') return null;
  if (typeof createdAt !== 'number') return null;
  return { id, paperId, page, label, createdAt };
}

/** A malformed PDF binding is dropped: rejecting the whole payload would hide the workspace. */
function parsePaperPdf(value: unknown): PaperPdf | null {
  if (!isRecord(value)) return null;
  const { sha256, name, bytes, pageCount, addedAt } = value;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (typeof name !== 'string' || name === '') return null;
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  if (typeof addedAt !== 'number') return null;
  if (pageCount !== null && typeof pageCount !== 'number') return null;
  return { sha256, name, bytes, pageCount, addedAt };
}

function parsePaperReading(value: unknown): PaperReading | null {
  if (!isRecord(value)) return null;
  const { page, updatedAt } = value;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) return null;
  if (typeof updatedAt !== 'number') return null;
  return { page, updatedAt };
}

/**
 * Tags are optional and cosmetic: a malformed list is dropped with the rest of the paper's
 * metadata intact, like the PDF binding. `undefined` means "this payload has none".
 */
function parsePaperTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === 'string')) return undefined;
  const tags = normalizeTags(value as string[]);
  return tags.length === 0 ? undefined : tags;
}

/** A status this build does not know is dropped; the paper falls back to unread. */
function parsePaperStatus(value: unknown): ReadingStatus | undefined {
  return isReadingStatus(value) ? value : undefined;
}

function parsePaper(value: unknown): Paper | null {
  if (!isRecord(value)) return null;
  const {
    id,
    title,
    authors,
    year,
    doi,
    arxivId,
    pdf,
    reading,
    tags,
    status,
    createdAt,
    updatedAt,
  } = value;
  if (typeof id !== 'string' || typeof title !== 'string') return null;
  if (!Array.isArray(authors) || !authors.every((a) => typeof a === 'string')) return null;
  if (typeof createdAt !== 'number' || typeof updatedAt !== 'number') return null;
  const paper: Paper = { id, title, authors, createdAt, updatedAt };
  // Optional fields are dropped rather than guessed when they have the wrong type.
  if (typeof year === 'number') paper.year = year;
  if (typeof doi === 'string') paper.doi = doi;
  if (typeof arxivId === 'string') paper.arxivId = arxivId;
  const parsedPdf = parsePaperPdf(pdf);
  if (parsedPdf !== null) paper.pdf = parsedPdf;
  const parsedReading = parsePaperReading(reading);
  if (parsedReading !== null) paper.reading = parsedReading;
  const parsedTags = parsePaperTags(tags);
  if (parsedTags !== undefined) paper.tags = parsedTags;
  const parsedStatus = parsePaperStatus(status);
  if (parsedStatus !== undefined) paper.status = parsedStatus;
  return paper;
}

function parseProject(value: unknown): Project | null {
  if (!isRecord(value)) return null;
  const { id, name, corePaperId, relatedPaperIds, createdAt, updatedAt } = value;
  if (typeof id !== 'string' || typeof name !== 'string') return null;
  if (typeof corePaperId !== 'string') return null;
  if (typeof createdAt !== 'number' || typeof updatedAt !== 'number') return null;
  if (!Array.isArray(relatedPaperIds)) return null;
  if (!relatedPaperIds.every((paperId) => typeof paperId === 'string')) return null;
  if (corePaperId === '' || relatedPaperIds.includes(corePaperId)) return null;
  if (new Set(relatedPaperIds).size !== relatedPaperIds.length) return null;
  return { id, name, corePaperId, relatedPaperIds: [...relatedPaperIds], createdAt, updatedAt };
}

function parsePaperRegistry(value: unknown): Record<string, Paper> | null {
  if (!isRecord(value)) return null;
  const papers: Record<string, Paper> = {};
  for (const [id, entry] of Object.entries(value)) {
    const paper = parsePaper(entry);
    // The key must be the paper's own id: two ids for one paper would make the
    // registry ambiguous, and nothing this app writes can produce that.
    if (paper === null || paper.id !== id) return null;
    papers[id] = paper;
  }
  return papers;
}

/**
 * Validates untrusted JSON (from storage) into a ProjectsState.
 * Returns null on any shape mismatch or broken project→paper reference, so callers can
 * quarantine the payload instead of starting from a half-consistent state.
 */
export function parseProjectsState(value: unknown): ProjectsState | null {
  if (!isRecord(value) || !Array.isArray(value.projects)) return null;
  const papers = parsePaperRegistry(value.papers);
  if (papers === null) return null;

  const projects: Project[] = [];
  for (const entry of value.projects) {
    const project = parseProject(entry);
    if (project === null) return null;
    projects.push(project);
  }
  if (new Set(projects.map((p) => p.id)).size !== projects.length) return null;

  for (const project of projects) {
    if (papers[project.corePaperId] === undefined) return null;
    if (project.relatedPaperIds.some((paperId) => papers[paperId] === undefined)) return null;
  }

  // A payload written before highlights existed has no list at all; anything else that is not a
  // list is corrupt rather than old.
  const rawAnnotations = value.annotations;
  const annotations: Annotation[] = [];
  if (rawAnnotations !== undefined) {
    if (!Array.isArray(rawAnnotations)) return null;
    for (const entry of rawAnnotations) {
      const annotation = parseAnnotation(entry);
      if (annotation === null) return null;
      // A highlight without its paper cannot be shown, and nothing this app writes can
      // produce one, so it is treated as corruption rather than silently dropped.
      if (papers[annotation.paperId] === undefined) return null;
      annotations.push(annotation);
    }
    if (new Set(annotations.map((annotation) => annotation.id)).size !== annotations.length) {
      return null;
    }
  }

  // A payload written before saved bookmarks existed has no list; anything else that is not a
  // list is corrupt rather than old.
  const rawBookmarks = value.bookmarks;
  const bookmarks: Bookmark[] = [];
  if (rawBookmarks !== undefined) {
    if (!Array.isArray(rawBookmarks)) return null;
    for (const entry of rawBookmarks) {
      const bookmark = parseBookmark(entry);
      if (bookmark === null) return null;
      if (papers[bookmark.paperId] === undefined) return null;
      bookmarks.push(bookmark);
    }
    if (new Set(bookmarks.map((bookmark) => bookmark.id)).size !== bookmarks.length) return null;
  }

  const known = projects.some((p) => p.id === value.selectedId);
  const selectedId = known ? (value.selectedId as string) : (projects[0]?.id ?? null);
  return { projects, papers, annotations, bookmarks, selectedId };
}

/* ------------------------------------------------------------------ *
 * Phase 0 shape (schema version 1, no version field)
 * Read only by the 1→2 migration; nothing writes this shape any more.
 * ------------------------------------------------------------------ */

export interface LegacyPaperRef {
  id: string;
  title: string;
  authors: string[];
  year?: number;
}

export interface LegacyProject {
  id: string;
  name: string;
  corePaper: LegacyPaperRef;
  relatedPapers: LegacyPaperRef[];
  createdAt: number;
  updatedAt: number;
}

export interface LegacyProjectsState {
  projects: LegacyProject[];
  selectedId: string | null;
}

function parseLegacyPaper(value: unknown): LegacyPaperRef | null {
  if (!isRecord(value)) return null;
  const { id, title, authors, year } = value;
  if (typeof id !== 'string' || typeof title !== 'string') return null;
  if (!Array.isArray(authors) || !authors.every((a) => typeof a === 'string')) return null;
  const paper: LegacyPaperRef = { id, title, authors };
  if (typeof year === 'number') paper.year = year;
  return paper;
}

function parseLegacyProject(value: unknown): LegacyProject | null {
  if (!isRecord(value)) return null;
  const { id, name, corePaper, relatedPapers, createdAt, updatedAt } = value;
  if (typeof id !== 'string' || typeof name !== 'string') return null;
  if (typeof createdAt !== 'number' || typeof updatedAt !== 'number') return null;
  const core = parseLegacyPaper(corePaper);
  if (core === null || !Array.isArray(relatedPapers)) return null;
  const related = relatedPapers
    .map(parseLegacyPaper)
    .filter((p): p is LegacyPaperRef => p !== null);
  if (related.length !== relatedPapers.length) return null;
  return { id, name, corePaper: core, relatedPapers: related, createdAt, updatedAt };
}

/** Validates the Phase 0 payload shape. Returns null when the payload is not one. */
export function parseLegacyState(value: unknown): LegacyProjectsState | null {
  if (!isRecord(value) || !Array.isArray(value.projects)) return null;
  const projects = value.projects
    .map(parseLegacyProject)
    .filter((p): p is LegacyProject => p !== null);
  if (projects.length !== value.projects.length) return null;
  const known = projects.some((p) => p.id === value.selectedId);
  const selectedId = known ? (value.selectedId as string) : (projects[0]?.id ?? null);
  return { projects, selectedId };
}
