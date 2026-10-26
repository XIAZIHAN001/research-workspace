import { act, renderHook, waitFor } from '@testing-library/react';
import { useMemo } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createConcept, createEvidence } from '../../domain/knowledge';
import type { KnowledgeAnalysis, KnowledgeRequest } from '../../services/ai/knowledgeTypes';
import type { KnowledgeOutcome } from '../../services/ai/client';
import { createKnowledgeStore } from '../../services/knowledgeStore';
import { makeId } from '../../services/ids';
import type { KnowledgeApi } from '../knowledge/useKnowledgeApi';
import { useKnowledgeApi } from '../knowledge/useKnowledgeApi';
import { useKnowledgeAnalysis } from './useKnowledgeAnalysis';
import type { PDFDocumentProxy } from './pdfjs';

const SHA = 'a'.repeat(64);
const PASSAGE =
  'A KZG commitment relies on a bilinear pairing over an elliptic curve group. The commitment is a single group element.';

const DOC = {
  numPages: 3,
  getPage: (page: number) =>
    Promise.resolve({
      getTextContent: () =>
        Promise.resolve({
          items: [
            {
              str:
                page === 1
                  ? PASSAGE
                  : 'We define the pairing e: G1 x G2 -> GT as a bilinear map that is non-degenerate.',
              hasEOL: false,
            },
          ],
        }),
    }),
} as unknown as PDFDocumentProxy;

const ANALYSIS: KnowledgeAnalysis = {
  provider: 'mock',
  providerLabel: '本地模拟（未连接在线模型）',
  model: 'mock-1',
  online: false,
  rulesVersion: 'k1',
  status: 'valid',
  groundedInText: true,
  concepts: [
    {
      name: 'KZG commitment',
      aliases: ['KZG'],
      summary: '（本地模拟）一个占位概念。',
      support: 'direct',
      evidence: [
        {
          passageId: 's1',
          page: 1,
          quote: 'A KZG commitment relies on a bilinear pairing over an elliptic curve group.',
        },
      ],
      evidenceStatus: 'verified',
    },
    {
      name: 'Bilinear pairing',
      aliases: [],
      summary: '（本地模拟）另一个占位概念。',
      support: 'inferred',
      evidence: [],
      evidenceStatus: 'none',
    },
  ],
  relations: [
    {
      from: 'KZG commitment',
      to: 'Bilinear pairing',
      kind: 'prerequisite',
      direction: 'from-first',
      support: 'direct',
      explanation: '（本地模拟）KZG 依赖配对。',
      evidence: [
        {
          passageId: 's1',
          page: 1,
          quote: 'A KZG commitment relies on a bilinear pairing over an elliptic curve group.',
        },
      ],
      evidenceStatus: 'verified',
    },
  ],
  rejected: 0,
  rejectedDetails: [],
  warnings: [],
  diagnostics: null,
  usage: null,
};

const CONTEXT = {
  paperId: 'paper-1',
  title: 'KZG commitments for everyone',
  pdfSha256: SHA,
  currentPage: 1,
  projectId: 'p1',
  selection: {
    page: 1,
    quote: 'A KZG commitment relies on a bilinear pairing over an elliptic curve group.',
    prefix: '',
    suffix: '',
    rects: [],
    start: 0,
    end: 76,
  },
  pageText: PASSAGE,
  annotations: [],
  difficulties: [],
};

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

function harness(
  analyze: (request: KnowledgeRequest) => Promise<KnowledgeOutcome>,
  doc: PDFDocumentProxy = DOC,
) {
  return renderHook(() => {
    const store = useMemo(() => createKnowledgeStore(memoryStorage()), []);
    const api: KnowledgeApi = useKnowledgeApi(store, makeId, () => 100);
    const analysis = useKnowledgeAnalysis({
      doc,
      knowledge: api,
      makeId,
      locate: () => ({ location: 'missing', anchor: null }),
      analyze: (request) => analyze(request),
    });
    return { analysis, store, api };
  });
}

async function runAnalysis(hook: ReturnType<typeof harness>): Promise<void> {
  act(() => {
    hook.result.current.analysis.open(CONTEXT);
  });
  act(() => {
    hook.result.current.analysis.prepare();
  });
  await waitFor(() => {
    expect(hook.result.current.analysis.phase).toBe('ready');
  });
  await act(async () => {
    hook.result.current.analysis.run();
  });
  await waitFor(() => {
    expect(['done', 'error']).toContain(hook.result.current.analysis.phase);
  });
}

