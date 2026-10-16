import { useState, type SubmitEvent } from 'react';
import { MAX_NAME_LENGTH } from '../../domain/normalize';
import type { Paper, PaperInput } from '../../domain/papers';
import type { PaperPdf } from '../../domain/pdfFile';
import type { Project } from '../../domain/project';
import type { PdfBlobStore } from '../../services/pdfStore';
import { Dialog } from '../../ui/Dialog';
import { preparePdfImport, type ProbePdf } from './importPdf';
import type { ImportCommit, ImportIntent } from './importPaperFlow';

interface ImportPaperDialogProps {
  open: boolean;
  onClose: () => void;
  /** `new` imports a paper; `attach` gives a file to a paper that already exists. */
  mode: 'new' | 'attach';
  targetPaper: Paper | null;
  projects: Project[];
  initialProjectId: string | null;
  papers: Record<string, Paper>;
  blobs: PdfBlobStore;
  probe: ProbePdf;
  /** Writes the import once the file is safely stored. */
  onCommit: (intent: ImportIntent, fields: PaperInput, pdf: PaperPdf) => ImportCommit;
  /** Called after a successful write, e.g. to open the reader. */
  onCommitted: (commit: ImportCommit) => void;
}

export function ImportPaperDialog(props: ImportPaperDialogProps) {
  return (
    <Dialog
      open={props.open}
      title={props.mode === 'new' ? '导入论文' : '导入 PDF 文件'}
      onClose={props.onClose}
    >
      <ImportForm {...props} />
    </Dialog>
  );
}

/** File name without its extension, tidied up: "attention_is_all_you_need.pdf" → readable. */
function titleFromFile(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

function ImportForm({
  mode,
  targetPaper,
  projects,
  initialProjectId,
  papers,
  blobs,
  probe,
  onCommit,
  onCommitted,
  onClose,
}: ImportPaperDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState(targetPaper?.title ?? '');
  const [authors, setAuthors] = useState((targetPaper?.authors ?? []).join(', '));
  const [year, setYear] = useState(targetPaper?.year === undefined ? '' : String(targetPaper.year));
  const [doi, setDoi] = useState(targetPaper?.doi ?? '');
  const [arxivId, setArxivId] = useState(targetPaper?.arxivId ?? '');
  const [projectId, setProjectId] = useState(initialProjectId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ pdf: PaperPdf; duplicateOf: Paper } | null>(null);
  /** Worth telling the reader, not worth stopping for: the same bytes, on another paper. */
  const [duplicateNote, setDuplicateNote] = useState<string | null>(null);

  const fields = (): PaperInput => {
    const parsedYear = year.trim() === '' ? undefined : Number(year);
    return {
      title,
      authors: authors
        .split(',')
        .map((author) => author.trim())
        .filter((author) => author !== ''),
      ...(parsedYear === undefined || Number.isFinite(parsedYear) ? { year: parsedYear } : {}),
      doi: doi.trim(),
      arxivId: arxivId.trim(),
    };
  };

  const write = (pdf: PaperPdf, reuse: Paper | null): void => {
    const intent: ImportIntent =
      reuse !== null
        ? { kind: 'attach-file', paperId: reuse.id, projectId: projectId === '' ? null : projectId }
        : mode === 'attach' && targetPaper !== null
          ? {
              kind: 'attach-file',
              paperId: targetPaper.id,
              projectId: projectId === '' ? null : projectId,
            }
          : { kind: 'new-paper', projectId: projectId === '' ? null : projectId };

    const outcome = onCommit(intent, fields(), pdf);
    if (outcome.status === 'refused') {
      setPending(null);
      setError(outcome.message);
      return;
    }
    onCommitted(outcome);
    onClose();
  };

  const submit = async (event: SubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (file === null) {
      setError('请选择一个 PDF 文件。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const prepared = await preparePdfImport({ blobs }, file, {
        probe,
        papers,
        attachedTo: mode === 'attach' ? (targetPaper?.id ?? null) : null,
      });
      if (prepared.status === 'failed') {
        setError(prepared.message);
        return;
      }
      const { pdf, duplicateOf } = prepared.prepared;
      // Importing a paper: the same file is not automatically the same paper, so ask.
      if (duplicateOf !== null && mode === 'new') {
        setPending({ pdf, duplicateOf });
        return;
      }
      // Attaching a file to a paper the reader already named is an explicit instruction; the
      // fact that another paper shares the file is worth saying, not worth stopping the flow.
      if (duplicateOf !== null) {
        setDuplicateNote(`这份文件和《${duplicateOf.title}》用的是同一个文件。`);
      }
      write(pdf, null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={(event) => void submit(event)} noValidate>
      <label className="field">
        <span className="field-label">PDF 文件</span>
        <input
          type="file"
          className="input"
          accept="application/pdf,.pdf"
          data-autofocus
          onChange={(event) => {
            const chosen = event.target.files?.[0] ?? null;
            setFile(chosen);
            setError(null);
            setPending(null);
            if (chosen !== null && title.trim() === '') setTitle(titleFromFile(chosen.name));
          }}
        />
      </label>

      <label className="field">
        <span className="field-label">标题</span>
        <input
          className="input"
          value={title}
          maxLength={MAX_NAME_LENGTH * 2}
          placeholder="例如 Attention Is All You Need"
          onChange={(event) => {
            setTitle(event.target.value);
            setError(null);
          }}
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span className="field-label">作者（逗号分隔）</span>
          <input
            className="input"
            value={authors}
            onChange={(event) => {
              setAuthors(event.target.value);
            }}
          />
        </label>
        <label className="field field-narrow">
          <span className="field-label">年份</span>
          <input
            className="input"
            inputMode="numeric"
            value={year}
            onChange={(event) => {
              setYear(event.target.value);
            }}
          />
        </label>
      </div>

      <label className="field">
        <span className="field-label">DOI（可留空）</span>
        <input
          className="input"
          value={doi}
          placeholder="10.1000/xyz"
          onChange={(event) => {
            setDoi(event.target.value);
            setError(null);
          }}
        />
      </label>

      <label className="field">
        <span className="field-label">arXiv ID（可留空）</span>
        <input
          className="input"
          value={arxivId}
          placeholder="2401.12345"
          onChange={(event) => {
            setArxivId(event.target.value);
            setError(null);
          }}
        />
      </label>

      <label className="field">
        <span className="field-label">加入</span>
        <select
          className="input"
          value={projectId}
          onChange={(event) => {
            setProjectId(event.target.value);
          }}
        >
          <option value="">仅加入论文库</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>

      {pending !== null && (
        <div className="hint" role="status">
          <p>
            这个文件和《{pending.duplicateOf.title}
            》用的是同一份文件（内容哈希相同）。同一份文件不代表同一篇论文。
          </p>
          <div className="dialog-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                write(pending.pdf, null);
              }}
            >
              仍然新建一篇论文
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                write(pending.pdf, pending.duplicateOf);
              }}
            >
              加入《{pending.duplicateOf.title}》
            </button>
          </div>
        </div>
      )}

      {duplicateNote !== null && <p className="hint">{duplicateNote}</p>}

      {error !== null && (
        <p className="hint hint-error" role="alert">
          {error}
        </p>
      )}

      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? '正在读取文件…' : '导入'}
        </button>
      </div>
    </form>
  );
}
