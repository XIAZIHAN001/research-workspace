import { describe, expect, it } from 'vitest';
import type { NormalizedRect } from './annotation';
import {
  EMPTY_KNOWLEDGE,
  conceptIdForName,
  conceptMatchesForName,
  confirmRelationChecked,
  createConcept,
  createEvidence,
  createRelation,
  deleteConcept,
  deleteRelation,
  evidenceForRelation,
  learningPath,
  mergeSuggestions,
  parseKnowledgeState,
  relationDirectionText,
  relationSemanticHint,
  updateRelationKind,
  type Concept,
  type ConceptRelation,
  type KnowledgeState,
} from './knowledge';

let counter = 0;
const nextId = (): string => {
  counter += 1;
  return `id-${String(counter)}`;
};

const RECT: NormalizedRect = { x: 0.1, y: 0.2, width: 0.3, height: 0.02 };
const SHA = (letter: string): string => letter.repeat(64);

function concept(state: KnowledgeState, name: string, projects = ['p1']): KnowledgeState {
  const created = createConcept({ name, projectIds: projects }, nextId, 1);
  if (created === null) throw new Error('concept not created');
  return { ...state, concepts: [...state.concepts, created] };
}

function relation(
  state: KnowledgeState,
  from: string,
  to: string,
  kind: ConceptRelation['kind'] = 'prerequisite',
): KnowledgeState {
  const result = createRelation(state, { from, to, kind }, nextId, 2);
  if (result.relation === null) throw new Error(`relation not created: ${String(result.reason)}`);
  return result.state;
}

const proposal = (id: string, name: string, overrides: Partial<Concept> = {}): Concept => ({
  id,
  name,
  aliases: [],
  summary: 'a proposed idea',
  origin: 'user',
  status: 'confirmed',
  projectIds: ['p1'],
  createdAt: 10,
  updatedAt: 10,
  ...overrides,
});

const suggestedRelation = (
  id: string,
  from: string,
  to: string,
  kind: ConceptRelation['kind'] = 'prerequisite',
  support: ConceptRelation['support'] = 'direct',
): ConceptRelation => ({
  id,
  from,
  to,
  kind,
  status: 'confirmed',
  origin: 'user',
  note: '',
  support,
  rationale: 'because the paper says so',
  provider: 'mock',
  providerLabel: '本地模拟',
  model: 'mock-1',
  rulesVersion: 'k1',
  createdAt: 10,
  updatedAt: 10,
});

