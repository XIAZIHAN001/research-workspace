import { ANNOTATION_KIND_LABEL, type Annotation } from '../../domain/annotation';
import type { Concept, ConceptEvidence } from '../../domain/knowledge';
import { authorCredit, type Paper } from '../../domain/papers';

/**
 * A workspace-wide search result.
 *
 * One record covers all four kinds because they are shown in one list and opened by one
 * action. Only the fields that apply to the kind are set; `paperId`/`page`/`quote` take a reader
 * to a place in a paper, while `conceptId`/`projectId` open a concept where it lives.
 */
export interface WorkspaceSearchResult {
  id: string;
  kind: WorkspaceResultKind;
  title: string;
  meta: string;
  snippet: string;
  paperId?: string;
  page?: number;
  quote?: string;
  conceptId?: string;
  projectId?: string;
}

export type WorkspaceResultKind = 'paper' | 'note' | 'concept' | 'evidence';

export interface WorkspaceSearchGroup {
  kind: WorkspaceResultKind;
  title: string;
  /** Every match this group has, before the display limit. */
  total: number;
  results: WorkspaceSearchResult[];
}

export interface WorkspaceSearchSource {
  papers: readonly Paper[];
  annotations: readonly Annotation[];
  concepts: readonly Concept[];
  evidence: readonly ConceptEvidence[];
}

export const SEARCH_GROUP_TITLES: Record<WorkspaceResultKind, string> = {
  paper: '论文',
  note: '笔记与注释',
  concept: '概念',
  evidence: '知识证据',
};

/** How many rows one group shows before the query needs narrowing. */
export const SEARCH_GROUP_LIMIT = 6;

const GROUP_ORDER: readonly WorkspaceResultKind[] = ['paper', 'note', 'concept', 'evidence'];

interface IndexedRecord {
  readonly text: string;
  readonly title: string;
  readonly result: Readonly<WorkspaceSearchResult>;
  readonly snippetText: string;
  readonly snippetLower: string;
}

/** An explicit snapshot: rebuild when source records change. No mutable-source cache is used. */
export interface WorkspaceSearchIndex {
  readonly groups: Readonly<Record<WorkspaceResultKind, readonly IndexedRecord[]>>;
}

export function createWorkspaceSearchIndex(source: WorkspaceSearchSource): WorkspaceSearchIndex {
  const paperTitles = new Map(source.papers.map((paper) => [paper.id, paper.title]));
  const conceptNames = new Map(source.concepts.map((concept) => [concept.id, concept.name]));
  const groups: Record<WorkspaceResultKind, IndexedRecord[]> = {
    paper: [],
    note: [],
    concept: [],
    evidence: [],
  };
  const add = (
    result: WorkspaceSearchResult,
    values: readonly (string | number | undefined)[],
    snippetText = '',
  ): void => {
    const clean = snippetText.replace(/\s+/g, ' ').trim();
    groups[result.kind].push({
      result,
      text: values
        .filter((value) => value !== undefined)
        .map(String)
        .join('\n')
        .toLowerCase(),
      title: result.title.toLowerCase(),
      snippetText: clean,
      snippetLower: clean.toLowerCase(),
    });
  };
  for (const paper of source.papers) {
    const identifiers = [paper.doi, paper.arxivId].filter(
      (value): value is string => value !== undefined,
    );
    add(
      {
        id: `paper:${paper.id}`,
        kind: 'paper',
        title: paper.title,
        meta: paperMeta(paper),
        snippet: identifiers.join(' · '),
        paperId: paper.id,
      },
      [paper.title, paper.authors.join(' '), paper.year, identifiers.join(' ')],
    );
  }
  for (const annotation of source.annotations) {
    const note = annotation.note.trim();
    const quote = annotation.quote.trim();
    add(
      {
        id: `note:${annotation.id}`,
        kind: 'note',
        title: truncate(note !== '' ? note : quote, 90),
        meta: `${paperTitles.get(annotation.paperId) ?? '未知论文'} · 第 ${String(annotation.page)} 页 · ${ANNOTATION_KIND_LABEL[annotation.kind]}`,
        snippet: '',
        paperId: annotation.paperId,
        page: annotation.page,
        quote: annotation.quote,
      },
      [annotation.note, annotation.quote],
      note !== '' ? quote : '',
    );
  }
  for (const concept of source.concepts) {
    add(
      {
        id: `concept:${concept.id}`,
        kind: 'concept',
        title: concept.name,
        meta: concept.status === 'suggested' ? '概念 · 待确认' : '概念',
        snippet: '',
        conceptId: concept.id,
        projectId: concept.projectIds[0],
      },
      [concept.name, concept.aliases.join(' '), concept.summary],
      concept.summary,
    );
  }
  for (const entry of source.evidence) {
    add(
      {
        id: `evidence:${entry.id}`,
        kind: 'evidence',
        title: truncate(entry.quote, 90),
        meta: `${conceptNames.get(entry.conceptId) ?? '未知概念'} · ${paperTitles.get(entry.paperId) ?? '未知论文'} · 第 ${String(entry.page)} 页`,
        snippet: '',
        paperId: entry.paperId,
        page: entry.page,
        quote: entry.quote,
        conceptId: entry.conceptId,
      },
      [entry.quote, entry.note],
      entry.note.trim(),
    );
  }
  return { groups };
}

