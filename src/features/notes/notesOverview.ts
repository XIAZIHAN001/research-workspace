import { sortAnnotations, type Annotation, type AnnotationKind } from '../../domain/annotation';
import type { Paper } from '../../domain/papers';

export type NotesKindFilter = 'all' | AnnotationKind;
/** The lifecycle of a question: open until the reader marks it answered. */
export type QuestionStatusFilter = 'open' | 'resolved';

export interface NotesOverviewFilter {
  /** Matched against the highlighted text and the reader's own note. */
  query: string;
  kind: NotesKindFilter;
  /** One paper, or null for every paper. */
  paperId: string | null;
  /**
   * Narrows to questions in that state. Null leaves every kind in the list; setting it makes
   * the view about questions only, whatever the kind filter said — a reader asking for
   * "未解决" wants exactly that, not unanswered questions mixed with insights.
   */
  questionStatus?: QuestionStatusFilter | null;
}

export interface NotesOverviewGroup {
  paperId: string;
  title: string;
  /** The notes for this paper, in reading order. */
  items: Annotation[];
}

/** Notes that match every active filter. The input order is not changed. */
export function filterNotes(
  annotations: readonly Annotation[],
  filter: NotesOverviewFilter,
): Annotation[] {
  const query = filter.query.trim().toLowerCase();
  const status = filter.questionStatus ?? null;
  return annotations.filter((annotation) => {
    if (status !== null) {
      if (annotation.kind !== 'question') return false;
      if (status === 'open' && annotation.resolvedAt !== undefined) return false;
      if (status === 'resolved' && annotation.resolvedAt === undefined) return false;
    }
    if (filter.kind !== 'all' && annotation.kind !== filter.kind) return false;
    if (filter.paperId !== null && annotation.paperId !== filter.paperId) return false;
    if (query === '') return true;
    return `${annotation.quote}\n${annotation.note}`.toLowerCase().includes(query);
  });
}

/** How many questions are still open across the workspace, for the page header. */
export function openQuestionCount(annotations: readonly Annotation[]): number {
  return annotations.filter(
    (annotation) => annotation.kind === 'question' && annotation.resolvedAt === undefined,
  ).length;
}

/**
 * Notes grouped by the paper they belong to.
 *
 * Groups follow the paper's most recent note, so the paper last worked on comes first; inside a
 * group the notes read in page order, like the paper itself. A note whose paper is missing from
 * the registry still gets a group rather than disappearing — losing a note silently would be
 * worse than showing it under an unnamed heading.
 */
export function groupNotes(
  annotations: readonly Annotation[],
  papers: Readonly<Record<string, Paper>>,
): NotesOverviewGroup[] {
  const byPaper = new Map<string, { items: Annotation[]; latest: number }>();
  for (const annotation of annotations) {
    const entry = byPaper.get(annotation.paperId);
    if (entry === undefined) {
      byPaper.set(annotation.paperId, { items: [annotation], latest: annotation.updatedAt });
    } else {
      entry.items.push(annotation);
      entry.latest = Math.max(entry.latest, annotation.updatedAt);
    }
  }

  return [...byPaper.entries()]
    .sort(
      ([oneId, one], [otherId, other]) =>
        other.latest - one.latest ||
        (papers[oneId]?.title ?? '').localeCompare(papers[otherId]?.title ?? '', 'zh-Hans-CN'),
    )
    .map(([paperId, entry]) => ({
      paperId,
      title: papers[paperId]?.title ?? '未知论文',
      items: sortAnnotations(entry.items),
    }));
}
