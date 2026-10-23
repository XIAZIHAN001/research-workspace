import { ArrowRight, BookOpen, FileUp, FolderOpen, Library, ListTodo, Plus } from 'lucide-react';
import { useMemo } from 'react';
import { authorCredit, paperStatus, type Paper } from '../../domain/papers';
import type { Project } from '../../domain/project';
import { splitWelcome } from '../../services/welcome';
import { formatRelativeDay } from '../../ui/format';

/** A lead longer than this reads as a sentence rather than a greeting and is set smaller. */
const LONG_LEAD = 16;
/** The workbench shows a short list, not the whole library. */
const RECENT_LIMIT = 4;
/** The queue is a nudge, not a backlog screen: the library is where the backlog lives. */
const QUEUE_LIMIT = 6;

interface HomeViewProps {
  welcome: { text: string | null; status: 'loading' | 'ready' | 'error' };
  selected: Project | null;
  /** Every project, newest activity first when the recent list is built. */
  projects: Project[];
  /** Every paper, so "continue reading" can be built from real reading positions. */
  papers: Paper[];
  now: number;
  onCreate: () => void;
  onOpenSelected: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenReader: (paperId: string) => void;
  onImport: () => void;
  onLibrary: () => void;
}

/**
 * The workbench: where the reader left off, and the shortest path to the next thing.
 *
 * It is deliberately a two-column dashboard rather than a large centred greeting. Every row
 * here is a real project or a paper with a saved reading position; when there is nothing to
 * show, the panel says so and points at the action that would create it.
 */
