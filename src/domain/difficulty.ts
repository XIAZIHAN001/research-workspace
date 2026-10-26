/**
 * What the assistant thought was worth understanding, and where it is in the paper.
 *
 * These records are deliberately *not* annotations. An annotation is something the reader
 * wrote; a suggestion is a machine's opinion that has been anchored to the text and can be
 * dismissed. Keeping them in their own shape and their own store means closing the suggestions
 * can never touch a note, and a note can never be mistaken for a suggestion.
 *
 * The anchor is the same structure a highlight uses — quote, context, and boxes as fractions of
 * the page — because the same conservative matching then applies: a suggestion is drawn on the
 * page only when its quotation can be found exactly once.
 */

import type { NormalizedRect } from './annotation';

export type DifficultyKind =
  'concept' | 'definition' | 'theorem' | 'formula' | 'algorithm' | 'design' | 'prerequisite';

export const DIFFICULTY_KINDS: readonly DifficultyKind[] = [
  'concept',
  'definition',
  'theorem',
  'formula',
  'algorithm',
  'design',
  'prerequisite',
];

export const DIFFICULTY_KIND_LABEL: Record<DifficultyKind, string> = {
  concept: '核心概念',
  definition: '定义',
  theorem: '定理',
  formula: '公式',
  algorithm: '算法步骤',
  design: '设计选择',
  prerequisite: '前置知识',
};

/** What the model proposed, before this app tried to find it on the page. */
export interface ProposedDifficulty {
  kind: DifficultyKind;
  /** A short name for the idea, for the list and the marker's tooltip. */
  title: string;
  /** The exact page text this is about. Verified verbatim by the service. */
  quote: string;
  /** Why this is worth understanding here. */
  why: string;
  /** One to three sentences a reader can use straight away. */
  quick: string;
  /** An optional nudge towards the deeper question. */
  deeper: string | null;
}

/** How well the quotation could be found on the rendered page. */
export type DifficultyLocation = 'found' | 'ambiguous' | 'missing';

/**
 * One suggestion, bound to a place in the paper.
 *
 * `anchor` is null unless the location is `found`. An ambiguous or missing quotation is still
 * worth showing — the reader may want the explanation — but it is never drawn on the page,
 * because guessing where it belongs is exactly what this project refuses to do.
 */
export interface DifficultySuggestion extends ProposedDifficulty {
  id: string;
  paperId: string;
  pdfSha256: string;
  page: number;
  location: DifficultyLocation;
  anchor: {
    quote: string;
    prefix: string;
    suffix: string;
    rects: NormalizedRect[];
    /** Offsets inside the page's own text, so the same passage can be sent to the assistant. */
    start: number;
    end: number;
  } | null;
  model: string;
  analysedAt: number;
}

/** A page's worth of suggestions, as it is cached. */
export interface DifficultyPageRecord {
  paperId: string;
  pdfSha256: string;
  page: number;
  model: string;
  rulesVersion: string;
  analysedAt: number;
  suggestions: DifficultySuggestion[];
  /** Suggestions dropped because their quotation was not in the text sent. */
  rejected: number;
}

/** The whole cache: analysed pages plus the reader's dismissals, per file. */
export interface DifficultyState {
  pages: Record<string, DifficultyPageRecord>;
  /** Suggestion ids the reader has dismissed, per file hash. */
  ignored: Record<string, string[]>;
}

/** The reader's two switches: whether new pages are analysed, and whether marks are drawn. */
export interface DifficultyPrefs {
  enabled: boolean;
  markersVisible: boolean;
}

export const DEFAULT_DIFFICULTY_PREFS: DifficultyPrefs = { enabled: false, markersVisible: true };

/** Enough for a long paper read end to end, bounded so storage cannot fill up. */
export const MAX_DIFFICULTY_PAGES = 400;

/** Drops the oldest analysed pages once the cache is over its bound. */
export function trimDifficultyPages(
  pages: Record<string, DifficultyPageRecord>,
  max: number = MAX_DIFFICULTY_PAGES,
): Record<string, DifficultyPageRecord> {
  const keys = Object.keys(pages);
  if (keys.length <= max) return pages;
  const ordered = keys
    .map((key) => ({ key, at: pages[key]?.analysedAt ?? 0 }))
    .sort((one, other) => other.at - one.at)
    .slice(0, max);
  const kept: Record<string, DifficultyPageRecord> = {};
  for (const { key } of ordered) {
    const record = pages[key];
    if (record !== undefined) kept[key] = record;
  }
  return kept;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isDifficultyPageRecord(value: unknown): value is DifficultyPageRecord {
  if (!isRecord(value)) return false;
  if (typeof value.paperId !== 'string' || typeof value.pdfSha256 !== 'string') return false;
  if (typeof value.page !== 'number' || !Number.isInteger(value.page)) return false;
  if (typeof value.model !== 'string' || typeof value.rulesVersion !== 'string') return false;
  if (typeof value.analysedAt !== 'number') return false;
  return Array.isArray(value.suggestions) && typeof value.rejected === 'number';
}

/**
 * Strict reader for a cached-pages payload, for restoring a backup.
 *
 * The store itself is deliberately forgiving — this cache is disposable — but a backup is
 * not: if any record is the wrong shape, the file is reported as damaged rather than
 * restoring a cache whose entries mean something different from what they claim.
 */
export function parseDifficultyState(value: unknown): DifficultyState | null {
  if (!isRecord(value)) return null;
  if ((value.version ?? 1) !== 1) return null;
  if (!isRecord(value.pages) || !isRecord(value.ignored)) return null;
  const pages: Record<string, DifficultyPageRecord> = {};
  for (const [key, entry] of Object.entries(value.pages)) {
    // `pages['__proto__'] = entry` would call the prototype setter and lose the record; the
    // cache is disposable, so a key this build cannot store is skipped rather than fatal.
    if (key === '__proto__') continue;
    if (!isDifficultyPageRecord(entry)) return null;
    pages[key] = entry;
  }
  const ignored: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value.ignored)) {
    if (key === '__proto__') continue;
    if (!Array.isArray(entry) || !entry.every((id) => typeof id === 'string')) return null;
    ignored[key] = entry;
  }
  return { pages, ignored };
}

export const LOCATION_LABEL: Record<DifficultyLocation, string> = {
  found: '已定位',
  ambiguous: '位置有歧义，未标注',
  missing: '原文中找不到，未标注',
};

/** A stable id for a suggestion: the same page and quotation always produce the same id. */
export function suggestionId(pdfSha256: string, page: number, quote: string): string {
  // A short, deterministic hash. It only has to be unique within one paper's stored pages,
  // and being derived from the content means a re-analysis of the same text replaces rather
  // than duplicates.
  let hash = 0;
  const seed = `${pdfSha256.slice(0, 12)}|${String(page)}|${quote}`;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return `d${(hash >>> 0).toString(36)}`;
}
