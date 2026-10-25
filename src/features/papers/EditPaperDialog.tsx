import { CloudDownload } from 'lucide-react';
import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { MAX_TITLE_LENGTH } from '../../domain/normalize';
import {
  paperStatus,
  READING_STATUSES,
  READING_STATUS_LABEL,
  type Paper,
  type PaperEdit,
  type ReadingStatus,
} from '../../domain/papers';
import { Dialog } from '../../ui/Dialog';
import { fetchPaperMetadata } from '../../services/metadataFetch';

interface EditPaperDialogProps {
  open: boolean;
  paper: Paper | null;
  onClose: () => void;
  /** Applies the edit. Returns a message to show when it was refused, or null on success. */
  onSave: (edit: PaperEdit) => string | null;
  /** Injectable for tests; the real lookup talks to Crossref and arXiv. */
  fetchMetadata?: typeof fetchPaperMetadata;
}

/**
 * Edits one paper's metadata. The PDF file is not touched here: attaching or replacing a
 * file is its own operation with its own confirmation.
 */
export function EditPaperDialog({
  open,
  paper,
  onClose,
  onSave,
  fetchMetadata,
}: EditPaperDialogProps) {
  return (
    <Dialog open={open} title="编辑论文信息" onClose={onClose}>
      {paper !== null && (
        <EditForm paper={paper} onClose={onClose} onSave={onSave} fetchMetadata={fetchMetadata} />
      )}
    </Dialog>
  );
}

function EditForm({
  paper,
  onClose,
  onSave,
  fetchMetadata = fetchPaperMetadata,
}: Pick<EditPaperDialogProps, 'onClose' | 'onSave'> & {
  paper: Paper;
  /** Injectable for tests; the real lookup talks to Crossref and arXiv. */
  fetchMetadata?: typeof fetchPaperMetadata;
}) {
  const [title, setTitle] = useState(paper.title);
  const [authors, setAuthors] = useState(paper.authors.join(', '));
  const [year, setYear] = useState(paper.year === undefined ? '' : String(paper.year));
  const [doi, setDoi] = useState(paper.doi ?? '');
  const [arxivId, setArxivId] = useState(paper.arxivId ?? '');
  const [tags, setTags] = useState((paper.tags ?? []).join(', '));
  const [status, setStatus] = useState<ReadingStatus>(paperStatus(paper));
  const [error, setError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [lookup, setLookup] = useState<string | null>(null);
  /*
   * The fields the lookup may fill, as they are right now — read at answer time, not at click
   * time. A reader who types a title while the request is in flight has said the last word on
   * that field; a closure captured at click would not know and would overwrite it.
   */
  const latestFields = useRef({ title, authors, year });
  useEffect(() => {
    latestFields.current = { title, authors, year };
  });
  /** Answers that arrive after a newer click (or unmount) are dropped by number. */
  const lookupSeq = useRef(0);
  /**
   * The identifiers the request was built from. If the reader edits DOI or arXiv ID while the
   * request is in flight, the answer describes a paper the form no longer asks about — it is
   * dropped rather than filled, the same rule the seq token applies to superseded clicks.
   */
  const lookupIds = useRef({ doi: '', arxivId: '' });
  // Mirrors the live fields: the async closure captured the click-time state, so a check
  // against `doi` inside it would compare the old value with itself and never fire.
  const currentIds = useRef({ doi: '', arxivId: '' });
  useEffect(() => {
    currentIds.current = { doi: doi.trim(), arxivId: arxivId.trim() };
  });

  /*
   * Fills only what is still empty: a title the reader already corrected wins over the
   * registry's, and the lookup is a convenience rather than an authority.
   */
  const fillFromRegistries = async (): Promise<void> => {
    const token = lookupSeq.current + 1;
    lookupSeq.current = token;
    lookupIds.current = { doi: doi.trim(), arxivId: arxivId.trim() };
    setLooking(true);
    setLookup(null);
    try {
      const outcome = await fetchMetadata({ doi: doi.trim(), arxivId: arxivId.trim() });
      if (token !== lookupSeq.current) return;
      // The identifiers must still be what the request asked about. Saying so beats silence:
      // the reader just changed the DOI and is probably waiting for exactly this answer.
      if (
        currentIds.current.doi !== lookupIds.current.doi ||
        currentIds.current.arxivId !== lookupIds.current.arxivId
      ) {
        setLookup('标识符已修改，本次查询结果已放弃；需要的话请重新点击补全。');
        return;
      }
      if (outcome.status === 'no-identifier') {
        setLookup('先填 DOI 或 arXiv ID，才能按它查找。');
        return;
      }
      if (outcome.status === 'unreachable') {
        setLookup('现在连不上登记库（可能离线），没有修改任何字段。');
        return;
      }
      if (outcome.status === 'not-found') {
        setLookup('登记库里查不到这个标识符，没有修改任何字段。');
        return;
      }
      const now = latestFields.current;
      const filled: string[] = [];
      if (outcome.metadata.title !== undefined && now.title.trim() === '') {
        setTitle(outcome.metadata.title.slice(0, MAX_TITLE_LENGTH));
        filled.push('标题');
      }
      if (
        outcome.metadata.authors !== undefined &&
        outcome.metadata.authors.length > 0 &&
        now.authors.trim() === ''
      ) {
        setAuthors(outcome.metadata.authors.join(', '));
        filled.push('作者');
      }
      if (outcome.metadata.year !== undefined && now.year.trim() === '') {
        setYear(String(outcome.metadata.year));
        filled.push('年份');
      }
      setLookup(
        filled.length === 0
          ? '查到了，但对应字段都已填过，未改动。'
          : `已按登记库填入：${filled.join('、')}。保存前可以再改。`,
      );
    } finally {
      setLooking(false);
    }
  };

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
      // An emptied field clears the tags rather than keeping the old ones.
      tags: tags
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag !== ''),
      status,
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
          maxLength={MAX_TITLE_LENGTH}
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
      <div className="field-row">
        <label className="field">
          <span className="field-label">标签（逗号分隔）</span>
          <input
            className="input"
            value={tags}
            placeholder="强化学习, 综述"
            onChange={(event) => {
              setTags(event.target.value);
              setError(null);
            }}
          />
        </label>
        <label className="field field-narrow">
          <span className="field-label">阅读状态</span>
          <select
            className="input"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as ReadingStatus);
              setError(null);
            }}
          >
            {READING_STATUSES.map((option) => (
              <option key={option} value={option}>
                {READING_STATUS_LABEL[option]}
              </option>
            ))}
          </select>
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
      <div className="field-row dialog-lookup">
        <button
          type="button"
          className="btn btn-quiet"
          disabled={looking || (doi.trim() === '' && arxivId.trim() === '')}
          title="按 DOI（Crossref）或 arXiv ID 向公开登记库查询，只填空白字段"
          onClick={() => {
            void fillFromRegistries();
          }}
        >
          <CloudDownload size={14} aria-hidden="true" />
          {looking ? '查询中…' : '按标识符补全'}
        </button>
        {lookup !== null && (
          <p className="hint" role="status">
            {lookup}
          </p>
        )}
      </div>
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
