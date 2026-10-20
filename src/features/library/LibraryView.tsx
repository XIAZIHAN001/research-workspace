import { FileUp, FolderPlus, Pencil, Plus, Search, SquareArrowOutUpRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Paper } from '../../domain/papers';
import type { Project } from '../../domain/project';
import { RowOverflow, RowOverflowItem } from '../../ui/RowOverflow';
import { PaperRow } from '../papers/PaperRow';

interface LibraryViewProps {
  /** Every paper in the knowledge base, already ordered. */
  papers: Paper[];
  projects: Project[];
  onOpenReader: (paperId: string) => void;
  onEditPaper: (paperId: string) => void;
  onImportFile: (paperId: string) => void;
  onImportNew: () => void;
  onLinkToProject: (paperId: string, projectId: string) => void;
  /** Preselected in every row's project picker, so a detour through the library is quick. */
  preferredProjectId?: string | null;
}

/** Finds a paper by anything a reader would remember about it. */
function matches(paper: Paper, query: string): boolean {
  if (query === '') return true;
  const haystack = [
    paper.title,
    paper.authors.join(' '),
    paper.doi ?? '',
    paper.arxivId ?? '',
    paper.pdf?.name ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

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
  onOpenReader,
  onEditPaper,
  onImportFile,
  onImportNew,
  onLinkToProject,
  preferredProjectId = null,
}: LibraryViewProps) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => papers.filter((paper) => matches(paper, query)), [papers, query]);

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
        <span className="library-count">{papers.length} 篇</span>
        <button type="button" className="btn" onClick={onImportNew}>
          <Plus size={14} aria-hidden="true" />
          导入论文
        </button>
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

      {shown.length === 0 ? (
        <p className="library-empty">
          {papers.length === 0
            ? '论文库还是空的。导入一份 PDF，或从项目里新建论文。'
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
