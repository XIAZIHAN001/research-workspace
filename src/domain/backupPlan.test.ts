import { describe, expect, it } from 'vitest';
import type { Annotation } from './annotation';
import type { Paper } from './papers';
import type { Project } from './project';
import type { ProjectsState } from './projectsState';
import type { Concept, ConceptEvidence, ConceptRelation, KnowledgeState } from './knowledge';
import type { DifficultyPageRecord, DifficultyState } from './difficulty';
import {
  EMPTY_PREFERENCES,
  DEFAULT_RESTORE_CHOICE,
  collectConflicts,
  mergeRestore,
  parseBackupData,
  planRestore,
  type BackupContents,
} from './backupPlan';

const SHA_A = 'a'.repeat(64);
const NOW = 1_700_000_000_000;

function paper(id: string, title: string, extra: Partial<Paper> = {}): Paper {
  return { id, title, authors: [], createdAt: 1, updatedAt: 1, ...extra };
}

function project(id: string, name: string, corePaperId: string, related: string[] = []): Project {
  return { id, name, corePaperId, relatedPaperIds: related, createdAt: 1, updatedAt: 1 };
}

function annotation(id: string, paperId: string, sha256 = SHA_A): Annotation {
  return {
    id,
    paperId,
    pdfSha256: sha256,
    page: 1,
    quote: 'quote',
    prefix: '',
    suffix: '',
    rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }],
    kind: 'note',
    note: '',
    origin: 'user',
    sourceLabel: '',
    createdAt: 1,
    updatedAt: 1,
  };
}

function concept(id: string, name: string, projectIds: string[]): Concept {
  return {
    id,
    name,
    aliases: [],
    summary: '',
    origin: 'user',
    status: 'confirmed',
    projectIds,
    createdAt: 1,
    updatedAt: 1,
  };
}

function evidence(id: string, conceptId: string, paperId: string, sha256 = SHA_A): ConceptEvidence {
  return {
    id,
    conceptId,
    paperId,
    pdfSha256: sha256,
    page: 1,
    quote: 'quote',
    prefix: '',
    suffix: '',
    rects: [],
    source: 'manual',
    note: '',
    createdAt: 1,
  };
}

function relation(
  id: string,
  from: string,
  to: string,
  kind: ConceptRelation['kind'] = 'prerequisite',
): ConceptRelation {
  return {
    id,
    from,
    to,
    kind,
    status: 'confirmed',
    origin: 'user',
    note: '',
    createdAt: 1,
    updatedAt: 1,
  };
}

const EMPTY_STATE: ProjectsState = { projects: [], papers: {}, annotations: [], selectedId: null };
const EMPTY_KNOWLEDGE: KnowledgeState = { version: 1, concepts: [], evidence: [], relations: [] };
const EMPTY_DIFFICULTIES: DifficultyState = { pages: {}, ignored: {} };

function source(
  projects: ProjectsState = EMPTY_STATE,
  knowledge: KnowledgeState = EMPTY_KNOWLEDGE,
  difficulties: DifficultyState = EMPTY_DIFFICULTIES,
) {
  return { projects, knowledge, difficulties };
}

function contents(overrides: Partial<BackupContents> = {}): BackupContents {
  return {
    projects: EMPTY_STATE,
    knowledge: EMPTY_KNOWLEDGE,
    difficulties: EMPTY_DIFFICULTIES,
    preferences: { ...EMPTY_PREFERENCES },
    recovery: {},
    missingFiles: [],
    ...overrides,
  };
}

function rawData(overrides: Record<string, unknown> = {}) {
  return {
    projects: {
      version: 5,
      projects: [],
      papers: {},
      annotations: [],
      selectedId: null,
    },
    knowledge: { version: 1, concepts: [], evidence: [], relations: [] },
    difficulties: { version: 1, pages: {}, ignored: {} },
    preferences: { theme: 'dark', paper: 'warm', avatar: null, difficulty: null },
    recovery: {},
    missingFiles: [],
    ...overrides,
  };
}

