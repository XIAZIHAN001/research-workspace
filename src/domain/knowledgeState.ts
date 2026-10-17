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
  confirmRelationChecked,
  createConcept,
  createEvidence,
  createRelation,
  deleteConcept,
  deleteRelation,
  detachProjectFromKnowledge,
  linkConceptToProject,
  mergeConcepts,
  mergeSuggestions,
  unlinkConceptFromProject,
  updateConcept,
  updateRelationKind,
  type Concept,
  type ConceptEvidence,
  type ConceptInput,
  type ConceptRelation,
  type EvidenceInput,
  type KnowledgeState,
  type RelationInput,
  type RelationKind,
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
  | { type: 'relation/updateKind'; id: string; kind: RelationKind; at: number }
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
      return confirmRelationChecked(state, action.id, action.at).state;

    case 'relation/updateKind':
      return updateRelationKind(state, action.id, action.kind, action.at).state;

    case 'relation/delete':
      return deleteRelation(state, action.id);

    case 'project/detach':
      return detachProjectFromKnowledge(state, action.projectId, action.at);

    case 'suggestions/add':
      // The domain function owns the rules: provenance is forced, duplicates become references,
      // and a loop is refused. The reducer only applies its result, so a caller cannot bypass
      // them by constructing a batch that looks authoritative.
      return mergeSuggestions(state, action).state;

    default:
      return state;
  }
}
