import { describe, expect, it } from 'vitest';
import type { Annotation } from './annotation';
import type { Concept, ConceptEvidence } from './knowledge';
import { buildPaperReport, reportFileName } from './paperReport';
import type { Paper } from './papers';
import type { Project } from './project';

const paper: Paper = {
  id: 'pa',
  title: 'Attention Is All You Need',
  authors: ['Vaswani', 'Shazeer'],
  year: 2017,
  doi: '10.5555/3295222',
  pdf: { sha256: 'a'.repeat(64), pageCount: 15, bytes: 1000, name: 'a.pdf', addedAt: 1 },
  reading: { page: 9, updatedAt: 50 },
  status: 'reading',
  createdAt: 1,
  updatedAt: 2,
};

const projects: Project[] = [
  {
    id: 'p1',
    name: '精读 Transformer',
    corePaperId: 'pa',
    relatedPaperIds: [],
    createdAt: 0,
    updatedAt: 0,
  },
];

const note = (id: string, overrides: Partial<Annotation> = {}): Annotation => ({
  id,
  paperId: 'pa',
  pdfSha256: 'a'.repeat(64),
  page: 3,
  quote: 'scaled dot-product attention',
  prefix: '',
  suffix: '',
  rects: [{ x: 0.1, y: 0.1, width: 0.5, height: 0.02 }],
  kind: 'question',
  note: '为什么除以 √d？',
  origin: 'user',
  sourceLabel: '',
  createdAt: 10,
  updatedAt: 11,
  ...overrides,
});

const concept: Concept = {
  id: 'c1',
  name: 'Self-attention',
  aliases: [],
  summary: '序列内每对位置直接交换信息。',
  origin: 'user',
  status: 'confirmed',
  projectIds: ['p1'],
  createdAt: 1,
  updatedAt: 1,
};

const evidence: ConceptEvidence = {
  id: 'e1',
  conceptId: 'c1',
  paperId: 'pa',
  pdfSha256: 'a'.repeat(64),
  page: 3,
  quote: 'scaled dot-product attention',
  prefix: '',
  suffix: '',
  rects: [{ x: 0.1, y: 0.1, width: 0.5, height: 0.02 }],
  source: 'annotation',
  note: '',
  createdAt: 5,
};

