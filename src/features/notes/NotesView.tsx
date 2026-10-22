import { NotebookPen, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ANNOTATION_KINDS, ANNOTATION_KIND_LABEL, type Annotation } from '../../domain/annotation';
import type { Paper } from '../../domain/papers';
import {
  filterNotes,
  groupNotes,
  type NotesKindFilter,
  type NotesOverviewGroup,
} from './notesOverview';

interface NotesViewProps {
  annotations: readonly Annotation[];
  papers: Readonly<Record<string, Paper>>;
  /** Opens the paper at the note's page and marks its quote. */
  onOpenPaper: (paperId: string, focus: { page: number; quote: string }) => void;
}

const KIND_FILTERS: readonly NotesKindFilter[] = ['all', ...ANNOTATION_KINDS];

/**
 * Every note in the workspace, grouped by paper.
 *
 * The reader's notes are already beside each paper; this page answers the other question —
 * "what have I written down, anywhere?" — without making them open papers one by one.
 */
export function NotesView({ annotations, papers, onOpenPaper }: NotesViewProps) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<NotesKindFilter>('all');
  const [paperId, setPaperId] = useState('');

  const shown = useMemo(
    () => filterNotes(annotations, { query, kind, paperId: paperId === '' ? null : paperId }),
    [annotations, query, kind, paperId],
  );
  const groups = useMemo(() => groupNotes(shown, papers), [shown, papers]);
  const papersWithNotes = useMemo(() => {
    const ids = new Set(annotations.map((annotation) => annotation.paperId));
    return [...ids]
      .map((id) => ({ id, title: papers[id]?.title ?? '未知论文' }))
      .sort((one, other) => one.title.localeCompare(other.title, 'zh-Hans-CN'));
  }, [annotations, papers]);
  const filtered = query !== '' || kind !== 'all' || paperId !== '';

  return (
    <section className="notes-page" aria-labelledby="notes-page-title">
      <header className="library-head">
        <h1 id="notes-page-title" className="library-title">
          全部笔记
        </h1>
        <span className="library-count">
          {shown.length === annotations.length
            ? `${String(annotations.length)} 条`
            : `${String(shown.length)} / ${String(annotations.length)} 条`}
        </span>
      </header>

      <label className="library-search">
        <Search size={15} aria-hidden="true" />
        <span className="sr-only">搜索笔记</span>
        <input
          className="input"
          type="search"
          value={query}
          placeholder="按高亮文字或笔记内容搜索"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </label>

      <div className="library-controls">
        <div className="library-chips" role="group" aria-label="笔记类型">
          {KIND_FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              className="chip"
              aria-pressed={kind === option}
              onClick={() => {
                setKind(option);
              }}
            >
              {option === 'all' ? '全部' : ANNOTATION_KIND_LABEL[option]}
            </button>
          ))}
        </div>
        {papersWithNotes.length > 1 && (
          <div className="library-selects">
            <label className="library-select">
              <span className="sr-only">按论文筛选</span>
              <select
                className="input"
                value={paperId}
                onChange={(event) => {
                  setPaperId(event.target.value);
                }}
              >
                <option value="">全部论文</option>
                {papersWithNotes.map((paper) => (
                  <option key={paper.id} value={paper.id}>
                    {paper.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>

      {groups.length === 0 ? (
        <p className="library-empty">
          {annotations.length === 0
            ? '还没有笔记。阅读时选中文字，就能留下高亮和笔记。'
            : filtered
              ? '没有符合筛选条件的笔记。'
              : '没有笔记。'}
        </p>
      ) : (
        <div className="notes-groups">
          {groups.map((group) => (
            <NotesGroup key={group.paperId} group={group} query={query} onOpenPaper={onOpenPaper} />
          ))}
        </div>
      )}
    </section>
  );
}

interface NotesGroupProps {
  group: NotesOverviewGroup;
  query: string;
  onOpenPaper: (paperId: string, focus: { page: number; quote: string }) => void;
}

function NotesGroup({ group, query, onOpenPaper }: NotesGroupProps) {
  return (
    <section className="notes-group-page" aria-labelledby={`notes-group-${group.paperId}`}>
      <header className="notes-group-head">
        <NotebookPen size={14} aria-hidden="true" />
        <h2 id={`notes-group-${group.paperId}`} className="notes-group-title">
          {group.title}
        </h2>
        <span className="notes-group-count">{group.items.length} 条</span>
      </header>
      <ul className="notes-page-list">
        {group.items.map((annotation) => (
          <li key={annotation.id}>
            <button
              type="button"
              className="note-card"
              onClick={() => {
                onOpenPaper(group.paperId, {
                  page: annotation.page,
                  quote: annotation.quote,
                });
              }}
            >
              <span className="note-card-meta">
                <span className="note-kind" data-kind={annotation.kind}>
                  {ANNOTATION_KIND_LABEL[annotation.kind]}
                </span>
                {annotation.origin === 'assistant' && <span className="note-origin">AI 辅助</span>}
                <span className="note-page">第 {annotation.page} 页</span>
              </span>
              <Highlighted text={annotation.quote} query={query} className="note-card-quote" />
              {annotation.note !== '' && (
                <Highlighted text={annotation.note} query={query} className="note-card-body" />
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface HighlightedProps {
  text: string;
  query: string;
  className: string;
}

/**
 * The text with the search term marked, so a long note shows why it matched.
 *
 * Matching is plain case-insensitive substring search, the same rule as the filter, so the
 * marked span can never disagree with the result being shown.
 */
function Highlighted({ text, query, className }: HighlightedProps) {
  const needle = query.trim().toLowerCase();
  if (needle === '') return <span className={className}>{text}</span>;
  const index = text.toLowerCase().indexOf(needle);
  if (index < 0) return <span className={className}>{text}</span>;
  return (
    <span className={className}>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + needle.length)}</mark>
      {text.slice(index + needle.length)}
    </span>
  );
}
