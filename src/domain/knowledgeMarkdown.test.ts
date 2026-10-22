import { describe, expect, it } from 'vitest';
import type { Concept, ConceptEvidence, ConceptRelation } from './knowledge';
import { buildKnowledgeMarkdown } from './knowledgeMarkdown';
import type { Paper } from './papers';
import type { Project } from './project';

const PROJECT: Project = {
  id: 'project-1',
  name: 'Test Project',
  corePaperId: 'paper-1',
  relatedPaperIds: [],
  createdAt: 0,
  updatedAt: 0,
};

const PAPERS: Record<string, Paper> = {
  'paper-1': {
    id: 'paper-1',
    title: 'The First Paper',
    authors: ['Ada Lovelace'],
    year: 2024,
    createdAt: 0,
    updatedAt: 0,
  },
};

function concept(overrides: Partial<Concept>): Concept {
  return {
    id: 'concept-1',
    name: 'Commitment',
    aliases: [],
    summary: '',
    origin: 'user',
    status: 'confirmed',
    projectIds: [PROJECT.id],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function evidence(overrides: Partial<ConceptEvidence>): ConceptEvidence {
  return {
    id: 'evidence-1',
    conceptId: 'concept-1',
    paperId: 'paper-1',
    pdfSha256: 'sha',
    page: 3,
    quote: 'a quoted passage',
    prefix: '',
    suffix: '',
    rects: [],
    source: 'annotation',
    note: '',
    createdAt: 0,
    ...overrides,
  };
}

function relation(overrides: Partial<ConceptRelation>): ConceptRelation {
  return {
    id: 'relation-1',
    from: 'concept-1',
    to: 'concept-2',
    kind: 'prerequisite',
    status: 'confirmed',
    origin: 'user',
    note: '',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('buildKnowledgeMarkdown', () => {
  it("exports this project's concepts with their evidence", () => {
    const markdown = buildKnowledgeMarkdown({
      project: PROJECT,
      papers: PAPERS,
      concepts: [concept({})],
      evidence: [evidence({})],
      relations: [],
    });
    expect(markdown).toContain('# Test Project · 知识');
    expect(markdown).toContain('概念：1');
    expect(markdown).toContain('## Commitment');
    expect(markdown).toContain('- 第 3 页 · 《The First Paper》');
    expect(markdown).toContain('  > a quoted passage');
  });

  it('leaves out concepts that belong to another project', () => {
    const markdown = buildKnowledgeMarkdown({
      project: PROJECT,
      papers: PAPERS,
      concepts: [concept({ id: 'other', name: 'Elsewhere', projectIds: ['another'] })],
      evidence: [],
      relations: [],
    });
    expect(markdown).not.toContain('Elsewhere');
    expect(markdown).toContain('这个项目还没有概念。');
  });

  it('keeps a relation only when both ends are in this project', () => {
    const markdown = buildKnowledgeMarkdown({
      project: PROJECT,
      papers: PAPERS,
      concepts: [concept({}), concept({ id: 'concept-2', name: 'Pairing' })],
      evidence: [],
      relations: [
        relation({}),
        relation({ id: 'dangling', from: 'concept-1', to: 'outside' }),
        relation({
          id: 'outside-start',
          from: 'outside',
          to: 'concept-2',
          kind: 'extends',
          note: 'should not appear',
        }),
      ],
    });
    expect(markdown).toContain('**前置知识**：Commitment → Pairing');
    expect(markdown).not.toContain('should not appear');
    expect(markdown).toContain('关系：1');
  });

  it("shows relation support and status, and prefers the reader's note to a rationale", () => {
    const markdown = buildKnowledgeMarkdown({
      project: PROJECT,
      papers: PAPERS,
      concepts: [concept({}), concept({ id: 'concept-2', name: 'Pairing' })],
      evidence: [],
      relations: [
        relation({
          support: 'inferred',
          status: 'suggested',
          note: 'my reason',
          rationale: 'the model’s reason',
        }),
      ],
    });
    expect(markdown).toContain('模型推断 · 待确认');
    expect(markdown).toContain('my reason');
    expect(markdown).not.toContain('the model’s reason');
  });

  it('handles an empty knowledge base', () => {
    const markdown = buildKnowledgeMarkdown({
      project: PROJECT,
      papers: PAPERS,
      concepts: [],
      evidence: [],
      relations: [],
      exportedAt: new Date(2026, 9, 21, 9, 5),
    });
    expect(markdown).toContain('概念：0');
    expect(markdown).toContain('关系：0');
    expect(markdown).toContain('导出时间：2026-10-21 09:05');
  });
});
