import {
  RELATION_KIND_LABEL,
  RELATION_SUPPORT_LABEL,
  type Concept,
  type ConceptEvidence,
  type ConceptRelation,
} from './knowledge';
import type { Paper } from './papers';
import type { Project } from './project';

export interface KnowledgeMarkdownInput {
  project: Project;
  /** Every paper the workspace knows, keyed by id, for evidence titles. */
  papers: Readonly<Record<string, Paper>>;
  /** Every concept in the workspace; concepts outside this project are left out. */
  concepts: readonly Concept[];
  evidence: readonly ConceptEvidence[];
  relations: readonly ConceptRelation[];
  exportedAt?: Date;
}

const STATUS_LABEL: Record<Concept['status'], string> = {
  confirmed: '已确认',
  suggested: '待确认',
};

const paperTitle = (papers: Readonly<Record<string, Paper>>, id: string): string =>
  papers[id]?.title ?? '这篇论文不在本地论文库里';

function formatTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * A project's knowledge graph as Markdown.
 *
 * Only knowledge that belongs to this project is exported: a concept shared with another project
 * is still this project's to show, but a relation whose other end is outside it would read as a
 * dangling arrow, so relations are kept only when both ends are in the exported set. Evidence is
 * grouped under the concept it supports, because that is the claim it exists to hold up.
 */
export function buildKnowledgeMarkdown({
  project,
  papers,
  concepts,
  evidence,
  relations,
  exportedAt = new Date(),
}: KnowledgeMarkdownInput): string {
  const owned = concepts
    .filter((concept) => concept.projectIds.includes(project.id))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const ids = new Set(owned.map((concept) => concept.id));
  const links = relations
    .filter((relation) => ids.has(relation.from) && ids.has(relation.to))
    .slice()
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.createdAt - b.createdAt);

  const lines: string[] = [
    `# ${project.name} · 知识`,
    '',
    `概念：${String(owned.length)}`,
    `关系：${String(links.length)}`,
    `导出时间：${formatTime(exportedAt)}`,
    '',
  ];

  if (owned.length === 0) {
    lines.push('这个项目还没有概念。', '');
  }

  const byId = new Map(owned.map((concept) => [concept.id, concept]));
  for (const concept of owned) {
    lines.push(`## ${concept.name}`, '', `状态：${STATUS_LABEL[concept.status]}`, '');
    if (concept.aliases.length > 0) {
      lines.push(`别名：${concept.aliases.join('、')}`, '');
    }
    if (concept.summary.trim() !== '') {
      lines.push(concept.summary.trim(), '');
    }

    const occurrences = evidence
      .filter((item) => item.conceptId === concept.id && ids.has(item.conceptId))
      .slice()
      .sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
    if (occurrences.length === 0) {
      lines.push('还没有证据。', '');
      continue;
    }

    lines.push('### 证据', '');
    for (const item of occurrences) {
      lines.push(`- 第 ${String(item.page)} 页 · 《${paperTitle(papers, item.paperId)}》`);
      if (item.quote.trim() !== '') {
        for (const quoteLine of item.quote.split('\n')) {
          lines.push(`  > ${quoteLine.trim()}`);
        }
      }
      if (item.note.trim() !== '') {
        lines.push(`  ${item.note.trim().replace(/\n/g, '\n  ')}`);
      }
    }
    lines.push('');
  }

  if (links.length > 0) {
    lines.push('## 关系', '');
    for (const relation of links) {
      const from = byId.get(relation.from)?.name ?? relation.from;
      const to = byId.get(relation.to)?.name ?? relation.to;
      const support =
        relation.support === undefined ? '' : ` · ${RELATION_SUPPORT_LABEL[relation.support]}`;
      lines.push(
        `- **${RELATION_KIND_LABEL[relation.kind]}**：${from} → ${to}${support} · ${STATUS_LABEL[relation.status]}`,
      );
      const detail =
        relation.note.trim() !== '' ? relation.note.trim() : relation.rationale?.trim();
      if (detail !== undefined && detail !== '') {
        lines.push(`  ${detail.replace(/\n/g, '\n  ')}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