describe('Phase 8: evidence-backed suggestions', () => {
  it('adds a batch as suggestions and keeps the evidence that grounds it', () => {
    const base = concept(EMPTY_KNOWLEDGE, 'KZG commitment');
    const kzg = base.concepts[0];
    if (kzg === undefined) throw new Error('missing concept');

    const occurrence = createEvidence(
      {
        conceptId: kzg.id,
        paperId: 'paper-1',
        pdfSha256: SHA('a'),
        page: 3,
        quote: 'a KZG commitment relies on a bilinear pairing',
        rects: [RECT],
        source: 'manual',
        relationId: 'r-1',
        verification: 'verbatim',
      },
      () => 'e-1',
      11,
    );
    if (occurrence === null) throw new Error('missing evidence');

    const result = mergeSuggestions(base, {
      concepts: [proposal('c-pairing', 'Bilinear pairing')],
      relations: [suggestedRelation('r-1', kzg.id, 'c-pairing')],
      evidence: [occurrence],
    });

    expect(result.report.addedConcepts).toBe(1);
    expect(result.report.addedRelations).toBe(1);
    expect(result.report.addedEvidence).toBe(1);
    expect(result.state.concepts.find((entry) => entry.id === 'c-pairing')?.status).toBe(
      'suggested',
    );
    expect(result.state.concepts.find((entry) => entry.id === 'c-pairing')?.origin).toBe('ai');
    const storedRelation = result.state.relations.find((entry) => entry.id === 'r-1');
    expect(storedRelation?.status).toBe('suggested');
    expect(storedRelation?.origin).toBe('ai');
    expect(storedRelation?.support).toBe('direct');
    expect(storedRelation?.evidenceIds).toEqual(['e-1']);
    const storedEvidence = result.state.evidence.find((entry) => entry.id === 'e-1');
    expect(storedEvidence?.source).toBe('ai');
    expect(storedEvidence?.relationId).toBe('r-1');
    expect(storedEvidence?.verification).toBe('verbatim');
    expect(evidenceForRelation(result.state, 'r-1')).toHaveLength(1);
  });

  it('recognises a duplicate concept name and never overwrites the existing one', () => {
    let base = concept(EMPTY_KNOWLEDGE, 'Bilinear Pairing');
    const existing = base.concepts[0];
    if (existing === undefined) throw new Error('missing concept');
    base = {
      ...base,
      concepts: [{ ...existing, summary: 'the reader’s own words', status: 'confirmed' }],
    };

    const result = mergeSuggestions(base, {
      concepts: [proposal('c-new', '  bilinear   pairing ', { summary: 'the model’s words' })],
      relations: [suggestedRelation('r-1', 'c-new', 'c-new-2')],
      evidence: [],
    });

    expect(result.report.addedConcepts).toBe(0);
    expect(result.report.reusedConcepts).toBe(1);
    expect(result.state.concepts).toHaveLength(1);
    expect(result.state.concepts[0]?.summary).toBe('the reader’s own words');
    expect(conceptIdForName(result.state, 'BILINEAR PAIRING')).toBe(existing.id);
    expect(result.report.addedRelations).toBe(0);
  });

  it('does not add a duplicate or a looping prerequisite, and says why', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'A');
    state = concept(state, 'B');
    state = concept(state, 'C');
    const [a, b, c] = state.concepts;
    if (a === undefined || b === undefined || c === undefined) throw new Error('missing');
    state = relation(state, a.id, b.id, 'prerequisite');
    state = relation(state, b.id, c.id, 'prerequisite');

    const result = mergeSuggestions(state, {
      concepts: [],
      relations: [
        suggestedRelation('r-dup', a.id, b.id, 'prerequisite'),
        suggestedRelation('r-loop', c.id, a.id, 'prerequisite'),
      ],
      evidence: [],
    });

    expect(result.report.addedRelations).toBe(0);
    expect(result.report.skipped.map((entry) => entry.reason)).toEqual([
      '这条关系已经存在。',
      '这会形成一个循环前置依赖。',
    ]);
    expect(result.state).toBe(state);
  });

  it('refuses to confirm a suggestion that would close a loop later', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'A');
    state = concept(state, 'B');
    const [a, b] = state.concepts;
    if (a === undefined || b === undefined) throw new Error('missing');
    // A legacy/restored graph can already contain two suggested edges that loop. Confirmation
    // is where the check has to happen again.
    state = {
      ...state,
      relations: [
        { ...suggestedRelation('r-a-b', a.id, b.id), status: 'suggested' },
        { ...suggestedRelation('r-b-a', b.id, a.id), status: 'suggested' },
      ],
    };

    const decision = confirmRelationChecked(state, 'r-a-b', 20);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain('循环');
    expect(decision.state.relations.find((entry) => entry.id === 'r-a-b')?.status).toBe(
      'suggested',
    );
  });

  it('refuses a manual kind change that would loop, and treats the same kind as a no-op', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'A');
    state = concept(state, 'B');
    state = concept(state, 'C');
    const [a, b, c] = state.concepts;
    if (a === undefined || b === undefined || c === undefined) throw new Error('missing');
    state = relation(state, a.id, b.id, 'prerequisite');
    state = relation(state, b.id, c.id, 'prerequisite');
    state = relation(state, c.id, a.id, 'related');

    const relatedId = state.relations.find((entry) => entry.kind === 'related')?.id ?? '';
    const loop = updateRelationKind(state, relatedId, 'prerequisite', 30);
    expect(loop.ok).toBe(false);
    expect(loop.reason).toContain('循环');

    const noOp = updateRelationKind(state, relatedId, 'related', 30);
    expect(noOp.ok).toBe(true);
  });

  it('builds a learning path from confirmed prerequisites only, foundations first', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'KZG commitment');
    state = concept(state, 'Bilinear pairing');
    state = concept(state, 'Elliptic curve groups');
    const [kzg, pairing, ec] = state.concepts;
    if (kzg === undefined || pairing === undefined || ec === undefined) throw new Error('missing');
    state = relation(state, kzg.id, pairing.id, 'prerequisite');
    state = relation(state, pairing.id, ec.id, 'prerequisite');
    // A direct edge does not replace the longer route; the path still reaches the foundation.
    state = relation(state, kzg.id, ec.id, 'prerequisite');
    // A suggestion is not part of the teaching order.
    state = {
      ...state,
      concepts: [...state.concepts, proposal('c-suggested', 'Suggested idea')],
      relations: [
        ...state.relations,
        { ...suggestedRelation('r-suggested', kzg.id, 'c-suggested'), status: 'suggested' },
      ],
    };

    expect(learningPath(state, kzg.id).map((entry) => entry.name)).toEqual([
      'Elliptic curve groups',
      'Bilinear pairing',
      'KZG commitment',
    ]);
  });

  it('removes relation evidence with its relation, and only that evidence', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'A');
    state = concept(state, 'B');
    const [a, b] = state.concepts;
    if (a === undefined || b === undefined) throw new Error('missing');
    state = relation(state, a.id, b.id, 'prerequisite');
    const relationId = state.relations[0]?.id ?? '';
    const conceptEvidence = createEvidence(
      {
        conceptId: a.id,
        paperId: 'paper-1',
        pdfSha256: SHA('a'),
        page: 1,
        quote: 'A appears here',
        rects: [RECT],
        source: 'annotation',
      },
      () => 'e-concept',
      1,
    );
    const relationEvidence = createEvidence(
      {
        conceptId: a.id,
        paperId: 'paper-1',
        pdfSha256: SHA('a'),
        page: 2,
        quote: 'A needs B',
        rects: [RECT],
        source: 'ai',
        relationId,
      },
      () => 'e-relation',
      1,
    );
    if (conceptEvidence === null || relationEvidence === null) throw new Error('missing');
    state = { ...state, evidence: [conceptEvidence, relationEvidence] };

    const after = deleteRelation(state, relationId);
    expect(after.relations).toHaveLength(0);
    expect(after.evidence.map((entry) => entry.id)).toEqual(['e-concept']);
  });

  it('removes a relation’s evidence even when the deleted concept is its target', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'A');
    state = concept(state, 'B');
    const [a, b] = state.concepts;
    if (a === undefined || b === undefined) throw new Error('missing');
    state = relation(state, a.id, b.id, 'prerequisite');
    const relationId = state.relations[0]?.id ?? '';
    const occurrence = createEvidence(
      {
        conceptId: a.id,
        paperId: 'paper-1',
        pdfSha256: SHA('a'),
        page: 2,
        quote: 'A needs B',
        rects: [RECT],
        source: 'ai',
        relationId,
      },
      () => 'e-1',
      1,
    );
    if (occurrence === null) throw new Error('missing');
    state = { ...state, evidence: [occurrence] };

    const after = deleteConcept(state, b.id);
    expect(after.relations).toHaveLength(0);
    expect(after.evidence).toHaveLength(0);
  });

  it('reads a Phase 7 payload unchanged and rejects dangling Phase 8 links', () => {
    const conceptRecord = {
      id: 'c1',
      name: 'Language model',
      aliases: [],
      summary: '',
      origin: 'user',
      status: 'confirmed',
      projectIds: ['p1'],
      createdAt: 1,
      updatedAt: 1,
    };
    const evidenceRecord = {
      id: 'e1',
      conceptId: 'c1',
      paperId: 'paper-1',
      pdfSha256: SHA('a'),
      page: 1,
      quote: 'a language model',
      prefix: '',
      suffix: '',
      rects: [],
      source: 'manual',
      note: '',
      createdAt: 1,
    };

    const validLegacy = {
      version: 1,
      concepts: [conceptRecord],
      evidence: [evidenceRecord],
      relations: [],
    };
    expect(parseKnowledgeState(validLegacy)?.concepts).toHaveLength(1);
    expect(parseKnowledgeState(validLegacy)?.evidence).toHaveLength(1);

    const danglingRelation = {
      version: 1,
      concepts: [conceptRecord],
      evidence: [{ ...evidenceRecord, relationId: 'r-missing' }],
      relations: [],
    };
    expect(parseKnowledgeState(danglingRelation)).toBeNull();

    const danglingEvidenceList = {
      version: 1,
      concepts: [conceptRecord, { ...conceptRecord, id: 'c2', name: 'Other' }],
      evidence: [evidenceRecord],
      relations: [
        {
          id: 'r1',
          from: 'c1',
          to: 'c2',
          kind: 'prerequisite',
          status: 'suggested',
          origin: 'ai',
          note: '',
          evidenceIds: ['e-missing'],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };
    expect(parseKnowledgeState(danglingEvidenceList)).toBeNull();
  });

  it('keeps optional Phase 8 fields when a valid payload is read strictly', () => {
    const payload = {
      version: 1,
      concepts: [
        {
          id: 'c1',
          name: 'KZG commitment',
          aliases: ['KZG'],
          summary: '',
          origin: 'ai',
          status: 'suggested',
          projectIds: ['p1'],
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'c2',
          name: 'Bilinear pairing',
          aliases: [],
          summary: '',
          origin: 'ai',
          status: 'suggested',
          projectIds: ['p1'],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      evidence: [
        {
          id: 'e1',
          conceptId: 'c1',
          paperId: 'paper-1',
          pdfSha256: SHA('a'),
          page: 1,
          quote: 'a KZG commitment',
          prefix: '',
          suffix: '',
          rects: [],
          source: 'ai',
          relationId: 'r1',
          verification: 'located',
          note: '',
          createdAt: 1,
        },
      ],
      relations: [
        {
          id: 'r1',
          from: 'c1',
          to: 'c2',
          kind: 'prerequisite',
          status: 'suggested',
          origin: 'ai',
          note: '',
          support: 'inferred',
          rationale: 'why',
          provider: 'mock',
          providerLabel: '本地模拟',
          model: 'mock-1',
          rulesVersion: 'k1',
          evidenceIds: ['e1'],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };
    const parsed = parseKnowledgeState(payload);
    expect(parsed?.relations[0]?.support).toBe('inferred');
    expect(parsed?.evidence[0]?.verification).toBe('located');
  });
});

describe('Phase 8.2: relation semantics and identity safety', () => {
  it('fills direction placeholders without rewriting names that contain A or B', () => {
    expect(relationDirectionText('definition', 'Bilinear pairing', 'KZG commitment')).toBe(
      'Bilinear pairing 的定义依赖 KZG commitment',
    );
    expect(relationDirectionText('prerequisite', 'Model B', 'Model A')).toBe(
      '要理解 Model B，需要先理解 Model A',
    );
  });

  it('flags a definition rationale written as a learning prerequisite (DLM → shared canvas)', () => {
    const hint = relationSemanticHint({
      kind: 'prerequisite',
      rationale:
        'DLM is defined as a model that generates by iteratively denoising a shared canvas.',
      note: '',
    });
    expect(hint?.suggestedKind).toBe('definition');
    expect(hint?.message).toContain('定义依赖');
  });

  it('flags a replacement rationale written as an extension (complementary → primary)', () => {
    const hint = relationSemanticHint({
      kind: 'extends',
      rationale:
        'Complementary representations replace the single primary representation rather than extend it.',
      note: '',
    });
    expect(hint?.suggestedKind).toBe('replaces');
  });

  it('flags an approximation rationale written as an extension (resampling → Q_β)', () => {
    const hint = relationSemanticHint({
      kind: 'extends',
      rationale:
        'Importance resampling approximates Q_β when the normalising constant is intractable.',
      note: '',
    });
    expect(hint?.suggestedKind).toBe('approximates');
  });

  it('flags a prerequisite justified only by co-occurrence', () => {
    const hint = relationSemanticHint({
      kind: 'prerequisite',
      rationale: 'Both concepts appear in the same paragraph, so they co-occur.',
      note: '',
    });
    expect(hint?.suggestedKind).toBe('related');
    expect(hint?.message).toContain('同一段出现不足以构成前置');
  });

  it('does not hint when the rationale states a genuine learning order or extension', () => {
    expect(
      relationSemanticHint({
        kind: 'prerequisite',
        rationale:
          'A reader needs to understand the shared canvas before understanding how DLM denoises it.',
        note: '',
      }),
    ).toBeNull();
    expect(
      relationSemanticHint({
        kind: 'extends',
        rationale: 'The new layer adds a capability the base model did not have.',
        note: '',
      }),
    ).toBeNull();
  });

  it('keeps a confirmed relation’s kind untouched until a person changes it', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'DLM');
    state = concept(state, 'Shared canvas');
    const [dlm, canvas] = state.concepts;
    if (dlm === undefined || canvas === undefined) throw new Error('missing concepts');
    state = {
      ...state,
      relations: [
        {
          ...suggestedRelation('r-def', dlm.id, canvas.id, 'prerequisite'),
          rationale: 'DLM is defined as denoising a shared canvas.',
        },
      ],
    };

    // The check is advisory only: computing it cannot reclassify anything.
    expect(relationSemanticHint(state.relations[0]!)?.suggestedKind).toBe('definition');
    expect(state.relations[0]?.kind).toBe('prerequisite');

    // The explicit action is the only path that changes the stored kind.
    const changed = updateRelationKind(state, 'r-def', 'definition', 30);
    expect(changed.ok).toBe(true);
    expect(changed.state.relations[0]?.kind).toBe('definition');
    expect(changed.state.relations[0]?.status).toBe('confirmed');
  });

  it('treats the same name on two concepts as ambiguous, not as one identity', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'Shared canvas');
    state = concept(state, 'Shared canvas');
    const [one, two] = state.concepts;
    if (one === undefined || two === undefined) throw new Error('missing concepts');

    expect(conceptMatchesForName(state, '  shared   CANVAS ').map((entry) => entry.id)).toEqual([
      one.id,
      two.id,
    ]);
    expect(conceptIdForName(state, 'shared canvas')).toBeNull();
  });

  it('treats a shared alias as ambiguous across two differently named concepts', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'DLM');
    state = concept(state, 'Diffusion language model');
    const [short, long] = state.concepts;
    if (short === undefined || long === undefined) throw new Error('missing concepts');
    state = {
      ...state,
      concepts: state.concepts.map((entry) => ({ ...entry, aliases: ['DLM'] })),
    };

    expect(conceptMatchesForName(state, 'dlm').map((entry) => entry.id)).toEqual([
      short.id,
      long.id,
    ]);
    expect(conceptIdForName(state, 'DLM')).toBeNull();
  });

  it('skips a concept and its relation when a name matches several existing concepts', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'Representation');
    state = concept(state, 'Complementary representations');
    const [first, second] = state.concepts;
    if (first === undefined || second === undefined) throw new Error('missing concepts');
    state = {
      ...state,
      concepts: state.concepts.map((entry) => ({ ...entry, aliases: ['rep'] })),
    };

    const result = mergeSuggestions(state, {
      concepts: [proposal('c-new', 'REP', { aliases: [] })],
      relations: [suggestedRelation('r-new', 'c-new', second.id, 'related')],
      evidence: [],
    });

    expect(result.report.addedConcepts).toBe(0);
    expect(result.report.reusedConcepts).toBe(0);
    expect(result.report.addedRelations).toBe(0);
    expect(result.report.skipped[0]?.reason).toContain('仅凭同名合并');
    expect(result.report.skipped.some((entry) => entry.kind === 'relation')).toBe(true);
    expect(result.state.concepts).toHaveLength(2);
    expect(result.state.relations).toHaveLength(0);
  });

  it('still reuses a concept through a unique alias without adding a duplicate', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'Diffusion language model');
    const existing = state.concepts[0];
    if (existing === undefined) throw new Error('missing concept');
    state = {
      ...state,
      concepts: [{ ...existing, aliases: ['DLM'] }],
    };

    const result = mergeSuggestions(state, {
      concepts: [proposal('c-new', 'dlm', { aliases: [] })],
      relations: [],
      evidence: [],
    });

    expect(result.report.addedConcepts).toBe(0);
    expect(result.report.reusedConcepts).toBe(1);
    expect(result.state.concepts).toHaveLength(1);
    expect(result.state.concepts[0]?.summary).toBe(existing.summary);
  });
});
