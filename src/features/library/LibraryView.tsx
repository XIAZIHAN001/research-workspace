import { FileUp, Pencil, Plus, Search, SquareArrowOutUpRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Paper } from '../../domain/papers';
import type { Project } from '../../domain/project';
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
                  {paper.pdf !== undefined && (
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
                  )}
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => {
                      onImportFile(paper.id);
                    }}
                  >
                    <FileUp size={14} aria-hidden="true" />
                    {paper.pdf === undefined ? '导入 PDF' : '替换 PDF'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => {
                      onEditPaper(paper.id);
                    }}
                  >
                    <Pencil size={14} aria-hidden="true" />
                    编辑
                  </button>
                  {projects.length > 0 && (
                    <LinkToProject
                      projects={projects}
                      initialProjectId={preferredProjectId ?? ''}
                      onLink={(projectId) => {
                        onLinkToProject(paper.id, projectId);
                      }}
                    />
                  )}
                </PaperRow>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function LinkToProject({
  projects,
  initialProjectId,
  onLink,
}: {
  projects: Project[];
  initialProjectId: string;
  onLink: (projectId: string) => void;
}) {
  const [projectId, setProjectId] = useState(initialProjectId);
  return (
    <span className="paper-row-link">
      <label>
        <span className="sr-only">选择要加入的项目</span>
        <select
          className="input"
          value={projectId}
          onChange={(event) => {
            setProjectId(event.target.value);
          }}
        >
          <option value="">加入项目…</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="btn btn-quiet"
        disabled={projectId === ''}
        onClick={() => {
          onLink(projectId);
          setProjectId('');
        }}
      >
        加入
      </button>
    </span>
  );
}
