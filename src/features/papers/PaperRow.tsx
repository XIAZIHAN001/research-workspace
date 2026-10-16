import type { ReactNode } from 'react';
import { authorCredit, type Paper } from '../../domain/papers';
import { formatBytes } from '../../ui/format';

interface PaperRowProps {
  paper: Paper;
  /** A small line under the file status, e.g. which projects reference this paper. */
  note?: ReactNode;
  /** The actions for this paper. */
  children: ReactNode;
}

/** One paper in a dense list: what it is, whether it has a file, and what can be done. */
export function PaperRow({ paper, note, children }: PaperRowProps) {
  const meta = [
    authorCredit(paper),
    paper.year === undefined ? null : String(paper.year),
    paper.doi === undefined ? null : `DOI ${paper.doi}`,
    paper.arxivId === undefined ? null : `arXiv ${paper.arxivId}`,
  ].filter((part): part is string => part !== null);

  return (
    <article className="paper-row">
      <div className="paper-row-main">
        <h3 className="paper-row-title">{paper.title}</h3>
        {meta.length > 0 && <p className="paper-row-meta">{meta.join(' · ')}</p>}
        <p className="paper-row-file" data-has-pdf={paper.pdf !== undefined}>
          {paper.pdf === undefined
            ? '没有本地 PDF'
            : `${paper.pdf.name} · ${formatBytes(paper.pdf.bytes)}${
                paper.pdf.pageCount === null ? '' : ` · ${String(paper.pdf.pageCount)} 页`
              }`}
        </p>
        {note}
      </div>
      <div className="paper-row-actions">{children}</div>
    </article>
  );
}
