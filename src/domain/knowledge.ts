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
 *   prerequisite: `from` needs `to` first          (KZG —prerequisite→ bilinear pairing)
 *   definition:   `from` is defined/characterized by `to` (DLM —definition→ shared canvas)
 *   approximates: `from` is an approximation of `to`    (resampling —approximates→ Q_β)
 *   replaces:     `from` replaces/contrasts with `to`   (complementary views —replaces→ single view)
 *   extends:      `from` builds on `to`                 (KZG —extends→ Pedersen commitment)
 *   related:      undirected association
 *
 * Only `prerequisite` is a *learning* relation: it is the only kind used by the learning path.
 * The others are claims about how the ideas relate academically; a definition is not a lesson
 * order, an approximation is not an extension, and a replacement is not an extension either.
 * Keeping those distinctions in the type system is what keeps the graph from slowly turning
 * every co-occurrence into a prerequisite.
 *
 * Every relation also records who put it there. A relation the reader made is never rewritten
 * by a later suggestion — suggestions are new records with their own status until confirmed.
 */

import type { NormalizedRect } from './annotation';

export type ConceptStatus = 'confirmed' | 'suggested';
export type ConceptOrigin = 'user' | 'ai';

export type RelationKind =
  'prerequisite' | 'definition' | 'approximates' | 'replaces' | 'extends' | 'related';

/**
 * How a relation is grounded.
 *
 * This is deliberately not a truth value. `direct` means the model backed the relation with a
 * quotation that really occurs in the paper text it was sent — which proves the words exist,
 * not that the relation is academically correct. `inferred` is the model's own reasoning over
 * the text; `external` is knowledge the model brought from outside the paper. The interface
 * shows all three differently, and only the reader can turn any of them into accepted knowledge.
 */
export type RelationSupport = 'direct' | 'inferred' | 'external';

export const RELATION_SUPPORTS: readonly RelationSupport[] = ['direct', 'inferred', 'external'];

export const RELATION_SUPPORT_LABEL: Record<RelationSupport, string> = {
  direct: '原文直接支持',
  inferred: '模型推断',
  external: '外部知识',
};

/**
 * How far an occurrence's location was checked.
 *
 * `verbatim` — the quotation was verified against the exact text sent (server side).
 * `located` — this app also found it on the rendered page and measured its boxes.
 * `unverified` — recorded before either check could run; it can be shown, but never jumped to.
 * A verbatim match proves the words exist; it does not prove any relation drawn from them.
 */
export type EvidenceVerification = 'verbatim' | 'located' | 'unverified';

export const EVIDENCE_VERIFICATIONS: readonly EvidenceVerification[] = [
  'verbatim',
  'located',
  'unverified',
];

export const EVIDENCE_VERIFICATION_LABEL: Record<EvidenceVerification, string> = {
  verbatim: '引文逐字校验',
  located: '位置已核实',
  unverified: '位置未核实',
};

export const RELATION_KINDS: readonly RelationKind[] = [
  'prerequisite',
  'definition',
  'approximates',
  'replaces',
  'extends',
  'related',
];

export const RELATION_KIND_LABEL: Record<RelationKind, string> = {
  prerequisite: '前置知识',
  definition: '定义依赖',
  approximates: '近似实现',
  replaces: '替代/对照',
  extends: '扩展',
  related: '相关',
};

/** The kinds whose meaning has a direction. `related` is the only undirected one. */
export const DIRECTED_RELATION_KINDS: readonly RelationKind[] = [
  'prerequisite',
  'definition',
  'approximates',
  'replaces',
  'extends',
];

/** Relations that describe academic structure but never learning order. */
export const ACADEMIC_RELATION_KINDS: readonly RelationKind[] = [
  'definition',
  'approximates',
  'replaces',
];

/** Only this kind participates in learning paths and cycle checks. */
export const LEARNING_RELATION_KIND: RelationKind = 'prerequisite';

/**
 * How to read a relation, in the interface's own words.
 *
 * The arrow is always from the concept the reader is looking at, which is the only reading a
 * person can do without a legend: "this needs that first".
 */
export const RELATION_DIRECTION: Record<RelationKind, string> = {
  prerequisite: '要理解 A，需要先理解 B',
  definition: 'A 的定义依赖 B',
  approximates: 'A 近似实现 B',
  replaces: 'A 替代/对照 B',
  extends: 'A 扩展了 B',
  related: 'A 与 B 相关（无方向）',
};

/**
 * Fills the A/B placeholders with real names.
 *
 * This is not `replace('A', …)`: a name such as `Bilinear pairing` contains a B, and a naive
 * replacement would rewrite the name itself instead of the placeholder that follows it.
 */
export function relationDirectionText(kind: RelationKind, from: string, to: string): string {
  return RELATION_DIRECTION[kind]
    .split(/\b([AB])\b/)
    .map((part) => (part === 'A' ? from : part === 'B' ? to : part))
    .join('');
}

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
  /**
   * The relation this occurrence grounds, when it is relation evidence rather than concept
   * evidence. Present only on records produced by a knowledge analysis; absent on everything
   * the reader made before Phase 8, which is why it has to remain optional.
   */
  relationId?: string;
  /** What was actually checked when this record was stored. Absent means `unverified`. */
  verification?: EvidenceVerification;
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
  /** Why the reader believes this, in their own words. Never overwritten by a model. */
  note: string;
  /**
   * How the model grounded this relation. Absent on relations the reader made themselves,
   * because they did not make a claim about grounding — they just knew it.
   */
  support?: RelationSupport;
  /** The model's explanation of why the relation holds. Separate from the reader's `note`. */
  rationale?: string;
  /** Who proposed it. All optional so a Phase 7 payload stays exactly as it was. */
  provider?: string;
  providerLabel?: string;
  model?: string;
  /** The analysis rules that produced this suggestion, so a stale suggestion is recognisable. */
  rulesVersion?: string;
  /** The occurrence records that ground this relation. */
  evidenceIds?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface RejectionEvidence {
  paperId: string;
  pdfSha256: string;
  page: number;
  quote: string;
}

