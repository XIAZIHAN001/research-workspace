import {
  Copy,
  FileUp,
  FolderPlus,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  SquareArrowOutUpRight,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Paper } from '../../domain/papers';
import type { Project } from '../../domain/project';
import { RowOverflow, RowOverflowItem } from '../../ui/RowOverflow';
import { PaperRow } from '../papers/PaperRow';
import {
  collectTags,
  libraryPapers,
  LIBRARY_SCOPE_LABEL,
  LIBRARY_SORT_LABEL,
  LIBRARY_STATUS_LABEL,
  readingProgress,
  type LibraryScope,
  type LibrarySort,
  type LibraryStatusFilter,
} from './libraryFilters';

interface LibraryViewProps {
  /** Every paper in the knowledge base, already ordered. */
  papers: Paper[];
  projects: Project[];
  /** Papers that have at least one note, so the library can filter by them. */
  annotatedPaperIds?: ReadonlySet<string>;
  onOpenReader: (paperId: string) => void;
  onEditPaper: (paperId: string) => void;
  onImportFile: (paperId: string) => void;
  onImportNew: () => void;
  onLinkToProject: (paperId: string, projectId: string) => void;
  /** Copies the paper's BibTeX entry. Omitted in tests and in hosts without a clipboard. */
  onCopyBibtex?: (paper: Paper) => void;
  /** Opens the .bib import dialog. Omitted in hosts that only show the library. */
  onImportBibtex?: () => void;
  /** Downloads the whole library as one .bib file. */
  onExportBibtex?: () => void;
  /** Preselected in every row's project picker, so a detour through the library is quick. */
  preferredProjectId?: string | null;
}

const SCOPES: readonly LibraryScope[] = ['all', 'has-pdf', 'in-project', 'has-notes'];
const STATUSES: readonly LibraryStatusFilter[] = ['all', 'unread', 'reading', 'done'];
const SORTS: readonly LibrarySort[] = ['recent-reading', 'added', 'year-desc', 'year-asc', 'title'];
const NO_PAPERS: ReadonlySet<string> = new Set();

/**
 * The library: every paper the workspace knows, with the projects that use it.
 *
 * It is deliberately not a second workspace — no folders, no ordering of its own. Its job is
 * to answer "do I already have this paper, and where is it used?", and to hand a paper to a
 * project or to the reader.
 */
