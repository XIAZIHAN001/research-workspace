import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Concept, ConceptRelation, KnowledgeState } from '../../domain/knowledge';
import type { Paper } from '../../domain/papers';
import type { KnowledgeApi } from '../knowledge/useKnowledgeApi';
import { localKnowledgeFor } from '../knowledge/localKnowledge';
import { KnowledgePanel } from './KnowledgePanel';
import { buildRetrievalPlan } from './paperRetrieval';
import type { KnowledgeAnalysisState } from './useKnowledgeAnalysis';
import type { KnowledgeAnalysis } from '../../services/ai/knowledgeTypes';

const SHA = 'a'.repeat(64);
const QUOTE = 'A KZG commitment relies on a bilinear pairing over an elliptic curve group.';

const PAPER: Paper = {
  id: 'paper-1',
  title: 'KZG commitments for everyone',
  authors: [],
  pdf: { sha256: SHA, name: 'kzg.pdf', bytes: 100, pageCount: 3, addedAt: 1 },
  createdAt: 1,
  updatedAt: 1,
};

const PROJECT = {
  id: 'p1',
  name: 'KZG study',
  corePaperId: 'paper-1',
  relatedPaperIds: [],
  createdAt: 1,
  updatedAt: 1,
};

const KZG: Concept = {
  id: 'c-kzg',
  name: 'KZG commitment',
  aliases: [],
  summary: '把多项式绑定到一个承诺上。',
  origin: 'user',
  status: 'confirmed',
  projectIds: ['p1'],
  createdAt: 1,
  updatedAt: 1,
};

const PAIRING: Concept = {
  id: 'c-pairing',
  name: 'Bilinear pairing',
  aliases: [],
  summary: '双线性映射。',
  origin: 'ai',
  status: 'suggested',
  projectIds: ['p1'],
  createdAt: 1,
  updatedAt: 1,
};

const SUGGESTED: ConceptRelation = {
  id: 'r-1',
  from: 'c-kzg',
  to: 'c-pairing',
  kind: 'prerequisite',
  status: 'suggested',
  origin: 'ai',
  note: '',
  support: 'direct',
  rationale: '模型认为 KZG 依赖配对。',
  provider: 'mock',
  providerLabel: '本地模拟',
  model: 'mock-1',
  rulesVersion: 'k1',
  evidenceIds: ['e-1'],
  createdAt: 1,
  updatedAt: 1,
};

const EVIDENCE = {
  id: 'e-1',
  conceptId: 'c-kzg',
  paperId: 'paper-1',
  pdfSha256: SHA,
  page: 1,
  quote: QUOTE,
  prefix: '',
  suffix: '',
  rects: [],
  source: 'ai' as const,
  relationId: 'r-1',
  verification: 'verbatim' as const,
  note: '',
  createdAt: 1,
};

const STATE: KnowledgeState = {
  version: 2,
  concepts: [KZG, PAIRING],
  evidence: [EVIDENCE],
  relations: [SUGGESTED],
  rejections: [],
};

const CONTEXT = {
  paperId: 'paper-1',
  title: PAPER.title,
  pdfSha256: SHA,
  currentPage: 1,
  projectId: 'p1',
  selection: {
    page: 1,
    quote: QUOTE,
    prefix: '',
    suffix: '',
    rects: [],
    start: 0,
    end: QUOTE.length,
  },
  pageText: `${QUOTE} The commitment is a single group element.`,
  annotations: [],
  difficulties: [],
};

const PLAN = buildRetrievalPlan({
  pages: [
    {
      page: 1,
      text: CONTEXT.pageText,
      itemCount: 20,
      singleCharItems: 0,
      fragmented: false,
    },
  ],
  pageCount: 3,
  currentPage: 1,
  selection: QUOTE,
  conceptNames: ['KZG commitment'],
});

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
      name: 'Bilinear pairing',
      aliases: [],
      summary: '双线性映射。',
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
      explanation: '模型认为 KZG 依赖配对。',
      evidence: [{ passageId: 's1', page: 1, quote: QUOTE }],
      evidenceStatus: 'verified',
    },
  ],
  rejected: 1,
  rejectedDetails: [{ code: 'quote-not-in-passage', label: '引文', message: '引文不在原文里。' }],
  warnings: ['一条模型输出被拒绝。'],
  diagnostics: null,
  usage: null,
};

