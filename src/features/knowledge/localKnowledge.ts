/**
 * What the reader already knows about the passage in front of them.
 *
 * This is the quiet half of "查看相关知识": it reads the local knowledge graph and says which
 * concepts are connected to the current selection or page, where the evidence is, and what is
 * still a pending suggestion. It never calls a model, which is why opening the panel is free
 * and why the panel can show something useful before the reader decides to analyse anything.
 */

import {
  conceptIdForName,
  normalizeConceptName,
  prerequisitesOf,
  type Concept,
  type ConceptEvidence,
  type ConceptRelation,
  type KnowledgeState,
} from '../../domain/knowledge';

export type LocalMatchKind = 'selection' | 'page' | 'evidence';

export interface LocalConceptMatch {
  concept: Concept;
  matchedBy: LocalMatchKind;
  /** Occurrences of this concept in the current paper, newest first. */
  evidence: ConceptEvidence[];
  /** The occurrences on the current page, if any. */
  pageEvidence: ConceptEvidence[];
  /** Confirmed prerequisites, ready to navigate. */
  prerequisites: Concept[];
  /** Suggestions that mention this concept and still need a decision. */
  pendingRelations: ConceptRelation[];
  pendingConcepts: Concept[];
}

export interface LocalKnowledge {
  matches: LocalConceptMatch[];
  /** Suggestions tied to this paper even when their concepts did not match by name. */
  pendingRelations: ConceptRelation[];
  pendingConcepts: Concept[];
  conceptsInScope: number;
}

export interface LocalKnowledgeInput {
  projectId: string | null;
  paperId: string;
  currentPage: number;
  selection: string;
  pageText: string;
}

function contains(haystack: string, needle: string): boolean {
  if (needle === '') return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Ranks concepts by how directly they touch what is on screen.
 *
 * A name that appears in the selection is the strongest signal; a name on the page is next; an
 * occurrence recorded on this page or elsewhere in this paper means the concept is genuinely
 * about this paper even if its name is not spelled the same way. Nothing is inferred from mere
 * co-occurrence beyond that, and nothing is merged.
 */
export function localKnowledgeFor(
  state: KnowledgeState,
  input: LocalKnowledgeInput,
): LocalKnowledge {
  const projectId = input.projectId;
  const inScope =
    projectId === null
      ? state.concepts
      : state.concepts.filter((concept) => concept.projectIds.includes(projectId));
  const selection = input.selection.replace(/\s+/g, ' ').trim();
  const pageText = input.pageText.replace(/\s+/g, ' ').trim();

  const matches: LocalConceptMatch[] = [];
  for (const concept of inScope) {
    const evidence = state.evidence
      .filter(
        (entry) =>
          entry.conceptId === concept.id &&
          entry.paperId === input.paperId &&
          entry.relationId === undefined,
      )
      .sort((one, other) => other.createdAt - one.createdAt);
    const pageEvidence = evidence.filter((entry) => entry.page === input.currentPage);

    const names = [concept.name, ...concept.aliases];
    const inSelection = names.some(
      (name) => normalizeConceptName(name) !== '' && contains(selection, name),
    );
    const onPage = names.some(
      (name) => normalizeConceptName(name) !== '' && contains(pageText, name),
    );
    if (!inSelection && !onPage && evidence.length === 0) continue;

    const matchedBy: LocalMatchKind = inSelection ? 'selection' : onPage ? 'page' : 'evidence';

    const pendingRelations = state.relations.filter(
      (relation) =>
        relation.status === 'suggested' &&
        (relation.from === concept.id || relation.to === concept.id),
    );
    const pendingIds = new Set<string>();
    for (const relation of pendingRelations) {
      pendingIds.add(relation.from === concept.id ? relation.to : relation.from);
    }
    const pendingConcepts = state.concepts.filter(
      (entry) => pendingIds.has(entry.id) && entry.status === 'suggested',
    );

    matches.push({
      concept,
      matchedBy,
      evidence,
      pageEvidence,
      prerequisites: prerequisitesOf(state, concept.id),
      pendingRelations,
      pendingConcepts,
    });
  }

  const order: Record<LocalMatchKind, number> = { selection: 0, page: 1, evidence: 2 };
  matches.sort((one, other) => {
    const byKind = order[one.matchedBy] - order[other.matchedBy];
    if (byKind !== 0) return byKind;
    if (one.pageEvidence.length !== other.pageEvidence.length) {
      return other.pageEvidence.length - one.pageEvidence.length;
    }
    return one.concept.name.localeCompare(other.concept.name, 'zh-Hans-CN');
  });

  const matchedIds = new Set(matches.map((match) => match.concept.id));
  const pendingRelations = state.relations.filter((relation) => {
    if (relation.status !== 'suggested') return false;
    if (matchedIds.has(relation.from) || matchedIds.has(relation.to)) return false;
    return state.evidence.some(
      (entry) => entry.relationId === relation.id && entry.paperId === input.paperId,
    );
  });
  const pendingConcepts = state.concepts.filter(
    (concept) =>
      concept.status === 'suggested' &&
      !matchedIds.has(concept.id) &&
      pendingRelations.some(
        (relation) => relation.from === concept.id || relation.to === concept.id,
      ),
  );

  return {
    matches: matches.slice(0, 12),
    pendingRelations,
    pendingConcepts,
    conceptsInScope: inScope.length,
  };
}

/** The concept a name in a local match or a suggestion refers to, if it is already known. */
export function knownConcept(state: KnowledgeState, name: string): Concept | null {
  const id = conceptIdForName(state, name);
  return id === null ? null : (state.concepts.find((concept) => concept.id === id) ?? null);
}
