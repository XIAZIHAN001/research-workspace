import { normalizeName } from './normalize';

/**
 * A paper as the knowledge base knows it, independent of any project.
 *
 * `id` is the global identity: projects reference it and, later, notes, annotations and
 * knowledge-graph nodes hang off it. It is generated once and never derived from the
 * title or from an external identifier, so renaming a paper or correcting its DOI keeps
 * every reference intact.
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
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. */
  updatedAt: number;
}

/** Everything needed to create a paper. External identifiers are optional. */
export interface PaperInput {
  title: string;
  authors?: string[];
  year?: number;
  doi?: string | null;
  arxivId?: string | null;
}

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
  const title = normalizeName(input.title);
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

  return paper;
}

/**
 * Finds the paper a set of external identifiers points at, or null when none does.
 *
 * This is the only automatic identity match. A missing identifier matches nothing, and a
 * title is never consulted: two papers that share a title stay two papers until something
 * reliable (DOI, arXiv id, or later a PDF content hash) says otherwise.
 */
export function findPaperByExternalId(
  papers: Record<string, Paper>,
  ids: ExternalIds,
): Paper | null {
  const registered = Object.values(papers);
  const doi = ids.doi == null ? null : normalizeDoi(ids.doi);
  if (doi !== null) {
    const byDoi = registered.find((paper) => paper.doi === doi);
    if (byDoi !== undefined) return byDoi;
  }
  const arxivId = ids.arxivId == null ? null : normalizeArxivId(ids.arxivId);
  if (arxivId !== null) {
    const byArxiv = registered.find((paper) => paper.arxivId === arxivId);
    if (byArxiv !== undefined) return byArxiv;
  }
  return null;
}

/** Short author credit for dense UI: "Vaswani 等", "He", or null when unknown. */
export function authorCredit(paper: Pick<Paper, 'authors'>): string | null {
  const names = cleanAuthors(paper.authors);
  const first = names[0];
  if (first === undefined) return null;
  const surname = first.split(/\s+/).at(-1) ?? first;
  return names.length > 1 ? `${surname} 等` : surname;
}