describe('reading a backup data section', () => {
  it('accepts a coherent workspace', () => {
    const data = rawData({
      projects: {
        version: 5,
        projects: [project('p1', '项目', 'paper1')],
        papers: {
          paper1: paper('paper1', '论文', {
            pdf: { sha256: SHA_A, name: 'a.pdf', bytes: 10, pageCount: 1, addedAt: 1 },
          }),
        },
        annotations: [annotation('n1', 'paper1')],
        selectedId: 'p1',
      },
      knowledge: {
        version: 1,
        concepts: [concept('c1', '概念', ['p1'])],
        evidence: [evidence('e1', 'c1', 'paper1')],
        relations: [],
      },
    });
    const parsed = parseBackupData(data);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.contents.projects.projects).toHaveLength(1);
    expect(parsed.contents.knowledge.concepts).toHaveLength(1);
    expect(parsed.contents.preferences.theme).toBe('dark');
  });

  it('refuses project data from a newer schema instead of dropping fields', () => {
    const parsed = parseBackupData(rawData({ projects: { ...rawData().projects, version: 99 } }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.join(' ')).toContain('更新版本');
  });

  it('refuses a graph whose evidence points at a missing paper', () => {
    const data = rawData({
      projects: {
        version: 5,
        projects: [project('p1', '项目', 'paper1')],
        papers: { paper1: paper('paper1', '论文') },
        annotations: [],
        selectedId: 'p1',
      },
      knowledge: {
        version: 1,
        concepts: [concept('c1', '概念', ['p1'])],
        evidence: [evidence('e1', 'c1', 'paper-missing')],
        relations: [],
      },
    });
    const parsed = parseBackupData(data);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.join(' ')).toContain('不存在的论文');
  });

  it('refuses a concept linked to a project the backup does not contain', () => {
    const data = rawData({
      projects: {
        version: 5,
        projects: [project('p1', '项目', 'paper1')],
        papers: { paper1: paper('paper1', '论文') },
        annotations: [],
        selectedId: 'p1',
      },
      knowledge: {
        version: 1,
        concepts: [concept('c1', '概念', ['p1', 'ghost'])],
        evidence: [],
        relations: [],
      },
    });
    expect(parseBackupData(data).ok).toBe(false);
  });

  it('reads the Phase 8.2 academic relation kinds without rewriting them', () => {
    const data = rawData({
      projects: {
        version: 5,
        projects: [project('p1', '项目', 'paper1')],
        papers: { paper1: paper('paper1', '论文') },
        annotations: [],
        selectedId: 'p1',
      },
      knowledge: {
        version: 1,
        concepts: [
          concept('c1', 'DLM', ['p1']),
          concept('c2', 'shared canvas', ['p1']),
          concept('c3', 'single primary representation', ['p1']),
        ],
        evidence: [],
        relations: [
          relation('r1', 'c1', 'c2', 'definition'),
          relation('r2', 'c2', 'c1', 'approximates'),
          relation('r3', 'c1', 'c3', 'replaces'),
        ],
      },
    });
    const parsed = parseBackupData(data);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.contents.knowledge.relations.map((entry) => entry.kind)).toEqual([
      'definition',
      'approximates',
      'replaces',
    ]);
  });

  it('keeps cosmetic problems as warnings rather than refusing the restore', () => {
    const parsed = parseBackupData(
      rawData({ preferences: { theme: 'neon', paper: 'warm', avatar: 'javascript:alert(1)' } }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.warnings.length).toBeGreaterThanOrEqual(1);
    expect(parsed.contents.preferences.theme).toBeNull();
    expect(parsed.contents.preferences.avatar).toBeNull();
  });
});

