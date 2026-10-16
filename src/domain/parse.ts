import type { Paper } from './papers';
import type { PaperPdf, PaperReading } from './pdfFile';
import type { Project } from './project';
import type { ProjectsState } from './projectsState';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/* ------------------------------------------------------------------ *
 * Current shape (schema version 3)
 * ------------------------------------------------------------------ */

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

function parsePaper(value: unknown): Paper | null {
  if (!isRecord(value)) return null;
  const { id, title, authors, year, doi, arxivId, pdf, reading, createdAt, updatedAt } = value;
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

  const known = projects.some((p) => p.id === value.selectedId);
  const selectedId = known ? (value.selectedId as string) : (projects[0]?.id ?? null);
  return { projects, papers, selectedId };
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
