import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, useSyncExternalStore } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../../domain/annotation';
import type { Paper } from '../../domain/papers';
import { EMPTY_KNOWLEDGE, type KnowledgeState } from '../../domain/knowledge';
import { knowledgeReducer, type KnowledgeAction } from '../../domain/knowledgeState';
import { DIFFICULTY_STORAGE_KEY } from '../../services/difficultyStore';
import {
  createKnowledgeStore,
  KNOWLEDGE_STORAGE_KEY,
  type KnowledgeStore,
} from '../../services/knowledgeStore';
import { KnowledgeView } from './KnowledgeView';
import { useKnowledgeApi } from './useKnowledgeApi';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const PROJECT = {
  id: 'project-1',
  name: 'A Study',
  corePaperId: 'paper-1',
  relatedPaperIds: ['paper-2'],
  createdAt: 1,
  updatedAt: 1,
};

const PAPERS: Record<string, Paper> = {
  'paper-1': {
    id: 'paper-1',
    title: 'The Core Paper',
    authors: [],
    pdf: { sha256: SHA_A, name: 'core.pdf', bytes: 10, pageCount: 3, addedAt: 1 },
    createdAt: 1,
    updatedAt: 1,
  },
  'paper-2': {
    id: 'paper-2',
    title: 'A Related Paper',
    authors: [],
    pdf: { sha256: SHA_B, name: 'related.pdf', bytes: 10, pageCount: 5, addedAt: 1 },
    createdAt: 1,
    updatedAt: 1,
  },
};

const ANNOTATION: Annotation = {
  id: 'ann-1',
  paperId: 'paper-1',
  pdfSha256: SHA_A,
  page: 2,
  quote: 'the commitment binds the polynomial',
  prefix: '',
  suffix: '',
  rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }],
  kind: 'note',
  note: '这是理解 KZG 的关键一句。',
  origin: 'user',
  sourceLabel: '',
  createdAt: 1,
  updatedAt: 1,
};

function memory(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  };
}

let counter = 0;
const nextId = (): string => {
  counter += 1;
  return `id-${String(counter)}`;
};

function Harness({
  store,
  annotations = [],
  projects = [PROJECT],
  onOpenReader = vi.fn(),
  onOpenProject = vi.fn(),
}: {
  store: KnowledgeStore;
  annotations?: Annotation[];
  projects?: (typeof PROJECT)[];
  onOpenReader?: (paperId: string, focus?: { page: number; quote: string }) => void;
  onOpenProject?: (projectId: string) => void;
}) {
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  const api = useKnowledgeApi(store, nextId, () => 100);
  const [mode, setMode] = useState<'list' | 'graph'>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <KnowledgeView
      project={PROJECT}
      papers={PAPERS}
      annotations={annotations}
      projects={projects}
      api={api}
      mode={mode}
      selectedId={selectedId}
      onModeChange={setMode}
      onSelect={setSelectedId}
      onOpenProject={onOpenProject}
      onOpenReader={onOpenReader}
    />
  );
}

function setup(annotations: Annotation[] = []) {
  const disk = memory();
  const store = createKnowledgeStore(disk);
  const onOpenReader = vi.fn();
  const view = render(
    <Harness store={store} annotations={annotations} onOpenReader={onOpenReader} />,
  );
  return { store, view, onOpenReader, disk };
}

async function createConcept(name: string, summary = ''): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: /新建概念/ }));
  await userEvent.type(screen.getByLabelText('概念名称'), name);
  if (summary !== '') await userEvent.type(screen.getByLabelText('简短概述'), summary);
  await userEvent.click(screen.getByRole('button', { name: '创建' }));
}

beforeEach(() => {
  window.localStorage.clear();
  counter = 0;
});