describe('merging a restore', () => {
  it('adds everything into an empty workspace', () => {
    const incoming = contents({
      projects: {
        projects: [project('p1', '项目', 'paper1', ['paper2'])],
        papers: {
          paper1: paper('paper1', '论文一', {
            pdf: { sha256: SHA_A, name: 'a.pdf', bytes: 10, pageCount: 1, addedAt: 1 },
          }),
          paper2: paper('paper2', '论文二'),
        },
        annotations: [annotation('n1', 'paper1')],
        selectedId: 'p1',
      },
      knowledge: {
        version: 1,
        concepts: [concept('c1', '概念', ['p1'])],
        evidence: [evidence('e1', 'c1', 'paper1')],
        relations: [],
      },
    });
    const merged = mergeRestore(
      source(),
      incoming,
      DEFAULT_RESTORE_CHOICE,
      { ...EMPTY_PREFERENCES },
      NOW,
    );
    expect(merged.projects.projects).toHaveLength(1);
    expect(Object.keys(merged.projects.papers)).toHaveLength(2);
    expect(merged.knowledge.concepts).toHaveLength(1);
    expect(merged.knowledge.evidence).toHaveLength(1);
    expect(merged.stats.projectsAdded).toBe(1);
    expect(merged.stats.papersAdded).toBe(2);
  });

  it('is idempotent: importing the same backup twice changes nothing the second time', () => {
    const incoming = contents({
      projects: {
        projects: [project('p1', '项目', 'paper1')],
        papers: { paper1: paper('paper1', '论文') },
        annotations: [annotation('n1', 'paper1')],
        selectedId: 'p1',
      },
      knowledge: {
        version: 1,
        concepts: [concept('c1', '概念', ['p1'])],
        evidence: [evidence('e1', 'c1', 'paper1')],
        relations: [],
      },
    });
    const once = mergeRestore(
      source(),
      incoming,
      DEFAULT_RESTORE_CHOICE,
      { ...EMPTY_PREFERENCES },
      NOW,
    );
    const twice = mergeRestore(
      source(once.projects, once.knowledge, once.difficulties),
      incoming,
      DEFAULT_RESTORE_CHOICE,
      { ...EMPTY_PREFERENCES },
      NOW,
    );
    expect(twice.stats.projectsAdded).toBe(0);
    expect(twice.stats.papersAdded).toBe(0);
    expect(twice.stats.annotationsAdded).toBe(0);
    expect(twice.stats.conceptsAdded).toBe(0);
    expect(twice.projects).toEqual(once.projects);
    expect(twice.knowledge).toEqual(once.knowledge);
  });

  it('joins a paper that already exists under the same DOI and rewrites every reference', () => {
    const currentProjects: ProjectsState = {
      projects: [project('pLocal', '本地项目', 'localPaper')],
      papers: {
        localPaper: paper('localPaper', '同一篇论文', { doi: '10.1000/x', pdf: undefined }),
      },
      annotations: [],
      selectedId: 'pLocal',
    };
    const incoming = contents({
      projects: {
        projects: [project('pRemote', '备份项目', 'remotePaper')],
        papers: {
          remotePaper: paper('remotePaper', '同一篇论文（备份）', {
            doi: '10.1000/x',
            pdf: { sha256: SHA_A, name: 'x.pdf', bytes: 10, pageCount: 1, addedAt: 1 },
          }),
        },
        annotations: [annotation('nRemote', 'remotePaper')],
        selectedId: 'pRemote',
      },
      knowledge: {
        version: 1,
        concepts: [concept('c1', '概念', ['pRemote'])],
        evidence: [evidence('eRemote', 'c1', 'remotePaper')],
        relations: [],
      },
    });

    const merged = mergeRestore(
      source(currentProjects),
      incoming,
      DEFAULT_RESTORE_CHOICE,
      { ...EMPTY_PREFERENCES },
      NOW,
    );

    expect(merged.stats.papersAdded).toBe(0);
    expect(merged.stats.papersMergedByIdentifier).toBe(1);
    // The local record keeps its identity, title and metadata; the file it lacked is adopted.
    expect(merged.projects.papers.localPaper?.title).toBe('同一篇论文');
    expect(merged.projects.papers.localPaper?.pdf?.sha256).toBe(SHA_A);
    expect(merged.projects.papers.remotePaper).toBeUndefined();
    const added = merged.projects.projects.find((entry) => entry.id === 'pRemote');
    expect(added?.corePaperId).toBe('localPaper');
    expect(merged.projects.annotations[0]?.paperId).toBe('localPaper');
    expect(merged.knowledge.evidence[0]?.paperId).toBe('localPaper');
    expect(merged.identifierMerges[0]?.field).toBe('doi');
  });

  it('keeps the local version of a same-id conflict unless the reader says otherwise', () => {
    const currentProjects: ProjectsState = {
      projects: [],
      papers: {},
      annotations: [],
      selectedId: null,
    };
    const currentKnowledge: KnowledgeState = {
      ...EMPTY_KNOWLEDGE,
      concepts: [concept('c1', '本机名称', [])],
    };
    const incoming = contents({
      knowledge: {
        version: 1,
        concepts: [concept('c1', '备份名称', [])],
        evidence: [],
        relations: [],
      },
    });
    const kept = mergeRestore(
      source(currentProjects, currentKnowledge),
      incoming,
      DEFAULT_RESTORE_CHOICE,
      { ...EMPTY_PREFERENCES },
      NOW,
    );
    expect(kept.knowledge.concepts[0]?.name).toBe('本机名称');
    const preferred = mergeRestore(
      source(currentProjects, currentKnowledge),
      incoming,
      { ...DEFAULT_RESTORE_CHOICE, sameIdPolicy: 'prefer-backup' },
      { ...EMPTY_PREFERENCES },
      NOW,
    );
    expect(preferred.knowledge.concepts[0]?.name).toBe('备份名称');
    expect(preferred.stats.conceptsUpdated).toBe(1);
  });

  it('never merges two projects that merely share a name', () => {
    const currentProjects: ProjectsState = {
      projects: [project('pLocal', '同名项目', 'localPaper')],
      papers: { localPaper: paper('localPaper', '本地论文') },
      annotations: [],
      selectedId: 'pLocal',
    };
    const incoming = contents({
      projects: {
        projects: [project('pRemote', '同名项目', 'remotePaper')],
        papers: { remotePaper: paper('remotePaper', '备份论文') },
        annotations: [],
        selectedId: 'pRemote',
      },
    });
    const merged = mergeRestore(
      source(currentProjects),
      incoming,
      DEFAULT_RESTORE_CHOICE,
      { ...EMPTY_PREFERENCES },
      NOW,
    );
    expect(merged.projects.projects).toHaveLength(2);
    expect(merged.projects.projects.map((entry) => entry.id).sort()).toEqual(['pLocal', 'pRemote']);
  });

  it('keeps a shared concept linked to every project that still exists', () => {
    const incoming = contents({
      projects: {
        projects: [project('p1', '项目一', 'paper1'), project('p2', '项目二', 'paper1')],
        papers: { paper1: paper('paper1', '论文') },
        annotations: [],
        selectedId: 'p1',
      },
      knowledge: {
        version: 1,
        concepts: [concept('c1', '共享概念', ['p1', 'p2', 'ghost'])],
        evidence: [],
        relations: [],
      },
    });
    // `ghost` would already have been refused by parseBackupData; merge itself is defensive.
    const merged = mergeRestore(
      source(),
      incoming,
      DEFAULT_RESTORE_CHOICE,
      { ...EMPTY_PREFERENCES },
      NOW,
    );
    expect(merged.knowledge.concepts[0]?.projectIds).toEqual(['p1', 'p2']);
  });

  it('skips an imported prerequisite that would close a cycle', () => {
    const current: KnowledgeState = {
      version: 1,
      concepts: [concept('a', 'A', []), concept('b', 'B', [])],
      evidence: [],
      relations: [relation('r1', 'b', 'a')],
    };
    const incoming = contents({
      knowledge: {
        version: 1,
        concepts: [concept('a', 'A', []), concept('b', 'B', [])],
        evidence: [],
        relations: [relation('r2', 'a', 'b')],
      },
    });
    const merged = mergeRestore(
      source(EMPTY_STATE, current),
      incoming,
      DEFAULT_RESTORE_CHOICE,
      { ...EMPTY_PREFERENCES },
      NOW,
    );
    expect(merged.knowledge.relations.map((entry) => entry.id)).toEqual(['r1']);
    expect(merged.warnings.join(' ')).toContain('循环');
  });

  it('merges the difficulty cache without losing dismissals', () => {
    const page = (analysedAt: number): DifficultyPageRecord => ({
      paperId: 'paper1',
      pdfSha256: SHA_A,
      page: 1,
      model: 'mock',
      rulesVersion: 'd1',
      analysedAt,
      suggestions: [],
      rejected: 0,
    });
    const current: DifficultyState = {
      pages: { k1: page(1) },
      ignored: { [SHA_A]: ['s1'] },
    };
    const incoming = contents({
      difficulties: { pages: { k1: page(2), k2: page(3) }, ignored: { [SHA_A]: ['s2'] } },
    });
    const merged = mergeRestore(
      source(EMPTY_STATE, EMPTY_KNOWLEDGE, current),
      incoming,
      DEFAULT_RESTORE_CHOICE,
      { ...EMPTY_PREFERENCES },
      NOW,
    );
    expect(merged.difficulties.pages.k1?.analysedAt).toBe(1);
    expect(merged.difficulties.pages.k2?.analysedAt).toBe(3);
    expect(merged.difficulties.ignored[SHA_A]?.sort()).toEqual(['s1', 's2']);
  });

  it('fills missing preferences but never overrides this machine’s own', () => {
    const incoming = contents({
      preferences: {
        theme: 'light',
        paper: 'dark',
        avatar: 'data:image/png;base64,AAA',
        difficulty: null,
      },
    });
    const kept = mergeRestore(
      source(),
      incoming,
      DEFAULT_RESTORE_CHOICE,
      { theme: 'dark', paper: null, avatar: null, difficulty: null },
      NOW,
    );
    expect(kept.preferences.theme).toBeUndefined();
    expect(kept.preferences.paper).toBe('dark');
    expect(kept.preferences.avatar).toBe('data:image/png;base64,AAA');
  });
});

