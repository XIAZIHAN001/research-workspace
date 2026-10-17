/**
 * What the reader knows, and where in a paper it said so.
 *
 * Two things are deliberately kept apart:
 *
 * - a **concept** is an idea that exists across papers and projects ("KZG commitment"), with
 *   one stable identity;
 * - an **occurrence** is one place in one paper where that idea is used, carrying the file, the
 *   page and the quotation it was read from.
 *
 * They are separate records because merging them is how knowledge bases go wrong: two papers
 * can use the same name for different things, and the same idea can appear a hundred times.
 * Nothing in this module merges concepts by name. Merging is an action the reader takes.
 *
 * The third record is a **relation** between two concepts. Its direction is defined once, here,
 * and never inferred at the point of use:
 *
 *   prerequisite: `from` needs `to` first      (KZG —prerequisite→ bilinear pairing)
 *   extends:      `from` builds on `to`        (KZG —extends→ Pedersen commitment)
 *   related:      undirected association
 *
 * Every relation also records who put it there. A relation the reader made is never rewritten
 * by a later suggestion — suggestions are new records with their own status until confirmed.
 */

import type { NormalizedRect } from './annotation';

export type ConceptStatus = 'confirmed' | 'suggested';
export type ConceptOrigin = 'user' | 'ai';

export type RelationKind = 'prerequisite' | 'related' | 'extends';

export const RELATION_KINDS: readonly RelationKind[] = ['prerequisite', 'related', 'extends'];

export const RELATION_KIND_LABEL: Record<RelationKind, string> = {
  prerequisite: '前置知识',
  related: '相关',
  extends: '扩展',
};

/**
 * How to read a relation, in the interface's own words.
 *
 * The arrow is always from the concept the reader is looking at, which is the only reading a
 * person can do without a legend: "this needs that first".
 */
export const RELATION_DIRECTION: Record<RelationKind, string> = {
  prerequisite: '要理解 A，需要先理解 B',
  related: 'A 与 B 相关（无方向）',
  extends: 'A 扩展了 B',
};

/**
 * Where an occurrence came from. A note the reader wrote outranks a suggestion, and the
 * interface can say which it is showing.
 */
export type EvidenceSource = 'annotation' | 'difficulty' | 'selection' | 'manual' | 'ai';

export const EVIDENCE_SOURCE_LABEL: Record<EvidenceSource, string> = {
  annotation: '来自你的笔记',
  difficulty: '来自难点标注',
  selection: '来自选中的原文',
  ai: 'AI 建议的出处',
  manual: '你手动添加',
};

