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
