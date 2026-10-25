/**
 * A highlight a reader made in a paper, with the note they wrote about it.
 *
 * The record holds two things that are deliberately separate: an *anchor* (which file, which
 * page, which text, and where on the page) and the *note* (what the reader wrote). Nothing in
 * the anchor refers to the app's own rendering — no DOM nodes, no element ids, no React state
 * — so it keeps its meaning when the page is re-rendered at another zoom, in another window,
 * or by a later version of pdf.js.
 */
export interface NormalizedRect {
  /** All four are fractions of the page box, so they survive zoom and window size. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AnnotationKind = 'question' | 'insight' | 'note';

/**
 * Where the *text* of a note came from.
 *
 * Once a reader saves an explanation the assistant wrote, it sits in the same list as the notes
 * they typed themselves — and the two must not be confused, either now or after an edit. So the
 * origin records how the text entered the app and is never rewritten: a note that began as an
 * answer stays marked as one, even after the reader edits it.
 */
export type AnnotationOrigin = 'user' | 'assistant';

export const ANNOTATION_ORIGINS: readonly AnnotationOrigin[] = ['user', 'assistant'];

export const ORIGIN_LABEL: Record<AnnotationOrigin, string> = {
  user: '自己写',
  assistant: 'AI 辅助',
};

export interface Annotation {
  id: string;
  /** The global paper this belongs to: notes follow the paper, not the project. */
  paperId: string;
  /** SHA-256 of the PDF the selection was made on. */
  pdfSha256: string;
  /** 1-based page number. */
  page: number;
  /** The selected text, whitespace-collapsed. */
  quote: string;
  /** A little of the text before the quote, for re-locating it unambiguously. */
  prefix: string;
  /** A little of the text after the quote. */
  suffix: string;
  /** Where the quote sits on the page, as fractions of the page box. */
  rects: NormalizedRect[];
  kind: AnnotationKind;
  note: string;
  origin: AnnotationOrigin;
  /** Which provider and model wrote an assistant note; empty for the reader's own. */
  sourceLabel: string;
  /**
   * When the reader marked a question answered, in epoch ms. Absence means still open.
   *
   * Only questions carry the notion in the UI, but the field is not narrowed to them: a
   * resolution is a fact about a note, and refusing to store it for other kinds would make
   * "change a note's kind" destroy a state the reader never asked to lose.
   */
  resolvedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** What the reader can write about a passage. */
export const ANNOTATION_KINDS: readonly AnnotationKind[] = ['question', 'insight', 'note'];

export const ANNOTATION_KIND_LABEL: Record<AnnotationKind, string> = {
  question: '疑问',
  insight: '理解',
  note: '记录',
};

/** Characters of context stored on each side of the quote. */
export const CONTEXT_RADIUS = 40;

export const MAX_QUOTE_LENGTH = 2000;
export const MAX_NOTE_LENGTH = 4000;
export const MAX_SOURCE_LENGTH = 120;

export interface AnnotationInput {
  paperId: string;
  pdfSha256: string;
  page: number;
  quote: string;
  prefix: string;
  suffix: string;
  rects: readonly NormalizedRect[];
  kind: AnnotationKind;
  note?: string;
  /** Defaults to the reader's own writing; only the assistant flow passes `assistant`. */
  origin?: AnnotationOrigin;
  sourceLabel?: string;
}

/** Collapses the whitespace a PDF text layer puts between and inside lines. */
export function normalizeQuote(text: string): string {
  return collapseWhitespace(text).trim();
}

/**
 * Collapses whitespace but keeps the ends.
 *
 * Context has to keep its boundary spaces: matching rewards how much of the stored text around
 * a quote lines up with the page, and a trimmed context is one character out of step with the
 * page text it came from — which is exactly enough to make every occurrence score zero.
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** A box smaller than this is a rounding artefact, not a highlight. */
const MIN_RECT = 0.002;

/** Intersects every box with the page, so a stored highlight can never be drawn off the paper. */
function normalizeRects(rects: readonly NormalizedRect[]): NormalizedRect[] {
  const clamp = (value: number): number => Math.min(1, Math.max(0, value));
  const kept: NormalizedRect[] = [];
  for (const rect of rects) {
    const left = clamp(rect.x);
    const right = clamp(rect.x + rect.width);
    const top = clamp(rect.y);
    const bottom = clamp(rect.y + rect.height);
    const width = right - left;
    const height = bottom - top;
    if (width > MIN_RECT && height > MIN_RECT) kept.push({ x: left, y: top, width, height });
  }
  return kept;
}

/**
 * Builds an annotation. Returns null when the input cannot be anchored — an empty selection,
 * a page below the first one, a file hash that is not a hash — because a record that cannot be
 * found again is worse than a refusal that says so.
 */
export function createAnnotation(
  input: AnnotationInput,
  makeId: () => string,
  now: number,
): Annotation | null {
  const quote = normalizeQuote(input.quote);
  if (quote === '' || quote.length > MAX_QUOTE_LENGTH) return null;
  if (!Number.isInteger(input.page) || input.page < 1) return null;
  if (!/^[0-9a-f]{64}$/.test(input.pdfSha256)) return null;
  const rects = normalizeRects(input.rects);
  if (rects.length === 0) return null;

  return {
    id: makeId(),
    paperId: input.paperId,
    pdfSha256: input.pdfSha256,
    page: input.page,
    quote,
    prefix: collapseWhitespace(input.prefix).slice(-CONTEXT_RADIUS),
    suffix: collapseWhitespace(input.suffix).slice(0, CONTEXT_RADIUS),
    rects,
    kind: input.kind,
    note: (input.note ?? '').slice(0, MAX_NOTE_LENGTH),
    origin: input.origin ?? 'user',
    sourceLabel: (input.sourceLabel ?? '').slice(0, MAX_SOURCE_LENGTH),
    createdAt: now,
    updatedAt: now,
  };
}

/** An edit touches what the reader wrote, never where the highlight is, nor who wrote it. */
export interface AnnotationEdit {
  note?: string;
  kind?: AnnotationKind;
  /** Sets or clears the resolution. `undefined` leaves it alone, like every other field. */
  resolvedAt?: number | null;
}

export function applyAnnotationEdit(
  annotation: Annotation,
  edit: AnnotationEdit,
  now: number,
): Annotation {
  const note = edit.note === undefined ? annotation.note : edit.note.slice(0, MAX_NOTE_LENGTH);
  const kind = edit.kind ?? annotation.kind;
  let resolvedAt = annotation.resolvedAt;
  if (edit.resolvedAt !== undefined) {
    resolvedAt = edit.resolvedAt === null ? undefined : Math.max(0, Math.floor(edit.resolvedAt));
  }
  if (
    note === annotation.note &&
    kind === annotation.kind &&
    resolvedAt === annotation.resolvedAt
  ) {
    return annotation;
  }
  // The spread first, the optional field after: `undefined` must really remove the key,
  // not leave a stale `resolvedAt: undefined` behind for JSON.stringify to skip silently —
  // the payload should say what it means.
  const updated = { ...annotation, note, kind, updatedAt: now };
  if (resolvedAt === undefined) delete updated.resolvedAt;
  else updated.resolvedAt = resolvedAt;
  return updated;
}

/** Newest first, which is the order the notes panel lists them in. */
export function sortAnnotations(annotations: readonly Annotation[]): Annotation[] {
  return [...annotations].sort((one, other) => {
    if (one.page !== other.page) return one.page - other.page;
    return one.createdAt - other.createdAt;
  });
}
