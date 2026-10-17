/**
 * The reducer behind the knowledge view.
 *
 * It is pure: every identifier and timestamp arrives in the action, so a test can replay a
 * sequence and get the same graph. The one rule it enforces on its own is about provenance —
 * anything that arrives through `suggestions/add` is stored as a suggestion, whatever the
 * caller claimed.
 */

import {
  confirmConcept,
  confirmRelation,
  createConcept,
  createEvidence,
  createRelation,
  deleteConcept,
  deleteRelation,
  detachProjectFromKnowledge,
  linkConceptToProject,
  mergeConcepts,
  unlinkConceptFromProject,
  updateConcept,
  type Concept,
  type ConceptEvidence,
  type ConceptInput,
  type ConceptRelation,
  type EvidenceInput,
  type KnowledgeState,
  type RelationInput,
} from './knowledge';

export type KnowledgeAction =
  | { type: 'concept/create'; input: ConceptInput; id: string; at: number }
  | {
      type: 'concept/update';
      id: string;
      edit: { name?: string; summary?: string; aliases?: readonly string[] };
      at: number;
    }
  | { type: 'concept/confirm'; id: string; at: number }
  | { type: 'concept/delete'; id: string }
  | { type: 'concept/merge'; sourceId: string; targetId: string; at: number }
  | { type: 'concept/linkProject'; id: string; projectId: string; at: number }
  | { type: 'concept/unlinkProject'; id: string; projectId: string; at: number }
  | { type: 'evidence/add'; input: EvidenceInput; id: string; at: number }
  | { type: 'evidence/remove'; id: string }
  | { type: 'relation/create'; input: RelationInput; id: string; at: number }
  | { type: 'relation/confirm'; id: string; at: number }
  | { type: 'relation/delete'; id: string }
  | { type: 'project/detach'; projectId: string; at: number }
  | {
      type: 'suggestions/add';
      concepts: readonly Concept[];
      relations: readonly ConceptRelation[];
      evidence: readonly ConceptEvidence[];
    };

export function knowledgeReducer(state: KnowledgeState, action: KnowledgeAction): KnowledgeState {
  switch (action.type) {
    case 'concept/create': {
      const concept = createConcept(action.input, () => action.id, action.at);
      if (concept === null) return state;
      return { ...state, concepts: [...state.concepts, concept] };
    }

    case 'concept/update':
      return updateConcept(state, action.id, action.edit, action.at);

    case 'concept/confirm':
      return confirmConcept(state, action.id, action.at);

    case 'concept/delete':
      return deleteConcept(state, action.id);

    case 'concept/merge':
      return mergeConcepts(state, action.sourceId, action.targetId, action.at);

    case 'concept/linkProject':
      return linkConceptToProject(state, action.id, action.projectId, action.at);

    case 'concept/unlinkProject':
      return unlinkConceptFromProject(state, action.id, action.projectId, action.at);

    case 'evidence/add': {
      const evidence = createEvidence(action.input, () => action.id, action.at);
      if (evidence === null) return state;
      if (!state.concepts.some((concept) => concept.id === evidence.conceptId)) return state;
      return { ...state, evidence: [...state.evidence, evidence] };
    }

    case 'evidence/remove':
      return { ...state, evidence: state.evidence.filter((entry) => entry.id !== action.id) };

    case 'relation/create':
      return createRelation(state, action.input, () => action.id, action.at).state;

    case 'relation/confirm':
      return confirmRelation(state, action.id, action.at);

    case 'relation/delete':
      return deleteRelation(state, action.id);

    case 'project/detach':
      return detachProjectFromKnowledge(state, action.projectId, action.at);

    case 'suggestions/add': {
      const knownConcepts = new Set(state.concepts.map((concept) => concept.id));
      const knownRelations = new Set(state.relations.map((relation) => relation.id));
      const knownEvidence = new Set(state.evidence.map((entry) => entry.id));

      // Provenance is not negotiable: whatever the caller wrote, a suggestion stays a
      // suggestion. That is what keeps an AI batch from overwriting the reader's own work.
      const concepts = action.concepts
        .filter((concept) => !knownConcepts.has(concept.id))
        .map((concept) => ({ ...concept, status: 'suggested' as const, origin: 'ai' as const }));
      const ids = new Set([...knownConcepts, ...concepts.map((concept) => concept.id)]);
      const relations = action.relations
        .filter(
          (relation) =>
            !knownRelations.has(relation.id) && ids.has(relation.from) && ids.has(relation.to),
        )
        .map((relation) => ({ ...relation, status: 'suggested' as const, origin: 'ai' as const }));
      const evidence = action.evidence.filter(
        (entry) => !knownEvidence.has(entry.id) && ids.has(entry.conceptId),
      );

      if (concepts.length === 0 && relations.length === 0 && evidence.length === 0) return state;
      return {
        ...state,
        concepts: [...state.concepts, ...concepts],
        relations: [...state.relations, ...relations],
        evidence: [...state.evidence, ...evidence],
      };
    }

    default:
      return state;
  }
}