export function HomeView({
  welcome,
  selected,
  projects,
  papers,
  now,
  onCreate,
  onOpenSelected,
  onOpenProject,
  onOpenReader,
  onImport,
  onLibrary,
}: HomeViewProps) {
  const { lead, stop, body } = splitWelcome(welcome.text ?? '');

  const recentPapers = useMemo(
    () =>
      papers
        .filter((paper) => paper.reading !== undefined)
        .sort((one, other) => (other.reading?.updatedAt ?? 0) - (one.reading?.updatedAt ?? 0))
        .slice(0, RECENT_LIMIT),
    [papers],
  );
  const recentProjects = useMemo(
    () =>
      [...projects].sort((one, other) => other.updatedAt - one.updatedAt).slice(0, RECENT_LIMIT),
    [projects],
  );
  /** Unread papers that have a file and no reading position: the honest "next up" list. */
  const queue = useMemo(
    () =>
      papers
        .filter(
          (paper) =>
            paperStatus(paper) === 'unread' &&
            paper.reading === undefined &&
            paper.pdf !== undefined,
        )
        .sort((one, other) => other.createdAt - one.createdAt)
        .slice(0, QUEUE_LIMIT),
    [papers],
  );
  const counts = useMemo(() => {
    const result = { unread: 0, reading: 0, done: 0 };
    for (const paper of papers) result[paperStatus(paper)] += 1;
    return result;
  }, [papers]);

  return (
    <section className="home" aria-label="首页">
      <header className="home-head">
        <div className="home-greeting">
          <h1
            className="welcome"
            aria-live="polite"
            aria-busy={welcome.status === 'loading'}
            data-long={Array.from(lead).length > LONG_LEAD}
          >
            <span className="welcome-lead">{lead}</span>
            {stop !== '' && <span className="sr-only">{stop}</span>}
            {body !== '' && <span className="welcome-body">{body}</span>}
          </h1>
        </div>

        <div className="home-actions">
          <button type="button" className="btn btn-primary" onClick={onCreate}>
            <Plus size={15} aria-hidden="true" />
            新建项目
          </button>
          <button type="button" className="btn" onClick={onImport}>
            <FileUp size={15} aria-hidden="true" />
            导入论文
          </button>
          <button type="button" className="btn btn-quiet" onClick={onLibrary}>
            <Library size={14} aria-hidden="true" />
            论文库
          </button>
          {selected !== null && (
            <button
              type="button"
              className="btn btn-quiet"
              title={selected.name}
              onClick={onOpenSelected}
            >
              <span className="btn-label">打开《{selected.name}》</span>
            </button>
          )}
        </div>
      </header>

      <div className="home-grid">
        <section className="home-panel" aria-labelledby="continue-title">
          <div className="home-panel-head">
            <h2 id="continue-title" className="home-panel-title">
              继续阅读
            </h2>
            {recentPapers.length > 0 && (
              <span className="home-panel-count">{recentPapers.length} 篇</span>
            )}
          </div>
          {recentPapers.length === 0 ? (
            <div className="home-empty">
              <BookOpen size={20} aria-hidden="true" />
              <p>
                {papers.length === 0
                  ? '还没有论文。导入一份 PDF，它就会出现在这里。'
                  : '还没有开始阅读的论文。去论文库挑一篇开始。'}
              </p>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={papers.length === 0 ? onImport : onLibrary}
              >
                {papers.length === 0 ? '导入第一篇论文' : '打开论文库'}
                <ArrowRight size={13} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <ul className="home-list">
              {recentPapers.map((paper) => (
                <li key={paper.id}>
                  <button
                    type="button"
                    className="home-row"
                    title={paper.title}
                    onClick={() => {
                      onOpenReader(paper.id);
                    }}
                  >
                    <span className="home-row-main">
                      <span className="home-row-title">{paper.title}</span>
                      <span className="home-row-meta">
                        {paper.reading === undefined
                          ? ''
                          : `第 ${String(paper.reading.page)} 页 · ${formatRelativeDay(
                              paper.reading.updatedAt,
                              now,
                            )}`}
                      </span>
                    </span>
                    <ArrowRight size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="home-panel" aria-labelledby="recent-projects-title">
          <div className="home-panel-head">
            <h2 id="recent-projects-title" className="home-panel-title">
              最近项目
            </h2>
            {recentProjects.length > 0 && (
              <span className="home-panel-count">{projects.length} 个</span>
            )}
          </div>
          {recentProjects.length === 0 ? (
            <div className="home-empty">
              <FolderOpen size={20} aria-hidden="true" />
              <p>项目列表还是空的。新建一个项目，从一篇想读懂的论文开始。</p>
              <button type="button" className="btn btn-quiet" onClick={onCreate}>
                创建第一个项目
                <ArrowRight size={13} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <ul className="home-list">
              {recentProjects.map((project) => (
                <li key={project.id}>
                  <button
                    type="button"
                    className="home-row"
                    title={project.name}
                    onClick={() => {
                      onOpenProject(project.id);
                    }}
                  >
                    <span className="home-row-main">
                      <span className="home-row-title">{project.name}</span>
                      <span className="home-row-meta">
                        {formatRelativeDay(project.updatedAt, now)}
                      </span>
                    </span>
                    <ArrowRight size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="home-panel home-queue-panel" aria-labelledby="reading-queue-title">
          <div className="home-panel-head">
            <h2 id="reading-queue-title" className="home-panel-title">
              阅读队列
            </h2>
            {papers.length > 0 && (
              <span className="home-panel-count">
                {counts.reading} 在读 · {counts.unread} 未读 · {counts.done} 读完
              </span>
            )}
          </div>
          {queue.length === 0 ? (
            <div className="home-empty home-queue-empty">
              <ListTodo size={20} aria-hidden="true" />
              <p>
                {papers.length === 0
                  ? '导入论文后，未读的论文会排在这里。'
                  : '队列里没有待读的论文。'}
              </p>
            </div>
          ) : (
            <ul className="home-list home-queue-list">
              {queue.map((paper) => {
                const meta = [
                  authorCredit(paper),
                  paper.year === undefined ? '' : String(paper.year),
                ]
                  .filter((part) => part !== '')
                  .join(' · ');
                return (
                  <li key={paper.id}>
                    <button
                      type="button"
                      className="home-row"
                      title={paper.title}
                      onClick={() => {
                        onOpenReader(paper.id);
                      }}
                    >
                      <span className="home-row-main">
                        <span className="home-row-title">{paper.title}</span>
                        {meta !== '' && <span className="home-row-meta">{meta}</span>}
                      </span>
                      <ArrowRight size={14} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
