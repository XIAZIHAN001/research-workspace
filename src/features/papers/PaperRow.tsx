import type { ReactNode } from 'react';
import { authorCredit, paperStatus, READING_STATUS_LABEL, type Paper } from '../../domain/papers';
import { formatBytes } from '../../ui/format';

interface PaperRowProps {
  paper: Paper;
  /** Percentage through the paper, when a reading position and a page count both exist. */
  progress?: number | null;
  /** A small line under the file status, e.g. which projects reference this paper. */
  note?: ReactNode;
  /** The actions for this paper. */
  children: ReactNode;
}

/** One paper in a dense list: what it is, whether it has a file, and what can be done. */
export function PaperRow({ paper, progress, note, children }: PaperRowProps) {
  const status = paperStatus(paper);
  const meta = [
    authorCredit(paper),
    paper.year === undefined ? null : String(paper.year),
    paper.doi === undefined ? null : `DOI ${paper.doi}`,
    paper.arxivId === undefined ? null : `arXiv ${paper.arxivId}`,
  ].filter((part): part is string => part !== null);

  return (
    <article className="paper-row">
      <div className="paper-row-main">
        <div className="paper-row-titleline">
          <h3 className="paper-row-title">{paper.title}</h3>
          {status !== 'unread' && (
            <span className="paper-status" data-status={status}>
              {READING_STATUS_LABEL[status]}
            </span>
          )}
        </div>
        {meta.length > 0 && <p className="paper-row-meta">{meta.join(' · ')}</p>}
        {paper.tags !== undefined && paper.tags.length > 0 && (
          <p className="paper-row-tags">
            {paper.tags.map((tag) => (
              <span key={tag} className="paper-tag">
                {tag}
              </span>
            ))}
          </p>
        )}
        <p className="paper-row-file" data-has-pdf={paper.pdf !== undefined}>
          {paper.pdf === undefined
            ? '没有本地 PDF'
            : `${paper.pdf.name} · ${formatBytes(paper.pdf.bytes)}${
                paper.pdf.pageCount === null ? '' : ` · ${String(paper.pdf.pageCount)} 页`
              }`}
        </p>
        {progress !== undefined && progress !== null && (
          <p className="paper-row-progress" aria-label={`阅读进度 ${String(progress)}%`}>
            <span className="paper-row-progress-track" aria-hidden="true">
              <span className="paper-row-progress-fill" style={{ width: `${String(progress)}%` }} />
            </span>
            <span className="paper-row-progress-value">{progress}%</span>
          </p>
        )}
        {note}
      </div>
      <div className="paper-row-actions">{children}</div>
    </article>
  );
}
