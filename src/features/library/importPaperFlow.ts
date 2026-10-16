import type { PaperPdf } from '../../domain/pdfFile';
import { normalizeName } from '../../domain/normalize';
import {
  resolvePaperIdentity,
  type AddPaperOutcome,
  type Paper,
  type PaperEdit,
  type PaperEditFailure,
  type PaperEditResult,
  type PaperInput,
  type PaperReferenceOutcome,
} from '../../domain/papers';

/**
 * What the user asked for. The four cases stay separate all the way down:
 * importing a new paper, recognising an existing one, attaching a file to a paper, and
 * referencing a paper from a project are different operations with different consequences.
 */
export type ImportIntent =
  /** Import the file as a paper. An existing paper identified by DOI/arXiv is reused. */
  | { kind: 'new-paper'; projectId: string | null }
  /** Attach the file to the named paper, leaving every other paper alone. */
  | { kind: 'attach-file'; paperId: string; projectId: string | null };

export interface ImportPorts {
  /** The current registry, for identity checks that must happen before anything is written. */
  papers: Record<string, Paper>;
  updatePaper: (paperId: string, edit: PaperEdit) => PaperEditResult;
  referencePaper: (projectId: string, input: PaperInput) => PaperReferenceOutcome;
  addPaper: (input: PaperInput) => AddPaperOutcome;
  linkPaper: (projectId: string, paperId: string) => void;
}

export type ImportCommit =
  /** A new paper record was created with the file attached. */
  | { status: 'created'; paperId: string }
  /** A paper already in the knowledge base was identified; the file was attached to it. */
  | { status: 'recognised'; paperId: string }
  /** The file was attached to the paper the user named. */
  | { status: 'attached'; paperId: string }
  /** Nothing was written; the message says why, in the user's terms. */
  | { status: 'refused'; message: string };

function label(field: 'doi' | 'arxivId'): string {
  return field === 'doi' ? 'DOI' : 'arXiv ID';
}

/** The user-facing reason an edit was refused. Never a code or a stack trace. */
export function describeEditFailure(failure: PaperEditFailure): string {
  switch (failure.reason) {
    case 'blank-title':
      return '请填写论文标题。';
    case 'invalid-year':
      return '年份不是一个有效的数字。';
    case 'invalid-identifier':
      return `无法识别这个 ${label(failure.field)}：${failure.value}`;
    case 'identifier-taken':
      return `这个 ${label(failure.field)} 已经属于《${failure.paper.title}》，没有改动，也没有合并这两篇论文。`;
    case 'unknown-paper':
      return '找不到这篇论文，可能已被删除。';
  }
}

/** Fields typed in the form, plus the PDF being imported. Empty identifiers clear a field. */
function editFrom(fields: PaperInput, pdf: PaperPdf): PaperEdit {
  const edit: PaperEdit = { pdf };
  edit.title = fields.title;
  edit.authors = fields.authors ?? [];
  if (fields.year !== undefined) edit.year = fields.year;
  if (fields.doi !== undefined) edit.doi = fields.doi === '' ? null : fields.doi;
  if (fields.arxivId !== undefined) edit.arxivId = fields.arxivId === '' ? null : fields.arxivId;
  return edit;
}

/**
 * Writes one import to the registry.
 *
 * Everything identity-related happens here, before any dispatch: identifiers are resolved
 * against the current registry, a conflict stops the import with a message, and only then
 * is the paper created, recognised or extended. The bytes are already stored by the time
 * this runs, so a refusal here leaves the file in the blob store and nothing else.
 */
export function commitImport(
  ports: ImportPorts,
  intent: ImportIntent,
  fields: PaperInput,
  pdf: PaperPdf,
): ImportCommit {
  // Checked before anything else so a blank title cannot reach the store at all.
  if (normalizeName(fields.title) === null)
    return { status: 'refused', message: '请填写论文标题。' };

  if (intent.kind === 'attach-file') {
    const result = ports.updatePaper(intent.paperId, editFrom(fields, pdf));
    if (!result.ok) return { status: 'refused', message: describeEditFailure(result.failure) };
    if (intent.projectId !== null) ports.linkPaper(intent.projectId, intent.paperId);
    return { status: 'attached', paperId: intent.paperId };
  }

  const identity = resolvePaperIdentity(ports.papers, fields);
  if (identity.kind === 'conflict') {
    const [first, second] = identity.papers;
    return {
      status: 'refused',
      message: `DOI 与 arXiv ID 分别指向《${first?.title ?? '?'}》和《${second?.title ?? '?'}》，没有导入。请去掉其中一个再试。`,
    };
  }

  if (identity.kind === 'match') {
    // The file belongs to a paper we already know: attach it there rather than creating a
    // second record for the same work.
    const result = ports.updatePaper(identity.paper.id, editFrom(fields, pdf));
    if (!result.ok) return { status: 'refused', message: describeEditFailure(result.failure) };
    if (intent.projectId !== null) ports.linkPaper(intent.projectId, identity.paper.id);
    return { status: 'recognised', paperId: identity.paper.id };
  }

  const outcome =
    intent.projectId === null
      ? ports.addPaper({ ...fields, pdf })
      : ports.referencePaper(intent.projectId, { ...fields, pdf });
  if (outcome.status === 'conflict') {
    return { status: 'refused', message: '这篇论文的身份与库里已有的记录冲突，没有导入。' };
  }
  if (outcome.status === 'invalid') {
    return { status: 'refused', message: '请填写论文标题。' };
  }
  return { status: 'created', paperId: outcome.paper.id };
}
