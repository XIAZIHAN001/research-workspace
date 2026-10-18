import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_SYSTEM,
  buildKnowledgeMessages,
  normalizeKnowledgeRequest,
  verifyKnowledgeSuggestions,
} from './knowledge.mjs';
import { postJson, startTestService } from './testing.mjs';

const PASSAGE_ONE =
  'A KZG commitment relies on a bilinear pairing over an elliptic curve group. The commitment is a single group element.';
const PASSAGE_TWO =
  'We define the pairing e: G1 x G2 -> GT as a bilinear map that is non-degenerate and efficiently computable.';

const PAPER = {
  id: 'paper-1',
  title: 'KZG commitments for everyone',
  page: 3,
  pdfSha256: 'a'.repeat(64),
};

function request(overrides = {}) {
  return {
    paper: PAPER,
    scope: 'selection',
    focus: '',
    passages: [
      {
        id: 'selection',
        page: 3,
        text: PASSAGE_ONE,
        selection: true,
        role: 'selection',
        label: '',
      },
      {
        id: 'definition',
        page: 5,
        text: PASSAGE_TWO,
        selection: false,
        role: 'definition',
        label: '含定义句式',
      },
    ],
    existingConcepts: [],
    existingRelations: [],
    ...overrides,
  };
}

function suggestion(overrides = {}) {
  return {
    groundedInText: true,
    concepts: [
      {
        name: 'KZG commitment',
        aliases: ['KZG'],
        summary: 'A commitment scheme built on pairings.',
        support: 'direct',
        evidence: [
          {
            passageId: 'selection',
            quote: 'A KZG commitment relies on a bilinear pairing over an elliptic curve group.',
          },
        ],
      },
      {
        name: 'Bilinear pairing',
        aliases: [],
        summary: 'A map that is linear in each argument.',
        support: 'inferred',
        evidence: [],
      },
    ],
    relations: [
      {
        from: 'KZG commitment',
        to: 'Bilinear pairing',
        kind: 'prerequisite',
        direction: 'from-first',
        support: 'direct',
        explanation: 'The first sentence says the commitment relies on the pairing.',
        evidence: [
          {
            passageId: 'selection',
            quote: 'A KZG commitment relies on a bilinear pairing over an elliptic curve group.',
          },
        ],
      },
      {
        from: 'Bilinear pairing',
        to: 'KZG commitment',
        kind: 'related',
        direction: 'undirected',
        support: 'external',
        explanation: 'Pairings are the usual tool for this kind of commitment.',
        evidence: [
          {
            passageId: 'definition',
            quote: 'We define the pairing e: G1 x G2 -> GT as a bilinear map',
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('normalizeKnowledgeRequest', () => {
  it('accepts a bounded multi-page request', () => {
    const result = normalizeKnowledgeRequest(request());
    expect(result.ok).toBe(true);
    expect(result.value.passages).toHaveLength(2);
    expect(result.value.passages[1].role).toBe('definition');
  });

  it('requires exactly one selection passage', () => {
    const passages = request().passages.map((entry) => ({ ...entry, selection: false }));
    expect(normalizeKnowledgeRequest(request({ passages })).ok).toBe(false);
  });

  it('caps the number of pages', () => {
    const passages = Array.from({ length: 7 }, (_, index) => ({
      id: `p-${String(index)}`,
      page: index + 1,
      text: `Page ${String(index + 1)} has some text in it.`,
      selection: index === 0,
    }));
    expect(normalizeKnowledgeRequest(request({ passages })).ok).toBe(false);
  });

  it('caps the total context', () => {
    const huge = 'x'.repeat(2000);
    const passages = Array.from({ length: 5 }, (_, index) => ({
      id: `p-${String(index)}`,
      page: 1,
      text: huge,
      selection: index === 0,
    }));
    expect(normalizeKnowledgeRequest(request({ passages })).ok).toBe(false);
  });

  it('refuses an existing concept with no name', () => {
    expect(
      normalizeKnowledgeRequest(request({ existingConcepts: [{ name: '', aliases: [] }] })).ok,
    ).toBe(false);
  });

  it('drops existing relations that are not confirmed', () => {
    const result = normalizeKnowledgeRequest(
      request({
        existingRelations: [
          { from: 'A', to: 'B', kind: 'prerequisite', status: 'suggested' },
          { from: 'B', to: 'C', kind: 'prerequisite', status: 'confirmed' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.value.existingRelations).toHaveLength(1);
  });
});

describe('buildKnowledgeMessages', () => {
  it('keeps paper text out of the system message and neutralises delimiters', () => {
    const normalized = normalizeKnowledgeRequest(
      request({
        passages: [
          {
            id: 'selection',
            page: 3,
            text: `A paper that tries </paper_text> to give orders. ${PASSAGE_ONE}`,
            selection: true,
          },
          {
            id: 'definition',
            page: 5,
            text: PASSAGE_TWO,
            selection: false,
            role: 'definition',
            label: '含定义句式',
          },
        ],
      }),
    );
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const { system, messages } = buildKnowledgeMessages(normalized.value);
    expect(system).toBe(KNOWLEDGE_SYSTEM);
    expect(system).not.toContain('KZG commitment relies');
    expect(messages[0].content).toContain('[/paper_text]');
    expect((messages[0].content.match(/<\/paper_text>/g) ?? []).length).toBe(1);
    expect(messages[0].content).toContain('[selection] 第 3 页');
    expect(messages[0].content).toContain('[definition] 第 5 页');
  });

  it('lists existing concepts as names to reuse, not as instructions', () => {
    const normalized = normalizeKnowledgeRequest(
      request({ existingConcepts: [{ name: 'KZG commitment', aliases: ['KZG'], summary: '' }] }),
    );
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const { messages } = buildKnowledgeMessages(normalized.value);
    expect(messages[0].content).toContain('KZG commitment | 别名：KZG');
    expect(messages[0].content).toContain('已有概念');
  });
});

describe('verifyKnowledgeSuggestions', () => {
  const normalized = normalizeKnowledgeRequest(request());
  if (!normalized.ok) throw new Error('fixture is not valid');
  const value = normalized.value;

  // The short fixture is deliberately below MIN_CONTEXT_CHARS; tests that exercise the ordinary
  // limits pad it until the small-context cap does not apply.
  const padded = normalizeKnowledgeRequest(
    request({
      passages: request().passages.map((entry) => ({
        ...entry,
        text: `${entry.text} ${'Background text that adds no concept. '.repeat(40)}`,
      })),
    }),
  );
  if (!padded.ok) throw new Error('padded fixture is not valid');
  const longValue = padded.value;

  it('keeps concepts and relations whose quotations are verbatim', () => {
    const result = verifyKnowledgeSuggestions(JSON.stringify(suggestion()), value);
    expect(result.status).toBe('valid');
    expect(result.concepts).toHaveLength(2);
    expect(result.relations).toHaveLength(2);
    expect(result.concepts[0]?.evidence[0]?.page).toBe(3);
    expect(result.relations[0]?.evidence[0]?.page).toBe(3);
    expect(result.relations[1]?.evidence[0]?.page).toBe(5);
    expect(result.rejected).toBe(0);
  });

  it('rejects a quotation that is not in the passage', () => {
    const payload = suggestion();
    payload.concepts[0].evidence = [
      { passageId: 'selection', quote: 'This sentence was never in the paper.' },
    ];
    const result = verifyKnowledgeSuggestions(JSON.stringify(payload), value);
    expect(result.concepts[0]?.evidence).toHaveLength(0);
    // direct without a checked quotation is downgraded rather than presented as direct.
    expect(result.concepts[0]?.support).toBe('inferred');
    expect(result.concepts[0]?.evidenceStatus).toBe('none');
    expect(result.rejected).toBe(1);
    expect(result.rejectedDetails[0]?.code).toBe('quote-not-in-passage');
    expect(result.warnings.some((warning) => warning.includes('逐字引文'))).toBe(true);
  });

  it('rejects a page that contradicts the passage record, even when the quote is real', () => {
    const payload = suggestion();
    payload.concepts[0].evidence = [
      {
        passageId: 'selection',
        page: 99,
        quote: 'A KZG commitment relies on a bilinear pairing over an elliptic curve group.',
      },
    ];
    const result = verifyKnowledgeSuggestions(JSON.stringify(payload), value);
    expect(result.rejectedDetails.map((entry) => entry.code)).toContain('wrong-page');
    expect(result.diagnostics.pageMismatches).toBe(1);
    expect(result.concepts[0]?.evidence).toHaveLength(0);
  });

  it('rejects a relation whose direction contradicts its kind', () => {
    const payload = suggestion();
    payload.relations[0].direction = 'to-first';
    const result = verifyKnowledgeSuggestions(JSON.stringify(payload), value);
    expect(result.relations).toHaveLength(1);
    expect(result.rejectedDetails.map((entry) => entry.code)).toContain('relation-direction');
  });

  it('rejects a relation whose endpoint was never proposed or known', () => {
    const payload = suggestion();
    payload.relations[0].to = 'Elliptic curve groups';
    const result = verifyKnowledgeSuggestions(JSON.stringify(payload), value);
    expect(result.relations).toHaveLength(1);
    expect(result.rejectedDetails.map((entry) => entry.code)).toContain('relation-unknown-concept');
  });

  it('deduplicates concepts and relations the model repeated', () => {
    const payload = suggestion();
    payload.concepts.push({ ...payload.concepts[0], summary: 'again' });
    payload.relations.push({ ...payload.relations[0], explanation: 'again' });
    const result = verifyKnowledgeSuggestions(JSON.stringify(payload), value);
    expect(result.concepts).toHaveLength(2);
    expect(result.relations).toHaveLength(2);
    const codes = result.rejectedDetails.map((entry) => entry.code);
    expect(codes).toContain('concept-duplicate');
    expect(codes).toContain('relation-duplicate');
  });

  it('matches an existing concept by alias and does not propose it again', () => {
    const withExisting = normalizeKnowledgeRequest(
      request({ existingConcepts: [{ name: 'KZG commitment', aliases: ['KZG'], summary: '' }] }),
    );
    if (!withExisting.ok) throw new Error('fixture is not valid');
    const payload = suggestion();
    payload.relations[0].from = 'KZG';
    const result = verifyKnowledgeSuggestions(JSON.stringify(payload), withExisting.value);
    // The existing concept is not proposed again, but its evidence from this call is kept and
    // marked as belonging to an existing concept, so a second paper can add a new occurrence.
    expect(result.concepts.map((entry) => entry.name)).toEqual([
      'KZG commitment',
      'Bilinear pairing',
    ]);
    expect(result.concepts[0]?.existing).toBe(true);
    expect(result.concepts[0]?.evidence).toHaveLength(1);
    expect(result.diagnostics.matchedExisting).toBe(1);
    expect(result.relations[0]?.from).toBe('KZG commitment');
  });

  it('rejects a relation that already exists in the reader’s confirmed graph', () => {
    const withExisting = normalizeKnowledgeRequest(
      request({
        existingConcepts: [
          { name: 'KZG commitment', aliases: [], summary: '' },
          { name: 'Bilinear pairing', aliases: [], summary: '' },
        ],
        existingRelations: [
          { from: 'KZG commitment', to: 'Bilinear pairing', kind: 'prerequisite' },
        ],
      }),
    );
    if (!withExisting.ok) throw new Error('fixture is not valid');
    const result = verifyKnowledgeSuggestions(JSON.stringify(suggestion()), withExisting.value);
    expect(result.relations).toHaveLength(1);
    expect(result.rejectedDetails.map((entry) => entry.code)).toContain('relation-exists');
  });

  it('rejects a prerequisite that would close a loop', () => {
    const withExisting = normalizeKnowledgeRequest(
      request({
        existingConcepts: [
          { name: 'KZG commitment', aliases: [], summary: '' },
          { name: 'Bilinear pairing', aliases: [], summary: '' },
        ],
        existingRelations: [
          { from: 'Bilinear pairing', to: 'KZG commitment', kind: 'prerequisite' },
        ],
      }),
    );
    if (!withExisting.ok) throw new Error('fixture is not valid');
    const result = verifyKnowledgeSuggestions(JSON.stringify(suggestion()), withExisting.value);
    expect(result.rejectedDetails.map((entry) => entry.code)).toContain('relation-cycle');
  });

  it('rejects a cycle formed within one reply', () => {
    const payload = suggestion();
    payload.relations.push({
      from: 'Bilinear pairing',
      to: 'KZG commitment',
      kind: 'prerequisite',
      direction: 'from-first',
      support: 'inferred',
      explanation: 'The reverse dependency.',
      evidence: [],
    });
    const result = verifyKnowledgeSuggestions(JSON.stringify(payload), value);
    expect(result.rejectedDetails.map((entry) => entry.code)).toContain('relation-cycle');
  });

  it('ignores status, ids and paper identifiers the model tried to supply', () => {
    const payload = suggestion();
    payload.concepts[0].status = 'confirmed';
    payload.concepts[0].id = 'model-id';
    payload.relations[0].status = 'confirmed';
    payload.doi = '10.0000/not-real';
    payload.arxivId = 'arXiv:0000.00000';
    payload.paperId = 'model-paper';
    const result = verifyKnowledgeSuggestions(JSON.stringify(payload), value);
    expect(result.concepts[0]).not.toHaveProperty('status');
    expect(result.concepts[0]).not.toHaveProperty('id');
    expect(result.relations[0]).not.toHaveProperty('status');
    expect(result.diagnostics.ignoredProvenanceFields).toBeGreaterThan(0);
    expect(result.diagnostics.ignoredIdentityFields).toBeGreaterThan(0);
    expect(result.warnings.some((warning) => warning.includes('论文标识'))).toBe(true);
  });

  it('marks an empty or truncated reply instead of inventing suggestions', () => {
    const empty = verifyKnowledgeSuggestions('', value);
    expect(empty.status).toBe('malformed');
    expect(empty.concepts).toHaveLength(0);

    const truncated = verifyKnowledgeSuggestions('{"concepts":[{"name":"KZG"', value, {
      truncated: true,
    });
    expect(truncated.status).toBe('incomplete');
    expect(truncated.concepts).toHaveLength(0);

    const incompleteButParseable = verifyKnowledgeSuggestions(JSON.stringify(suggestion()), value, {
      truncated: true,
    });
    expect(incompleteButParseable.status).toBe('incomplete');
    expect(incompleteButParseable.warnings.length).toBeGreaterThan(0);
  });

  it('accepts a reply with no suggestions when the text is insufficient', () => {
    const result = verifyKnowledgeSuggestions(
      JSON.stringify({ groundedInText: false, concepts: [], relations: [] }),
      value,
    );
    expect(result.status).toBe('valid');
    expect(result.groundedInText).toBe(false);
    expect(result.concepts).toHaveLength(0);
  });

  it('keeps a model-written formula clearly on the model’s side', () => {
    const payload = suggestion();
    payload.relations[0].explanation =
      'The paper’s formula is fragmented; the model adds $$R(u)=\\log P_1(u)/P_0(u)$$ as its own explanation.';
    const result = verifyKnowledgeSuggestions(JSON.stringify(payload), value);
    expect(result.relations[0]?.explanation).toContain('model adds');
    expect(result.relations[0]?.explanation).toContain('$$');
    expect(result.relations[0]?.evidence[0]?.quote).toBe(
      'A KZG commitment relies on a bilinear pairing over an elliptic curve group.',
    );
  });

  it('accepts the academic relation kinds and checks each one’s direction', () => {
    const payload = suggestion();
    payload.relations = [
      {
        from: 'KZG commitment',
        to: 'Bilinear pairing',
        kind: 'definition',
        direction: 'from-first',
        support: 'inferred',
        explanation: 'The commitment’s definition is stated through the pairing.',
        evidence: [],
      },
      {
        from: 'Bilinear pairing',
        to: 'KZG commitment',
        kind: 'approximates',
        direction: 'from-first',
        support: 'inferred',
        explanation: 'The pairing is the implementation the commitment uses.',
        evidence: [],
      },
      {
        from: 'KZG commitment',
        to: 'Bilinear pairing',
        kind: 'replaces',
        direction: 'from-first',
        support: 'inferred',
        explanation: 'The commitment is contrasted with a plain pairing.',
        evidence: [],
      },
      {
        from: 'Bilinear pairing',
        to: 'KZG commitment',
        kind: 'extends',
        direction: 'from-first',
        support: 'inferred',
        explanation: 'The pairing adds capability to the commitment.',
        evidence: [],
      },
    ];
    const result = verifyKnowledgeSuggestions(JSON.stringify(payload), longValue);
    expect(result.relations.map((entry) => entry.kind)).toEqual([
      'definition',
      'approximates',
      'replaces',
      'extends',
    ]);
    expect(result.relations.every((entry) => entry.direction === 'from-first')).toBe(true);
  });

  it('rejects a new-kind relation whose direction is not from-first', () => {
    const payload = suggestion();
    payload.relations[0].kind = 'definition';
    payload.relations[0].direction = 'undirected';
    const result = verifyKnowledgeSuggestions(JSON.stringify(payload), value);
    expect(result.relations).toHaveLength(1);
    expect(result.rejectedDetails.map((entry) => entry.code)).toContain('relation-direction');
  });

  it('lowers direct support when the concept name is the model’s own wording', () => {
    const payload = suggestion();
    payload.concepts[0].name = 'Commitment binding property';
    payload.concepts[0].aliases = ['binding guarantee'];
    const result = verifyKnowledgeSuggestions(JSON.stringify(payload), value);
    expect(result.concepts[0]?.support).toBe('inferred');
    expect(result.diagnostics.nameNotVerbatim).toBe(1);
    expect(result.warnings.some((warning) => warning.includes('不是所给原文中的逐字术语'))).toBe(
      true,
    );
  });

  it('keeps direct support when an alias is verbatim in a passage', () => {
    const payload = suggestion();
    payload.concepts[0].name = 'Commitment binding property';
    payload.concepts[0].aliases = ['a single group element'];
    const result = verifyKnowledgeSuggestions(JSON.stringify(payload), value);
    expect(result.concepts[0]?.support).toBe('direct');
    expect(result.diagnostics.nameNotVerbatim).toBe(0);
  });

  it('does not resolve an ambiguous existing name to the first concept', () => {
    const withExisting = normalizeKnowledgeRequest(
      request({
        existingConcepts: [
          { name: 'KZG commitment', aliases: ['KZG'], summary: '' },
          { name: 'Commitment scheme', aliases: ['KZG'], summary: '' },
        ],
      }),
    );
    if (!withExisting.ok) throw new Error('fixture is not valid');
    const payload = suggestion();
    payload.concepts = [
      { name: 'KZG', aliases: [], summary: '', support: 'inferred', evidence: [] },
      payload.concepts[1],
    ];
    payload.relations = [
      {
        from: 'KZG',
        to: 'Bilinear pairing',
        kind: 'related',
        direction: 'undirected',
        support: 'inferred',
        explanation: 'An ambiguous endpoint.',
        evidence: [],
      },
    ];
    const result = verifyKnowledgeSuggestions(JSON.stringify(payload), withExisting.value);
    expect(result.concepts.map((entry) => entry.name)).toEqual(['Bilinear pairing']);
    expect(result.relations).toHaveLength(0);
    const codes = result.rejectedDetails.map((entry) => entry.code);
    expect(codes).toContain('concept-ambiguous-existing');
    expect(codes).toContain('relation-ambiguous-concept');
    expect(result.diagnostics.ambiguousExistingNames).toBe(1);
    expect(result.diagnostics.ambiguousConceptsSkipped).toBe(1);
    expect(result.diagnostics.ambiguousRelationsSkipped).toBe(1);
    expect(result.diagnostics.matchedExisting).toBe(0);
  });

  it('matches an existing concept case-insensitively without renaming it', () => {
    const withExisting = normalizeKnowledgeRequest(
      request({ existingConcepts: [{ name: 'KZG commitment', aliases: [], summary: '' }] }),
    );
    if (!withExisting.ok) throw new Error('fixture is not valid');
    const payload = suggestion();
    payload.concepts[0].name = 'kzg COMMITMENT';
    const result = verifyKnowledgeSuggestions(JSON.stringify(payload), withExisting.value);
    expect(result.concepts[0]?.name).toBe('KZG commitment');
    expect(result.concepts[0]?.existing).toBe(true);
    expect(result.diagnostics.matchedExisting).toBe(1);
  });

  it('caps suggestions when the supplied context is very small', () => {
    const payload = {
      groundedInText: true,
      concepts: Array.from({ length: 6 }, (_, index) => ({
        name: `Concept ${String(index + 1)}`,
        aliases: [],
        summary: 'A placeholder concept.',
        support: 'inferred',
        evidence: [],
      })),
      relations: [
        [1, 2],
        [1, 3],
        [1, 4],
        [1, 5],
        [1, 6],
        [2, 3],
      ].map(([from, to]) => ({
        from: `Concept ${String(from)}`,
        to: `Concept ${String(to)}`,
        kind: 'related',
        direction: 'undirected',
        support: 'inferred',
        explanation: 'A general association.',
        evidence: [],
      })),
    };
    const result = verifyKnowledgeSuggestions(JSON.stringify(payload), value);
    expect(result.diagnostics.smallContext).toBe(true);
    expect(result.concepts).toHaveLength(3);
    expect(result.relations).toHaveLength(3);
    expect(result.diagnostics.smallContextLimited).toBeGreaterThan(0);
    expect(result.warnings.some((warning) => warning.includes('最多保留'))).toBe(true);
  });

  it('does not apply the small-context cap when the context is large enough', () => {
    const payload = {
      groundedInText: true,
      concepts: Array.from({ length: 6 }, (_, index) => ({
        name: `Concept ${String(index + 1)}`,
        aliases: [],
        summary: 'A placeholder concept.',
        support: 'inferred',
        evidence: [],
      })),
      relations: [
        [1, 2],
        [1, 3],
        [1, 4],
        [1, 5],
        [1, 6],
        [2, 3],
      ].map(([from, to]) => ({
        from: `Concept ${String(from)}`,
        to: `Concept ${String(to)}`,
        kind: 'related',
        direction: 'undirected',
        support: 'inferred',
        explanation: 'A general association.',
        evidence: [],
      })),
    };
    const result = verifyKnowledgeSuggestions(JSON.stringify(payload), longValue);
    expect(result.diagnostics.smallContext).toBe(false);
    expect(result.concepts).toHaveLength(6);
    expect(result.relations).toHaveLength(6);
  });
});

describe('the knowledge endpoint', () => {
  it('serves an offline mock reply through the full guard chain', async () => {
    const service = await startTestService();
    try {
      const response = await postJson(service.base, '/api/ai/knowledge', request());
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.provider).toBe('mock');
      expect(body.online).toBe(false);
      expect(body.status).toBe('valid');
      expect(body.concepts.length).toBeGreaterThan(0);
      expect(body.relations.length).toBeGreaterThan(0);
      expect(body.relations[0].direction).toBe('from-first');
      expect(typeof body.rulesVersion).toBe('string');
    } finally {
      await service.stop();
    }
  });

  it('reports the boundary cases through the mock triggers', async () => {
    const service = await startTestService();
    try {
      const cases = [
        ['[[mock:knowledge-broken]]', 'malformed'],
        ['[[mock:knowledge-truncated]]', 'incomplete'],
        ['[[mock:knowledge-empty]]', 'valid'],
      ];
      for (const [trigger, status] of cases) {
        const response = await postJson(
          service.base,
          '/api/ai/knowledge',
          request({ focus: trigger }),
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.status).toBe(status);
      }

      const badQuote = await postJson(
        service.base,
        '/api/ai/knowledge',
        request({ focus: '[[mock:knowledge-bad-quote]]' }),
      );
      const badQuoteBody = await badQuote.json();
      expect(badQuoteBody.rejected).toBeGreaterThan(0);
      expect(badQuoteBody.concepts.every((entry) => entry.evidence.length === 0)).toBe(true);

      const wrongPage = await postJson(
        service.base,
        '/api/ai/knowledge',
        request({ focus: '[[mock:knowledge-wrong-page]]' }),
      );
      const wrongPageBody = await wrongPage.json();
      expect(wrongPageBody.diagnostics.pageMismatches).toBeGreaterThan(0);

      const wrongDirection = await postJson(
        service.base,
        '/api/ai/knowledge',
        request({ focus: '[[mock:knowledge-wrong-direction]]' }),
      );
      const wrongDirectionBody = await wrongDirection.json();
      expect(
        wrongDirectionBody.rejectedDetails.some((entry) => entry.code === 'relation-direction'),
      ).toBe(true);

      const duplicate = await postJson(
        service.base,
        '/api/ai/knowledge',
        request({ focus: '[[mock:knowledge-duplicate]]' }),
      );
      const duplicateBody = await duplicate.json();
      expect(duplicateBody.concepts).toHaveLength(2);
      expect(duplicateBody.relations).toHaveLength(1);
      expect(duplicateBody.rejectedDetails.map((entry) => entry.code)).toContain(
        'relation-duplicate',
      );

      const cycle = await postJson(
        service.base,
        '/api/ai/knowledge',
        request({ focus: '[[mock:knowledge-cycle]]' }),
      );
      const cycleBody = await cycle.json();
      expect(cycleBody.rejectedDetails.some((entry) => entry.code === 'relation-cycle')).toBe(true);

      const bypass = await postJson(
        service.base,
        '/api/ai/knowledge',
        request({ focus: '[[mock:knowledge-bypass]]' }),
      );
      const bypassBody = await bypass.json();
      expect(bypassBody.concepts[0]).not.toHaveProperty('status');
      expect(bypassBody.diagnostics.ignoredProvenanceFields).toBeGreaterThan(0);

      const invalidKind = await postJson(
        service.base,
        '/api/ai/knowledge',
        request({ focus: '[[mock:knowledge-invalid-kind]]' }),
      );
      const invalidKindBody = await invalidKind.json();
      expect(invalidKindBody.rejectedDetails.some((entry) => entry.code === 'relation-kind')).toBe(
        true,
      );
    } finally {
      await service.stop();
    }
  });

  it('exercises the Phase 8.2 mock scenarios through the endpoint', async () => {
    const service = await startTestService();
    const padded = request({
      passages: request().passages.map((entry) => ({
        ...entry,
        text: `${entry.text} ${'Background context for the relation test. '.repeat(40)}`,
      })),
    });
    try {
      const newKinds = await postJson(service.base, '/api/ai/knowledge', {
        ...padded,
        focus: '[[mock:knowledge-new-kinds]]',
      });
      const newKindsBody = await newKinds.json();
      expect(newKindsBody.status).toBe('valid');
      expect(newKindsBody.relations.map((entry) => entry.kind)).toEqual([
        'definition',
        'approximates',
        'replaces',
        'extends',
      ]);

      const coined = await postJson(service.base, '/api/ai/knowledge', {
        ...request(),
        focus: '[[mock:knowledge-coined-name]]',
      });
      const coinedBody = await coined.json();
      expect(coinedBody.concepts[0].support).toBe('inferred');
      expect(coinedBody.diagnostics.nameNotVerbatim).toBeGreaterThan(0);

      const many = await postJson(service.base, '/api/ai/knowledge', {
        ...request(),
        focus: '[[mock:knowledge-many]]',
      });
      const manyBody = await many.json();
      expect(manyBody.diagnostics.smallContext).toBe(true);
      expect(manyBody.concepts).toHaveLength(3);
      expect(manyBody.relations).toHaveLength(3);

      const requestBody = request({
        focus: '[[mock:knowledge-existing]]',
        existingConcepts: [{ name: 'KZG commitment', aliases: ['KZG'], summary: '' }],
      });
      const existing = await postJson(service.base, '/api/ai/knowledge', requestBody);
      const existingBody = await existing.json();
      expect(existingBody.diagnostics.matchedExisting).toBe(1);
      expect(existingBody.concepts[0]).toMatchObject({ name: 'KZG commitment', existing: true });

      const aliasReuse = await postJson(service.base, '/api/ai/knowledge', {
        ...request({
          focus: '[[mock:knowledge-existing-alias]]',
          existingConcepts: [{ name: 'KZG commitment', aliases: ['KZG'], summary: '' }],
        }),
      });
      const aliasReuseBody = await aliasReuse.json();
      expect(aliasReuseBody.diagnostics.matchedExisting).toBe(1);
      expect(aliasReuseBody.concepts[0]).toMatchObject({
        name: 'KZG commitment',
        existing: true,
      });
      expect(aliasReuseBody.relations[0]?.from).toBe('KZG commitment');

      const ambiguous = await postJson(service.base, '/api/ai/knowledge', {
        ...request({
          focus: '[[mock:knowledge-ambiguous]]',
          existingConcepts: [
            { name: 'KZG commitment', aliases: ['KZG'], summary: '' },
            { name: 'KZG proof', aliases: ['KZG'], summary: '' },
          ],
        }),
      });
      const ambiguousBody = await ambiguous.json();
      const ambiguousCodes = ambiguousBody.rejectedDetails.map((entry) => entry.code);
      expect(ambiguousCodes).toContain('concept-ambiguous-existing');
      expect(ambiguousCodes).toContain('relation-ambiguous-concept');
      expect(ambiguousBody.diagnostics.matchedExisting).toBe(0);
      expect(ambiguousBody.concepts.map((entry) => entry.name)).not.toContain('KZG commitment');
    } finally {
      await service.stop();
    }
  });

  it('refuses a request that would send too much context', async () => {
    const service = await startTestService();
    try {
      const response = await postJson(
        service.base,
        '/api/ai/knowledge',
        request({
          passages: Array.from({ length: 9 }, (_, index) => ({
            id: `p-${String(index)}`,
            page: index + 1,
            text: 'Some text for the request.',
            selection: index === 0,
          })),
        }),
      );
      expect(response.status).toBe(400);
    } finally {
      await service.stop();
    }
  });
});