export function LibraryView({
  papers,
  projects,
  annotatedPaperIds = NO_PAPERS,
  onOpenReader,
  onEditPaper,
  onImportFile,
  onImportNew,
  onLinkToProject,
  onCopyBibtex,
  onImportBibtex,
  onExportBibtex,
  preferredProjectId = null,
}: LibraryViewProps) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<LibrarySort>('recent-reading');
  const [scope, setScope] = useState<LibraryScope>('all');
  const [status, setStatus] = useState<LibraryStatusFilter>('all');
  const [tag, setTag] = useState('');

  const projectPaperIds = useMemo(
    () => new Set(projects.flatMap((project) => [project.corePaperId, ...project.relatedPaperIds])),
    [projects],
  );
  const tags = useMemo(() => collectTags(papers), [papers]);
  const shown = useMemo(
    () =>
      libraryPapers(papers, {
        query,
        sort,
        scope,
        status,
        tag: tag === '' ? null : tag,
        projectPaperIds,
        annotatedPaperIds,
      }),
    [papers, query, sort, scope, status, tag, projectPaperIds, annotatedPaperIds],
  );
  const filtered = query !== '' || scope !== 'all' || status !== 'all' || tag !== '';
  const reset = (): void => {
    setQuery('');
    setSort('recent-reading');
    setScope('all');
    setStatus('all');
    setTag('');
  };

  const projectsOf = (paper: Paper): string[] =>
    projects
      .filter(
        (project) => project.corePaperId === paper.id || project.relatedPaperIds.includes(paper.id),
      )
      .map((project) => project.name);

  return (
    <section className="library" aria-labelledby="library-title">
      <header className="library-head">
        <h1 id="library-title" className="library-title">
          论文库
        </h1>
        <span className="library-count">
          {shown.length === papers.length
            ? `${String(papers.length)} 篇`
            : `${String(shown.length)} / ${String(papers.length)} 篇`}
        </span>
        <button type="button" className="btn" onClick={onImportNew}>
          <Plus size={14} aria-hidden="true" />
          导入论文
        </button>
        {onImportBibtex !== undefined && (
          <button type="button" className="btn btn-quiet" onClick={onImportBibtex}>
            导入 BibTeX
          </button>
        )}
        {onExportBibtex !== undefined && papers.length > 0 && (
          <button type="button" className="btn btn-quiet" onClick={onExportBibtex}>
            <Copy size={14} aria-hidden="true" />
            导出 .bib
          </button>
        )}
      </header>

      <label className="library-search">
        <Search size={15} aria-hidden="true" />
        <span className="sr-only">搜索论文</span>
        <input
          className="input"
          type="search"
          value={query}
          placeholder="按标题、作者、DOI 或文件名搜索"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </label>

      <div className="library-controls">
        <div className="library-chips" role="group" aria-label="论文范围">
          {SCOPES.map((option) => (
            <button
              key={option}
              type="button"
              className="chip"
              aria-pressed={scope === option}
              onClick={() => {
                setScope(option);
              }}
            >
              {LIBRARY_SCOPE_LABEL[option]}
            </button>
          ))}
        </div>
        <div className="library-selects">
          <label className="library-select">
            <span className="sr-only">排序方式</span>
            <select
              className="input"
              value={sort}
              onChange={(event) => {
                setSort(event.target.value as LibrarySort);
              }}
            >
              {SORTS.map((option) => (
                <option key={option} value={option}>
                  {LIBRARY_SORT_LABEL[option]}
                </option>
              ))}
            </select>
          </label>
          <label className="library-select">
            <span className="sr-only">阅读状态</span>
            <select
              className="input"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as LibraryStatusFilter);
              }}
            >
              {STATUSES.map((option) => (
                <option key={option} value={option}>
                  {LIBRARY_STATUS_LABEL[option]}
                </option>
              ))}
            </select>
          </label>
          {tags.length > 0 && (
            <label className="library-select">
              <span className="sr-only">标签</span>
              <select
                className="input"
                value={tag}
                onChange={(event) => {
                  setTag(event.target.value);
                }}
              >
                <option value="">全部标签</option>
                {tags.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          )}
          {filtered && (
            <button type="button" className="btn btn-quiet" onClick={reset}>
              <RotateCcw size={14} aria-hidden="true" />
              重置
            </button>
          )}
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="library-empty">
          {papers.length === 0
            ? '论文库还是空的。导入一份 PDF，或从项目里新建论文。'
            : filtered
              ? '没有符合筛选条件的论文。'
              : '没有匹配的论文。'}
        </p>
      ) : (
        <ul className="library-list">
          {shown.map((paper) => {
            const used = projectsOf(paper);
            return (
              <li key={paper.id}>
                <PaperRow
                  paper={paper}
                  progress={readingProgress(paper)}
                  note={
                    used.length > 0 ? (
                      <p className="paper-row-note">用于：{used.join('、')}</p>
                    ) : null
                  }
                >
                  {/*
                   * One visible action per row: reading the paper. Everything else — replacing
                   * the file, editing the record, filing it under a project — is real but rare,
                   * and four labelled buttons on every row made the list read as a wall of
                   * controls instead of a list of papers. They are one click further away now,
                   * not less reachable.
                   */}
                  {paper.pdf !== undefined ? (
                    <button
                      type="button"
                      className="btn btn-quiet"
                      onClick={() => {
                        onOpenReader(paper.id);
                      }}
                    >
                      <SquareArrowOutUpRight size={14} aria-hidden="true" />
                      阅读
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-quiet"
                      onClick={() => {
                        onImportFile(paper.id);
                      }}
                    >
                      <FileUp size={14} aria-hidden="true" />
                      导入 PDF
                    </button>
                  )}
                  <RowOverflow label="更多操作">
                    {(close) => (
                      <>
                        {onCopyBibtex !== undefined && (
                          <RowOverflowItem
                            icon={<Copy size={14} aria-hidden="true" />}
                            label="复制 BibTeX"
                            onSelect={() => {
                              close();
                              onCopyBibtex(paper);
                            }}
                          />
                        )}
                        <RowOverflowItem
                          icon={<FileUp size={14} aria-hidden="true" />}
                          label={paper.pdf === undefined ? '导入 PDF' : '替换 PDF'}
                          onSelect={() => {
                            close();
                            onImportFile(paper.id);
                          }}
                        />
                        <RowOverflowItem
                          icon={<Pencil size={14} aria-hidden="true" />}
                          label="编辑"
                          onSelect={() => {
                            close();
                            onEditPaper(paper.id);
                          }}
                        />
                        {projects.length > 0 && (
                          <LinkToProject
                            projects={projects}
                            initialProjectId={preferredProjectId ?? ''}
                            onClose={close}
                            onLink={(projectId) => {
                              onLinkToProject(paper.id, projectId);
                            }}
                          />
                        )}
                      </>
                    )}
                  </RowOverflow>
                </PaperRow>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * The project picker, as one row inside the overflow menu.
 *
 * It used to be a permanently-open `<select>` plus a confirm button on every row. Now the select
 * only appears after the menu item is chosen, which is one control per row instead of three.
 */
function LinkToProject({
  projects,
  initialProjectId,
  onLink,
  onClose,
}: {
  projects: Project[];
  initialProjectId: string;
  onLink: (projectId: string) => void;
  onClose: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [projectId, setProjectId] = useState(initialProjectId);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // While the picker is showing it owns the row's focus: outside click or Escape puts it back
  // to the plain menu item, so a reader can back out without hunting for the trigger.
  useEffect(() => {
    if (!picking) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node) === true) return;
      setPicking(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setPicking(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [picking]);

  const link = (): void => {
    if (projectId === '') return;
    onLink(projectId);
    setProjectId('');
    onClose();
  };

  if (!picking) {
    return (
      <div className="row-overflow-link" ref={rootRef}>
        <button
          type="button"
          role="menuitem"
          className="row-overflow-item"
          onClick={() => {
            setPicking(true);
          }}
        >
          <FolderPlus size={14} aria-hidden="true" />
          加入项目
        </button>
      </div>
    );
  }

  return (
    <div className="row-overflow-link" ref={rootRef}>
      <label className="row-overflow-field">
        <span className="sr-only">选择要加入的项目</span>
        <select
          className="input"
          value={projectId}
          autoFocus
          onChange={(event) => {
            setProjectId(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              link();
            }
          }}
        >
          <option value="">选择项目…</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="btn btn-quiet row-overflow-confirm"
        disabled={projectId === ''}
        onClick={link}
      >
        加入
      </button>
    </div>
  );
}
