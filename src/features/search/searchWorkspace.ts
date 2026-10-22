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

export function searchWorkspace(
  source: WorkspaceSearchSource,
  rawQuery: string,
  limit = SEARCH_GROUP_LIMIT,
): WorkspaceSearchGroup[] {
  const tokens = rawQuery
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token !== '');
  if (tokens.length === 0) return [];

  const paperTitles = new Map(source.papers.map((paper) => [paper.id, paper.title]));
  const conceptNames = new Map(source.concepts.map((concept) => [concept.id, concept.name]));

  const groups: WorkspaceSearchGroup[] = [];

  const papers: WorkspaceSearchResult[] = [];
  for (const paper of source.papers) {
    const identifiers = [paper.doi, paper.arxivId].filter(
      (value): value is string => value !== undefined,
    );
    const matched = rank(
      tokens,
      paper.title,
      paper.authors.join(' '),
      paper.year,
      identifiers.join(' '),
    );
    if (matched === null) continue;
    const meta = paperMeta(paper);
    papers.push({
      id: `paper:${paper.id}`,
      kind: 'paper',
      title: paper.title,
      meta,
      snippet: identifiers.length > 0 ? identifiers.join(' · ') : '',
      paperId: paper.id,
    });
  }
  pushGroup(groups, 'paper', papers, limit);

  const notes: WorkspaceSearchResult[] = [];
  for (const annotation of source.annotations) {
    const matched = rank(tokens, annotation.note, annotation.quote);
    if (matched === null) continue;
    const note = annotation.note.trim();
    const quote = annotation.quote.trim();
    notes.push({
      id: `note:${annotation.id}`,
      kind: 'note',
      title: truncate(note !== '' ? note : quote, 90),
      meta: `${paperTitles.get(annotation.paperId) ?? '未知论文'} · 第 ${String(annotation.page)} 页 · ${ANNOTATION_KIND_LABEL[annotation.kind]}`,
      snippet: snippetAround(note !== '' ? quote : '', tokens),
      paperId: annotation.paperId,
      page: annotation.page,
      quote: annotation.quote,
    });
  }
  pushGroup(
    groups,
    'note',
    sortRanked(notes, tokens, (result) => result.title),
    limit,
  );

  const concepts: WorkspaceSearchResult[] = [];
  for (const concept of source.concepts) {
    const matched = rank(tokens, concept.name, concept.aliases.join(' '), concept.summary);
    if (matched === null) continue;
    concepts.push({
      id: `concept:${concept.id}`,
      kind: 'concept',
      title: concept.name,
      meta: concept.status === 'suggested' ? '概念 · 待确认' : '概念',
      snippet: snippetAround(concept.summary, tokens),
      conceptId: concept.id,
      projectId: concept.projectIds[0],
    });
  }
  pushGroup(
    groups,
    'concept',
    sortRanked(concepts, tokens, (result) => result.title),
    limit,
  );

  const evidence: WorkspaceSearchResult[] = [];
  for (const entry of source.evidence) {
    const matched = rank(tokens, entry.quote, entry.note);
    if (matched === null) continue;
    const note = entry.note.trim();
    evidence.push({
      id: `evidence:${entry.id}`,
      kind: 'evidence',
      title: truncate(entry.quote, 90),
      meta: `${conceptNames.get(entry.conceptId) ?? '未知概念'} · ${paperTitles.get(entry.paperId) ?? '未知论文'} · 第 ${String(entry.page)} 页`,
      snippet: snippetAround(note, tokens),
      paperId: entry.paperId,
      page: entry.page,
      quote: entry.quote,
      conceptId: entry.conceptId,
    });
  }
  pushGroup(
    groups,
    'evidence',
    sortRanked(evidence, tokens, (result) => result.title),
    limit,
  );

  return GROUP_ORDER.flatMap((kind) => {
    const group = groups.find((candidate) => candidate.kind === kind);
    return group === undefined ? [] : [group];
  });
}

function pushGroup(
  groups: WorkspaceSearchGroup[],
  kind: WorkspaceResultKind,
  results: WorkspaceSearchResult[],
  limit: number,
): void {
  if (results.length === 0) return;
  groups.push({
    kind,
    title: SEARCH_GROUP_TITLES[kind],
    total: results.length,
    results: results.slice(0, Math.max(1, limit)),
  });
}

/** Every token must occur somewhere in the record; null when it does not match at all. */
function rank(
  tokens: readonly string[],
  ...values: readonly (string | number | undefined)[]
): number | null {
  const text = values
    .filter((value) => value !== undefined)
    .map((value) => String(value))
    .join('\n')
    .toLowerCase();
  if (!tokens.every((token) => text.includes(token))) return null;
  // A title that contains the whole query outranks one that only matches in a body field.
  const phrase = tokens.join(' ');
  const first = values[0];
  return typeof first === 'string' && first.toLowerCase().includes(phrase) ? 0 : 1;
}

/** Matches keep their source order inside a rank; the phrase match simply moves up. */
function sortRanked(
  results: readonly WorkspaceSearchResult[],
  tokens: readonly string[],
  primary: (result: WorkspaceSearchResult) => string,
): WorkspaceSearchResult[] {
  return [...results].sort((one, other) => {
    const phrase = tokens.join(' ');
    const oneRank = primary(one).toLowerCase().includes(phrase) ? 0 : 1;
    const otherRank = primary(other).toLowerCase().includes(phrase) ? 0 : 1;
    return oneRank - otherRank;
  });
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
function snippetAround(text: string, tokens: readonly string[], radius = 54): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean === '') return '';
  const lower = clean.toLowerCase();
  let index = -1;
  for (const token of tokens) {
    const found = lower.indexOf(token);
    if (found !== -1 && (index === -1 || found < index)) index = found;
  }
  if (index <= radius) return truncate(clean, radius * 2);
  const start = index - radius;
  return `…${truncate(clean.slice(start), radius * 2)}`;
}
