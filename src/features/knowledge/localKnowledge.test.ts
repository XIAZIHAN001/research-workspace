import { describe, expect, it } from 'vitest';
import {
  createConcept,
  createEvidence,
  createRelation,
  type KnowledgeState,
} from '../../domain/knowledge';
import { localKnowledgeFor } from './localKnowledge';

const SHA = 'a'.repeat(64);
let counter = 0;
const nextId = (): string => {
  counter += 1;
  return `l-${String(counter)}`;
};

function base(): KnowledgeState {
  let state: KnowledgeState = { version: 1, concepts: [], evidence: [], relations: [] };
  const add = (name: string, summary = ''): string => {
    const concept = createConcept({ name, summary, projectIds: ['p1'] }, nextId, 1);
    if (concept === null) throw new Error('no concept');
    state = { ...state, concepts: [...state.concepts, concept] };
    return concept.id;
  };
  const relate = (from: string, to: string): void => {
    const result = createRelation(state, { from, to, kind: 'prerequisite' }, nextId, 2);
    if (result.relation === null) throw new Error('no relation');
    state = result.state;
  };
  const kzg = add('KZG commitment');
  const pairing = add('Bilinear pairing');
  const ec = add('Elliptic curve groups');
  relate(kzg, pairing);
  relate(pairing, ec);
  const evidence = createEvidence(
    {
      conceptId: kzg,
      paperId: 'paper-1',
      pdfSha256: SHA,
      page: 3,
      quote: 'A KZG commitment relies on a bilinear pairing',
      rects: [],
      source: 'manual',
    },
    nextId,
    3,
  );
  if (evidence !== null) state = { ...state, evidence: [evidence] };
  return state;
}

describe('local knowledge for a passage', () => {
  it('finds a concept by name in the selection and shows its prerequisites', () => {
    const state = base();
    const local = localKnowledgeFor(state, {
      projectId: 'p1',
      paperId: 'paper-1',
      currentPage: 3,
      selection: 'A KZG commitment relies on a bilinear pairing',
      pageText: 'A KZG commitment relies on a bilinear pairing',
    });
    expect(local.matches[0]?.concept.name).toBe('KZG commitment');
    expect(local.matches[0]?.matchedBy).toBe('selection');
    expect(local.matches[0]?.prerequisites.map((concept) => concept.name)).toContain(
      'Bilinear pairing',
    );
  });

  it('finds a concept through recorded evidence even when its name is not on the page', () => {
    const state = base();
    const local = localKnowledgeFor(state, {
      projectId: 'p1',
      paperId: 'paper-1',
      currentPage: 3,
      selection: 'something else entirely',
      pageText: 'something else entirely',
    });
    expect(local.matches.some((match) => match.concept.name === 'KZG commitment')).toBe(true);
    expect(local.matches[0]?.pageEvidence).toHaveLength(1);
  });

  it('does not match a concept from another paper or another project', () => {
    const state = base();
    const local = localKnowledgeFor(state, {
      projectId: 'p2',
      paperId: 'paper-2',
      currentPage: 1,
      selection: 'KZG commitment',
      pageText: 'KZG commitment',
    });
    expect(local.matches).toHaveLength(0);
    expect(local.conceptsInScope).toBe(0);
  });

  it('lists pending suggestions that involve a matched concept', () => {
    let state = base();
    const kzg = state.concepts[0];
    if (kzg === undefined) throw new Error('missing');
    const suggested = createConcept({ name: 'Trusted setup', projectIds: ['p1'] }, nextId, 4);
    if (suggested === null) throw new Error('missing');
    state = {
      ...state,
      concepts: [...state.concepts, { ...suggested, origin: 'ai', status: 'suggested' }],
      relations: [
        ...state.relations,
        {
          id: 'r-suggested',
          from: kzg.id,
          to: suggested.id,
          kind: 'prerequisite',
          status: 'suggested',
          origin: 'ai',
          note: '',
          support: 'inferred',
          rationale: 'the model thinks so',
          createdAt: 4,
          updatedAt: 4,
        },
      ],
    };
    const local = localKnowledgeFor(state, {
      projectId: 'p1',
      paperId: 'paper-1',
      currentPage: 3,
      selection: 'KZG commitment',
      pageText: 'KZG commitment',
    });
    const match = local.matches.find((entry) => entry.concept.id === kzg.id);
    expect(match?.pendingRelations).toHaveLength(1);
    expect(match?.pendingConcepts.map((concept) => concept.name)).toEqual(['Trusted setup']);
  });
});
