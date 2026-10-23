import { normalizeTitle } from './normalize';
import type { PaperPdf, PaperReading } from './pdfFile';

/** Where a paper is in the reading queue. Absence on a paper means `unread`. */
export const READING_STATUSES = ['unread', 'reading', 'done'] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

export const READING_STATUS_LABEL: Record<ReadingStatus, string> = {
  unread: '未读',
  reading: '在读',
  done: '读完',
};

export const MAX_TAG_LENGTH = 24;
export const MAX_TAGS = 12;

export function isReadingStatus(value: unknown): value is ReadingStatus {
  return typeof value === 'string' && READING_STATUSES.includes(value as ReadingStatus);
}

/** The status a paper shows for; a paper that never had one is unread. */
export function paperStatus(paper: Pick<Paper, 'status'>): ReadingStatus {
  return paper.status ?? 'unread';
}

/**
 * Tags as stored: trimmed, empty entries dropped, compared case-insensitively so "RL" and
 * "rl" are one tag, and bounded so one paste cannot turn a row into a paragraph.
 */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().slice(0, MAX_TAG_LENGTH);
    if (tag === '') continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
    if (result.length >= MAX_TAGS) break;
  }
  return result;
}

/**
 * A paper as the knowledge base knows it, independent of any project.
 *
 * `id` is the global identity: projects reference it and, later, notes, annotations and
 * knowledge-graph nodes hang off it. It is generated once and never derived from the
 * title, from an external identifier or from the PDF file, so renaming a paper, correcting
 * its DOI or swapping its PDF keeps every reference intact.
 */
export interface Paper {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  /** Normalized DOI: lowercase, no resolver prefix. */
  doi?: string;
  /** Normalized arXiv id: no `arXiv:` prefix, no version suffix, lowercase. */
  arxivId?: string;
  /** The local PDF attached to this paper, if one was imported. Bytes live in IndexedDB. */
  pdf?: PaperPdf;
  /** Where the reader last left off. */
  reading?: PaperReading;
  /** Free-form labels for the library. Absent when the paper has none. */
  tags?: string[];
  /** Reading queue state. Absent means unread. */
  status?: ReadingStatus;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. */
  updatedAt: number;
}

/** Everything needed to create a paper. External identifiers and the PDF are optional. */
export interface PaperInput {
  title: string;
  authors?: string[];
  year?: number;
  doi?: string | null;
  arxivId?: string | null;
  pdf?: PaperPdf | null;
}

/**
 * A change to an existing paper. `undefined` leaves a field alone; `null` clears it.
 *
 * Editing metadata, attaching a PDF and importing a new paper are deliberately separate
 * operations: this one only ever touches the paper it names, and never creates, merges or
 * deletes anything.
 */
export interface PaperEdit {
  title?: string;
  authors?: string[];
  year?: number | null;
  doi?: string | null;
  arxivId?: string | null;
  pdf?: PaperPdf | null;
  reading?: PaperReading;
  /** `null` clears every tag; an array replaces them. */
  tags?: string[] | null;
  /** `null` or `'unread'` clears the queue state back to unread. */
  status?: ReadingStatus | null;
}

export type PaperEditFailure =
  | { reason: 'unknown-paper' }
  | { reason: 'blank-title' }
  | { reason: 'invalid-year'; value: number }
  | { reason: 'invalid-identifier'; field: 'doi' | 'arxivId'; value: string }
  /** Another paper already owns this identifier: never merged, never overwritten. */
  | { reason: 'identifier-taken'; field: 'doi' | 'arxivId'; paper: Paper };

export type PaperEditResult = { ok: true; paper: Paper } | { ok: false; failure: PaperEditFailure };

/** External identifiers used to recognise a paper that is already in the knowledge base. */
export interface ExternalIds {
  doi?: string | null;
  arxivId?: string | null;
}

const DOI_PREFIX = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i;
/** Prefix 10.NNNN, then a non-empty suffix. Anything else is not a DOI we can match on. */
const DOI_SHAPE = /^10\.\d{4,9}\/\S+$/;

const ARXIV_PREFIX = /^(?:https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)/i;
/** New scheme (2401.12345) and the pre-2007 one (hep-th/9901001). */
const ARXIV_NEW = /^\d{4}\.\d{4,5}$/;
const ARXIV_OLD = /^[a-z-]+(?:\.[a-z]{2})?\/\d{7}$/;
const ARXIV_VERSION = /v\d+$/;

