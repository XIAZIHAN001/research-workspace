import { paperStatus, type Paper, type ReadingStatus } from '../../domain/papers';

/** How the library orders papers. Every sort has a deterministic tie-breaker: the title. */
export type LibrarySort = 'recent-reading' | 'added' | 'year-desc' | 'year-asc' | 'title';

export const LIBRARY_SORT_LABEL: Record<LibrarySort, string> = {
  'recent-reading': '最近阅读',
  added: '最近添加',
  'year-desc': '年份新到旧',
  'year-asc': '年份旧到新',
  title: '标题',
};

/** The broad slice of the library a reader wants to see. */
export type LibraryScope = 'all' | 'has-pdf' | 'in-project' | 'has-notes';

export const LIBRARY_SCOPE_LABEL: Record<LibraryScope, string> = {
  all: '全部',
  'has-pdf': '有 PDF',
  'in-project': '在项目',
  'has-notes': '有笔记',
};

export type LibraryStatusFilter = 'all' | ReadingStatus;

export const LIBRARY_STATUS_LABEL: Record<LibraryStatusFilter, string> = {
  all: '全部状态',
  unread: '未读',
  reading: '在读',
  done: '读完',
};

export interface LibraryOptions {
  query: string;
  sort: LibrarySort;
  scope: LibraryScope;
  status: LibraryStatusFilter;
  /** A tag to keep, or null for every tag. */
  tag: string | null;
  /** Papers referenced by at least one project, by id. */
  projectPaperIds: ReadonlySet<string>;
  /** Papers that have at least one highlight or note, by id. */
  annotatedPaperIds: ReadonlySet<string>;
}

/** Finds a paper by anything a reader would remember about it, including its tags. */
function matchesQuery(paper: Paper, query: string): boolean {
  if (query === '') return true;
  const haystack = [
    paper.title,
    paper.authors.join(' '),
    paper.doi ?? '',
    paper.arxivId ?? '',
    paper.pdf?.name ?? '',
    (paper.tags ?? []).join(' '),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function matchesScope(paper: Paper, scope: LibraryScope, options: LibraryOptions): boolean {
  switch (scope) {
    case 'has-pdf':
      return paper.pdf !== undefined;
    case 'in-project':
      return options.projectPaperIds.has(paper.id);
    case 'has-notes':
      return options.annotatedPaperIds.has(paper.id);
    case 'all':
      return true;
  }
}

function hasTag(paper: Paper, tag: string): boolean {
  const key = tag.toLowerCase();
  return (paper.tags ?? []).some((candidate) => candidate.toLowerCase() === key);
}

function compareByTitle(one: Paper, other: Paper): number {
  return one.title.localeCompare(other.title, 'zh-Hans-CN');
}

const bySort: Record<LibrarySort, (one: Paper, other: Paper) => number> = {
  'recent-reading': (one, other) =>
    (other.reading?.updatedAt ?? 0) - (one.reading?.updatedAt ?? 0) || compareByTitle(one, other),
  added: (one, other) => other.createdAt - one.createdAt || compareByTitle(one, other),
  'year-desc': (one, other) =>
    (other.year ?? Number.NEGATIVE_INFINITY) - (one.year ?? Number.NEGATIVE_INFINITY) ||
    compareByTitle(one, other),
  'year-asc': (one, other) =>
    (one.year ?? Number.POSITIVE_INFINITY) - (other.year ?? Number.POSITIVE_INFINITY) ||
    compareByTitle(one, other),
  title: compareByTitle,
};

/**
 * The papers the library should show, in the order it should show them.
 *
 * Filters compose: a query, a scope, a reading status and a tag all apply at once. The input
 * array is never mutated — the returned list is a new array.
 */
export function libraryPapers(papers: readonly Paper[], options: LibraryOptions): Paper[] {
  return papers
    .filter((paper) => matchesQuery(paper, options.query))
    .filter((paper) => matchesScope(paper, options.scope, options))
    .filter((paper) => options.status === 'all' || paperStatus(paper) === options.status)
    .filter((paper) => options.tag === null || hasTag(paper, options.tag))
    .sort(bySort[options.sort]);
}

/**
 * How far through the paper the reader is, as a whole percentage, or null when there is no
 * page count or no reading position to compare against it.
 */
export function readingProgress(paper: Pick<Paper, 'reading' | 'pdf'>): number | null {
  const pageCount = paper.pdf?.pageCount ?? null;
  if (paper.reading === undefined || pageCount === null || pageCount <= 0) return null;
  const page = Math.min(Math.max(paper.reading.page, 1), pageCount);
  return Math.round((page / pageCount) * 100);
}

/** Every tag in use, one spelling each, in the order a reader would look for them. */
export function collectTags(papers: readonly Paper[]): string[] {
  const seen = new Map<string, string>();
  for (const paper of papers) {
    for (const tag of paper.tags ?? []) {
      const key = tag.toLowerCase();
      if (!seen.has(key)) seen.set(key, tag);
    }
  }
  return [...seen.values()].sort((one, other) => one.localeCompare(other, 'zh-Hans-CN'));
}