/** Search a reusable snapshot, retaining bounded candidates while counting every match. */
export function searchWorkspaceIndex(
  index: WorkspaceSearchIndex,
  rawQuery: string,
  limit = SEARCH_GROUP_LIMIT,
): WorkspaceSearchGroup[] {
  const tokens = queryTokens(rawQuery);
  if (tokens.length === 0) return [];
  const phrase = tokens.join(' ');
  // Preserve slice(0, Math.max(1, limit)): NaN means zero; fractions truncate; Infinity is unbounded.
  const bound = Number.isNaN(limit) ? 0 : Math.floor(Math.max(1, limit));
  const groups: WorkspaceSearchGroup[] = [];
  for (const kind of GROUP_ORDER) {
    let total = 0;
    const primary: IndexedRecord[] = [];
    const secondary: IndexedRecord[] = [];
    for (const record of index.groups[kind]) {
      if (!tokens.every((token) => record.text.includes(token))) continue;
      total++;
      // Papers deliberately keep source order; other groups rank the displayed (truncated) title.
      const selected = kind === 'paper' || record.title.includes(phrase) ? primary : secondary;
      if (selected.length < bound) selected.push(record);
    }
    if (total === 0) continue;
    const selected = primary.concat(secondary).slice(0, bound);
    groups.push({
      kind,
      title: SEARCH_GROUP_TITLES[kind],
      total,
      results: selected.map((record) => ({
        ...record.result,
        snippet: kind === 'paper' ? record.result.snippet : snippetAround(record, tokens),
      })),
    });
  }
  return groups;
}

/** Fresh one-shot search; repeated callers should explicitly retain an index instead. */
export function searchWorkspace(
  source: WorkspaceSearchSource,
  rawQuery: string,
  limit = SEARCH_GROUP_LIMIT,
): WorkspaceSearchGroup[] {
  if (rawQuery.trim() === '') return [];
  return searchWorkspaceIndex(createWorkspaceSearchIndex(source), rawQuery, limit);
}

function queryTokens(rawQuery: string): string[] {
  return rawQuery
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token !== '');
}

function paperMeta(paper: Paper): string {
  const parts: string[] = [];
  const credit = authorCredit(paper);
  if (credit !== null) parts.push(credit);
  if (paper.year !== undefined) parts.push(String(paper.year));
  parts.push(paper.doi === undefined ? '论文' : '论文 · DOI');
  return parts.join(' · ');
}

function truncate(text: string, length: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= length ? clean : `${clean.slice(0, length - 1)}…`;
}

/** A window of text around the first matching token, so the result shows *why* it matched. */
function snippetAround(record: IndexedRecord, tokens: readonly string[], radius = 54): string {
  const clean = record.snippetText;
  if (clean === '') return '';
  const lower = record.snippetLower;
  let index = -1;
  for (const token of tokens) {
    const found = lower.indexOf(token);
    if (found !== -1 && (index === -1 || found < index)) index = found;
  }
  if (index <= radius) return truncate(clean, radius * 2);
  const start = index - radius;
  return `…${truncate(clean.slice(start), radius * 2)}`;
}