/**
 * Normalizes a DOI to its canonical form, or returns null when it is not a DOI.
 *
 * Both halves are lowercased: the prefix is case-insensitive by definition and resolvers
 * treat the suffix the same way, so `10.1000/ABC` and `10.1000/abc` are one record.
 */
export function normalizeDoi(raw: string): string | null {
  const value = raw.trim().replace(DOI_PREFIX, '').trim().toLowerCase();
  return DOI_SHAPE.test(value) ? value : null;
}

/**
 * Normalizes an arXiv id, or returns null when it is not one.
 *
 * The version suffix is dropped: v1 and v2 of a preprint are the same paper for the
 * purpose of notes and citations, and arXiv treats the bare id as the stable one.
 */
export function normalizeArxivId(raw: string): string | null {
  const value = raw
    .trim()
    .replace(ARXIV_PREFIX, '')
    .replace(/\.pdf$/i, '')
    .trim()
    .toLowerCase()
    .replace(ARXIV_VERSION, '');
  return ARXIV_NEW.test(value) || ARXIV_OLD.test(value) ? value : null;
}

function cleanAuthors(authors: readonly string[]): string[] {
  return authors.map((author) => author.trim()).filter((author) => author !== '');
}

/**
 * Builds a paper. Returns null for a blank title.
 *
 * Identifiers that do not normalize are dropped rather than stored as typed: a malformed
 * DOI can never match a later import, so keeping it would only look like a working link.
 */
export function createPaper(input: PaperInput, makeId: () => string, now: number): Paper | null {
  const title = normalizeTitle(input.title);
  if (title === null) return null;

  const paper: Paper = {
    id: makeId(),
    title,
    authors: cleanAuthors(input.authors ?? []),
    createdAt: now,
    updatedAt: now,
  };
  if (typeof input.year === 'number' && Number.isFinite(input.year)) paper.year = input.year;

  const doi = input.doi == null ? null : normalizeDoi(input.doi);
  if (doi !== null) paper.doi = doi;
  const arxivId = input.arxivId == null ? null : normalizeArxivId(input.arxivId);
  if (arxivId !== null) paper.arxivId = arxivId;
  if (input.pdf != null) paper.pdf = input.pdf;

  return paper;
}

/**
 * Applies an edit to one paper, or explains why it cannot be applied.
 *
 * The paper's `id` is never part of an edit: identity is not editable. An identifier that
 * already belongs to a different paper makes the whole edit fail — importing, editing and
 * merging are separate operations, and silently moving a DOI from one record to another
 * would rewrite two papers' identities at once.
 *
 * Returns the same paper object when the edit changes nothing, so callers can treat that
 * as a no-op.
 */
export function applyPaperEdit(
  papers: Record<string, Paper>,
  paperId: string,
  edit: PaperEdit,
  now: number,
): PaperEditResult {
  const current = papers[paperId];
  if (current === undefined) return { ok: false, failure: { reason: 'unknown-paper' } };

  const updated: Paper = { ...current };

  if (edit.title !== undefined) {
    const title = normalizeTitle(edit.title);
    if (title === null) return { ok: false, failure: { reason: 'blank-title' } };
    updated.title = title;
  }
  if (edit.authors !== undefined) updated.authors = cleanAuthors(edit.authors);
  if (edit.year !== undefined) {
    if (edit.year === null) delete updated.year;
    else if (Number.isFinite(edit.year)) updated.year = edit.year;
    else return { ok: false, failure: { reason: 'invalid-year', value: edit.year } };
  }

  for (const field of ['doi', 'arxivId'] as const) {
    const raw = edit[field];
    if (raw === undefined) continue;
    const value = raw === null ? null : normalizeIdentifier(field, raw);
    if (raw !== null && value === null) {
      return { ok: false, failure: { reason: 'invalid-identifier', field, value: raw } };
    }
    if (value === null) {
      delete updated[field];
      continue;
    }
    const owner = findByIdentifier(papers, field, value);
    if (owner !== undefined && owner.id !== paperId) {
      return { ok: false, failure: { reason: 'identifier-taken', field, paper: owner } };
    }
    updated[field] = value;
  }

  if (edit.pdf !== undefined) {
    if (edit.pdf === null) delete updated.pdf;
    else updated.pdf = edit.pdf;
  }
  if (edit.reading !== undefined) {
    updated.reading = {
      page: Math.max(1, Math.floor(edit.reading.page)),
      updatedAt: edit.reading.updatedAt,
    };
  }
  if (edit.tags !== undefined) {
    if (edit.tags === null) {
      delete updated.tags;
    } else {
      const tags = normalizeTags(edit.tags);
      if (tags.length === 0) delete updated.tags;
      else updated.tags = tags;
    }
  }
  if (edit.status !== undefined) {
    // `unread` is the absence of a status, so both spellings produce the same record.
    if (edit.status === null || edit.status === 'unread') delete updated.status;
    else updated.status = edit.status;
  }

  if (papersEqual(current, updated)) return { ok: true, paper: current };
  updated.updatedAt = now;
  return { ok: true, paper: updated };
}