export interface Concept {
  id: string;
  name: string;
  aliases: string[];
  /** One or two sentences: what it is, in the reader's own terms. */
  summary: string;
  origin: ConceptOrigin;
  status: ConceptStatus;
  /** Which projects show this concept. A concept can be shared by several. */
  projectIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ConceptEvidence {
  id: string;
  conceptId: string;
  paperId: string;
  /**
   * The file the quotation was read from.
   *
   * This is what keeps an old occurrence from pointing into a replaced PDF: the reader is only
   * taken to the page when the paper still holds this exact file.
   */
  pdfSha256: string;
  page: number;
  quote: string;
  prefix: string;
  suffix: string;
  rects: NormalizedRect[];
  source: EvidenceSource;
  /** The annotation this was taken from, when it came from one. */
  annotationId?: string;
  /** The difficulty suggestion this was taken from, when it came from one. */
  suggestionId?: string;
  /** The reader's own words about this occurrence, when there are any. */
  note: string;
  createdAt: number;
}

export interface ConceptRelation {
  id: string;
  /** The concept that needs / extends / relates to `to`. */
  from: string;
  to: string;
  kind: RelationKind;
  status: ConceptStatus;
  origin: ConceptOrigin;
  /** Why the reader believes this, in their own words. */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeState {
  version: 1;
  concepts: Concept[];
  evidence: ConceptEvidence[];
  relations: ConceptRelation[];
}

export const EMPTY_KNOWLEDGE: KnowledgeState = {
  version: 1,
  concepts: [],
  evidence: [],
  relations: [],
};

export const MAX_CONCEPT_NAME = 80;
export const MAX_SUMMARY = 600;
export const MAX_RELATION_NOTE = 400;

/** Names are compared case- and whitespace-insensitively, but never *merged* by that. */
export function normalizeConceptName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface ConceptInput {
  name: string;
  summary?: string;
  aliases?: readonly string[];
  projectIds: readonly string[];
  origin?: ConceptOrigin;
  status?: ConceptStatus;
}

export function createConcept(
  input: ConceptInput,
  makeId: () => string,
  now: number,
): Concept | null {
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (name === '' || name.length > MAX_CONCEPT_NAME) return null;
  const projectIds = [
    ...new Set(input.projectIds.filter((id) => typeof id === 'string' && id !== '')),
  ];
  if (projectIds.length === 0) return null;

  return {
    id: makeId(),
    name,
    aliases: [...new Set((input.aliases ?? []).map((alias) => alias.trim()).filter(Boolean))],
    summary: (input.summary ?? '').trim().slice(0, MAX_SUMMARY),
    origin: input.origin ?? 'user',
    status: input.status ?? 'confirmed',
    projectIds,
    createdAt: now,
    updatedAt: now,
  };
}

export function updateConcept(
  state: KnowledgeState,
  id: string,
  edit: { name?: string; summary?: string; aliases?: readonly string[] },
  now: number,
): KnowledgeState {
  return {
    ...state,
    concepts: state.concepts.map((concept) => {
      if (concept.id !== id) return concept;
      const name = (edit.name ?? concept.name).replace(/\s+/g, ' ').trim();
      if (name === '' || name.length > MAX_CONCEPT_NAME) return concept;
      return {
        ...concept,
        name,
        summary: (edit.summary ?? concept.summary).trim().slice(0, MAX_SUMMARY),
        aliases:
          edit.aliases === undefined
            ? concept.aliases
            : [...new Set(edit.aliases.map((alias) => alias.trim()).filter(Boolean))],
        updatedAt: now,
      };
    }),
  };
}

/** Confirms a suggestion. The origin stays `ai`: who wrote it is a fact about it. */
export function confirmConcept(state: KnowledgeState, id: string, now: number): KnowledgeState {
  return {
    ...state,
    concepts: state.concepts.map((concept) =>
      concept.id === id ? { ...concept, status: 'confirmed', updatedAt: now } : concept,
    ),
  };
}

export function linkConceptToProject(
  state: KnowledgeState,
  id: string,
  projectId: string,
  now: number,
): KnowledgeState {
  return {
    ...state,
    concepts: state.concepts.map((concept) =>
      concept.id === id && !concept.projectIds.includes(projectId)
        ? { ...concept, projectIds: [...concept.projectIds, projectId], updatedAt: now }
        : concept,
    ),
  };
}

export interface EvidenceInput {
  conceptId: string;
  paperId: string;
  pdfSha256: string;
  page: number;
  quote: string;
  prefix?: string;
  suffix?: string;
  rects: readonly NormalizedRect[];
  source: EvidenceSource;
  annotationId?: string;
  suggestionId?: string;
  note?: string;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function createEvidence(
  input: EvidenceInput,
  makeId: () => string,
  now: number,
): ConceptEvidence | null {
  const quote = collapseWhitespace(input.quote);
  if (quote === '' || quote.length > 2000) return null;
  if (!Number.isInteger(input.page) || input.page < 1) return null;
  if (!/^[0-9a-f]{64}$/.test(input.pdfSha256)) return null;

  return {
    id: makeId(),
    conceptId: input.conceptId,
    paperId: input.paperId,
    pdfSha256: input.pdfSha256,
    page: input.page,
    quote,
    prefix: collapseWhitespace(input.prefix ?? '').slice(-40),
    suffix: collapseWhitespace(input.suffix ?? '').slice(0, 40),
    rects: input.rects.map((rect) => ({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    })),
    source: input.source,
    ...(input.annotationId === undefined ? {} : { annotationId: input.annotationId }),
    ...(input.suggestionId === undefined ? {} : { suggestionId: input.suggestionId }),
    note: collapseWhitespace(input.note ?? '').slice(0, 4000),
    createdAt: now,
  };
}

/** True when this occurrence was read from a file the paper no longer holds. */
export function isStaleEvidence(
  evidence: ConceptEvidence,
  currentSha256: string | null | undefined,
): boolean {
  return (
    currentSha256 !== undefined && currentSha256 !== null && evidence.pdfSha256 !== currentSha256
  );
}

export function relationExists(
  state: KnowledgeState,
  from: string,
  to: string,
  kind: RelationKind,
): boolean {
  return state.relations.some((relation) => {
    if (relation.kind !== kind) return false;
    if (kind === 'related') {
      return (
        (relation.from === from && relation.to === to) ||
        (relation.from === to && relation.to === from)
      );
    }
    return relation.from === from && relation.to === to;
  });
}

/**
 * Would adding `from → to` create a cycle through prerequisite edges?
 *
 * A dependency that leads back to itself is not a dependency; it is a mistake worth refusing at
 * the point the reader makes it, rather than showing as a graph loop nobody can read.
 */
export function wouldCycle(
  state: KnowledgeState,
  from: string,
  to: string,
  kind: RelationKind,
): boolean {
  if (kind !== 'prerequisite') return from === to;
  if (from === to) return true;
  const forward = new Map<string, string[]>();
  for (const relation of state.relations) {
    if (relation.kind !== 'prerequisite') continue;
    const list = forward.get(relation.from) ?? [];
    list.push(relation.to);
    forward.set(relation.from, list);
  }
  const stack = [to];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    if (current === from) return true;
    seen.add(current);
    for (const next of forward.get(current) ?? []) stack.push(next);
  }
  return false;
}

export interface RelationInput {
  from: string;
  to: string;
  kind: RelationKind;
  note?: string;
  origin?: ConceptOrigin;
  status?: ConceptStatus;
}

export function createRelation(
  state: KnowledgeState,
  input: RelationInput,
  makeId: () => string,
  now: number,
): { state: KnowledgeState; relation: ConceptRelation | null; reason?: string } {
  if (!RELATION_KINDS.includes(input.kind)) {
    return { state, relation: null, reason: '未知的关系类型。' };
  }
  if (input.from === input.to) {
    return { state, relation: null, reason: '一个概念不能依赖它自己。' };
  }
  const has = (id: string): boolean => state.concepts.some((concept) => concept.id === id);
  if (!has(input.from) || !has(input.to)) {
    return { state, relation: null, reason: '关系两端的概念不存在。' };
  }
  if (relationExists(state, input.from, input.to, input.kind)) {
    return { state, relation: null, reason: '这条关系已经存在。' };
  }
  if (wouldCycle(state, input.from, input.to, input.kind)) {
    return { state, relation: null, reason: '这会形成一个循环依赖。' };
  }

  const relation: ConceptRelation = {
    id: makeId(),
    from: input.from,
    to: input.to,
    kind: input.kind,
    status: input.status ?? 'confirmed',
    origin: input.origin ?? 'user',
    note: (input.note ?? '').trim().slice(0, MAX_RELATION_NOTE),
    createdAt: now,
    updatedAt: now,
  };
  return { state: { ...state, relations: [...state.relations, relation] }, relation };
}

export function confirmRelation(state: KnowledgeState, id: string, now: number): KnowledgeState {
  return {
    ...state,
    relations: state.relations.map((relation) =>
      relation.id === id ? { ...relation, status: 'confirmed', updatedAt: now } : relation,
    ),
  };
}

/** Removes one relation. Concepts and papers are untouched — this is the whole of the change. */
export function deleteRelation(state: KnowledgeState, id: string): KnowledgeState {
  return { ...state, relations: state.relations.filter((relation) => relation.id !== id) };
}

/**
 * Removes a concept with everything that belongs to it: its occurrences and its relations.
 *
 * Papers are never touched — they are not owned by a concept. Deleting the concept the reader
 * created is the only way its occurrences go.
 */
export function deleteConcept(state: KnowledgeState, id: string): KnowledgeState {
  return {
    ...state,
    concepts: state.concepts.filter((concept) => concept.id !== id),
    evidence: state.evidence.filter((entry) => entry.conceptId !== id),
    relations: state.relations.filter((relation) => relation.from !== id && relation.to !== id),
  };
}

/**
 * Moves one concept's occurrences and relations into another, and removes the first.
 *
 * This is the only path that merges two concepts, and it only runs when the reader asks for it —
 * a shared name is not evidence that two ideas are the same.
 */
export function mergeConcepts(
  state: KnowledgeState,
  sourceId: string,
  targetId: string,
  now: number,
): KnowledgeState {
  if (sourceId === targetId) return state;
  const source = state.concepts.find((concept) => concept.id === sourceId);
  const target = state.concepts.find((concept) => concept.id === targetId);
  if (source === undefined || target === undefined) return state;

  const evidence = state.evidence.map((entry) =>
    entry.conceptId === sourceId ? { ...entry, conceptId: targetId } : entry,
  );

  // Re-point the relations, dropping any that become self-references or duplicates. `related`
  // is undirected, so its reverse counts as a duplicate too.
  const relations: ConceptRelation[] = [];
  const seen = new Set<string>();
  for (const relation of state.relations) {
    const from = relation.from === sourceId ? targetId : relation.from;
    const to = relation.to === sourceId ? targetId : relation.to;
    if (from === to) continue;
    const key = `${from}|${to}|${relation.kind}`;
    const reverse = relation.kind === 'related' ? `${to}|${from}|related` : null;
    if (seen.has(key) || (reverse !== null && seen.has(reverse))) continue;
    seen.add(key);
    relations.push(
      from === relation.from && to === relation.to
        ? relation
        : { ...relation, from, to, updatedAt: now },
    );
  }

  const projectIds = [...new Set([...target.projectIds, ...source.projectIds])];
  return {
    ...state,
    concepts: state.concepts
      .filter((concept) => concept.id !== sourceId)
      .map((concept) =>
        concept.id === targetId ? { ...concept, projectIds, updatedAt: now } : concept,
      ),
    evidence,
    relations,
  };
}

/**
 * Removes a project from every concept that names it.
 *
 * The concepts themselves, their occurrences and their relations are kept: a concept may be
 * shared with another project, and one project's deletion is not evidence about anybody else's
 * knowledge. A concept left without a project simply stops appearing in a project's view.
 */
export function detachProjectFromKnowledge(
  state: KnowledgeState,
  projectId: string,
  now: number,
): KnowledgeState {
  return {
    ...state,
    concepts: state.concepts.map((concept) =>
      concept.projectIds.includes(projectId)
        ? {
            ...concept,
            projectIds: concept.projectIds.filter((id) => id !== projectId),
            updatedAt: now,
          }
        : concept,
    ),
  };
}

/* ------------------------------------------------------------------ *
 * Reading the graph
 * ------------------------------------------------------------------ */

export function conceptsInProject(state: KnowledgeState, projectId: string): Concept[] {
  return state.concepts
    .filter((concept) => concept.projectIds.includes(projectId))
    .sort((one, other) => one.name.localeCompare(other.name, 'zh-Hans-CN'));
}

export function evidenceFor(state: KnowledgeState, conceptId: string): ConceptEvidence[] {
  return state.evidence
    .filter((entry) => entry.conceptId === conceptId)
    .sort((one, other) => other.createdAt - one.createdAt);
}

export function relationsFor(state: KnowledgeState, conceptId: string): ConceptRelation[] {
  return state.relations.filter(
    (relation) => relation.from === conceptId || relation.to === conceptId,
  );
}

/**
 * The concepts this one needs first.
 *
 * Only confirmed relations are returned: a suggestion is not a dependency until the reader says
 * it is, and presenting one as fact is exactly what this project refuses to do with AI output.
 */
export function prerequisitesOf(state: KnowledgeState, conceptId: string): Concept[] {
  const ids = state.relations
    .filter(
      (relation) =>
        relation.kind === 'prerequisite' &&
        relation.from === conceptId &&
        relation.status === 'confirmed',
    )
    .map((relation) => relation.to);
  return state.concepts.filter((concept) => ids.includes(concept.id));
}

/** Concepts that list this one as a prerequisite. */
export function dependentsOf(state: KnowledgeState, conceptId: string): Concept[] {
  const ids = state.relations
    .filter(
      (relation) =>
        relation.kind === 'prerequisite' &&
        relation.to === conceptId &&
        relation.status === 'confirmed',
    )
    .map((relation) => relation.from);
  return state.concepts.filter((concept) => ids.includes(concept.id));
}

export function relatedOf(state: KnowledgeState, conceptId: string): Concept[] {
  const ids = state.relations
    .filter(
      (relation) =>
        relation.kind === 'related' &&
        relation.status === 'confirmed' &&
        (relation.from === conceptId || relation.to === conceptId),
    )
    .map((relation) => (relation.from === conceptId ? relation.to : relation.from));
  return state.concepts.filter((concept) => ids.includes(concept.id));
}

/** The papers a concept was seen in, one entry per paper, with how many occurrences each has. */
export function papersOf(
  state: KnowledgeState,
  conceptId: string,
): { paperId: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of state.evidence) {
    if (entry.conceptId !== conceptId) continue;
    counts.set(entry.paperId, (counts.get(entry.paperId) ?? 0) + 1);
  }
  return [...counts.entries()].map(([paperId, count]) => ({ paperId, count }));
}

/**
 * Suggested concepts and relations that mention a confirmed one.
 *
 * Kept in one place so the interface can show "AI suggested this" without ever letting a
 * suggestion into the confirmed lists above.
 */
export function suggestionsFor(
  state: KnowledgeState,
  conceptId: string,
): {
  concepts: Concept[];
  relations: ConceptRelation[];
} {
  const linked = new Set<string>();
  for (const relation of state.relations) {
    if (relation.status !== 'suggested') continue;
    if (relation.from === conceptId) linked.add(relation.to);
    if (relation.to === conceptId) linked.add(relation.from);
  }
  return {
    concepts: state.concepts.filter(
      (concept) => concept.status === 'suggested' && linked.has(concept.id),
    ),
    relations: state.relations.filter(
      (relation) =>
        relation.status === 'suggested' &&
        (relation.from === conceptId || relation.to === conceptId),
    ),
  };
}