/**
 * A relation suggestion the reader explicitly refused.
 *
 * This is not "these two concepts may never be related". It records one specific claim:
 * these two concept identities, this relation kind, this explanation and these quotations.
 * A different kind, explanation or evidence set is a different suggestion and may appear.
 *
 * `fingerprint` is computed from those stable fields — never from a per-run suggestion id or a
 * model-generated identifier — so the same claim is recognised across analyses and restarts.
 */
export interface RejectedRelationSuggestion {
  id: string;
  /** Stable concept ids, not names. Renaming a concept does not detach its rejection. */
  from: string;
  to: string;
  kind: RelationKind;
  rationale: string;
  evidence: RejectionEvidence[];
  fingerprint: string;
  provider?: string;
  providerLabel?: string;
  model?: string;
  rulesVersion?: string;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeState {
  version: 2;
  concepts: Concept[];
  evidence: ConceptEvidence[];
  relations: ConceptRelation[];
  /** Explicit refusals of relation suggestions; kept apart from confirmed knowledge. */
  rejections: RejectedRelationSuggestion[];
}

export const EMPTY_KNOWLEDGE: KnowledgeState = {
  version: 2,
  concepts: [],
  evidence: [],
  relations: [],
  rejections: [],
};

export const MAX_CONCEPT_NAME = 80;
export const MAX_SUMMARY = 600;
export const MAX_RELATION_NOTE = 400;

/** Names are compared case- and whitespace-insensitively, but never *merged* by that. */
export function normalizeConceptName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** Shape check for one stored concept. Shared by the store and the backup reader. */
export function isConceptRecord(value: unknown): value is Concept {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id !== '' &&
    typeof value.name === 'string' &&
    value.name !== '' &&
    isStringArray(value.aliases) &&
    typeof value.summary === 'string' &&
    (value.origin === 'user' || value.origin === 'ai') &&
    (value.status === 'confirmed' || value.status === 'suggested') &&
    isStringArray(value.projectIds) &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number'
  );
}

export function isEvidenceRecord(value: unknown): value is ConceptEvidence {
  if (!isRecord(value)) return false;
  if (!(
    typeof value.id === 'string' &&
    typeof value.conceptId === 'string' &&
    typeof value.paperId === 'string' &&
    typeof value.pdfSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.pdfSha256) &&
    typeof value.page === 'number' &&
    Number.isInteger(value.page) &&
    value.page >= 1 &&
    typeof value.quote === 'string' &&
    typeof value.note === 'string' &&
    Array.isArray(value.rects)
  )) {
    return false;
  }
  if (value.relationId !== undefined && typeof value.relationId !== 'string') return false;
  if (
    value.verification !== undefined &&
    (typeof value.verification !== 'string' ||
      !EVIDENCE_VERIFICATIONS.includes(value.verification as EvidenceVerification))
  ) {
    return false;
  }
  return true;
}

export function isRelationRecord(value: unknown): value is ConceptRelation {
  if (!isRecord(value)) return false;
  if (!(
    typeof value.id === 'string' &&
    typeof value.from === 'string' &&
    typeof value.to === 'string' &&
    typeof value.kind === 'string' &&
    RELATION_KINDS.includes(value.kind as RelationKind) &&
    (value.status === 'confirmed' || value.status === 'suggested') &&
    (value.origin === 'user' || value.origin === 'ai')
  )) {
    return false;
  }
  if (
    value.support !== undefined &&
    (typeof value.support !== 'string' ||
      !RELATION_SUPPORTS.includes(value.support as RelationSupport))
  ) {
    return false;
  }
  for (const key of ['rationale', 'provider', 'providerLabel', 'model', 'rulesVersion'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  }
  if (value.evidenceIds !== undefined && !isStringArray(value.evidenceIds)) return false;
  return true;
}

export function isRejectionEvidenceRecord(value: unknown): value is RejectionEvidence {
  if (!isRecord(value)) return false;
  return (
    typeof value.paperId === 'string' &&
    value.paperId !== '' &&
    typeof value.pdfSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.pdfSha256) &&
    typeof value.page === 'number' &&
    Number.isInteger(value.page) &&
    value.page >= 1 &&
    typeof value.quote === 'string'
  );
}

export function isRejectedRelationRecord(value: unknown): value is RejectedRelationSuggestion {
  if (!isRecord(value)) return false;
  if (!(
    typeof value.id === 'string' &&
    value.id !== '' &&
    typeof value.from === 'string' &&
    value.from !== '' &&
    typeof value.to === 'string' &&
    value.to !== '' &&
    typeof value.kind === 'string' &&
    RELATION_KINDS.includes(value.kind as RelationKind) &&
    typeof value.rationale === 'string' &&
    typeof value.fingerprint === 'string' &&
    value.fingerprint !== '' &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isRejectionEvidenceRecord)
  )) {
    return false;
  }
  for (const key of ['provider', 'providerLabel', 'model', 'rulesVersion'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  }
  return typeof value.createdAt === 'number' && typeof value.updatedAt === 'number';
}

