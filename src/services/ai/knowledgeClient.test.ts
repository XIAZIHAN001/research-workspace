import { describe, expect, it, vi } from 'vitest';
import { analyzeKnowledge } from './client';
import type { KnowledgeAnalysis, KnowledgeRequest } from './knowledgeTypes';

const REQUEST: KnowledgeRequest = {
  paper: { id: 'p1', title: 'A Paper', page: 1, pdfSha256: 'a'.repeat(64) },
  focus: 'a selection',
  scope: 'selection',
  passages: [
    {
      id: 's1',
      page: 1,
      text: 'A KZG commitment relies on a bilinear pairing.',
      selection: true,
      role: 'selection',
      label: '读者选中的原文',
    },
  ],
  existingConcepts: [],
  existingRelations: [],
};

const ANALYSIS: KnowledgeAnalysis = {
  provider: 'mock',
  providerLabel: '本地模拟',
  model: 'mock-1',
  online: false,
  rulesVersion: 'k1',
  status: 'valid',
  groundedInText: true,
  concepts: [],
  relations: [],
  rejected: 0,
  rejectedDetails: [],
  warnings: [],
  diagnostics: null,
  usage: null,
};

function reply(status: number, body: unknown): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    void input;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('analyzeKnowledge', () => {
  it('posts to the knowledge endpoint and returns the analysis', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/api/ai/knowledge');
      return new Response(JSON.stringify(ANALYSIS), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const outcome = await analyzeKnowledge(REQUEST, { fetchImpl });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.analysis.rulesVersion).toBe('k1');
  });

  it('treats a reply without a status as recovered, not valid', async () => {
    const older: Record<string, unknown> = { ...ANALYSIS };
    delete older.status;
    const outcome = await analyzeKnowledge(REQUEST, { fetchImpl: reply(200, older) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.analysis.status).toBe('recovered');
  });

  it('refuses a payload that is not a knowledge analysis', async () => {
    const outcome = await analyzeKnowledge(REQUEST, {
      fetchImpl: reply(200, { concepts: 'not-an-array', relations: [] }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('upstream');
  });

  it('maps service errors to a readable failure', async () => {
    const outcome = await analyzeKnowledge(REQUEST, {
      fetchImpl: reply(400, { error: 'bad-request', message: 'too much context' }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('bad-request');
  });

  it('returns offline when the service cannot be reached', async () => {
    const fetchImpl = vi.fn(async () => Promise.reject(new Error('connection refused')));
    const outcome = await analyzeKnowledge(REQUEST, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('offline');
  });
});