describe('KnowledgeView: concepts', () => {
  it('starts empty and says so', () => {
    setup();
    expect(screen.getByText(/还没有概念/)).toBeInTheDocument();
  });

  it('creates a concept and shows it in the list and the detail', async () => {
    setup();
    await createConcept('KZG commitment', '把多项式绑定到一个承诺上。');
    const list = screen.getByLabelText('概念列表');
    expect(within(list).getByText('KZG commitment')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '概念：KZG commitment' })).toBeInTheDocument();
    const detail = screen.getByRole('region', { name: '概念：KZG commitment' });
    expect(within(detail).getByText('把多项式绑定到一个承诺上。')).toBeInTheDocument();
  });

  it('keeps the graph and the list showing the same concepts', async () => {
    setup();
    await createConcept('Alpha');
    await createConcept('Beta');
    await userEvent.click(screen.getByRole('button', { name: '关系图' }));
    const graph = screen.getByRole('group', { name: '概念关系图' });
    const nodes = [...graph.querySelectorAll('.concept-node')];
    expect(
      nodes
        .map((node) => node.getAttribute('aria-label'))
        .filter((label): label is string => label !== null)
        .sort(),
    ).toEqual(['Alpha', 'Beta']);
    await userEvent.click(screen.getByRole('button', { name: '列表' }));
    expect(within(screen.getByLabelText('概念列表')).getByText('Alpha')).toBeInTheDocument();
  });
});

