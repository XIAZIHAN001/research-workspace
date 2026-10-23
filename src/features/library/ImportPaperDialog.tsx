import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { FileText, Upload } from 'lucide-react';
import { MAX_TITLE_LENGTH } from '../../domain/normalize';
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
export type ReadPdfMetadata = (bytes: PdfBytes, titleHint?: string) => Promise<PdfMetadata>;

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

/**
 * A paper title short enough to sit inside a button.
 *
 * The full title goes in the tooltip and the sentence above the buttons; the button itself only
 * has to say which paper is meant. Counted in code points so an emoji or a CJK title is never
 * cut mid-character.
 */
function shortTitle(title: string, max = 24): string {
  const characters = Array.from(title);
  return characters.length <= max ? title : `${characters.slice(0, max).join('')}…`;
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
  /**
   * Bumped per chosen file, so a slow read from an earlier file cannot land on this one.
   *
   * Kept in a ref rather than state: the read is async and compares the token it was given
   * against the current one, and a state read inside that closure is the value from the render
   * the read started in — always one behind, so every read saw itself as outdated, bailed out
   * before applying anything, and the "reading" hint never cleared.
   */
  const metaToken = useRef(0);
  /**
   * True while the title showing in the field is the one derived from the file name.
   *
   * The file name fills the title immediately on choosing a file, before the metadata read
   * has returned; the metadata's own title is better, and the field's comment promises it
   * replaces the file name. Anything the reader typed is never replaced, so the flag clears
   * the moment the field is edited by hand.
   */
  const titleIsFromFile = useRef(false);
  /**
   * The duplicate confirmation, brought into view when it appears.
   *
   * It is appended after the form's fields, so in a short window it can land below the dialog's
   * visible area — the reader answered "which file?" and got no visible question back. Scrolling
   * it into view is the minimum that makes the choice reachable without hunting for it.
   */
  const pendingRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (pending === null) return;
    pendingRef.current?.scrollIntoView({ block: 'nearest' });
  }, [pending]);

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
      const bytes = new Uint8Array(await chosen.arrayBuffer());
      if (token !== metaToken.current) return;
      // The file name is often the paper's own title, and it anchors the first-page author
      // scan when the PDF carries no title in its metadata.
      const meta = await readMetadata(bytes, titleFromFile(chosen.name));
      if (token !== metaToken.current) return;

      if (meta.title !== undefined && meta.title !== '') {
        const replacesFileName = titleIsFromFile.current;
        titleIsFromFile.current = false;
        setTitle((current) =>
          current.trim() === '' || replacesFileName ? (meta.title ?? current) : current,
        );
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
        setDoi((current) => (current.trim() === '' ? (meta.doi ?? current) : current));
      }
    } catch {
      // Reading metadata is best-effort. The form stays exactly as the reader left it.
    } finally {
      if (token === metaToken.current) setReadingMeta(false);
    }
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
              metaToken.current += 1;
              setReadingMeta(false);
              return;
            }
            // The file name is the weakest possible title, so it is only a last resort: the
            // PDF's own metadata is about to be read and will replace this if it has one.
            if (title.trim() === '') {
              setTitle(titleFromFile(chosen.name));
              titleIsFromFile.current = true;
            }
            const token = metaToken.current + 1;
            metaToken.current = token;
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
                const primary =
                  event.currentTarget.form?.querySelector<HTMLInputElement>(
                    'input[data-autofocus]',
                  );
                // `form?.` short-circuits to undefined, so both have to be excluded.
                if (primary !== null && primary !== undefined) {
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
          maxLength={MAX_TITLE_LENGTH}
          placeholder="例如 Attention Is All You Need"
          onChange={(event) => {
            setTitle(event.target.value);
            // Typed by hand: this is the reader's title now, and a later metadata read
            // must not replace it.
            titleIsFromFile.current = false;
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
        <div ref={pendingRef} className="hint" role="status">
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
              aria-label={`加入《${pending.duplicateOf.title}》`}
              title={`加入《${pending.duplicateOf.title}》`}
              onClick={() => {
                write(pending.pdf, pending.duplicateOf);
              }}
            >
              加入《{shortTitle(pending.duplicateOf.title)}》
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
