import { BookOpen, Library, Network, NotebookPen, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Dialog } from '../../ui/Dialog';
import {
  searchWorkspace,
  SEARCH_GROUP_LIMIT,
  type WorkspaceResultKind,
  type WorkspaceSearchResult,
  type WorkspaceSearchSource,
} from './searchWorkspace';

interface GlobalSearchDialogProps {
  open: boolean;
  source: WorkspaceSearchSource;
  onClose: () => void;
  /** Opens a paper at a place, when the result names one. */
  onOpenPaper: (paperId: string, focus?: { page: number; quote: string }) => void;
  /** Opens a concept in the project that shows it. */
  onOpenConcept: (conceptId: string, projectId: string) => void;
}

const KIND_ICON: Record<WorkspaceResultKind, typeof Search> = {
  paper: Library,
  note: NotebookPen,
  concept: Network,
  evidence: BookOpen,
};

/**
 * One field over everything the workspace knows.
 *
 * It searches the records themselves — paper metadata, notes, concepts and knowledge evidence —
 * rather than the text inside PDF files; the reader's own find bar is the place for that. Opening
 * a result leaves the dialog and takes the reader straight to the page or the concept.
 */
export function GlobalSearchDialog({
  open,
  source,
  onClose,
  onOpenPaper,
  onOpenConcept,
}: GlobalSearchDialogProps) {
  return (
    <Dialog open={open} title="全局检索" onClose={onClose}>
      <SearchBody
        source={source}
        onClose={onClose}
        onOpenPaper={onOpenPaper}
        onOpenConcept={onOpenConcept}
      />
    </Dialog>
  );
}

interface SearchBodyProps extends Omit<GlobalSearchDialogProps, 'open'> {
  onClose: () => void;
}

function SearchBody({ source, onClose, onOpenPaper, onOpenConcept }: SearchBodyProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const groups = useMemo(() => searchWorkspace(source, query), [source, query]);
  const flat = useMemo(() => groups.flatMap((group) => group.results), [groups]);
  const current = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);

  const choose = (result: WorkspaceSearchResult | undefined): void => {
    if (result === undefined) return;
    if (result.kind === 'concept') {
      if (result.conceptId !== undefined && result.projectId !== undefined) {
        onClose();
        onOpenConcept(result.conceptId, result.projectId);
      }
      return;
    }
    if (result.paperId === undefined) return;
    onClose();
    onOpenPaper(
      result.paperId,
      result.page === undefined || result.quote === undefined
        ? undefined
        : { page: result.page, quote: result.quote },
    );
  };

  return (
    <div className="global-search">
      <div className="global-search-field" role="search">
        <Search size={16} aria-hidden="true" />
        <input
          data-autofocus
          type="text"
          value={query}
          placeholder="搜索论文、笔记、概念、知识证据…"
          aria-label="搜索工作区"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((index) => Math.min(index + 1, flat.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              choose(flat[current]);
            }
          }}
        />
      </div>

      <div className="global-search-results">
        {query.trim() === '' ? (
          <p className="global-search-hint">
            输入关键词，检索论文元数据、笔记与注释、概念和知识证据。
          </p>
        ) : flat.length === 0 ? (
          <p className="global-search-hint">没有找到匹配的内容。</p>
        ) : (
          groups.map((group) => (
            <section key={group.kind} className="global-search-group">
              <h3 className="global-search-group-title">
                {group.title}
                <span className="global-search-group-count">
                  {group.total > group.results.length
                    ? `显示 ${String(group.results.length)} / ${String(group.total)}`
                    : String(group.total)}
                </span>
              </h3>
              <ul>
                {group.results.map((result) => {
                  const Icon = KIND_ICON[result.kind];
                  const index = flat.indexOf(result);
                  const disabled =
                    result.kind === 'concept'
                      ? result.conceptId === undefined || result.projectId === undefined
                      : result.paperId === undefined;
                  return (
                    <li key={result.id}>
                      <button
                        type="button"
                        className="global-search-row"
                        data-active={index === current}
                        disabled={disabled}
                        onClick={() => {
                          choose(result);
                        }}
                      >
                        <Icon size={15} aria-hidden="true" />
                        <span className="global-search-text">
                          <span className="global-search-title">{result.title}</span>
                          {result.snippet !== '' && (
                            <span className="global-search-snippet">{result.snippet}</span>
                          )}
                          <span className="global-search-meta">{result.meta}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>

      <p className="global-search-foot">
        <span>↑↓ 选择 · Enter 打开 · Esc 关闭</span>
        <span>每组最多 {SEARCH_GROUP_LIMIT} 条</span>
      </p>
    </div>
  );
}
