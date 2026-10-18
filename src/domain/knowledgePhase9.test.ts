import { describe, expect, it } from 'vitest';
import {
  EMPTY_KNOWLEDGE,
  createConcept,
  createRelation,
  deleteConcept,
  evidenceForRelation,
  mergeConcepts,
  mergeSuggestions,
  parseKnowledgeState,
  rejectRelationSuggestion,
  relationSuggestionFingerprint,
  undoRejection,
  type ConceptEvidence,
  type ConceptRelation,
  type KnowledgeState,
  type RejectionEvidence,
  type SuggestionBatch,
} from './knowledge';

const SHA = 'a'.repeat(64);
const RECT = { x: 0.1, y: 0.2, width: 0.3, height: 0.02 };

let counter = 0;
const nextId = (): string => {
  counter += 1;
  return `id-${String(counter)}`;
};

function base(): KnowledgeState {
  const one = createConcept({ name: 'DLM', projectIds: ['p1'] }, () => 'c1', 1);
  const two = createConcept({ name: 'shared canvas', projectIds: ['p1'] }, () => 'c2', 1);
  if (one === null || two === null) throw new Error('concepts not created');
  return { ...EMPTY_KNOWLEDGE, concepts: [one, two] };
}

const EVIDENCE: RejectionEvidence = {
  paperId: 'paper-1',
  pdfSha256: SHA,
  page: 2,
  quote: 'DLM is defined by denoising a shared canvas',
};

function proposal(
  ids: { relation: string; evidence: string } = { relation: 'proposal-r', evidence: 'proposal-e' },
  overrides: Partial<ConceptRelation> = {},
  evidenceOverrides: Partial<RejectionEvidence> = {},
): SuggestionBatch {
  const relation: ConceptRelation = {
    id: ids.relation,
    from: 'c1',
    to: 'c2',
    kind: 'definition',
    status: 'suggested',
    origin: 'ai',
    note: '',
    support: 'direct',
    rationale: 'DLM is defined by a shared canvas.',
    provider: 'mock',
    providerLabel: '本地模拟',
    model: 'mock-1',
    rulesVersion: 'k2',
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  };
  const evidence: ConceptEvidence = {
    id: ids.evidence,
    conceptId: 'c1',
    paperId: EVIDENCE.paperId,
    pdfSha256: EVIDENCE.pdfSha256,
    page: EVIDENCE.page,
    quote: EVIDENCE.quote,
    prefix: '',
    suffix: '',
    rects: [RECT],
    source: 'ai',
    relationId: ids.relation,
    verification: 'located',
    note: '',
    createdAt: 10,
    ...evidenceOverrides,
  };
  return { concepts: [], relations: [relation], evidence: [evidence] };
}

function merge(state: KnowledgeState, batch: SuggestionBatch): KnowledgeState {
  return mergeSuggestions(state, batch).state;
}

