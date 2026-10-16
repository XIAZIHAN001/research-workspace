import { authorCredit, type Paper } from '../../domain/papers';
import type { Project } from '../../domain/project';

interface ProjectViewProps {
  project: Project;
  /** The project's core paper, resolved from the knowledge-base registry. */
  corePaper: Paper | null;
}

const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' });

/** A title longer than this is set smaller, so a full paper title does not fill the page. */
const LONG_TITLE = 40;

/**
 * Project page placeholder. Reading will be the core of this page; the knowledge graph,
 * notes and recommendations attach to it as secondary views, not as top-level workspaces.
 */
export function ProjectView({ project, corePaper }: ProjectViewProps) {
  return (
    <article className="project" aria-labelledby="project-title">
      <h1
        id="project-title"
        className="project-title"
        data-long={Array.from(project.name).length > LONG_TITLE}
      >
        {project.name}
      </h1>
      <dl className="facts">
        <div>
          <dt>核心论文</dt>
          <dd>{corePaper?.title ?? '未填写'}</dd>
        </div>
        <div>
          <dt>作者</dt>
          <dd>{corePaper === null ? '未填写' : (authorCredit(corePaper) ?? '未填写')}</dd>
        </div>
        <div>
          <dt>关联论文</dt>
          <dd>{project.relatedPaperIds.length} 篇</dd>
        </div>
        <div>
          <dt>创建于</dt>
          <dd>{dateFormat.format(project.createdAt)}</dd>
        </div>
      </dl>
      <p className="project-note">论文阅读器将在后续阶段加入，这里会成为项目的阅读主页。</p>
    </article>
  );
}