function normalizeIdentifier(field: 'doi' | 'arxivId', raw: string): string | null {
  return field === 'doi' ? normalizeDoi(raw) : normalizeArxivId(raw);
}

/** The paper that already carries this identifier, if any. */
function findByIdentifier(
  papers: Record<string, Paper>,
  field: 'doi' | 'arxivId',
  value: string,
): Paper | undefined {
  return Object.values(papers).find((paper) => paper[field] === value);
}

function papersEqual(one: Paper, other: Paper): boolean {
  return JSON.stringify(one) === JSON.stringify(other);
}

/** What resolving a set of external identifiers against the registry found. */
export type PaperIdentityResolution =
  /** No usable identifier: nothing may be matched automatically. */
  | { kind: 'none' }
  /** Every usable identifier points at the same single paper. */
  | { kind: 'match'; paper: Paper }
  /**
   * The identifiers disagree — one points at paper A, another at paper B, or a single
   * identifier matches several records. Never resolved by picking a winner.
   */
  | { kind: 'conflict'; papers: Paper[] };

/** Result of asking a project to reference a paper. */
export type PaperReferenceOutcome =
  /** The paper is linked: either an existing record was reused, or a new one was created. */
  | { status: 'linked'; paper: Paper }
  /** The identifiers point at more than one existing paper. Nothing was linked or created. */
  | { status: 'conflict'; papers: Paper[] }
  /** The input cannot describe a paper (a blank title). */
  | { status: 'invalid' };

/** Result of adding a paper to the knowledge base without attaching it to a project. */
export type AddPaperOutcome =
  /** The paper is in the knowledge base: either an existing record was reused, or a new one. */
  | { status: 'added'; paper: Paper }
  | { status: 'conflict'; papers: Paper[] }
  | { status: 'invalid' };

/**
 * Resolves external identifiers to the paper they identify.
 *
 * This is the only automatic identity match. A missing identifier matches nothing, and a
 * title is never consulted: two papers that share a title stay two papers until something
 * reliable (DOI, arXiv id, or later a PDF content hash) says otherwise.
 *
 * Identifiers that point at different papers are reported as a conflict rather than
 * resolved by precedence — silently preferring the DOI would attach a project to the wrong
 * paper, and merging the two records would invent an identity relationship the data does
 * not support.
 */
export function resolvePaperIdentity(
  papers: Record<string, Paper>,
  ids: ExternalIds,
): PaperIdentityResolution {
  const registered = Object.values(papers);
  const matches: Paper[] = [];
  const addMatches = (matchesPaper: (paper: Paper) => boolean): void => {
    for (const paper of registered) {
      if (matchesPaper(paper) && !matches.some((seen) => seen.id === paper.id)) matches.push(paper);
    }
  };

  const doi = ids.doi == null ? null : normalizeDoi(ids.doi);
  if (doi !== null) addMatches((paper) => paper.doi === doi);
  const arxivId = ids.arxivId == null ? null : normalizeArxivId(ids.arxivId);
  if (arxivId !== null) addMatches((paper) => paper.arxivId === arxivId);

  const [only, ...others] = matches;
  if (only === undefined) return { kind: 'none' };
  if (others.length === 0) return { kind: 'match', paper: only };
  return { kind: 'conflict', papers: matches };
}

/** Short author credit for dense UI: "Vaswani 等", "He", or null when unknown. */
export function authorCredit(paper: Pick<Paper, 'authors'>): string | null {
  const names = cleanAuthors(paper.authors);
  const first = names[0];
  if (first === undefined) return null;
  const surname = first.split(/\s+/).at(-1) ?? first;
  return names.length > 1 ? `${surname} 等` : surname;
}