describe('useKnowledgeAnalysis', () => {
  it('does not install a plan from a stale prepare after the panel is reopened', async () => {
    let releasePage: ((page: unknown) => void) | null = null;
    const pageThree = new Promise((resolve) => {
      releasePage = resolve;
    });
    const pageBody = (text: string) => ({
      getTextContent: () => Promise.resolve({ items: [{ str: text, hasEOL: false }] }),
    });
    const doc = {
      numPages: 3,
      getPage: (page: number) =>
        page === 3 ? pageThree : Promise.resolve(pageBody(`page ${String(page)} text`)),
    } as unknown as PDFDocumentProxy;

    const hook = harness(async () => ({ ok: true, analysis: ANALYSIS }), doc);
    act(() => {
      hook.result.current.analysis.open(CONTEXT);
    });
    act(() => {
      hook.result.current.analysis.prepare();
    });
    // Let the first extraction reach the deferred page before the panel is reopened.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const secondContext = {
      ...CONTEXT,
      currentPage: 2,
      selection: null,
      pageText: 'Second page text that should win.',
    };
    act(() => {
      hook.result.current.analysis.open(secondContext);
    });
    act(() => {
      hook.result.current.analysis.prepare();
    });

    await act(async () => {
      releasePage?.(pageBody('page 3 text'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(hook.result.current.analysis.phase).toBe('ready');
    });

    const plan = hook.result.current.analysis.plan;
    expect(plan?.segments[0]?.page).toBe(2);
    expect(plan?.segments[0]?.text).toContain('Second page text that should win.');
  });

  it('does not call the model until the explicit run, and stores suggestions as suggestions', async () => {
    const requests: KnowledgeRequest[] = [];
    const analyze = vi.fn(async (request: KnowledgeRequest): Promise<KnowledgeOutcome> => {
      requests.push(request);
      return { ok: true, analysis: ANALYSIS };
    });
    const hook = harness(analyze);

    act(() => {
      hook.result.current.analysis.open(CONTEXT);
    });
    act(() => {
      hook.result.current.analysis.prepare();
    });
    await waitFor(() => {
      expect(hook.result.current.analysis.phase).toBe('ready');
    });
    expect(analyze).not.toHaveBeenCalled();
    expect(hook.result.current.analysis.plan?.segments[0]?.role).toBe('selection');
    expect(hook.result.current.analysis.plan?.totalChars).toBeGreaterThan(0);

    await act(async () => {
      hook.result.current.analysis.run();
    });
    await waitFor(() => {
      expect(hook.result.current.analysis.phase).toBe('done');
    });
    expect(analyze).toHaveBeenCalledTimes(1);

    const request = requests[0];
    expect(request?.passages.filter((passage) => passage.selection)).toHaveLength(1);
    expect(request?.passages.every((passage) => passage.text.length <= 1200)).toBe(true);
    expect(request?.existingRelations).toEqual([]);

    const state = hook.result.current.store.getSnapshot().state;
    const kzg = state.concepts.find((concept) => concept.name === 'KZG commitment');
    const pairing = state.concepts.find((concept) => concept.name === 'Bilinear pairing');
    expect(kzg?.status).toBe('suggested');
    expect(kzg?.origin).toBe('ai');
    expect(pairing?.status).toBe('suggested');
    expect(state.relations).toHaveLength(1);
    expect(state.relations[0]?.status).toBe('suggested');
    expect(state.relations[0]?.origin).toBe('ai');
    expect(state.relations[0]?.support).toBe('direct');
    expect(state.relations[0]?.rationale).toContain('KZG');
    const relationEvidence = state.evidence.filter((entry) => entry.relationId !== undefined);
    expect(relationEvidence).toHaveLength(1);
    expect(relationEvidence[0]?.source).toBe('ai');
    expect(relationEvidence[0]?.verification).toBe('verbatim');
    expect(hook.result.current.analysis.report?.addedRelations).toBe(1);
  });

  it('reuses an existing concept instead of creating a duplicate or overwriting it', async () => {
    const analyze = async (): Promise<KnowledgeOutcome> => ({ ok: true, analysis: ANALYSIS });
    const hook = harness(analyze);

    const store = hook.result.current.store;
    const base = createConcept(
      { name: 'KZG commitment', summary: '读者自己的概述', projectIds: ['p1'] },
      makeId,
      1,
    );
    if (base === null) throw new Error('concept not created');
    store.dispatch({
      type: 'concept/create',
      input: { name: base.name, summary: base.summary, projectIds: ['p1'] },
      id: base.id,
      at: 1,
    });
    store.dispatch({
      type: 'concept/confirm',
      id: base.id,
      at: 2,
    });

    await runAnalysis(hook);
    const state = store.getSnapshot().state;
    const sameName = state.concepts.filter((concept) => concept.name === 'KZG commitment');
    expect(sameName).toHaveLength(1);
    expect(sameName[0]?.summary).toBe('读者自己的概述');
    expect(sameName[0]?.status).toBe('confirmed');
    expect(state.concepts.some((concept) => concept.name === 'Bilinear pairing')).toBe(true);
    expect(state.relations[0]?.from).toBe(base.id);
    expect(state.relations[0]?.status).toBe('suggested');
    const newEvidence = state.evidence.filter(
      (entry) =>
        entry.conceptId === base.id && entry.source === 'ai' && entry.relationId === undefined,
    );
    expect(newEvidence).toHaveLength(1);
    expect(newEvidence[0]?.quote).toContain('KZG commitment');
  });

  it('adds nothing when the reply is malformed', async () => {
    const analyze = async (): Promise<KnowledgeOutcome> => ({
      ok: true,
      analysis: { ...ANALYSIS, status: 'malformed', concepts: [], relations: [] },
    });
    const hook = harness(analyze);
    await runAnalysis(hook);
    expect(hook.result.current.analysis.phase).toBe('error');
    expect(hook.result.current.store.getSnapshot().state.concepts).toHaveLength(0);
    expect(hook.result.current.store.getSnapshot().state.relations).toHaveLength(0);
  });

  it('does not duplicate anything when the same analysis is run twice', async () => {
    const analyze = async (): Promise<KnowledgeOutcome> => ({ ok: true, analysis: ANALYSIS });
    const hook = harness(analyze);
    await runAnalysis(hook);
    const afterFirst = hook.result.current.store.getSnapshot().state;
    expect(afterFirst.concepts).toHaveLength(2);
    expect(afterFirst.relations).toHaveLength(1);

    await act(async () => {
      hook.result.current.analysis.run();
    });
    await waitFor(() => {
      expect(hook.result.current.analysis.phase).toBe('done');
    });
    const afterSecond = hook.result.current.store.getSnapshot().state;
    expect(afterSecond.concepts).toHaveLength(2);
    expect(afterSecond.relations).toHaveLength(1);
    expect(afterSecond.evidence).toHaveLength(afterFirst.evidence.length);
  });

  it('shows local knowledge before any analysis', () => {
    const hook = harness(async () => ({ ok: true, analysis: ANALYSIS }));
    const store = hook.result.current.store;
    const concept = createConcept(
      { name: 'KZG commitment', summary: '', projectIds: ['p1'] },
      makeId,
      1,
    );
    if (concept === null) throw new Error('concept not created');
    store.dispatch({
      type: 'concept/create',
      input: { name: concept.name, projectIds: ['p1'] },
      id: concept.id,
      at: 1,
    });
    const evidence = createEvidence(
      {
        conceptId: concept.id,
        paperId: 'paper-1',
        pdfSha256: SHA,
        page: 1,
        quote: 'A KZG commitment relies on a bilinear pairing',
        rects: [],
        source: 'manual',
      },
      makeId,
      2,
    );
    if (evidence === null) throw new Error('evidence not created');
    store.dispatch({
      type: 'evidence/add',
      input: {
        conceptId: concept.id,
        paperId: 'paper-1',
        pdfSha256: SHA,
        page: 1,
        quote: evidence.quote,
        rects: [],
        source: 'manual',
      },
      id: evidence.id,
      at: 2,
    });

    act(() => {
      hook.result.current.analysis.open(CONTEXT);
    });
    expect(hook.result.current.analysis.local?.matches[0]?.concept.name).toBe('KZG commitment');
    expect(hook.result.current.analysis.local?.matches[0]?.matchedBy).toBe('selection');
  });
});