function makeApi(): KnowledgeApi {
  return {
    state: STATE,
    persisted: true,
    issue: null,
    createConcept: vi.fn(),
    updateConcept: vi.fn(),
    confirmConcept: vi.fn(),
    deleteConcept: vi.fn(),
    mergeConcept: vi.fn(),
    linkProject: vi.fn(),
    unlinkProject: vi.fn(),
    addEvidence: vi.fn(),
    removeEvidence: vi.fn(),
    createRelation: vi.fn(() => ({ ok: true })),
    confirmRelation: vi.fn(() => ({ ok: true })),
    updateRelationKind: vi.fn(() => ({ ok: true })),
    rejectRelation: vi.fn(() => ({ ok: true })),
    undoRejection: vi.fn(),
    deleteRelation: vi.fn(),
    addSuggestions: vi.fn(() => ({
      addedConcepts: 0,
      reusedConcepts: 0,
      addedRelations: 0,
      addedEvidence: 0,
      skipped: [],
    })),
    candidatesFromDifficulties: vi.fn(() => []),
  };
}

function makeAnalysis(overrides: Partial<KnowledgeAnalysisState> = {}): KnowledgeAnalysisState {
  return {
    context: CONTEXT,
    local: localKnowledgeFor(STATE, {
      projectId: 'p1',
      paperId: 'paper-1',
      currentPage: 1,
      selection: QUOTE,
      pageText: CONTEXT.pageText,
    }),
    phase: 'ready',
    plan: PLAN,
    analysis: null,
    report: null,
    error: null,
    failedPages: [],
    open: vi.fn(),
    prepare: vi.fn(),
    run: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  };
}

function renderPanel(analysis: KnowledgeAnalysisState, api = makeApi()) {
  return render(
    <KnowledgePanel
      paper={PAPER}
      projectId="p1"
      projects={[PROJECT]}
      knowledge={api}
      analysis={analysis}
      health={{
        ok: true,
        provider: 'mock',
        label: '本地模拟（未连接在线模型）',
        model: 'mock-1',
        reasoning: null,
        online: false,
        limits: {
          passages: 8,
          passageChars: 2000,
          totalContextChars: 6000,
          questionChars: 1000,
          requestsPerMinute: 30,
          answerTokens: 8192,
        },
      }}
      onClose={vi.fn()}
      onJumpToQuote={vi.fn()}
      onOpenConceptInProject={vi.fn()}
      onNotice={vi.fn()}
    />,
  );
}

