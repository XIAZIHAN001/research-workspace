import { ANNOTATION_KIND_LABEL, ORIGIN_LABEL, type Annotation } from './annotation';
import type { Paper } from './papers';

export interface NotesMarkdownInput {
  paper: Paper;
  /** Notes may belong to other papers; they are filtered by `paper.id` before export. */
  annotations: readonly Annotation[];
  exportedAt?: Date;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** A timestamp a person can read in a file, in local time. */
export function formatExportTime(date: Date): string {
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Quotes every line, so a multi-line selection stays one block quote. */
function quoteBlock(quote: string): string[] {
  return quote
    .split('\n')
    .map((line) => `> ${line.trim()}`.trimEnd())
    .filter((line) => line !== '>');
}

/**
 * The reader's notes as a Markdown file they can keep, read elsewhere, or paste into a draft.
 *
 * Page grouping matters more than chronology here: a note's meaning depends on the passage it
 * was written beside, so the page order of the paper is the order the export follows, and the
 * quotation is always printed above the note rather than the other way around.
 */
export function buildNotesMarkdown({
  paper,
  annotations,
  exportedAt = new Date(),
}: NotesMarkdownInput): string {
  const notes = annotations
    .filter((annotation) => annotation.paperId === paper.id)
    .slice()
    .sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);

  const meta: string[] = [];
  if (paper.authors.length > 0) meta.push(paper.authors.join('、'));
  if (paper.year !== undefined) meta.push(String(paper.year));
  if (paper.doi !== undefined) meta.push(`DOI: ${paper.doi}`);
  else if (paper.arxivId !== undefined) meta.push(`arXiv: ${paper.arxivId}`);

  const lines: string[] = [`# ${paper.title}`, ''];
  if (meta.length > 0) lines.push(meta.join(' · '), '');
  lines.push(`笔记：${String(notes.length)} 条`, `导出时间：${formatExportTime(exportedAt)}`, '');

  if (notes.length === 0) {
    lines.push('还没有笔记。', '');
    return lines.join('\n');
  }

  let page: number | null = null;
  for (const annotation of notes) {
    if (annotation.page !== page) {
      page = annotation.page;
      lines.push(`## 第 ${String(page)} 页`, '');
    }
    lines.push(
      `**${ANNOTATION_KIND_LABEL[annotation.kind]}** · ${ORIGIN_LABEL[annotation.origin]}`,
      '',
    );
    if (annotation.quote.trim() !== '') {
      lines.push(...quoteBlock(annotation.quote), '');
    }
    if (annotation.note.trim() !== '') {
      lines.push(annotation.note.trim(), '');
    }
  }
  return lines.join('\n');
}

/**
 * A file name that survives Windows, macOS and Linux.
 *
 * The title is the part a reader will find again, so it is kept as long as a name can reasonably
 * be; the characters no file system accepts become spaces rather than disappearing, which keeps
 * words from running together.
 */
export function notesFileName(paper: Paper): string {
  const base =
    paper.title
      .replace(/[\\/:*?"<>|]/g, ' ')
      // Control characters cannot appear in a downloaded file name either.
      .replace(/\p{Cc}/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60)
      .trim() || '论文笔记';
  return `${base}.md`;
}
