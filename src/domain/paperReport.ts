import { ANNOTATION_KIND_LABEL, ORIGIN_LABEL, type Annotation } from './annotation';
import type { Concept, ConceptEvidence } from './knowledge';
import { EVIDENCE_SOURCE_LABEL, RELATION_KIND_LABEL, type ConceptRelation } from './knowledge';
import { sortGlossary, type GlossaryEntry } from './glossary';
import { formatExportTime, notesFileName } from './notesMarkdown';
import { READING_STATUS_LABEL, paperStatus, type Paper } from './papers';
import type { Project } from './project';

export interface PaperReportInput {
  paper: Paper;
  /** All annotations; the ones for other papers are filtered out. */
  annotations: readonly Annotation[];
  /** The knowledge graph; only the parts touching this paper are used. */
  knowledge: {
    concepts: readonly Concept[];
    evidence: readonly ConceptEvidence[];
    relations: readonly ConceptRelation[];
  };
  projects: readonly Project[];
  /** The workspace glossary; entries for this paper are listed in their own section. */
  glossary?: readonly GlossaryEntry[];
  exportedAt?: Date;
}

/**
 * One paper as a self-contained Markdown report: what it is, what the reader marked and asked,
 * and which concepts it grounded. The audience is the reader six months later, or a colleague —
 * so every claim keeps its quotation and page number, the same honesty rule the app itself
 * follows when it draws evidence back into the paper.
 */
export function buildPaperReport({
  paper,
  annotations,
  knowledge,
  projects,
  glossary = [],
  exportedAt = new Date(),
}: PaperReportInput): string {
  const notes = annotations
    .filter((annotation) => annotation.paperId === paper.id)
    .slice()
    .sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
  const open = notes.filter(
    (note) => note.kind === 'question' && note.resolvedAt === undefined,
  ).length;

  const usedIn = projects
    .filter(
      (project) => project.corePaperId === paper.id || project.relatedPaperIds.includes(paper.id),
    )
    .map((project) => project.name);

  const lines: string[] = [`# ${paper.title}`, ''];

  const meta: string[] = [];
  if (paper.authors.length > 0) meta.push(paper.authors.join('、'));
  if (paper.year !== undefined) meta.push(String(paper.year));
  if (paper.doi !== undefined) meta.push(`DOI: ${paper.doi}`);
  else if (paper.arxivId !== undefined) meta.push(`arXiv: ${paper.arxivId}`);
  meta.push(READING_STATUS_LABEL[paperStatus(paper)]);
  if (meta.length > 0) lines.push(meta.join(' · '), '');

  const detail: string[] = [];
  if (paper.reading !== undefined && (paper.pdf?.pageCount ?? 0) > 0) {
    detail.push(`读到第 ${String(paper.reading.page)} / ${String(paper.pdf?.pageCount)} 页`);
  }
  if (usedIn.length > 0) detail.push(`所属项目：${usedIn.join('、')}`);
  detail.push(
    `批注 ${String(notes.length)} 条${open > 0 ? ` · 未解决疑问 ${String(open)} 个` : ''}`,
  );
  lines.push(detail.join('，'), `导出时间：${formatExportTime(exportedAt)}`, '');

  // ---- The summary card, when one exists --------------------------------------------
  if (paper.summary !== undefined) {
    const summary = paper.summary;
    const stale =
      summary.pdfSha256 !== undefined && summary.pdfSha256 !== (paper.pdf?.sha256 ?? null);
    lines.push('## AI 摘要卡', '');
    lines.push(
      `（${summary.providerLabel} · ${summary.model} · ${summary.online ? '在线' : '本地模拟'} · 生成于 ${formatExportTime(new Date(summary.createdAt))}${stale ? ' · 生成自另一个 PDF 版本' : ''}）`,
      '',
    );
    lines.push(summary.text, '');
  }

  // ---- The paper's own vocabulary ----------------------------------------------------
  const terms = sortGlossary(glossary.filter((entry) => entry.paperId === paper.id));
  if (terms.length > 0) {
    lines.push('## 术语表', '');
    for (const entry of terms) {
      lines.push(
        entry.definition === ''
          ? `- **${entry.term}**`
          : `- **${entry.term}**：${entry.definition}`,
      );
    }
    lines.push('');
  }

  // ---- Annotations, in the paper's own page order ----------------------------------
  if (notes.length === 0) {
    lines.push('## 批注', '', '还没有批注。', '');
  } else {
    lines.push('## 批注', '');
    let page: number | null = null;
    for (const note of notes) {
      if (note.page !== page) {
        page = note.page;
        lines.push(`### 第 ${String(page)} 页`, '');
      }
      const badges = [ANNOTATION_KIND_LABEL[note.kind]];
      if (note.kind === 'question' && note.resolvedAt !== undefined) {
        badges.push(`已解决 ${formatExportTime(new Date(note.resolvedAt))}`);
      }
      badges.push(ORIGIN_LABEL[note.origin]);
      lines.push(`**${badges.join(' · ')}**`, '');
      if (note.quote.trim() !== '') lines.push(...quoteBlock(note.quote), '');
      if (note.note.trim() !== '') lines.push(note.note.trim(), '');
    }
  }

  // ---- The concepts this paper grounds ----------------------------------------------
  const byConcept = new Map<string, ConceptEvidence[]>();
  for (const evidence of knowledge.evidence) {
    if (evidence.paperId !== paper.id) continue;
    const list = byConcept.get(evidence.conceptId) ?? [];
    list.push(evidence);
    byConcept.set(evidence.conceptId, list);
  }
  const conceptOrder = [...byConcept.keys()]
    .map((id) => knowledge.concepts.find((concept) => concept.id === id))
    .filter((concept): concept is Concept => concept !== undefined)
    .sort((one, other) => one.name.localeCompare(other.name, 'zh-Hans-CN'));

  if (conceptOrder.length === 0) {
    lines.push('## 涉及概念', '', '还没有概念从这篇论文建立。', '');
  } else {
    lines.push('## 涉及概念', '');
    for (const concept of conceptOrder) {
      const pieces = byConcept.get(concept.id) ?? [];
      const status = concept.status === 'confirmed' ? '已确认' : '待确认';
      lines.push(`### ${concept.name}（${status}）`, '');
      if (concept.summary.trim() !== '') lines.push(concept.summary.trim(), '');
      for (const evidence of pieces) {
        const parts = [
          `第 ${String(evidence.page)} 页`,
          EVIDENCE_SOURCE_LABEL[evidence.source] ?? '',
        ].filter((part) => part !== '');
        lines.push(`- [${parts.join(' · ')}] ${evidence.quote}`);
        if (evidence.note.trim() !== '') lines.push(`  - ${evidence.note.trim()}`);
      }
      const relations = knowledge.relations.filter(
        (relation) =>
          (relation.from === concept.id || relation.to === concept.id) &&
          relation.status === 'confirmed',
      );
      for (const relation of relations) {
        const other = knowledge.concepts.find(
          (candidate) =>
            candidate.id === (relation.from === concept.id ? relation.to : relation.from),
        );
        if (other === undefined) continue;
        lines.push(`- 关系：${other.name}（${RELATION_KIND_LABEL[relation.kind]}）`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/** Mirrors the notes file name, with a label that says what is inside. */
export function reportFileName(paper: Paper): string {
  return notesFileName(paper).replace(/\.md$/, '-阅读报告.md');
}

/** Quotes every line, so a multi-line selection stays one block quote. */
function quoteBlock(quote: string): string[] {
  return quote
    .split('\n')
    .map((line) => `> ${line.trim()}`.trimEnd())
    .filter((line) => line !== '>');
}
