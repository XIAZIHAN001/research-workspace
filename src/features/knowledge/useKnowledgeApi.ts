import { useCallback, useMemo } from 'react';
import {
  confirmRelationChecked,
  createRelation,
  mergeSuggestions,
  normalizeConceptName,
  updateRelationKind,
  type Concept,
  type ConceptEvidence,
  type ConceptInput,
  type EvidenceInput,
  type KnowledgeState,
  type RelationInput,
  type RelationKind,
  type SuggestionBatch,
  type SuggestionReport,
} from '../../domain/knowledge';
import type { KnowledgeAction } from '../../domain/knowledgeState';
import type { KnowledgeStore } from '../../services/knowledgeStore';
import { defaultStore, readItem } from '../../services/storage';
import { DIFFICULTY_STORAGE_KEY } from '../../services/difficultyStore';
import type { DifficultyPageRecord, DifficultySuggestion } from '../../domain/difficulty';

export interface ConceptCandidate {
  /** The name proposed for a new concept. Never merged with an existing one by name. */
  name: string;
  summary: string;
  /** The occurrences that would come with it. */
  evidence: EvidenceInput[];
  /** Existing concepts whose name matches — shown to the reader, never merged automatically. */
  possibleDuplicates: Concept[];
}

export interface KnowledgeApi {
  state: KnowledgeState;
  persisted: boolean;
  issue: string | null;
  /** Returns the id the new concept will have, so evidence can point at it immediately. */
  createConcept: (input: ConceptInput) => string;
  updateConcept: (
    id: string,
    edit: { name?: string; summary?: string; aliases?: string[] },
  ) => void;
  confirmConcept: (id: string) => void;
  deleteConcept: (id: string) => void;
  mergeConcept: (sourceId: string, targetId: string) => void;
  linkProject: (conceptId: string, projectId: string) => void;
  /** Stops showing the concept in one project. Nothing is deleted. */
  unlinkProject: (conceptId: string, projectId: string) => void;
  addEvidence: (input: EvidenceInput) => void;
  removeEvidence: (id: string) => void;
  createRelation: (input: RelationInput) => { ok: boolean; reason?: string };
  /** Confirms only if the relation still makes a coherent graph; a refusal carries its reason. */
  confirmRelation: (id: string) => { ok: boolean; reason?: string };
  updateRelationKind: (id: string, kind: RelationKind) => { ok: boolean; reason?: string };
  deleteRelation: (id: string) => void;
  /** Adds an analysis batch, enforcing provenance/dedupe/cycle rules; returns what happened. */
  addSuggestions: (batch: SuggestionBatch) => SuggestionReport;
  /** Reads the difficulty cache and proposes concepts; adds nothing until the reader says so. */
  candidatesFromDifficulties: (pdfSha256s: readonly string[]) => ConceptCandidate[];
}

/**
 * The knowledge graph as the interface sees it: state plus the actions that change it.
 *
 * Everything that mutates goes through one store, so there is exactly one place where the graph
 * is written and one place where a failed write is reported. Relations are checked here rather
 * than in the component, because "why was this refused" (duplicate, cycle) is information the
 * reader needs to see.
 */