describe('buildPaperReport', () => {
  it('marks notes made on an older PDF file, whose page numbers no longer match', () => {
    const report = buildPaperReport({
      paper,
      annotations: [note('old', { pdfSha256: 'b'.repeat(64) })],
      knowledge: { concepts: [], evidence: [], relations: [] },
      projects: [],
    });
    expect(report).toContain('旧 PDF 文件');
  });

  it('carries the metadata: authors, year, DOI, status, position and projects', () => {
    const report = buildPaperReport({
      paper,
      annotations: [],
      knowledge: { concepts: [], evidence: [], relations: [] },
      projects,
      exportedAt: new Date('2026-10-25T08:00:00'),
    });
    expect(report).toContain('# Attention Is All You Need');
    expect(report).toContain('Vaswani、Shazeer · 2017 · DOI: 10.5555/3295222 · 在读');
    expect(report).toContain('读到第 9 / 15 页');
    expect(report).toContain('所属项目：精读 Transformer');
    expect(report).toContain('导出时间：2026-10-25 08:00');
  });

  it('lists annotations in page order with their kind, resolution and origin', () => {
    const resolved = note('q1', { resolvedAt: Date.parse('2026-10-25T09:30:00') });
    const later = note('q2', { id: 'q2', page: 7, kind: 'insight', note: '并行化关键' });
    const report = buildPaperReport({
      paper,
      annotations: [later, resolved, note('other', { paperId: 'elsewhere' })],
      knowledge: { concepts: [], evidence: [], relations: [] },
      projects: [],
    });
    const page3 = report.indexOf('### 第 3 页');
    const page7 = report.indexOf('### 第 7 页');
    expect(page3).toBeGreaterThanOrEqual(0);
    expect(page7).toBeGreaterThan(page3);
    expect(report).toContain('**疑问 · 已解决 2026-10-25 09:30 · 自己写**');
    expect(report).toContain('> scaled dot-product attention');
    expect(report).toContain('为什么除以 √d？');
    // Notes that belong to another paper never appear.
    expect(report).not.toContain('other');
  });

  it('counts the questions that are still open in the summary line', () => {
    const report = buildPaperReport({
      paper,
      annotations: [note('q1'), note('q2', { resolvedAt: 1 })],
      knowledge: { concepts: [], evidence: [], relations: [] },
      projects: [],
    });
    expect(report).toContain('批注 2 条 · 未解决疑问 1 个');
  });

  it('groups the concepts this paper grounds, with evidence quotes and relations', () => {
    const other: Concept = { ...concept, id: 'c2', name: '位置编码' };
    const report = buildPaperReport({
      paper,
      annotations: [],
      knowledge: {
        concepts: [concept, other],
        evidence: [evidence, { ...evidence, id: 'e2', paperId: 'elsewhere' }],
        relations: [
          {
            id: 'r1',
            from: 'c2',
            to: 'c1',
            kind: 'prerequisite',
            status: 'confirmed',
            origin: 'user',
            note: '',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
      projects: [],
    });
    expect(report).toContain('### Self-attention（已确认）');
    expect(report).toContain('序列内每对位置直接交换信息。');
    expect(report).toContain('[第 3 页 · 来自你的笔记] scaled dot-product attention');
    expect(report).toContain('关系：位置编码（前置知识）');
    // Evidence from another paper stays out of this paper's report.
    expect(report.match(/第 3 页 · 来自你的笔记/g)).toHaveLength(1);
  });

  it('says so honestly when there is nothing yet', () => {
    const report = buildPaperReport({
      paper,
      annotations: [],
      knowledge: { concepts: [], evidence: [], relations: [] },
      projects: [],
    });
    expect(report).toContain('还没有批注。');
    expect(report).toContain('还没有概念从这篇论文建立。');
  });
});

describe('reportFileName', () => {
  it('reuses the notes name with a label, keeping it filesystem-safe', () => {
    const named: Paper = { ...paper, title: 'A/B: C*"Long"* Title' };
    expect(reportFileName(named)).toMatch(/-阅读报告\.md$/);
    expect(reportFileName(named)).not.toMatch(/[\\/:*?"<>|]/);
  });
});

describe('summary card and glossary in the report', () => {
  it('carries the AI summary with its provenance and a stale marker after a file swap', () => {
    const sha = 'a'.repeat(64);
    const report = buildPaperReport({
      paper: {
        ...paper,
        summary: {
          text: '问题：X。方法：Y。结论：Z。',
          pdfSha256: 'b'.repeat(64),
          provider: 'mock',
          providerLabel: '本地模拟',
          model: 'mock-1',
          online: false,
          createdAt: Date.parse('2026-10-25T08:00:00'),
        },
      },
      annotations: [],
      knowledge: { concepts: [], evidence: [], relations: [] },
      projects: [],
      exportedAt: new Date('2026-10-25T09:00:00'),
    });
    void sha;
    expect(report).toContain('## AI 摘要卡');
    expect(report).toContain('本地模拟 · mock-1 · 本地模拟 · 生成于 2026-10-25 08:00');
    expect(report).toContain('生成自另一个 PDF 版本');
    // Without an origin hash the card is carried and claims nothing about staleness.
    const quiet = buildPaperReport({
      paper: {
        ...paper,
        summary: {
          text: 't',
          provider: 'm',
          providerLabel: 'l',
          model: 'm',
          online: false,
          createdAt: 1,
        },
      },
      annotations: [],
      knowledge: { concepts: [], evidence: [], relations: [] },
      projects: [],
    });
    expect(quiet).not.toContain('另一个 PDF 版本');
  });

  it('lists only this paper’s glossary terms, alphabetically', () => {
    const report = buildPaperReport({
      paper,
      annotations: [],
      knowledge: { concepts: [], evidence: [], relations: [] },
      projects: [],
      glossary: [
        {
          id: 'g2',
          paperId: 'pa',
          term: 'SNARK',
          definition: '简洁证明',
          createdAt: 1,
          updatedAt: 1,
        },
        { id: 'g1', paperId: 'pa', term: 'KZG', definition: '', createdAt: 1, updatedAt: 1 },
        { id: 'g3', paperId: 'other', term: '别篇', definition: '', createdAt: 1, updatedAt: 1 },
      ],
    });
    const section = report.slice(report.indexOf('## 术语表'));
    expect(section).toContain('- **KZG**');
    expect(section.indexOf('KZG')).toBeLessThan(section.indexOf('SNARK'));
    expect(section).toContain('- **SNARK**：简洁证明');
    expect(section).not.toContain('别篇');
    // No glossary at all: the section stays away entirely.
    const bare = buildPaperReport({
      paper,
      annotations: [],
      knowledge: { concepts: [], evidence: [], relations: [] },
      projects: [],
    });
    expect(bare).not.toContain('## 术语表');
  });
});
