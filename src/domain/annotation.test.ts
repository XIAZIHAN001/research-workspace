import { describe, expect, it } from 'vitest';
import type { NormalizedRect } from './annotation';
import {
  ANNOTATION_KIND_LABEL,
  ANNOTATION_KINDS,
  applyAnnotationEdit,
  CONTEXT_RADIUS,
  createAnnotation,
  MAX_NOTE_LENGTH,
  normalizeQuote,
  sortAnnotations,
  type Annotation,
  type AnnotationInput,
} from './annotation';

const SHA = 'a'.repeat(64);

/**
 * Boxes come out of floating-point arithmetic (`0.2 + 0.02 - 0.2` is not `0.02`), so they are
 * compared at the precision a highlight is actually drawn with.
 */
function roundRects(rects: readonly NormalizedRect[] | undefined): NormalizedRect[] {
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return (rects ?? []).map((rect) => ({
    x: round(rect.x),
    y: round(rect.y),
    width: round(rect.width),
    height: round(rect.height),
  }));
}

function input(overrides: Partial<AnnotationInput> = {}): AnnotationInput {
  return {
    paperId: 'paper-1',
    pdfSha256: SHA,
    page: 3,
    quote: '  the  rotated   attention\nmechanism ',
    prefix: 'we replace the standard dot product with',
    suffix: 'which lets the model attend to every token',
    rects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.02 }],
    kind: 'question',
    ...overrides,
  };
}

describe('normalizeQuote', () => {
  it('collapses the whitespace a text layer puts between lines', () => {
    expect(normalizeQuote('  the  rotated \n attention\tmechanism ')).toBe(
      'the rotated attention mechanism',
    );
  });

  it('returns an empty string for whitespace only', () => {
    expect(normalizeQuote(' \n\t ')).toBe('');
  });
});

describe('createAnnotation', () => {
  it('stores a normalized quote with its context and geometry', () => {
    const annotation = createAnnotation(input(), () => 'id-1', 100);
    if (annotation === null) throw new Error('expected an annotation');

    expect(annotation.id).toBe('id-1');
    expect(annotation.paperId).toBe('paper-1');
    expect(annotation.pdfSha256).toBe(SHA);
    expect(annotation.page).toBe(3);
    expect(annotation.quote).toBe('the rotated attention mechanism');
    expect(annotation.prefix).toBe('we replace the standard dot product with');
    // Context is capped at the radius, and the end nearest the quote is the part kept.
    expect(annotation.suffix).toBe(
      'which lets the model attend to every token'.slice(0, CONTEXT_RADIUS),
    );
    expect(annotation.kind).toBe('question');
    expect(annotation.note).toBe('');
    expect(annotation.createdAt).toBe(100);
    expect(annotation.updatedAt).toBe(100);
    expect(roundRects(annotation.rects)).toStrictEqual([
      { x: 0.1, y: 0.2, width: 0.4, height: 0.02 },
    ]);
  });

  it.each([
    { label: 'an empty selection', overrides: { quote: '   ' } },
    { label: 'page zero', overrides: { page: 0 } },
    { label: 'a fractional page', overrides: { page: 2.5 } },
    { label: 'a hash that is not a hash', overrides: { pdfSha256: 'nope' } },
    { label: 'an uppercase hash', overrides: { pdfSha256: 'A'.repeat(64) } },
    { label: 'no geometry at all', overrides: { rects: [] } },
  ])('refuses $label instead of storing something unfindable', ({ overrides }) => {
    expect(createAnnotation(input(overrides), () => 'id', 0)).toBeNull();
  });

  it('clamps boxes into the page and drops degenerate ones', () => {
    const annotation = createAnnotation(
      input({
        rects: [
          { x: -0.5, y: -0.2, width: 0.8, height: 0.5 },
          { x: 0.9, y: 0.9, width: 0.5, height: 0.5 },
          { x: 0.1, y: 0.1, width: 0, height: 0.2 },
          { x: 0.2, y: 0.2, width: 0.001, height: 0.2 },
        ],
      }),
      () => 'id',
      0,
    );
    // Boxes are intersected with the page: the first loses the half that hung off the left edge,
    // and the two boxes too small to be a highlight are gone.
    expect(roundRects(annotation?.rects)).toStrictEqual([
      { x: 0, y: 0, width: 0.3, height: 0.3 },
      { x: 0.9, y: 0.9, width: 0.1, height: 0.1 },
    ]);
  });

  it('collapses but does not trim the context, so it stays in step with the page', () => {
    const annotated = createAnnotation(
      input({ prefix: 'we   replace\nthe', suffix: '\nwhich  lets' }),
      () => 'id',
      0,
    );
    expect(annotated?.prefix).toBe('we replace the');
    expect(annotated?.suffix).toBe(' which lets');
  });

  it('keeps only the useful end of each context and caps the note', () => {
    const annotation = createAnnotation(
      input({
        prefix: 'x'.repeat(200),
        suffix: 'y'.repeat(200),
        note: 'z'.repeat(MAX_NOTE_LENGTH + 50),
      }),
      () => 'id',
      0,
    );
    expect(annotation?.prefix).toHaveLength(CONTEXT_RADIUS);
    expect(annotation?.suffix).toHaveLength(CONTEXT_RADIUS);
    expect(annotation?.note).toHaveLength(MAX_NOTE_LENGTH);
    // The context kept is the part nearest the quote.
    expect(annotation?.prefix.endsWith('x')).toBe(true);
    expect(annotation?.suffix.startsWith('y')).toBe(true);
  });

  it('has a label for every kind', () => {
    for (const kind of ANNOTATION_KINDS) {
      expect(ANNOTATION_KIND_LABEL[kind]).toBeTruthy();
    }
  });
});

