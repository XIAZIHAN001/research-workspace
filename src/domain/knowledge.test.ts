import { describe, expect, it } from 'vitest';
import type { NormalizedRect } from './annotation';
import {
  EMPTY_KNOWLEDGE,
  conceptsInProject,
  createConcept,
  createEvidence,
  createRelation,
  deleteRelation,
  dependentsOf,
  detachProjectFromKnowledge,
  evidenceFor,
  isStaleEvidence,
  mergeConcepts,
  papersOf,
  prerequisitesOf,
  relatedOf,
  relationExists,
  suggestionsFor,
  wouldCycle,
  type KnowledgeState,
} from './knowledge';
import { knowledgeReducer } from './knowledgeState';

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
  kind: 'prerequisite' | 'related' | 'extends' = 'prerequisite',
  status: 'confirmed' | 'suggested' = 'confirmed',
): KnowledgeState {
  const result = createRelation(state, { from, to, kind, status }, nextId, 2);
  if (result.relation === null) throw new Error(`relation not created: ${String(result.reason)}`);
  return result.state;
}

function evidence(
  state: KnowledgeState,
  conceptId: string,
  paperId: string,
  sha: string,
): KnowledgeState {
  const created = createEvidence(
    {
      conceptId,
      paperId,
      pdfSha256: sha,
      page: 3,
      quote: 'a commitment scheme hides the polynomial',
      rects: [RECT],
      source: 'annotation',
    },
    nextId,
    3,
  );
  if (created === null) throw new Error('evidence not created');
  return { ...state, evidence: [...state.evidence, created] };
}

describe('concepts', () => {
  it('keeps one identity for an idea used in several papers', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'KZG commitment');
    const id = state.concepts[0]?.id ?? '';
    state = evidence(state, id, 'paper-1', SHA('a'));
    state = evidence(state, id, 'paper-2', SHA('b'));

    expect(state.concepts).toHaveLength(1);
    expect(papersOf(state, id)).toEqual([
      { paperId: 'paper-1', count: 1 },
      { paperId: 'paper-2', count: 1 },
    ]);
  });

  it('never merges two concepts because they share a name', () => {
    // "FFT" the algorithm and "FFT" the French telecom company are the same string and
    // different ideas. Only the reader may decide they are one.
    let state = concept(EMPTY_KNOWLEDGE, 'FFT');
    state = concept(state, 'FFT');
    expect(state.concepts).toHaveLength(2);
    expect(state.concepts[0]?.id).not.toBe(state.concepts[1]?.id);

    const [one, other] = state.concepts;
    state = evidence(state, one?.id ?? '', 'paper-1', SHA('a'));
    state = evidence(state, other?.id ?? '', 'paper-2', SHA('b'));

    const merged = mergeConcepts(state, other?.id ?? '', one?.id ?? '', 10);
    expect(merged.concepts).toHaveLength(1);
    expect(merged.evidence).toHaveLength(2);
    expect(merged.evidence.every((entry) => entry.conceptId === one?.id)).toBe(true);
  });

  it('refuses a concept with no name or no project', () => {
    expect(createConcept({ name: '   ', projectIds: ['p1'] }, nextId, 1)).toBeNull();
    expect(createConcept({ name: 'KZG', projectIds: [] }, nextId, 1)).toBeNull();
  });

  it('lists a project’s concepts alphabetically, and only that project’s', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'Zero knowledge', ['p1']);
    state = concept(state, 'Algebra', ['p1']);
    state = concept(state, 'Other project only', ['p2']);
    expect(conceptsInProject(state, 'p1').map((entry) => entry.name)).toEqual([
      'Algebra',
      'Zero knowledge',
    ]);
  });
});

describe('evidence', () => {
  it('remembers which file, page and words an occurrence came from', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'KZG');
    const conceptId = state.concepts[0]?.id ?? '';
    state = evidence(state, conceptId, 'paper-1', SHA('a'));
    const entry = evidenceFor(state, conceptId)[0];
    expect(entry?.page).toBe(3);
    expect(entry?.pdfSha256).toBe(SHA('a'));
    expect(entry?.quote).toContain('commitment scheme');
  });

  it('marks an occurrence stale when the paper now holds a different file', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'KZG');
    const conceptId = state.concepts[0]?.id ?? '';
    state = evidence(state, conceptId, 'paper-1', SHA('a'));
    const entry = evidenceFor(state, conceptId)[0];
    if (entry === undefined) throw new Error('no evidence');

    expect(isStaleEvidence(entry, SHA('a'))).toBe(false);
    expect(isStaleEvidence(entry, SHA('b'))).toBe(true);
    // No file at all is not "stale": there is nothing to compare, and nothing to jump to.
    expect(isStaleEvidence(entry, null)).toBe(false);
  });

  it('refuses an occurrence without a real quotation or page', () => {
    expect(
      createEvidence(
        {
          conceptId: 'c1',
          paperId: 'p',
          pdfSha256: SHA('a'),
          page: 0,
          quote: 'x',
          rects: [],
          source: 'manual',
        },
        nextId,
        1,
      ),
    ).toBeNull();
  });
});

