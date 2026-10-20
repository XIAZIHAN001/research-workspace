import { useState, type SubmitEvent } from 'react';
import { FileText, Upload } from 'lucide-react';
import { MAX_NAME_LENGTH } from '../../domain/normalize';
import type { Paper, PaperInput } from '../../domain/papers';
import type { PaperPdf, PdfBytes } from '../../domain/pdfFile';
import type { Project } from '../../domain/project';
import type { PdfBlobStore } from '../../services/pdfStore';
import { readPdfMetadata, type PdfMetadata } from '../reader/pdfjs';
import { Dialog } from '../../ui/Dialog';
import { preparePdfImport, type ProbePdf } from './importPdf';
import type { ImportCommit, ImportIntent } from './importPaperFlow';

/**
 * Reads a PDF's information dictionary.
 *
 * Injectable for the same reason `probe` is: the tests need a deterministic answer without
 * building a real PDF. Consumes the bytes it is given, like `probe`.
 */
export type ReadPdfMetadata = (bytes: PdfBytes) => Promise<PdfMetadata>;

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
  /** Reads a PDF's own title/author/year/DOI. Defaults to the pdf.js-backed reader. */
  readMetadata?: ReadPdfMetadata;
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
  readMetadata = readPdfMetadata,
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
  /** Set while the PDF's own metadata is being read, so the form can say so honestly. */
  const [readingMeta, setReadingMeta] = useState(false);
  /** Bumped per chosen file, so a slow read from an earlier file cannot land on this one. */
  const [metaToken, setMetaToken] = useState(0);

  const fields = (): PaperInput => {
    const parsedYear = year.trim() === '' ? undefined : Number(year);    return {
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

  /**
   * Fills the empty fields from the PDF's own metadata.
   *
   * Importing is mostly a case of "the paper already knows its own title, author and year", and
   * making the reader retype them is the single most tedious part of the form. Only empty
   * fields are touched, so anything already on the paper — or already typed — is never
   * overwritten. A PDF that carries no usable metadata simply leaves the form as it was; this
   * is a convenience, never a requirement, so nothing here can fail the import.
   */
  const fillFromMetadata = async (chosen: File, token: number): Promise<void> => {
    setReadingMeta(true);
    try {
      const bytes = await chosen.arrayBuffer();
      if (token !== metaToken) return;
      const meta = await readMetadata(bytes as PdfBytes);
      if (token !== metaToken) return;

      if (meta.title !== undefined && meta.title !== '') {
        setTitle((current) => (current.trim() === '' ? meta.title ?? current : current));
      }
      if (meta.authors !== undefined && meta.authors.length > 0) {
        const joined = meta.authors.join(', ');
        setAuthors((current) => (current.trim() === '' ? joined : current));
      }
      if (meta.year !== undefined) {
        const asText = String(meta.year);
        setYear((current) => (current.trim() === '' ? asText : current));
      }
      if (meta.doi !== undefined && meta.doi !== '') {
        setDoi((current) => (current.trim() === '' ? meta.doi ?? current : current));
      }
    } catch {
      // Reading metadata is best-effort. The form stays exactly as the reader left it.
    } finally {
      if (token === metaToken) setReadingMeta(false);
    }
  };

  const write = (pdf: PaperPdf, reuse: Paper | null): void => {    const intent: ImportIntent =
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
      {/*
        The file input is a real `<input type="file">` — it is the only way to get the browser's
        file picker, its drag-and-drop, and its accessibility — but it is never seen. A label
        styled as a drop zone takes its place, and the input itself is pulled out of the layout
        and kept focusable so keyboard and screen-reader users reach the same picker.
      */}
      <div className="field">
        <span className="field-label" id="pdf-file-label">
          PDF 文件
        </span>
        <input
          type="file"
          accept="application/pdf,.pdf"
          className="file-input-native"
          data-autofocus
          aria-labelledby="pdf-file-label"
          onChange={(event) => {
            const chosen = event.target.files?.[0] ?? null;
            setFile(chosen);
            setError(null);
            setPending(null);
            if (chosen === null) {
              setMetaToken((token) => token + 1);
              setReadingMeta(false);
              return;
            }
            // The file name is the weakest possible title, so it is only a last resort: the
            // PDF's own metadata is about to be read and will replace this if it has one.
            if (title.trim() === '') setTitle(titleFromFile(chosen.name));
            const token = metaToken + 1;
            setMetaToken(token);
            void fillFromMetadata(chosen, token);
          }}
        />
        <label className={`file-drop${file === null ? '' : ' file-drop-filled'}`}>
          <input
            type="file"
            accept="application/pdf,.pdf"
            className="file-input-native"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const chosen = event.target.files?.[0] ?? null;
              if (chosen !== null) {
                // Route through the same path as the primary input by asking the form's own
                // file input to take it, so there is one place that reacts to a chosen file.
                const primary = event.currentTarget.form?.querySelector<HTMLInputElement>(
                  'input[data-autofocus]',
                );
                if (primary !== null && primary !== null) {
                  const transfer = new DataTransfer();
                  transfer.items.add(chosen);
                  primary.files = transfer.files;
                  primary.dispatchEvent(new Event('change', { bubbles: true }));
                }
              }
            }}
          />
          <span className="file-drop-icon" aria-hidden="true">
            {file === null ? <Upload size={18} /> : <FileText size={18} />}
          </span>
          <span className="file-drop-text">
            {file === null ? (
              <>
                <span className="file-drop-title">选择 PDF 文件</span>
                <span className="file-drop-hint">或把文件拖到这里</span>
              </>
            ) : (
              <>
                <span className="file-drop-title">{file.name}</span>
                <span className="file-drop-hint">
                  {readingMeta
                    ? '正在读取标题、作者与年份…'
                    : `${(file.size / 1024).toFixed(0)} KB · 点击可重新选择`}
                </span>
              </>
            )}
          </span>
        </label>
      </div>

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