describe('applyAnnotationEdit', () => {
  const annotation: Annotation = createAnnotation(
    input({ note: 'first' }),
    () => 'id',
    10,
  ) as Annotation;

  it('changes the note and stamps the time', () => {
    const updated = applyAnnotationEdit(annotation, { note: 'second thought' }, 20);
    expect(updated.note).toBe('second thought');
    expect(updated.updatedAt).toBe(20);
    expect(updated.createdAt).toBe(10);
  });

  it('changes the kind without touching the anchor', () => {
    const updated = applyAnnotationEdit(annotation, { kind: 'insight' }, 20);
    expect(updated.kind).toBe('insight');
    expect(updated.quote).toBe(annotation.quote);
    expect(updated.rects).toBe(annotation.rects);
    expect(updated.page).toBe(annotation.page);
  });

  it('returns the very same object when nothing changes', () => {
    expect(applyAnnotationEdit(annotation, { note: 'first', kind: 'question' }, 99)).toBe(
      annotation,
    );
  });

  it('caps a note that is too long', () => {
    const updated = applyAnnotationEdit(annotation, { note: 'n'.repeat(MAX_NOTE_LENGTH + 10) }, 20);
    expect(updated.note).toHaveLength(MAX_NOTE_LENGTH);
  });
});

describe('sortAnnotations', () => {
  it('orders by page first, then by when it was written', () => {
    const make = (id: string, page: number, createdAt: number): Annotation =>
      createAnnotation(input({ page }), () => id, createdAt) as Annotation;
    const sorted = sortAnnotations([make('c', 2, 5), make('a', 1, 9), make('b', 1, 3)]);
    expect(sorted.map((annotation) => annotation.id)).toStrictEqual(['b', 'a', 'c']);
  });

  it('does not modify the list it is given', () => {
    const list = [createAnnotation(input({ page: 2 }), () => 'second', 1) as Annotation];
    const copy = [...list];
    sortAnnotations(list);
    expect(list).toStrictEqual(copy);
  });
});