describe('KnowledgePanel', () => {
  it('shows local knowledge and the context plan before any call', () => {
    const analysis = makeAnalysis();
    renderPanel(analysis);
    expect(screen.getByText('本地已有知识')).toBeInTheDocument();
    expect(screen.getByText('KZG commitment')).toBeInTheDocument();
    expect(screen.getByText(/打开面板不会调用模型/)).toBeInTheDocument();
    expect(screen.getByText(/发送前确认/)).toBeInTheDocument();
    expect(screen.getByText(/使用第 1 页/)).toBeInTheDocument();
    expect(screen.getByText(/不会发起在线调用/)).toBeInTheDocument();
    expect(analysis.run).not.toHaveBeenCalled();
  });

  it('runs only when the reader clicks start', async () => {
    const analysis = makeAnalysis();
    renderPanel(analysis);
    await userEvent.click(screen.getByRole('button', { name: '开始分析' }));
    expect(analysis.run).toHaveBeenCalledTimes(1);
  });

  it('shows the local suggestion with its support and accepts or ignores it', async () => {
    const api = makeApi();
    renderPanel(makeAnalysis(), api);
    const local = screen.getByText('KZG commitment').closest('.knowledge-concept');
    if (local === null) throw new Error('no local concept');
    expect(within(local as HTMLElement).getByText('原文直接支持')).toBeInTheDocument();
    expect(within(local as HTMLElement).getByText(/模型认为 KZG 依赖配对/)).toBeInTheDocument();
    await userEvent.click(within(local as HTMLElement).getByRole('button', { name: '采纳' }));
    expect(api.confirmRelation).toHaveBeenCalledWith('r-1');
  });

  it('shows the model result, the mock warning and the rejected output', () => {
    renderPanel(
      makeAnalysis({
        phase: 'done',
        analysis: ANALYSIS,
        report: {
          addedConcepts: 0,
          reusedConcepts: 1,
          addedRelations: 1,
          addedEvidence: 1,
          skipped: [],
        },
      }),
    );
    expect(screen.getByText(/本地模拟（mock provider）/)).toBeInTheDocument();
    expect(screen.getByText(/模型提出 1 个概念、1 条关系/)).toBeInTheDocument();
    expect(screen.getByText(/服务端拒绝的 1 条内容/)).toBeInTheDocument();
    expect(screen.getByText(/引文不在原文里/)).toBeInTheDocument();
    expect(screen.getByText(/一条模型输出被拒绝/)).toBeInTheDocument();
  });

  it('shows an error without claiming anything was saved', () => {
    renderPanel(
      makeAnalysis({
        phase: 'error',
        error: '模型返回的内容无法还原成知识建议；原始输出没有加入知识库。',
      }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('没有加入知识库');
  });
});

describe('KnowledgePanel suggestion matching', () => {
  it('does not attach an ignored suggestion to a different relation between the same concepts', async () => {
    const confirmedPrerequisite = {
      ...SUGGESTED,
      id: 'r-ab',
      from: 'c-kzg',
      to: 'c-pairing',
      kind: 'prerequisite' as const,
      status: 'confirmed' as const,
      rationale: 'A needs B',
    };
    const relatedSuggestion = {
      ...SUGGESTED,
      id: 'r-ba',
      from: 'c-pairing',
      to: 'c-kzg',
      kind: 'related' as const,
      support: 'external' as const,
      rationale: 'B relates to A',
    };
    const analysis: KnowledgeAnalysis = {
      ...ANALYSIS,
      concepts: [],
      relations: [
        {
          from: 'Bilinear pairing',
          to: 'KZG commitment',
          kind: 'related',
          direction: 'undirected',
          support: 'external',
          explanation: 'B relates to A',
          evidence: [],
          evidenceStatus: 'none',
        },
      ],
      rejected: 0,
      rejectedDetails: [],
      warnings: [],
    };

    function Harness() {
      const [state, setState] = useState({
        version: 2 as const,
        concepts: [KZG, { ...PAIRING, status: 'suggested' as const }],
        evidence: [],
        relations: [confirmedPrerequisite, relatedSuggestion],
        rejections: [],
      });
      const api: KnowledgeApi = {
        ...makeApi(),
        state,
        confirmRelation: vi.fn(() => ({ ok: true })),
        deleteRelation: (id: string) => {
          setState((current) => ({
            ...current,
            relations: current.relations.filter((relation) => relation.id !== id),
          }));
        },
        updateRelationKind: vi.fn(() => ({ ok: true })),
      };
      return (
        <KnowledgePanel
          paper={PAPER}
          projectId="p1"
          projects={[PROJECT]}
          knowledge={api}
          analysis={makeAnalysis({ phase: 'done', analysis, report: null })}
          health={null}
          onClose={vi.fn()}
          onJumpToQuote={vi.fn()}
          onOpenConceptInProject={vi.fn()}
          onNotice={vi.fn()}
        />
      );
    }

    render(<Harness />);
    const row = screen.getByText('B relates to A').closest('.knowledge-suggestion-row');
    if (row === null) throw new Error('no suggestion row');
    expect(
      within(row as HTMLElement).getByRole('button', { name: '拒绝该关系' }),
    ).toBeInTheDocument();
    await userEvent.click(within(row as HTMLElement).getByRole('button', { name: '暂时忽略' }));
    expect(screen.queryByText('B relates to A')).not.toBeInTheDocument();
    // The unrelated confirmed prerequisite is still in the graph.
    expect(screen.queryByText('A needs B')).not.toBeInTheDocument();
  });
});