describe('KnowledgeView: relations', () => {
  async function withTwo(): Promise<void> {
    await createConcept('KZG commitment');
    await createConcept('Bilinear pairing');
  }

  it('adds a prerequisite and reads it from both ends', async () => {
    setup();
    await withTwo();
    // The first concept is selected after creating the second? Select KZG explicitly.
    await userEvent.click(
      within(screen.getByLabelText('概念列表')).getByRole('button', { name: /KZG commitment/ }),
    );
    await userEvent.selectOptions(
      screen.getByLabelText('关系对象'),
      screen.getByRole('option', { name: 'Bilinear pairing' }),
    );
    await userEvent.click(screen.getByRole('button', { name: '添加关系' }));

    const detail = screen.getByRole('region', { name: '概念：KZG commitment' });
    expect(
      within(detail).getAllByRole('button', { name: 'Bilinear pairing' }).length,
    ).toBeGreaterThan(0);

    // And from the prerequisite's side, KZG depends on it. The first matching button is the
    // confirmed prerequisite list; the learning path repeats the name further down.
    await userEvent.click(
      within(detail).getAllByRole('button', { name: 'Bilinear pairing' })[0] as HTMLElement,
    );
    const other = screen.getByRole('region', { name: '概念：Bilinear pairing' });
    expect(within(other).getByText(/被这些概念依赖/)).toBeInTheDocument();
    expect(within(other).getByRole('button', { name: 'KZG commitment' })).toBeInTheDocument();
  });

  it('refuses a cycle and says why', async () => {
    setup();
    await withTwo();
    await userEvent.click(
      within(screen.getByLabelText('概念列表')).getByRole('button', { name: /KZG commitment/ }),
    );
    await userEvent.selectOptions(
      screen.getByLabelText('关系对象'),
      screen.getByRole('option', { name: 'Bilinear pairing' }),
    );
    await userEvent.click(screen.getByRole('button', { name: '添加关系' }));

    await userEvent.click(
      within(screen.getByLabelText('概念列表')).getByRole('button', { name: /Bilinear pairing/ }),
    );
    await userEvent.selectOptions(
      screen.getByLabelText('关系对象'),
      screen.getByRole('option', { name: 'KZG commitment' }),
    );
    await userEvent.click(screen.getByRole('button', { name: '添加关系' }));

    expect(screen.getByRole('status')).toHaveTextContent(/循环/);
  });

  it('deletes a relation without touching either concept', async () => {
    setup();
    await withTwo();
    await userEvent.click(
      within(screen.getByLabelText('概念列表')).getByRole('button', { name: /KZG commitment/ }),
    );
    await userEvent.selectOptions(
      screen.getByLabelText('关系对象'),
      screen.getByRole('option', { name: 'Bilinear pairing' }),
    );
    await userEvent.click(screen.getByRole('button', { name: '添加关系' }));
    await userEvent.click(
      screen.getByRole('button', { name: '删除指向 Bilinear pairing 的前置关系' }),
    );

    const list = screen.getByLabelText('概念列表');
    expect(within(list).getByText('KZG commitment')).toBeInTheDocument();
    expect(within(list).getByText('Bilinear pairing')).toBeInTheDocument();
  });

  it('shows an AI-suggested relation as a suggestion until it is adopted', async () => {
    const disk = memory();
    const store = createKnowledgeStore(disk);
    store.dispatch({
      type: 'concept/create',
      input: { name: 'A', projectIds: [PROJECT.id] },
      id: 'a',
      at: 1,
    });
    store.dispatch({
      type: 'concept/create',
      input: { name: 'B', projectIds: [PROJECT.id] },
      id: 'b',
      at: 1,
    });
    store.dispatch({
      type: 'suggestions/add',
      concepts: [],
      relations: [
        {
          id: 'r1',
          from: 'a',
          to: 'b',
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
    render(<Harness store={store} />);

    const detail = screen.getByRole('region', { name: '概念：A' });
    expect(within(detail).getByText(/AI 建议的关系/)).toBeInTheDocument();
    // Not counted as a prerequisite yet.
    expect(within(detail).getByText(/还没有记录它依赖什么/)).toBeInTheDocument();

    await userEvent.click(within(detail).getByRole('button', { name: '采纳' }));
    expect(within(detail).queryByText(/AI 建议的关系/)).not.toBeInTheDocument();
    expect(within(detail).getAllByRole('button', { name: 'B' }).length).toBeGreaterThan(0);
  });

  it('hints at a definition written as a prerequisite, and changes it only on request', async () => {
    const disk = memory();
    const store = createKnowledgeStore(disk);
    store.dispatch({
      type: 'concept/create',
      input: { name: 'DLM', projectIds: [PROJECT.id] },
      id: 'dlm',
      at: 1,
    });
    store.dispatch({
      type: 'concept/create',
      input: { name: 'Shared canvas', projectIds: [PROJECT.id] },
      id: 'canvas',
      at: 1,
    });
    store.dispatch({
      type: 'suggestions/add',
      concepts: [],
      relations: [
        {
          id: 'r-def',
          from: 'dlm',
          to: 'canvas',
          kind: 'prerequisite',
          status: 'confirmed',
          origin: 'user',
          note: '',
          support: 'direct',
          rationale: 'DLM is defined as a model that iteratively denoises a shared canvas.',
          provider: 'mock',
          providerLabel: '本地模拟',
          model: 'mock-1',
          rulesVersion: 'k2',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      evidence: [],
    });
    store.dispatch({ type: 'relation/confirm', id: 'r-def', at: 2 });
    render(<Harness store={store} />);

    const detail = screen.getByRole('region', { name: '概念：DLM' });
    expect(within(detail).getByText(/说明更像「定义依赖」/)).toBeInTheDocument();
    expect(within(detail).getByLabelText('把与 Shared canvas 的关系改为')).toHaveValue(
      'prerequisite',
    );
    expect(within(detail).getByText('学习路径')).toBeInTheDocument();

    await userEvent.click(within(detail).getByRole('button', { name: '改为「定义依赖」' }));

    expect(screen.getByRole('status')).toHaveTextContent('关系类型已改为「定义依赖」');
    expect(within(detail).getByLabelText('把与 Shared canvas 的关系改为')).toHaveValue(
      'definition',
    );
    expect(within(detail).getByText('定义、近似与替代')).toBeInTheDocument();
    expect(within(detail).getByText(/还没有记录它依赖什么/)).toBeInTheDocument();
    // The academic relation no longer contributes a learning path.
    expect(within(detail).queryByText('学习路径')).not.toBeInTheDocument();
  });
});

describe('KnowledgeView: evidence', () => {
  async function withEvidence(): Promise<ReturnType<typeof setup>> {
    const context = setup([ANNOTATION]);
    await createConcept('KZG commitment');
    await userEvent.click(screen.getByRole('button', { name: /从笔记里添加出处/ }));
    await userEvent.click(screen.getByRole('button', { name: '添加' }));
    return context;
  }

  it('attaches a note as evidence and opens the paper at that quotation', async () => {
    const { onOpenReader } = await withEvidence();
    expect(screen.getByText(/“the commitment binds the polynomial”/)).toBeInTheDocument();
    expect(screen.getByText(/你的笔记|来自你的笔记/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '打开原文' }));
    expect(onOpenReader).toHaveBeenCalledWith('paper-1', {
      page: 2,
      quote: 'the commitment binds the polynomial',
    });
  });

  it('keeps evidence from a replaced file, but refuses to jump with it', async () => {
    const { store, view } = await withEvidence();
    view.unmount();
    const state = store.getSnapshot().state;
    const evidence = state.evidence[0];
    if (evidence === undefined) throw new Error('no evidence');
    // Simulate the paper being given a different PDF.
    const replaced = knowledgeReducer(state, {
      type: 'evidence/add',
      input: {
        conceptId: evidence.conceptId,
        paperId: evidence.paperId,
        pdfSha256: SHA_B,
        page: 4,
        quote: 'a different file altogether',
        rects: [],
        source: 'manual',
      },
      id: 'old-file-evidence',
      at: 2,
    } satisfies KnowledgeAction);

    render(<Harness store={fakeStore(replaced)} />);
    const warning = screen.getByText(/这条出处来自另一个文件版本/);
    const row = warning.closest('li');
    if (row === null) throw new Error('no evidence row');
    expect(within(row).getByRole('button', { name: '打开原文' })).toBeDisabled();
    // The occurrence read from the paper's current file is still reachable.
    const fresh = screen
      .getAllByRole('button', { name: '打开原文' })
      .filter((button) => !button.hasAttribute('disabled'));
    expect(fresh).toHaveLength(1);
  });

  /** A store whose snapshot is the given state, for asserting what a state renders as. */
  function fakeStore(state: KnowledgeState): KnowledgeStore {
    // `getSnapshot` must return the same object every time, or React re-renders forever.
    const snapshot = {
      state,
      persisted: true,
      issue: null,
      dropped: 0,
      writesBlocked: false,
    };
    return {
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
      dispatch: () => undefined,
    };
  }
});

describe('KnowledgeView: candidates from reading records', () => {
  function seedDifficulty(): void {
    window.localStorage.setItem(
      DIFFICULTY_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        pages: {
          [`${SHA_A}|1|mock-1|d1`]: {
            paperId: 'paper-1',
            pdfSha256: SHA_A,
            page: 1,
            model: 'mock-1',
            rulesVersion: 'd1',
            analysedAt: 1,
            rejected: 0,
            suggestions: [
              {
                id: 'd-1',
                paperId: 'paper-1',
                pdfSha256: SHA_A,
                page: 1,
                kind: 'concept',
                title: 'KZG commitment',
                quote: 'the commitment binds the polynomial',
                why: '它决定了后面所有验证等式。',
                quick: '先把多项式固定住，之后才能用很小的证明核对它。',
                deeper: null,
                location: 'found',
                anchor: {
                  quote: 'the commitment binds the polynomial',
                  prefix: '',
                  suffix: '',
                  rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }],
                  start: 0,
                  end: 10,
                },
                model: 'mock-1',
                analysedAt: 1,
              },
            ],
          },
        },
        ignored: {},
      }),
    );
  }

  it('proposes a concept from the difficulty cache, and adds it only when asked', async () => {
    seedDifficulty();
    const { store } = setup();
    await userEvent.click(screen.getByRole('button', { name: /从阅读记录整理/ }));

    const panel = screen.getByRole('group', { name: '概念建议' });
    expect(within(panel).getByText('KZG commitment')).toBeInTheDocument();
    expect(within(panel).getByText(/1 处出处/)).toBeInTheDocument();
    // Nothing is added until the reader says so.
    expect(store.getSnapshot().state.concepts).toHaveLength(0);

    await userEvent.click(within(panel).getByRole('button', { name: '添加为待确认概念' }));
    const state = store.getSnapshot().state;
    expect(state.concepts).toHaveLength(1);
    expect(state.concepts[0]?.status).toBe('suggested');
    expect(state.concepts[0]?.origin).toBe('ai');
    expect(state.evidence).toHaveLength(1);
    expect(within(screen.getByLabelText('概念列表')).getAllByText('待确认').length).toBeGreaterThan(
      0,
    );
  });

  it('says so when there is nothing cached to work from', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: /从阅读记录整理/ }));
    expect(screen.getByRole('status')).toHaveTextContent(/还没有已缓存的难点分析/);
  });

  it('never merges a candidate with a concept of the same name', async () => {
    seedDifficulty();
    const { store } = setup();
    await createConcept('KZG commitment');
    await userEvent.click(screen.getByRole('button', { name: /从阅读记录整理/ }));
    const panel = screen.getByRole('group', { name: '概念建议' });
    expect(within(panel).getByText(/不会自动合并/)).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: '添加为待确认概念' }));
    expect(store.getSnapshot().state.concepts).toHaveLength(2);
  });
});