describe('planning a restore', () => {
  function incomingWithPdf(): BackupContents {
    return contents({
      projects: {
        projects: [project('p1', '项目', 'paper1')],
        papers: {
          paper1: paper('paper1', '论文', {
            pdf: { sha256: SHA_A, name: 'a.pdf', bytes: 100, pageCount: 1, addedAt: 1 },
          }),
        },
        annotations: [],
        selectedId: 'p1',
      },
    });
  }

  it('lists what will be added and what has to be copied', () => {
    const plan = planRestore({
      current: source(),
      currentPreferences: { ...EMPTY_PREFERENCES },
      contents: incomingWithPdf(),
      fileHashes: new Set([SHA_A]),
      fileBytes: new Map([[SHA_A, 100]]),
      presentPdfHashes: new Set(),
      availableBytes: 10_000,
      now: NOW,
    });
    expect(plan.additions).toMatchObject({ projects: 1, papers: 1 });
    expect(plan.pdfsToCopy).toEqual([SHA_A]);
    expect(plan.neededBytes).toBe(100);
    expect(plan.storageSufficient).toBe(true);
    expect(plan.missingPdfPapers).toEqual([]);
    expect(plan.blockers).toEqual([]);
  });

  it('flags a paper whose PDF is neither in the backup nor on this machine', () => {
    const plan = planRestore({
      current: source(),
      currentPreferences: { ...EMPTY_PREFERENCES },
      contents: incomingWithPdf(),
      fileHashes: new Set(),
      fileBytes: new Map(),
      presentPdfHashes: new Set(),
      availableBytes: null,
      now: NOW,
    });
    expect(plan.missingPdfPapers).toHaveLength(1);
    expect(plan.warnings.join(' ')).toContain('PDF 不在备份里');
  });

  it('does not count a PDF that is already in the blob store', () => {
    const plan = planRestore({
      current: source(),
      currentPreferences: { ...EMPTY_PREFERENCES },
      contents: incomingWithPdf(),
      fileHashes: new Set([SHA_A]),
      fileBytes: new Map([[SHA_A, 100]]),
      presentPdfHashes: new Set([SHA_A]),
      availableBytes: null,
      now: NOW,
    });
    expect(plan.pdfsToCopy).toEqual([]);
    expect(plan.neededBytes).toBe(0);
  });

  it('refuses a plan that would fill the disk', () => {
    const plan = planRestore({
      current: source(),
      currentPreferences: { ...EMPTY_PREFERENCES },
      contents: incomingWithPdf(),
      fileHashes: new Set([SHA_A]),
      fileBytes: new Map([[SHA_A, 1000]]),
      presentPdfHashes: new Set(),
      availableBytes: 100,
      now: NOW,
    });
    expect(plan.storageSufficient).toBe(false);
  });

  it('reports same-id objects whose content differs', () => {
    const currentKnowledge: KnowledgeState = {
      ...EMPTY_KNOWLEDGE,
      concepts: [concept('c1', '本机名称', [])],
    };
    const incoming = contents({
      knowledge: {
        version: 1,
        concepts: [concept('c1', '备份名称', [])],
        evidence: [],
        relations: [],
      },
    });
    const plan = planRestore({
      current: source(EMPTY_STATE, currentKnowledge),
      currentPreferences: { ...EMPTY_PREFERENCES },
      contents: incoming,
      fileHashes: new Set(),
      fileBytes: new Map(),
      presentPdfHashes: new Set(),
      availableBytes: null,
      now: NOW,
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.kind).toBe('concept');
  });

  it('blocks when an incoming identifier points at two local papers', () => {
    const currentProjects: ProjectsState = {
      projects: [],
      papers: {
        one: paper('one', '论文一', { doi: '10.1000/x' }),
        two: paper('two', '论文二', { doi: '10.1000/x' }),
      },
      annotations: [],
      selectedId: null,
    };
    const incoming = contents({
      projects: {
        projects: [],
        papers: { three: paper('three', '论文三', { doi: '10.1000/x' }) },
        annotations: [],
        selectedId: null,
      },
    });
    const plan = planRestore({
      current: source(currentProjects),
      currentPreferences: { ...EMPTY_PREFERENCES },
      contents: incoming,
      fileHashes: new Set(),
      fileBytes: new Map(),
      presentPdfHashes: new Set(),
      availableBytes: null,
      now: NOW,
    });
    expect(plan.blockers.length).toBe(1);
  });
});

describe('Phase 8: suggestion evidence in backups', () => {
  const currentProjects: ProjectsState = {
    projects: [project('p1', '项目', 'paper1')],
    papers: {
      paper1: paper('paper1', '论文一', {
        pdf: { sha256: SHA_A, name: 'a.pdf', bytes: 1, pageCount: 1, addedAt: 1 },
      }),
    },
    annotations: [],
    selectedId: 'p1',
  };
  const c1 = concept('c1', 'KZG commitment', ['p1']);
  const c2 = concept('c2', 'Bilinear pairing', ['p1']);

  it('keeps support, explanation, model and evidence links through a merge', () => {
    const occurrence: ConceptEvidence = {
      ...evidence('e1', 'c1', 'paper1'),
      relationId: 'r1',
      verification: 'located',
      source: 'ai',
    };
    const incoming: ConceptRelation = {
      ...relation('r1', 'c1', 'c2'),
      status: 'suggested',
      origin: 'ai',
      support: 'direct',
      rationale: 'the paper says so',
      provider: 'mock',
      providerLabel: '本地模拟',
      model: 'mock-1',
      rulesVersion: 'k1',
      evidenceIds: ['e1'],
    };
    const merged = mergeRestore(
      source(currentProjects, { version: 1, concepts: [c1, c2], evidence: [], relations: [] }),
      contents({
        knowledge: { version: 1, concepts: [], evidence: [occurrence], relations: [incoming] },
      }),
      DEFAULT_RESTORE_CHOICE,
      { ...EMPTY_PREFERENCES },
      NOW,
    );
    const restored = merged.knowledge.relations.find((entry) => entry.id === 'r1');
    expect(restored?.status).toBe('suggested');
    expect(restored?.support).toBe('direct');
    expect(restored?.rationale).toBe('the paper says so');
    expect(restored?.model).toBe('mock-1');
    expect(restored?.evidenceIds).toEqual(['e1']);
    expect(merged.knowledge.evidence[0]?.relationId).toBe('r1');
    expect(merged.knowledge.evidence[0]?.verification).toBe('located');
  });

  it('keeps an occurrence as concept evidence when its relation was skipped', () => {
    const current: KnowledgeState = {
      version: 1,
      concepts: [c1, c2],
      evidence: [],
      relations: [{ ...relation('r-existing', 'c2', 'c1'), status: 'confirmed' }],
    };
    const incomingKnowledge: KnowledgeState = {
      version: 1,
      concepts: [],
      evidence: [
        {
          ...evidence('e1', 'c1', 'paper1'),
          relationId: 'r-cycle',
          verification: 'verbatim',
        },
      ],
      relations: [
        {
          ...relation('r-cycle', 'c1', 'c2'),
          status: 'suggested',
          origin: 'ai',
          support: 'inferred',
          evidenceIds: ['e1'],
        },
      ],
    };
    const merged = mergeRestore(
      source(currentProjects, current),
      contents({ knowledge: incomingKnowledge }),
      DEFAULT_RESTORE_CHOICE,
      { ...EMPTY_PREFERENCES },
      NOW,
    );
    expect(merged.knowledge.relations.some((entry) => entry.id === 'r-cycle')).toBe(false);
    const kept = merged.knowledge.evidence.find((entry) => entry.id === 'e1');
    expect(kept).toBeDefined();
    expect(kept?.relationId).toBeUndefined();
  });

  it('treats different support or explanation as a same-id conflict', () => {
    const currentRelation: ConceptRelation = {
      ...relation('r1', 'c1', 'c2'),
      support: 'direct',
      rationale: 'one explanation',
    };
    const incomingRelation: ConceptRelation = {
      ...relation('r1', 'c1', 'c2'),
      support: 'inferred',
      rationale: 'one explanation',
    };
    const conflicts = collectConflicts(
      source(currentProjects, {
        version: 1,
        concepts: [c1, c2],
        evidence: [],
        relations: [currentRelation],
      }),
      contents({
        knowledge: {
          version: 1,
          concepts: [],
          evidence: [],
          relations: [incomingRelation],
        },
      }),
    );
    expect(conflicts.some((entry) => entry.kind === 'relation' && entry.id === 'r1')).toBe(true);
  });

  it('reads a Phase 7 knowledge payload and refuses dangling Phase 8 links', () => {
    const legacy = rawData({
      projects: {
        version: 5,
        projects: [project('p1', '项目', 'paper1')],
        papers: {
          paper1: paper('paper1', '论文一', {
            pdf: { sha256: SHA_A, name: 'a.pdf', bytes: 1, pageCount: 1, addedAt: 1 },
          }),
        },
        annotations: [],
        selectedId: 'p1',
      },
      knowledge: {
        version: 1,
        concepts: [c1],
        evidence: [evidence('e1', 'c1', 'paper1')],
        relations: [],
      },
    });
    expect(parseBackupData(legacy).ok).toBe(true);

    const danglingRelation = JSON.parse(JSON.stringify(legacy)) as Record<string, unknown>;
    (danglingRelation.knowledge as { evidence: unknown[] }).evidence = [
      { ...evidence('e1', 'c1', 'paper1'), relationId: 'r-missing' },
    ];
    expect(parseBackupData(danglingRelation).ok).toBe(false);

    const danglingEvidence = JSON.parse(JSON.stringify(legacy)) as Record<string, unknown>;
    (danglingEvidence.knowledge as { concepts: unknown[] }).concepts = [c1, c2];
    (danglingEvidence.knowledge as { relations: unknown[] }).relations = [
      {
        ...relation('r1', 'c1', 'c2'),
        evidenceIds: ['e-missing'],
      },
    ];
    expect(parseBackupData(danglingEvidence).ok).toBe(false);
  });
});