export function useKnowledgeApi(
  store: KnowledgeStore,
  makeId: () => string,
  now: () => number = Date.now,
): KnowledgeApi {
  const dispatch = useCallback(
    (action: KnowledgeAction) => {
      store.dispatch(action);
    },
    [store],
  );

  const snapshot = store.getSnapshot();
  const state = snapshot.state;

  const createRelationChecked = useCallback(
    (input: RelationInput): { ok: boolean; reason?: string } => {
      const at = now();
      const result = createRelation(store.getSnapshot().state, input, makeId, at);
      if (result.relation === null) return { ok: false, reason: result.reason };
      dispatch({ type: 'relation/create', input, id: result.relation.id, at });
      return { ok: true };
    },
    [dispatch, makeId, now, store],
  );

  const confirmRelation = useCallback(
    (id: string): { ok: boolean; reason?: string } => {
      const at = now();
      const result = confirmRelationChecked(store.getSnapshot().state, id, at);
      if (!result.ok) return { ok: false, reason: result.reason };
      dispatch({ type: 'relation/confirm', id, at });
      return { ok: true };
    },
    [dispatch, now, store],
  );

  const updateRelation = useCallback(
    (id: string, kind: RelationKind): { ok: boolean; reason?: string } => {
      const at = now();
      const result = updateRelationKind(store.getSnapshot().state, id, kind, at);
      if (!result.ok) return { ok: false, reason: result.reason };
      dispatch({ type: 'relation/updateKind', id, kind, at });
      return { ok: true };
    },
    [dispatch, now, store],
  );

  const addSuggestions = useCallback(
    (batch: SuggestionBatch): SuggestionReport => {
      const result = mergeSuggestions(store.getSnapshot().state, batch);
      if (
        result.report.addedConcepts > 0 ||
        result.report.addedRelations > 0 ||
        result.report.addedEvidence > 0
      ) {
        dispatch({
          type: 'suggestions/add',
          concepts: batch.concepts,
          relations: batch.relations,
          evidence: batch.evidence,
        });
      }
      return result.report;
    },
    [dispatch, store],
  );

  const candidatesFromDifficulties = useCallback(
    (pdfSha256s: readonly string[]): ConceptCandidate[] => {
      const raw = readItem(DIFFICULTY_STORAGE_KEY);
      if (raw === null) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return [];
      }
      const pages: Record<string, DifficultyPageRecord> =
        typeof parsed === 'object' && parsed !== null && 'pages' in parsed
          ? ((parsed as { pages: Record<string, DifficultyPageRecord> }).pages ?? {})
          : {};

      const wanted = new Set(pdfSha256s);
      const suggestions: DifficultySuggestion[] = [];
      for (const record of Object.values(pages)) {
        if (!wanted.has(record.pdfSha256)) continue;
        suggestions.push(...record.suggestions);
      }

      // One candidate per name, keeping the first occurrence; the others become extra evidence.
      const byName = new Map<string, ConceptCandidate>();
      for (const suggestion of suggestions) {
        if (suggestion.anchor === null) continue;
        const key = normalizeConceptName(suggestion.title);
        const evidence: EvidenceInput = {
          conceptId: '',
          paperId: suggestion.paperId,
          pdfSha256: suggestion.pdfSha256,
          page: suggestion.page,
          quote: suggestion.anchor.quote,
          prefix: suggestion.anchor.prefix,
          suffix: suggestion.anchor.suffix,
          rects: suggestion.anchor.rects,
          source: 'difficulty',
          suggestionId: suggestion.id,
        };
        const existing = byName.get(key);
        if (existing !== undefined) {
          existing.evidence.push(evidence);
          continue;
        }
        byName.set(key, {
          name: suggestion.title,
          summary: suggestion.quick,
          evidence: [evidence],
          possibleDuplicates: state.concepts.filter(
            (concept) => normalizeConceptName(concept.name) === key,
          ),
        });
      }
      return [...byName.values()];
    },
    [state.concepts],
  );

  return useMemo(
    () => ({
      state,
      persisted: snapshot.persisted,
      issue: snapshot.issue,
      createConcept: (input) => {
        const id = makeId();
        dispatch({ type: 'concept/create', input, id, at: now() });
        return id;
      },
      updateConcept: (id, edit) => {
        dispatch({ type: 'concept/update', id, edit, at: now() });
      },
      confirmConcept: (id) => {
        dispatch({ type: 'concept/confirm', id, at: now() });
      },
      deleteConcept: (id) => {
        dispatch({ type: 'concept/delete', id });
      },
      mergeConcept: (sourceId, targetId) => {
        dispatch({ type: 'concept/merge', sourceId, targetId, at: now() });
      },
      linkProject: (conceptId, projectId) => {
        dispatch({ type: 'concept/linkProject', id: conceptId, projectId, at: now() });
      },
      unlinkProject: (conceptId, projectId) => {
        dispatch({ type: 'concept/unlinkProject', id: conceptId, projectId, at: now() });
      },
      addEvidence: (input) => {
        dispatch({ type: 'evidence/add', input, id: makeId(), at: now() });
      },
      removeEvidence: (id) => {
        dispatch({ type: 'evidence/remove', id });
      },
      createRelation: createRelationChecked,
      confirmRelation,
      updateRelationKind: updateRelation,
      deleteRelation: (id) => {
        dispatch({ type: 'relation/delete', id });
      },
      addSuggestions,
      candidatesFromDifficulties,
    }),
    [
      state,
      snapshot.persisted,
      snapshot.issue,
      dispatch,
      makeId,
      now,
      createRelationChecked,
      confirmRelation,
      updateRelation,
      addSuggestions,
      candidatesFromDifficulties,
    ],
  );
}

/** Where the difficulty cache keeps its entries, for callers that need to look before reading. */
export function difficultyCacheExists(): boolean {
  return readItem(DIFFICULTY_STORAGE_KEY, defaultStore()) !== null;
}

export type { Concept, ConceptEvidence };