describe('KnowledgeView: persistence', () => {
  it('saves to storage and survives a reload of the store', async () => {
    const disk = memory();
    const store = createKnowledgeStore(disk);
    render(<Harness store={store} />);
    await createConcept('KZG commitment');

    expect(disk.items.get(KNOWLEDGE_STORAGE_KEY)).toContain('KZG commitment');
    const reloaded = createKnowledgeStore(disk);
    expect(reloaded.getSnapshot().state.concepts).toHaveLength(1);
  });

  it('warns when a change could not be saved', async () => {
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    const store = createKnowledgeStore(failing);
    render(<Harness store={store} />);
    await createConcept('KZG commitment');
    expect(screen.getByRole('status')).toHaveTextContent(/没有保存到本地存储/);
  });

  it('report a partially unreadable payload rather than staying silent', () => {
    const disk = memory({
      [KNOWLEDGE_STORAGE_KEY]: JSON.stringify({
        version: 1,
        concepts: [
          {
            id: 'ok',
            name: 'KZG',
            aliases: [],
            summary: '',
            origin: 'user',
            status: 'confirmed',
            projectIds: ['project-1'],
            createdAt: 1,
            updatedAt: 1,
          },
          { id: 'bad' },
        ],
        evidence: [],
        relations: [],
      }),
    });
    const store = createKnowledgeStore(disk);
    render(<Harness store={store} />);
    expect(screen.getByRole('status')).toHaveTextContent(/有一部分无法读取/);
    expect(within(screen.getByLabelText('概念列表')).getByText('KZG')).toBeInTheDocument();
  });
});