describe('Phase 9: explicit rejection of relation suggestions', () => {
  it('derives the same fingerprint from the same claim, whatever the run ids are', () => {
    const baseInput = {
      from: 'c1',
      to: 'c2',
      kind: 'definition' as const,
      rationale: '  DLM is   defined by a shared canvas. ',
      evidence: [EVIDENCE],
    };
    const first = relationSuggestionFingerprint(baseInput);
    expect(first).toBe(
      relationSuggestionFingerprint({
        ...baseInput,
        rationale: 'DLM IS DEFINED BY A SHARED CANVAS.',
        evidence: [{ ...EVIDENCE, quote: `  ${EVIDENCE.quote.toUpperCase()}  ` }],
      }),
    );
    expect(first).not.toBe(relationSuggestionFingerprint({ ...baseInput, kind: 'approximates' }));
    expect(first).not.toBe(
      relationSuggestionFingerprint({ ...baseInput, rationale: 'Another explanation.' }),
    );
    expect(first).not.toBe(
      relationSuggestionFingerprint({
        ...baseInput,
        evidence: [{ ...EVIDENCE, quote: 'Another quotation' }],
      }),
    );
    expect(first).not.toBe(relationSuggestionFingerprint({ ...baseInput, from: 'c2', to: 'c1' }));
  });

  it('records the claim, removes the suggestion and can be undone', () => {
    let state = merge(base(), proposal());
    const relation = state.relations[0];
    if (relation === undefined) throw new Error('relation not added');
    expect(evidenceForRelation(state, relation.id)).toHaveLength(1);

    const result = rejectRelationSuggestion(state, relation.id, 'rej-1', 20);
    state = result.state;
    expect(result.rejection?.fingerprint).toMatch(/^rel1-/);
    expect(result.rejection?.from).toBe('c1');
    expect(result.rejection?.to).toBe('c2');
    expect(result.rejection?.kind).toBe('definition');
    expect(result.rejection?.evidence).toEqual([EVIDENCE]);
    expect(state.relations).toEqual([]);
    expect(state.evidence).toEqual([]);
    expect(state.concepts).toHaveLength(2);
    expect(state.rejections).toHaveLength(1);

    const undone = undoRejection(state, 'rej-1');
    expect(undone.rejections).toEqual([]);
    expect(undone.concepts).toEqual(state.concepts);
  });

  it('does not accept a confirmed relation as a suggestion to reject', () => {
    let state = base();
    const created = createRelation(
      state,
      { from: 'c1', to: 'c2', kind: 'definition', status: 'confirmed' },
      nextId,
      2,
    );
    state = created.state;
    const relation = state.relations[0];
    if (relation === undefined) throw new Error('relation not created');
    const result = rejectRelationSuggestion(state, relation.id, 'rej-1', 3);
    expect(result.rejection).toBeNull();
    expect(result.reason).toContain('已确认');
    expect(result.state.relations).toHaveLength(1);
    expect(result.state.rejections).toEqual([]);
  });

  it('skips the same claim after re-analysis, with a different run id', () => {
    let state = merge(base(), proposal());
    const relation = state.relations[0];
    if (relation === undefined) throw new Error('relation not added');
    state = rejectRelationSuggestion(state, relation.id, 'rej-1', 20).state;

    const second = mergeSuggestions(state, proposal({ relation: 'run-2-r', evidence: 'run-2-e' }));
    expect(second.state.relations).toEqual([]);
    expect(second.report.addedRelations).toBe(0);
    expect(second.report.skipped.map((entry) => entry.reason).join(' ')).toContain('明确拒绝');
  });

  it('lets a different explanation, evidence set or kind appear as a new claim', () => {
    let state = merge(base(), proposal());
    const relation = state.relations[0];
    if (relation === undefined) throw new Error('relation not added');
    state = rejectRelationSuggestion(state, relation.id, 'rej-1', 20).state;

    const differentExplanation = merge(
      state,
      proposal(
        { relation: 'run-2-r', evidence: 'run-2-e' },
        { rationale: 'A different reason for the same endpoints.' },
      ),
    );
    expect(differentExplanation.relations).toHaveLength(1);
    expect(differentExplanation.rejections).toHaveLength(1);

    const differentEvidence = merge(
      state,
      proposal(
        { relation: 'run-3-r', evidence: 'run-3-e' },
        {},
        { quote: 'A different quotation from the paper' },
      ),
    );
    expect(differentEvidence.relations).toHaveLength(1);

    const differentKind = merge(
      state,
      proposal({ relation: 'run-4-r', evidence: 'run-4-e' }, { kind: 'approximates' }),
    );
    expect(differentKind.relations).toHaveLength(1);
  });

  it('restores the same claim after the reader undoes the rejection', () => {
    let state = merge(base(), proposal());
    const relation = state.relations[0];
    if (relation === undefined) throw new Error('relation not added');
    state = rejectRelationSuggestion(state, relation.id, 'rej-1', 20).state;
    state = undoRejection(state, 'rej-1');
    const afterUndo = mergeSuggestions(state, proposal());
    expect(afterUndo.report.addedRelations).toBe(1);
    expect(afterUndo.state.relations).toHaveLength(1);
  });

  it('drops rejections when their concept is deleted, and remaps them on merge', () => {
    let state = merge(base(), proposal());
    const relation = state.relations[0];
    if (relation === undefined) throw new Error('relation not added');
    state = rejectRelationSuggestion(state, relation.id, 'rej-1', 20).state;

    expect(deleteConcept(state, 'c2').rejections).toEqual([]);

    const third = createConcept({ name: 'canvas', projectIds: ['p1'] }, () => 'c3', 1);
    if (third === null) throw new Error('concept not created');
    state = { ...state, concepts: [...state.concepts, third] };
    const merged = mergeConcepts(state, 'c2', 'c3', 30);
    expect(merged.rejections).toHaveLength(1);
    expect(merged.rejections[0]?.from).toBe('c1');
    expect(merged.rejections[0]?.to).toBe('c3');
    expect(merged.rejections[0]?.fingerprint).toBe(
      relationSuggestionFingerprint({
        from: 'c1',
        to: 'c3',
        kind: 'definition',
        rationale: merged.rejections[0]?.rationale ?? '',
        evidence: merged.rejections[0]?.evidence ?? [],
      }),
    );
  });

  it('migrates a version-1 payload to version 2 with no rejections', () => {
    const state = base();
    const parsed = parseKnowledgeState({
      version: 1,
      concepts: state.concepts,
      evidence: [],
      relations: [],
    });
    expect(parsed?.version).toBe(2);
    expect(parsed?.rejections).toEqual([]);
  });

  it('reads a version-2 rejection only when both concepts resolve', () => {
    const state = merge(base(), proposal());
    const relation = state.relations[0];
    if (relation === undefined) throw new Error('relation not added');
    const rejection = rejectRelationSuggestion(state, relation.id, 'rej-1', 20).rejection;
    if (rejection === null) throw new Error('rejection not created');

    const parsed = parseKnowledgeState({
      version: 2,
      concepts: state.concepts,
      evidence: [],
      relations: [],
      rejections: [rejection],
    });
    expect(parsed?.rejections).toHaveLength(1);
    expect(parsed?.rejections[0]?.fingerprint).toBe(rejection.fingerprint);

    expect(
      parseKnowledgeState({
        version: 2,
        concepts: state.concepts.filter((entry) => entry.id !== 'c2'),
        evidence: [],
        relations: [],
        rejections: [rejection],
      }),
    ).toBeNull();
    expect(
      parseKnowledgeState({
        version: 3,
        concepts: state.concepts,
        evidence: [],
        relations: [],
        rejections: [],
      }),
    ).toBeNull();
  });
});