describe('relations', () => {
  it('reads prerequisite from the dependent to the knowledge it needs', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'KZG');
    state = concept(state, 'Bilinear pairing');
    const [kzg, pairing] = state.concepts;
    state = relation(state, kzg?.id ?? '', pairing?.id ?? '', 'prerequisite');

    expect(prerequisitesOf(state, kzg?.id ?? '').map((entry) => entry.name)).toEqual([
      'Bilinear pairing',
    ]);
    // And the other way round: the pairing is what KZG depends on.
    expect(dependentsOf(state, pairing?.id ?? '').map((entry) => entry.name)).toEqual(['KZG']);
    expect(prerequisitesOf(state, pairing?.id ?? '')).toEqual([]);
  });

  it('treats related as undirected and extends as directed', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'KZG');
    state = concept(state, 'Pedersen commitment');
    const [kzg, pedersen] = state.concepts;
    state = relation(state, kzg?.id ?? '', pedersen?.id ?? '', 'related');
    expect(relatedOf(state, kzg?.id ?? '')).toHaveLength(1);
    expect(relatedOf(state, pedersen?.id ?? '')).toHaveLength(1);

    let extended = concept(EMPTY_KNOWLEDGE, 'A');
    extended = concept(extended, 'B');
    const [a, b] = extended.concepts;
    extended = relation(extended, a?.id ?? '', b?.id ?? '', 'extends');
    const edge = extended.relations[0];
    expect(edge?.from).toBe(a?.id);
    expect(edge?.to).toBe(b?.id);
  });

  it('refuses a duplicate, a self-reference and a cycle', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'A');
    state = concept(state, 'B');
    state = concept(state, 'C');
    const [a, b, c] = state.concepts.map((entry) => entry.id);
    state = relation(state, a ?? '', b ?? '', 'prerequisite');
    state = relation(state, b ?? '', c ?? '', 'prerequisite');

    expect(relationExists(state, a ?? '', b ?? '', 'prerequisite')).toBe(true);
    const duplicate = createRelation(
      state,
      { from: a ?? '', to: b ?? '', kind: 'prerequisite' },
      nextId,
      3,
    );
    expect(duplicate.relation).toBeNull();
    expect(duplicate.reason).toContain('已经存在');

    const self = createRelation(state, { from: a ?? '', to: a ?? '', kind: 'related' }, nextId, 3);
    expect(self.relation).toBeNull();

    // C already depends on A through B; A depending on C would close the loop.
    expect(wouldCycle(state, c ?? '', a ?? '', 'prerequisite')).toBe(true);
    const cycle = createRelation(
      state,
      { from: c ?? '', to: a ?? '', kind: 'prerequisite' },
      nextId,
      3,
    );
    expect(cycle.relation).toBeNull();
    expect(cycle.reason).toContain('循环');
  });

  it('deletes one relation and nothing else', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'A');
    state = concept(state, 'B');
    const [a, b] = state.concepts;
    state = relation(state, a?.id ?? '', b?.id ?? '');
    const id = state.relations[0]?.id ?? '';

    const after = deleteRelation(state, id);
    expect(after.relations).toEqual([]);
    expect(after.concepts).toHaveLength(2);
  });
});

describe('suggestions versus knowledge', () => {
  it('never lets a suggestion be read as a dependency', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'KZG');
    state = concept(state, 'Pairing');
    const [kzg, pairing] = state.concepts;
    state = relation(state, kzg?.id ?? '', pairing?.id ?? '', 'prerequisite', 'suggested');

    expect(prerequisitesOf(state, kzg?.id ?? '')).toEqual([]);
    expect(suggestionsFor(state, kzg?.id ?? '').relations).toHaveLength(1);
  });

  it('stores an AI batch as suggestions whatever the caller claimed', () => {
    const suspicious = {
      id: 'c-ai',
      name: 'Pairing',
      aliases: [],
      summary: '',
      origin: 'user' as const,
      status: 'confirmed' as const,
      projectIds: ['p1'],
      createdAt: 1,
      updatedAt: 1,
    };
    const next = knowledgeReducer(EMPTY_KNOWLEDGE, {
      type: 'suggestions/add',
      concepts: [suspicious],
      relations: [],
      evidence: [],
    });
    expect(next.concepts[0]?.status).toBe('suggested');
    expect(next.concepts[0]?.origin).toBe('ai');
  });

  it('does not overwrite a confirmed relation when the same one is suggested again', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'A');
    state = concept(state, 'B');
    const [a, b] = state.concepts;
    state = relation(state, a?.id ?? '', b?.id ?? '', 'prerequisite');

    const suggested: KnowledgeState = knowledgeReducer(state, {
      type: 'suggestions/add',
      concepts: [],
      relations: [
        {
          id: 'r-ai',
          from: a?.id ?? '',
          to: b?.id ?? '',
          kind: 'prerequisite',
          status: 'confirmed',
          origin: 'user',
          note: '',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      evidence: [],
    });
    // The reducer only rejects duplicate ids; a second edge with a different id is a different
    // statement, and it arrives as a suggestion that the reader can compare and dismiss.
    expect(suggested.relations).toHaveLength(2);
    expect(suggested.relations.find((entry) => entry.id === state.relations[0]?.id)?.status).toBe(
      'confirmed',
    );
    expect(suggested.relations.find((entry) => entry.id === 'r-ai')?.status).toBe('suggested');
  });
});

describe('projects', () => {
  it('keeps a shared concept when one of its projects is removed', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'Shared idea', ['p1', 'p2']);
    const id = state.concepts[0]?.id ?? '';
    state = evidence(state, id, 'paper-1', SHA('a'));

    const after = detachProjectFromKnowledge(state, 'p1', 5);
    expect(after.concepts).toHaveLength(1);
    expect(after.concepts[0]?.projectIds).toEqual(['p2']);
    expect(after.evidence).toHaveLength(1);
  });

  it('keeps a concept whose only project went away, rather than deleting the reader’s work', () => {
    let state = concept(EMPTY_KNOWLEDGE, 'Own idea', ['p1']);
    state = detachProjectFromKnowledge(state, 'p1', 5);
    expect(state.concepts).toHaveLength(1);
    expect(state.concepts[0]?.projectIds).toEqual([]);
  });
});