describe('KnowledgeView: the empty state does not invent anything', () => {
  it('shows no relations and no evidence for a fresh concept', async () => {
    setup();
    await createConcept('Lonely');
    const detail = screen.getByRole('region', { name: '概念：Lonely' });
    expect(within(detail).getByText(/还没有记录它依赖什么/)).toBeInTheDocument();
    expect(within(detail).getByText(/还没有原文出处/)).toBeInTheDocument();
    expect(within(detail).getByText(/0 篇论文里/)).toBeInTheDocument();
  });
});

describe('unknown actions', () => {
  it('are ignored by the reducer', () => {
    const state = knowledgeReducer(EMPTY_KNOWLEDGE, {
      type: 'relation/delete',
      id: 'nothing',
    } satisfies KnowledgeAction);
    expect(state).toEqual(EMPTY_KNOWLEDGE);
  });
});

describe('KnowledgeView: concepts across projects', () => {
  it('joins another project, opens it, and leaves without deleting anything', async () => {
    const second = { ...PROJECT, id: 'project-2', name: 'Second Project' };
    const disk = memory();
    const store = createKnowledgeStore(disk);
    store.dispatch({
      type: 'concept/create',
      input: { name: 'Shared idea', projectIds: ['project-1'] },
      id: 'concept-1',
      at: 1,
    });
    store.dispatch({
      type: 'evidence/add',
      input: {
        conceptId: 'concept-1',
        paperId: 'paper-1',
        pdfSha256: SHA_A,
        page: 1,
        quote: 'a quotation',
        rects: [],
        source: 'manual',
      },
      id: 'evidence-1',
      at: 2,
    });
    const onOpenProject = vi.fn();
    render(<Harness store={store} projects={[PROJECT, second]} onOpenProject={onOpenProject} />);
    const detail = screen.getByRole('region', { name: '概念：Shared idea' });

    await userEvent.selectOptions(
      within(detail).getByRole('combobox', { name: '加入项目' }),
      'project-2',
    );
    await userEvent.click(within(detail).getByRole('button', { name: '加入项目' }));
    expect(store.getSnapshot().state.concepts[0]?.projectIds).toEqual(['project-1', 'project-2']);

    await userEvent.click(within(detail).getByRole('button', { name: 'Second Project' }));
    expect(onOpenProject).toHaveBeenCalledWith('project-2');

    await userEvent.click(
      within(detail).getByRole('button', { name: '从《A Study》移出这个概念' }),
    );
    expect(store.getSnapshot().state.concepts[0]?.projectIds).toEqual(['project-2']);
    // The occurrence is untouched: leaving a project is a view change, not a deletion.
    expect(store.getSnapshot().state.evidence).toHaveLength(1);
  });

  it('marks a concept that has no quotation behind it', () => {
    const disk = memory();
    const store = createKnowledgeStore(disk);
    store.dispatch({
      type: 'concept/create',
      input: { name: 'Bare idea', projectIds: ['project-1'] },
      id: 'concept-1',
      at: 1,
    });
    render(<Harness store={store} />);
    expect(screen.getByText('尚无出处')).toBeInTheDocument();
  });
});
