import { useState, type SubmitEvent } from 'react';
import { MAX_NAME_LENGTH } from '../../domain/normalize';
import type { Paper, PaperEdit } from '../../domain/papers';
import { Dialog } from '../../ui/Dialog';

interface EditPaperDialogProps {
  open: boolean;
  paper: Paper | null;
  onClose: () => void;
  /** Applies the edit. Returns a message to show when it was refused, or null on success. */
  onSave: (edit: PaperEdit) => string | null;
}

/**
 * Edits one paper's metadata. The PDF file is not touched here: attaching or replacing a
 * file is its own operation with its own confirmation.
 */
export function EditPaperDialog({ open, paper, onClose, onSave }: EditPaperDialogProps) {
  return (
    <Dialog open={open} title="编辑论文信息" onClose={onClose}>
      {paper !== null && <EditForm paper={paper} onClose={onClose} onSave={onSave} />}
    </Dialog>
  );
}

function EditForm({
  paper,
  onClose,
  onSave,
}: Pick<EditPaperDialogProps, 'onClose' | 'onSave'> & { paper: Paper }) {
  const [title, setTitle] = useState(paper.title);
  const [authors, setAuthors] = useState(paper.authors.join(', '));
  const [year, setYear] = useState(paper.year === undefined ? '' : String(paper.year));
  const [doi, setDoi] = useState(paper.doi ?? '');
  const [arxivId, setArxivId] = useState(paper.arxivId ?? '');
  const [error, setError] = useState<string | null>(null);

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmedYear = year.trim();
    const edit: PaperEdit = {
      title,
      authors: authors
        .split(',')
        .map((author) => author.trim())
        .filter((author) => author !== ''),
      year: trimmedYear === '' ? null : Number(trimmedYear),
      // An emptied field clears the identifier rather than keeping the old one.
      doi: doi.trim() === '' ? null : doi.trim(),
      arxivId: arxivId.trim() === '' ? null : arxivId.trim(),
    };
    const message = onSave(edit);
    if (message === null) onClose();
    else setError(message);
  };

  return (
    <form className="form" onSubmit={submit} noValidate>
      <label className="field">
        <span className="field-label">标题</span>
        <input
          className="input"
          value={title}
          maxLength={MAX_NAME_LENGTH * 2}
          data-autofocus
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
              setError(null);
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
              setError(null);
            }}
          />
        </label>
      </div>
      <label className="field">
        <span className="field-label">DOI（留空表示清除）</span>
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
        <span className="field-label">arXiv ID（留空表示清除）</span>
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
      {error !== null && (
        <p className="hint hint-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
        <button type="submit" className="btn btn-primary">
          保存
        </button>
      </div>
    </form>
  );
}