/**
 * Strict reader for a whole knowledge payload, used where the caller must not accept a
 * partial graph — restoring a backup, above all. The lenient path in `knowledgeStore`
 * still keeps what it understands and copies the rest aside; this one says no to the lot,
 * so a restore either writes a graph whose references all resolve or writes nothing.
 */
export function parseKnowledgeState(value: unknown): KnowledgeState | null {
  if (!isRecord(value)) return null;
  const version = value.version ?? 1;
  // Version 1 is the Phase 7/8 shape; version 2 adds explicit relation rejections. A newer
  // version is refused rather than guessed at, and the restore path writes nothing.
  if (version !== 1 && version !== 2) return null;
  if (!Array.isArray(value.concepts) || !Array.isArray(value.evidence)) return null;
  if (!Array.isArray(value.relations)) return null;
  const concepts = value.concepts.filter(isConceptRecord);
  const evidence = value.evidence.filter(isEvidenceRecord);
  const relations = value.relations.filter(isRelationRecord);
  const rejections =
    version === 2
      ? Array.isArray(value.rejections)
        ? value.rejections.filter(isRejectedRelationRecord)
        : null
      : [];
  if (rejections === null) return null;
  if (
    concepts.length !== value.concepts.length ||
    evidence.length !== value.evidence.length ||
    relations.length !== value.relations.length ||
    (version === 2 &&
      Array.isArray(value.rejections) &&
      rejections.length !== value.rejections.length)
  ) {
    return null;
  }
  const conceptIds = new Set(concepts.map((concept) => concept.id));
  if (conceptIds.size !== concepts.length) return null;
  const evidenceIds = new Set<string>();
  for (const entry of evidence) {
    if (!conceptIds.has(entry.conceptId)) return null;
    if (evidenceIds.has(entry.id)) return null;
    evidenceIds.add(entry.id);
  }
  const relationIds = new Set<string>();
  for (const relation of relations) {
    if (!conceptIds.has(relation.from) || !conceptIds.has(relation.to)) return null;
    if (relation.from === relation.to) return null;
    if (relationIds.has(relation.id)) return null;
    relationIds.add(relation.id);
  }
  const rejectionIds = new Set<string>();
  const rejectionFingerprints = new Set<string>();
  for (const rejection of rejections) {
    if (!conceptIds.has(rejection.from) || !conceptIds.has(rejection.to)) return null;
    if (rejection.from === rejection.to) return null;
    if (rejectionIds.has(rejection.id)) return null;
    if (rejectionFingerprints.has(rejection.fingerprint)) return null;
    rejectionIds.add(rejection.id);
    rejectionFingerprints.add(rejection.fingerprint);
  }
  // Phase 8 adds two optional links between a suggestion and its quotations. They are checked
  // only when present, so a Phase 7 payload — which has neither — restores unchanged.
  for (const entry of evidence) {
    if (entry.relationId === undefined) continue;
    const relation = relations.find((candidate) => candidate.id === entry.relationId);
    if (relation === undefined) return null;
    if (relation.from !== entry.conceptId) return null;
  }
  for (const relation of relations) {
    for (const evidenceId of relation.evidenceIds ?? []) {
      const entry = evidence.find((candidate) => candidate.id === evidenceId);
      if (entry === undefined) return null;
      if (entry.relationId !== undefined && entry.relationId !== relation.id) return null;
      if (entry.conceptId !== relation.from) return null;
    }
  }
  return { version: 2, concepts, evidence, relations, rejections };
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

/**
 * Stops showing a concept in one project.
 *
 * The concept, its occurrences and its relations are untouched, and every other project that
 * names it keeps doing so. A concept left with no project still exists in the knowledge base;
 * it simply has no project view to appear in until it is linked again.
 */
export function unlinkConceptFromProject(
  state: KnowledgeState,
  id: string,
  projectId: string,
  now: number,
): KnowledgeState {
  return {
    ...state,
    concepts: state.concepts.map((concept) =>
      concept.id === id && concept.projectIds.includes(projectId)
        ? {
            ...concept,
            projectIds: concept.projectIds.filter((entry) => entry !== projectId),
            updatedAt: now,
          }
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
  /** Set when this occurrence is evidence for a relation rather than for the concept alone. */
  relationId?: string;
  verification?: EvidenceVerification;
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
    ...(input.relationId === undefined ? {} : { relationId: input.relationId }),
    ...(input.verification === undefined ? {} : { verification: input.verification }),
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
  return relationExistsExcept(state, from, to, kind, null);
}

/** The same check, optionally ignoring one relation — used when re-checking an existing edge. */
export function relationExistsExcept(
  state: KnowledgeState,
  from: string,
  to: string,
  kind: RelationKind,
  exceptId: string | null,
): boolean {
  return state.relations.some((relation) => {
    if (relation.id === exceptId) return false;
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
 *
 * Suggestions take part in this check too. An unconfirmed edge does not yet shape the reader's
 * knowledge, but accepting it later would create the loop, so it is better to never store it.
 */
export function wouldCycle(
  state: KnowledgeState,
  from: string,
  to: string,
  kind: RelationKind,
): boolean {
  return wouldCycleExcept(state, from, to, kind, null);
}

function wouldCycleExcept(
  state: KnowledgeState,
  from: string,
  to: string,
  kind: RelationKind,
  exceptId: string | null,
): boolean {
  if (kind !== LEARNING_RELATION_KIND) return from === to;
  if (from === to) return true;
  const forward = new Map<string, string[]>();
  for (const relation of state.relations) {
    if (relation.id === exceptId) continue;
    if (relation.kind !== LEARNING_RELATION_KIND) continue;
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
  return confirmRelationChecked(state, id, now).state;
}

export interface RelationDecision {
  state: KnowledgeState;
  ok: boolean;
  reason?: string;
}

/**
 * Confirms a suggested relation only if it still makes a coherent graph.
 *
 * A suggestion was checked when it was proposed, but the graph can change while it waits: a
 * relation that was harmless then can now be a duplicate or close a prerequisite loop. Refusing
 * at the moment of confirmation — with a reason the interface can show — is the only reading
 * that does not put a loop into the dependency graph.
 */
export function confirmRelationChecked(
  state: KnowledgeState,
  id: string,
  now: number,
): RelationDecision {
  const relation = state.relations.find((candidate) => candidate.id === id);
  if (relation === undefined) return { state, ok: false, reason: '这条关系已经不存在。' };
  if (relation.status === 'confirmed') return { state, ok: true };
  if (relationExistsExcept(state, relation.from, relation.to, relation.kind, relation.id)) {
    return { state, ok: false, reason: '已经存在一条相同的关系。' };
  }
  if (wouldCycleExcept(state, relation.from, relation.to, relation.kind, relation.id)) {
    return { state, ok: false, reason: '这会形成一个循环前置依赖，已拒绝。' };
  }
  return {
    state: {
      ...state,
      relations: state.relations.map((candidate) =>
        candidate.id === id ? { ...candidate, status: 'confirmed', updatedAt: now } : candidate,
      ),
    },
    ok: true,
  };
}

/**
 * Changes the kind of a relation, re-checking what the old kind meant.
 *
 * Only the reader reaches this, and only deliberately: a relation the model proposed with the
 * wrong type can be corrected before or after acceptance, but never silently reinterpreted.
 */
export function updateRelationKind(
  state: KnowledgeState,
  id: string,
  kind: RelationKind,
  now: number,
): RelationDecision {
  const relation = state.relations.find((candidate) => candidate.id === id);
  if (relation === undefined) return { state, ok: false, reason: '这条关系已经不存在。' };
  if (!RELATION_KINDS.includes(kind)) return { state, ok: false, reason: '未知的关系类型。' };
  if (relation.kind === kind) return { state, ok: true };
  if (relationExistsExcept(state, relation.from, relation.to, kind, relation.id)) {
    return { state, ok: false, reason: '已经存在一条相同类型的关系。' };
  }
  if (wouldCycleExcept(state, relation.from, relation.to, kind, relation.id)) {
    return { state, ok: false, reason: '这会形成一个循环前置依赖，已拒绝。' };
  }
  return {
    state: {
      ...state,
      relations: state.relations.map((candidate) =>
        candidate.id === id ? { ...candidate, kind, updatedAt: now } : candidate,
      ),
    },
    ok: true,
  };
}

/** Removes one relation and the occurrences that existed only to ground it. */
export function deleteRelation(state: KnowledgeState, id: string): KnowledgeState {
  return {
    ...state,
    relations: state.relations.filter((relation) => relation.id !== id),
    evidence: state.evidence.filter((entry) => entry.relationId !== id),
  };
}

/**
 * Removes a concept with everything that belongs to it: its occurrences and its relations.
 *
 * Papers are never touched — they are not owned by a concept. Deleting the concept the reader
 * created is the only way its occurrences go.
 */
export function deleteConcept(state: KnowledgeState, id: string): KnowledgeState {
  const removedRelationIds = new Set(
    state.relations
      .filter((relation) => relation.from === id || relation.to === id)
      .map((relation) => relation.id),
  );
  return {
    ...state,
    concepts: state.concepts.filter((concept) => concept.id !== id),
    evidence: state.evidence.filter(
      (entry) =>
        entry.conceptId !== id &&
        (entry.relationId === undefined || !removedRelationIds.has(entry.relationId)),
    ),
    relations: state.relations.filter((relation) => !removedRelationIds.has(relation.id)),
    // A rejection is a decision about two concepts; once one of them is gone it has no subject
    // left and would be impossible to restore (the strict reader requires both ids to resolve).
    rejections: state.rejections.filter(
      (rejection) => rejection.from !== id && rejection.to !== id,
    ),
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

  // Occurrences that grounded a relation which no longer exists would be orphaned evidence;
  // they are removed with it. Concept occurrences and occurrences of surviving relations stay.
  const keptRelationIds = new Set(relations.map((relation) => relation.id));
  const mappedEvidence = state.evidence.map((entry) =>
    entry.conceptId === sourceId ? { ...entry, conceptId: targetId } : entry,
  );
  const evidence = mappedEvidence.filter(
    (entry) => entry.relationId === undefined || keptRelationIds.has(entry.relationId),
  );

  const projectIds = [...new Set([...target.projectIds, ...source.projectIds])];
  const rejections: RejectedRelationSuggestion[] = [];
  const seenRejections = new Set<string>();
  for (const rejection of state.rejections) {
    const from = rejection.from === sourceId ? targetId : rejection.from;
    const to = rejection.to === sourceId ? targetId : rejection.to;
    if (from === to) continue;
    const fingerprint =
      from === rejection.from && to === rejection.to
        ? rejection.fingerprint
        : relationSuggestionFingerprint({
            from,
            to,
            kind: rejection.kind,
            rationale: rejection.rationale,
            evidence: rejection.evidence,
          });
    if (seenRejections.has(fingerprint)) continue;
    seenRejections.add(fingerprint);
    rejections.push(
      from === rejection.from && to === rejection.to
        ? rejection
        : { ...rejection, from, to, fingerprint, updatedAt: now },
    );
  }
  return {
    ...state,
    concepts: state.concepts
      .filter((concept) => concept.id !== sourceId)
      .map((concept) =>
        concept.id === targetId ? { ...concept, projectIds, updatedAt: now } : concept,
      ),
    evidence,
    relations,
    rejections,
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
 * Phase 8: suggestions that carry their own evidence
 * ------------------------------------------------------------------ */

/**
 * Every existing concept whose name or alias matches `name` after normalisation.
 *
 * Returned as a list, not a single id, because a name is not an identity. Two concepts may
 * legitimately share a name (the same word means different things in different papers), and
 * picking the first one would silently attach new evidence to the wrong idea. Callers that
 * need an automatic match must require exactly one result.
 */
export function conceptMatchesForName(state: KnowledgeState, name: string): Concept[] {
  const key = normalizeConceptName(name);
  if (key === '') return [];
  return state.concepts.filter(
    (concept) =>
      normalizeConceptName(concept.name) === key ||
      concept.aliases.some((alias) => normalizeConceptName(alias) === key),
  );
}

/**
 * The one existing concept a name refers to, or null when there is none or more than one.
 *
 * Ambiguity is deliberately reported as "no automatic match". The reader can still merge two
 * concepts by hand; the app will not choose one for them.
 */
export function conceptIdForName(state: KnowledgeState, name: string): string | null {
  const matches = conceptMatchesForName(state, name);
  return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}

export interface RelationSemanticHint {
  /** A kind the explanation looks more like, or null when the hint is only "review this". */
  suggestedKind: RelationKind | null;
  message: string;
}

const DEFINITION_CUES =
  /定义(?:为|于|是|依赖)|被定义为|defined\s+as|is\s+defined|are\s+defined|characteri[sz]ed\s+by|refers?\s+to|denotes?/i;
const CO_OCCURRENCE_CUES =
  /同一?段|同段|共同出现|一起出现|并列出现|co-?occur|same\s+(?:sentence|paragraph)|appears?\s+in\s+the\s+same/i;
const REPLACEMENT_CUES =
  /替代|取代|对照|对比|instead|rather\s+than|replaces?|replacement|contrast|alternative/i;
const APPROXIMATION_CUES =
  /近似|近似实现|近似于|approximat|resampling|importance\s+sampling|intractable|implement(?:s|ed|ation)?/i;
const LEARNING_CUES =
  /先理解|需要先|必须先|前置|prerequisite|before\s+understanding|requires?\s+understanding/i;

/**
 * An advisory semantic check for one relation.
 *
 * This never changes a record. It reads the explanation the reader or the model wrote and says
 * when that explanation looks like a different kind of claim — a definition written as a
 * learning prerequisite, or a replacement/approximation written as an extension. Existing
 * confirmed relations are exactly the case this is for: they are not reclassified
 * automatically, but the reader can apply the suggestion with one explicit click.
 *
 * The cues are deliberately crude and phrase-based. A hint is a reason to look, not a verdict;
 * a relation with no matching cue returns null rather than pretending to be checked.
 */
export function relationSemanticHint(
  relation: Pick<ConceptRelation, 'kind' | 'rationale' | 'note'>,
): RelationSemanticHint | null {
  const text = `${relation.rationale ?? ''} ${relation.note}`.trim();
  if (text === '') return null;

  if (relation.kind === LEARNING_RELATION_KIND) {
    if (DEFINITION_CUES.test(text) && !LEARNING_CUES.test(text)) {
      return {
        suggestedKind: 'definition',
        message:
          '说明更像「定义依赖」而不是学习前置；定义关系不应进入学习路径。建议人工复核后改为「定义依赖」。',
      };
    }
    if (CO_OCCURRENCE_CUES.test(text) && !LEARNING_CUES.test(text)) {
      return {
        suggestedKind: 'related',
        message:
          '说明只提到同段/共同出现；同一段出现不足以构成前置关系。建议改为「相关」或先补充学习顺序上的理由。',
      };
    }
  }

  if (relation.kind === 'extends') {
    if (REPLACEMENT_CUES.test(text)) {
      return {
        suggestedKind: 'replaces',
        message:
          '说明更像「替代/对照」而不是「扩展」；替代或对照不应写成扩展。建议人工复核后改为「替代/对照」。',
      };
    }
    if (APPROXIMATION_CUES.test(text)) {
      return {
        suggestedKind: 'approximates',
        message:
          '说明更像「近似实现」而不是「扩展」；近似或实现关系不应写成扩展。建议人工复核后改为「近似实现」。',
      };
    }
  }

  return null;
}

/** The occurrences that ground one relation. */
export function evidenceForRelation(state: KnowledgeState, relationId: string): ConceptEvidence[] {
  return state.evidence
    .filter((entry) => entry.relationId === relationId)
    .sort((one, other) => one.page - other.page || one.createdAt - other.createdAt);
}

function fingerprintText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A deterministic 64-bit-ish string hash. No crypto API, so this stays synchronous and pure. */
function hashForFingerprint(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * The stable identity of one relation *claim*, used by explicit rejections.
 *
 * It deliberately includes only what the reader rejected: the two stable concept ids, the kind,
 * the explanation, and the evidence (paper, file, page, quotation). A transient suggestion id,
 * a new analysis run or a different provider must not change it. Conversely, changing the kind,
 * the explanation or the evidence makes a different claim that is allowed to appear again.
 */
export function relationSuggestionFingerprint(input: {
  from: string;
  to: string;
  kind: RelationKind;
  rationale: string;
  evidence: readonly RejectionEvidence[];
}): string {
  const evidence = input.evidence
    .map(
      (entry) =>
        `${entry.paperId}\u0003${entry.pdfSha256}\u0003${String(entry.page)}\u0003${fingerprintText(entry.quote)}`,
    )
    .sort()
    .join('\u0001');
  const canonical = [
    'relation-rejection-v1',
    input.from,
    input.to,
    input.kind,
    fingerprintText(input.rationale),
    evidence,
  ].join('\u0002');
  return `rel1-${hashForFingerprint(canonical)}`;
}

/**
 * Turns a suggestion into an explicit rejection and removes the suggestion.
 *
 * The rejection keeps a snapshot of the explanation and evidence, because the relation record
 * itself is deleted. Confirmed relations are not suggestions and are refused here: the reader
 * may delete or change one deliberately, but an AI batch must never overwrite it.
 */
export function rejectRelationSuggestion(
  state: KnowledgeState,
  relationId: string,
  rejectionId: string,
  now: number,
): { state: KnowledgeState; rejection: RejectedRelationSuggestion | null; reason?: string } {
  const relation = state.relations.find((candidate) => candidate.id === relationId);
  if (relation === undefined) {
    return { state, rejection: null, reason: '这条关系建议已经不存在。' };
  }
  if (relation.status === 'confirmed') {
    return { state, rejection: null, reason: '已确认的关系不能被当作建议拒绝。' };
  }
  const evidence = evidenceForRelation(state, relationId).map((entry) => ({
    paperId: entry.paperId,
    pdfSha256: entry.pdfSha256,
    page: entry.page,
    quote: entry.quote,
  }));
  const rationale = relation.rationale ?? '';
  const rejection: RejectedRelationSuggestion = {
    id: rejectionId,
    from: relation.from,
    to: relation.to,
    kind: relation.kind,
    rationale,
    evidence,
    fingerprint: relationSuggestionFingerprint({
      from: relation.from,
      to: relation.to,
      kind: relation.kind,
      rationale,
      evidence,
    }),
    ...(relation.provider === undefined ? {} : { provider: relation.provider }),
    ...(relation.providerLabel === undefined ? {} : { providerLabel: relation.providerLabel }),
    ...(relation.model === undefined ? {} : { model: relation.model }),
    ...(relation.rulesVersion === undefined ? {} : { rulesVersion: relation.rulesVersion }),
    createdAt: now,
    updatedAt: now,
  };
  const without = deleteRelation(state, relationId);
  return {
    state: {
      ...without,
      rejections: [
        ...without.rejections.filter((entry) => entry.fingerprint !== rejection.fingerprint),
        rejection,
      ],
    },
    rejection,
  };
}

export function undoRejection(state: KnowledgeState, id: string): KnowledgeState {
  return { ...state, rejections: state.rejections.filter((entry) => entry.id !== id) };
}

/**
 * The confirmed prerequisite chain a reader can learn along, foundations first.
 *
 * This is a topological order of the confirmed prerequisite subgraph reachable from the
 * concept, not a claim that any one order is the only correct one: where there are branches,
 * everything at the same depth is ordered by name so the result is stable. Only confirmed
 * relations take part — a suggestion is not a dependency. The concept itself comes last, which
 * is what makes the list read as "learn these, then this".
 */
export function learningPath(
  state: KnowledgeState,
  conceptId: string,
  { maxDepth = 8, maxNodes = 12 }: { maxDepth?: number; maxNodes?: number } = {},
): Concept[] {
  const target = state.concepts.find((concept) => concept.id === conceptId);
  if (target === undefined) return [];

  const depth = new Map<string, number>([[conceptId, 0]]);
  const queue: { id: string; depth: number }[] = [{ id: conceptId, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current.depth >= maxDepth) continue;
    for (const relation of state.relations) {
      if (relation.kind !== LEARNING_RELATION_KIND || relation.status !== 'confirmed') continue;
      if (relation.from !== current.id) continue;
      const prerequisite = state.concepts.find((concept) => concept.id === relation.to);
      if (prerequisite === undefined) continue;
      const nextDepth = current.depth + 1;
      if (nextDepth > (depth.get(relation.to) ?? -1)) {
        depth.set(relation.to, nextDepth);
        queue.push({ id: relation.to, depth: nextDepth });
      }
    }
  }

  const ordered = [...depth.entries()]
    .filter(([id]) => id !== conceptId)
    .map(([id, level]) => ({
      concept: state.concepts.find((concept) => concept.id === id),
      level,
    }))
    .filter((entry): entry is { concept: Concept; level: number } => entry.concept !== undefined)
    .sort(
      (one, other) =>
        other.level - one.level || one.concept.name.localeCompare(other.concept.name, 'zh-Hans-CN'),
    )
    .slice(0, Math.max(0, maxNodes - 1))
    .map((entry) => entry.concept);

  return [...ordered, target];
}

export interface SuggestionBatch {
  concepts: readonly Concept[];
  relations: readonly ConceptRelation[];
  evidence: readonly ConceptEvidence[];
}

export interface SuggestionSkip {
  kind: 'concept' | 'relation' | 'evidence';
  label: string;
  reason: string;
}

export interface SuggestionReport {
  addedConcepts: number;
  reusedConcepts: number;
  addedRelations: number;
  addedEvidence: number;
  skipped: SuggestionSkip[];
}

/**
 * Adds one analysis's suggestions to the graph without ever changing what is already there.
 *
 * The checks here are the last line of defence, not a repetition of the server's: a name that
 * matches exactly one existing concept becomes a reference to it, a name that matches several
 * is refused rather than guessed, a duplicate relation is skipped, and a prerequisite that
 * would close a loop is refused. Everything added is forced to `status: suggested` and
 * `origin: ai`, whatever the incoming record claimed — so no batch can write a confirmed fact
 * or overwrite a relation the reader made.
 *
 * The returned report is what the interface shows when it says "3 suggestions were not added,
 * and why". Nothing is skipped silently.
 */
export function mergeSuggestions(
  state: KnowledgeState,
  batch: SuggestionBatch,
): { state: KnowledgeState; report: SuggestionReport } {
  const report: SuggestionReport = {
    addedConcepts: 0,
    reusedConcepts: 0,
    addedRelations: 0,
    addedEvidence: 0,
    skipped: [],
  };

  // A key can point at more than one concept. That is not a detail to collapse: the same name
  // can legitimately mean different things in different papers, and choosing the first match
  // would attach new evidence to the wrong idea.
  const idsByName = new Map<string, Set<string>>();
  const remember = (concept: Concept): void => {
    for (const value of [concept.name, ...concept.aliases]) {
      const key = normalizeConceptName(value);
      if (key === '') continue;
      const ids = idsByName.get(key) ?? new Set<string>();
      ids.add(concept.id);
      idsByName.set(key, ids);
    }
  };
  for (const concept of state.concepts) remember(concept);

  const concepts = [...state.concepts];
  const idMap = new Map<string, string>();
  const skippedConceptReasons = new Map<string, string>();

  for (const proposed of batch.concepts) {
    const name = proposed.name.replace(/\s+/g, ' ').trim();
    if (name === '' || name.length > MAX_CONCEPT_NAME) {
      report.skipped.push({
        kind: 'concept',
        label: proposed.name.slice(0, 60),
        reason: '概念名称为空或过长。',
      });
      continue;
    }

    const keys = [name, ...proposed.aliases]
      .map((value) => normalizeConceptName(value))
      .filter((key) => key !== '');
    const existingIds = new Set<string>();
    for (const key of keys) {
      for (const id of idsByName.get(key) ?? []) existingIds.add(id);
    }
    if (existingIds.size > 1) {
      const reason =
        '名称或别名同时对应多个已有概念；为避免仅凭同名合并，未自动选择，也未加入这条建议。';
      skippedConceptReasons.set(proposed.id, reason);
      report.skipped.push({ kind: 'concept', label: name, reason });
      continue;
    }
    const existingId = [...existingIds][0];
    if (existingId !== undefined) {
      idMap.set(proposed.id, existingId);
      report.reusedConcepts += 1;
      continue;
    }

    if (concepts.some((concept) => concept.id === proposed.id)) {
      report.skipped.push({
        kind: 'concept',
        label: name,
        reason: '概念 id 与已有记录冲突，已跳过。',
      });
      continue;
    }

    const concept: Concept = {
      ...proposed,
      name,
      aliases: [...new Set(proposed.aliases.map((alias) => alias.trim()).filter(Boolean))].slice(
        0,
        8,
      ),
      summary: proposed.summary.trim().slice(0, MAX_SUMMARY),
      origin: 'ai',
      status: 'suggested',
      projectIds: [
        ...new Set(proposed.projectIds.filter((id) => typeof id === 'string' && id !== '')),
      ],
    };
    concepts.push(concept);
    remember(concept);
    idMap.set(proposed.id, concept.id);
    report.addedConcepts += 1;
  }

  const knownConceptIds = new Set(concepts.map((concept) => concept.id));
  const relations = [...state.relations];
  const relationIdMap = new Map<string, string>();

  for (const proposed of batch.relations) {
    const from = idMap.get(proposed.from) ?? proposed.from;
    const to = idMap.get(proposed.to) ?? proposed.to;
    const label = `${from.slice(0, 12)} → ${to.slice(0, 12)}`;
    const ambiguousReason =
      skippedConceptReasons.get(proposed.from) ?? skippedConceptReasons.get(proposed.to);
    if (ambiguousReason !== undefined) {
      report.skipped.push({ kind: 'relation', label, reason: ambiguousReason });
      continue;
    }
    if (!knownConceptIds.has(from) || !knownConceptIds.has(to)) {
      report.skipped.push({ kind: 'relation', label, reason: '关系两端的概念不存在。' });
      continue;
    }
    if (from === to) {
      report.skipped.push({ kind: 'relation', label, reason: '关系指向概念自己。' });
      continue;
    }
    if (!RELATION_KINDS.includes(proposed.kind)) {
      report.skipped.push({ kind: 'relation', label, reason: '未知的关系类型。' });
      continue;
    }
    if (relations.some((relation) => relation.id === proposed.id)) {
      report.skipped.push({ kind: 'relation', label, reason: '关系 id 与已有记录冲突。' });
      continue;
    }
    const working: KnowledgeState = { ...state, concepts, relations };
    if (relationExistsExcept(working, from, to, proposed.kind, proposed.id)) {
      report.skipped.push({ kind: 'relation', label, reason: '这条关系已经存在。' });
      continue;
    }
    const rejectionEvidence = batch.evidence
      .filter(
        (entry) =>
          entry.relationId === proposed.id || (proposed.evidenceIds ?? []).includes(entry.id),
      )
      .map((entry) => ({
        paperId: entry.paperId,
        pdfSha256: entry.pdfSha256,
        page: entry.page,
        quote: entry.quote,
      }));
    const fingerprint = relationSuggestionFingerprint({
      from,
      to,
      kind: proposed.kind,
      rationale: proposed.rationale ?? '',
      evidence: rejectionEvidence,
    });
    if (state.rejections.some((rejection) => rejection.fingerprint === fingerprint)) {
      report.skipped.push({
        kind: 'relation',
        label,
        reason: '这条关系建议已被你明确拒绝；撤销拒绝后，下一次分析才可能再次提出。',
      });
      continue;
    }
    if (wouldCycle(working, from, to, proposed.kind)) {
      report.skipped.push({ kind: 'relation', label, reason: '这会形成一个循环前置依赖。' });
      continue;
    }

    const relation: ConceptRelation = {
      ...proposed,
      from,
      to,
      origin: 'ai',
      status: 'suggested',
      note: proposed.note.trim().slice(0, MAX_RELATION_NOTE),
      support: proposed.support ?? 'inferred',
      evidenceIds: [],
    };
    relations.push(relation);
    relationIdMap.set(proposed.id, relation.id);
    report.addedRelations += 1;
  }

  const evidence = [...state.evidence];
  const relationEvidence = new Map<string, string[]>();
  const knownEvidenceIds = new Set(evidence.map((entry) => entry.id));

  for (const proposed of batch.evidence) {
    const conceptId = idMap.get(proposed.conceptId) ?? proposed.conceptId;
    const mappedRelation =
      proposed.relationId === undefined
        ? undefined
        : (relationIdMap.get(proposed.relationId) ?? proposed.relationId);
    const relation =
      mappedRelation === undefined
        ? undefined
        : relations.find((candidate) => candidate.id === mappedRelation);
    if (proposed.relationId !== undefined && relation === undefined) {
      report.skipped.push({
        kind: 'evidence',
        label: proposed.quote.slice(0, 40),
        reason: '所属的关系建议没有被加入，出处也一并跳过。',
      });
      continue;
    }
    const ambiguousReason = skippedConceptReasons.get(proposed.conceptId);
    if (ambiguousReason !== undefined) {
      report.skipped.push({
        kind: 'evidence',
        label: proposed.quote.slice(0, 40),
        reason: ambiguousReason,
      });
      continue;
    }
    if (!knownConceptIds.has(conceptId)) {
      report.skipped.push({
        kind: 'evidence',
        label: proposed.quote.slice(0, 40),
        reason: '出处指向的概念不存在。',
      });
      continue;
    }
    if (relation !== undefined && relation.from !== conceptId) {
      report.skipped.push({
        kind: 'evidence',
        label: proposed.quote.slice(0, 40),
        reason: '出处的来源概念与关系不一致。',
      });
      continue;
    }
    if (knownEvidenceIds.has(proposed.id)) {
      report.skipped.push({
        kind: 'evidence',
        label: proposed.quote.slice(0, 40),
        reason: '出处 id 与已有记录冲突。',
      });
      continue;
    }
    const duplicate = evidence.some(
      (entry) =>
        entry.conceptId === conceptId &&
        entry.paperId === proposed.paperId &&
        entry.pdfSha256 === proposed.pdfSha256 &&
        entry.page === proposed.page &&
        collapseWhitespace(entry.quote) === collapseWhitespace(proposed.quote) &&
        (entry.relationId ?? null) === (relation?.id ?? null),
    );
    if (duplicate) {
      report.skipped.push({
        kind: 'evidence',
        label: proposed.quote.slice(0, 40),
        reason: '这条出处已经存在。',
      });
      continue;
    }

    const entry: ConceptEvidence = {
      ...proposed,
      conceptId,
      source: 'ai',
      verification: proposed.verification ?? 'unverified',
      ...(relation === undefined ? {} : { relationId: relation.id }),
    };
    if (!isEvidenceRecord(entry)) {
      report.skipped.push({
        kind: 'evidence',
        label: proposed.quote.slice(0, 40),
        reason: '出处记录的形状不完整。',
      });
      continue;
    }
    evidence.push(entry);
    knownEvidenceIds.add(entry.id);
    if (relation !== undefined) {
      const list = relationEvidence.get(relation.id) ?? [];
      list.push(entry.id);
      relationEvidence.set(relation.id, list);
    }
    report.addedEvidence += 1;
  }

  const withEvidence = relations.map((relation) => {
    const ids = relationEvidence.get(relation.id);
    if (ids === undefined) return relation;
    return {
      ...relation,
      evidenceIds: [...new Set([...(relation.evidenceIds ?? []), ...ids])],
    };
  });

  if (report.addedConcepts === 0 && report.addedRelations === 0 && report.addedEvidence === 0) {
    return { state, report };
  }

  return {
    state: { ...state, concepts, relations: withEvidence, evidence },
    report,
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
        relation.kind === LEARNING_RELATION_KIND &&
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
        relation.kind === LEARNING_RELATION_KIND &&
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
