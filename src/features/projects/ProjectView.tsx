import { FileUp, Library, Pencil, SquareArrowOutUpRight, Unlink } from 'lucide-react';
import type { Paper } from '../../domain/papers';
import type { Project } from '../../domain/project';
import { PaperRow } from '../papers/PaperRow';

interface ProjectViewProps {
  project: Project;
  /** The knowledge-base registry, for resolving the papers this project references. */
  papers: Record<string, Paper>;
  onOpenReader: (paperId: string) => void;
  /** Attach or replace the PDF of a paper. */
  onImportFile: (paperId: string) => void;
  onEditPaper: (paperId: string) => void;
  onUnlinkPaper: (paperId: string) => void;
  /** Import a new paper (with a PDF) into this project. */
  onImportNew: () => void;
  /** Pick an existing paper from the library and add it here. */
  onLinkFromLibrary: () => void;
}

const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' });

/** A title longer than this is set smaller, so a full paper title does not fill the page. */
const LONG_TITLE = 40;

/**
 * A project page: the paper the project is built around, the papers linked to it, and the
 * way into the reader. Reading is the point of the page; everything else is in service of it.
 */
export function ProjectView({
  project,
  papers,
  onOpenReader,
  onImportFile,
  onEditPaper,
  onUnlinkPaper,
  onImportNew,
  onLinkFromLibrary,
}: ProjectViewProps) {
  const corePaper = papers[project.corePaperId] ?? null;
  const related = project.relatedPaperIds
    .map((paperId) => papers[paperId])
    .filter((paper): paper is Paper => paper !== undefined);

  return (
    <article className="project" aria-labelledby="project-title">
      <h1
        id="project-title"
        className="project-title"
        data-long={Array.from(project.name).length > LONG_TITLE}
      >
        {project.name}
      </h1>

      <section className="project-section" aria-labelledby="core-paper-heading">
        <div className="section-head">
          <h2 id="core-paper-heading" className="section-title">
            核心论文
          </h2>
          <button type="button" className="btn btn-quiet" onClick={onLinkFromLibrary}>
            <Library size={14} aria-hidden="true" />
            从论文库关联
          </button>
        </div>
        {corePaper === null ? (
          <p className="project-note">这篇论文的记录已经不在了，可以重新导入一份 PDF。</p>
        ) : (
          <PaperRow paper={corePaper}>
            {corePaper.pdf !== undefined && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  onOpenReader(corePaper.id);
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
                onImportFile(corePaper.id);
              }}
            >
              <FileUp size={14} aria-hidden="true" />
              {corePaper.pdf === undefined ? '导入 PDF' : '替换 PDF'}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                onEditPaper(corePaper.id);
              }}
            >
              <Pencil size={14} aria-hidden="true" />
              编辑
            </button>
          </PaperRow>
        )}
      </section>

      <section className="project-section" aria-labelledby="related-heading">
        <div className="section-head">
          <h2 id="related-heading" className="section-title">
            关联论文
          </h2>
          <span className="section-count">{related.length} 篇</span>
          <button type="button" className="btn btn-quiet" onClick={onImportNew}>
            <FileUp size={14} aria-hidden="true" />
            导入新论文
          </button>
        </div>
        {related.length === 0 ? (
          <p className="project-note">
            还没有关联论文。可以从论文库关联已有的论文，或者导入一份新的 PDF。
          </p>
        ) : (
          <ul className="paper-list">
            {related.map((paper) => (
              <li key={paper.id}>
                <PaperRow paper={paper}>
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
                      onUnlinkPaper(paper.id);
                    }}
                  >
                    <Unlink size={14} aria-hidden="true" />
                    移出项目
                  </button>
                </PaperRow>
              </li>
            ))}
          </ul>
        )}
      </section>

      <dl className="facts">
        <div>
          <dt>创建于</dt>
          <dd>{dateFormat.format(project.createdAt)}</dd>
        </div>
      </dl>
    </article>
  );
}
