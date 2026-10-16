import { House, PanelLeftClose, Plus, Settings2 } from 'lucide-react';
import { useMemo } from 'react';
import type { Project } from '../../domain/project';
import { ThemeSwitch } from '../theme/ThemeSwitch';
import type { ThemePref } from '../theme/theme';
import { formatRelativeDay } from '../../ui/format';
import { glowProps } from '../../ui/glow';
import { ProjectRow } from './ProjectRow';

const RECENT_LIMIT = 3;
/** A shortcut list only earns its space once the full list is long enough to need one. */
const RECENT_MIN_PROJECTS = 6;

interface SidebarProps {
  open: boolean;
  projects: Project[];
  selectedId: string | null;
  homeActive: boolean;
  now: number;
  managing: boolean;
  renamingId: string | null;
  themePref: ThemePref;
  onHome: () => void;
  onCollapse: () => void;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onToggleManage: () => void;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, name: string) => void;
  onCancelRename: () => void;
  onRequestDelete: (project: Project) => void;
  onThemeChange: (pref: ThemePref) => void;
}

export function Sidebar(props: SidebarProps) {
  const { projects, selectedId, homeActive, now, managing, renamingId, open } = props;

  // updatedAt is the "last touched" clock; reading sessions will bump it once a reader exists.
  const recent = useMemo(
    () =>
      projects.length < RECENT_MIN_PROJECTS
        ? []
        : [...projects].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT_LIMIT),
    [projects],
  );

  return (
    <aside
      id="sidebar"
      className="sidebar glass"
      aria-label="项目导航"
      inert={!open}
      {...glowProps}
    >
      <div className="sidebar-top">
        <span className="brand">Research Workspace</span>
        <button
          type="button"
          className="icon-btn"
          aria-label="收起侧栏"
          title="收起侧栏"
          onClick={props.onCollapse}
        >
          <PanelLeftClose size={16} aria-hidden="true" />
        </button>
      </div>

      <nav className="sidebar-scroll" aria-label="项目">
        <button
          type="button"
          {...glowProps}
          className="nav-item spot"
          aria-current={homeActive ? 'page' : undefined}
          onClick={props.onHome}
        >
          <House size={15} aria-hidden="true" />
          <span>首页</span>
        </button>

        {recent.length > 0 && (
          <section className="group" aria-labelledby="recent-title">
            <h2 id="recent-title" className="group-title">
              最近更新
            </h2>
            <ul>
              {recent.map((project) => (
                <li key={project.id}>
                  <button
                    type="button"
                    {...glowProps}
                    className="nav-item spot"
                    title={project.name}
                    onClick={() => {
                      props.onSelect(project.id);
                    }}
                  >
                    <span className="row-name">{project.name}</span>
                    <span className="row-meta">{formatRelativeDay(project.updatedAt, now)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="group" aria-labelledby="projects-title">
          <div className="group-head">
            <h2 id="projects-title" className="group-title">
              项目
            </h2>
            <button
              type="button"
              className="icon-btn"
              aria-label="新建项目"
              title="新建项目"
              onClick={props.onCreate}
            >
              <Plus size={15} aria-hidden="true" />
            </button>
          </div>
          {projects.length === 0 ? (
            <p className="group-empty">还没有项目。点击右上角的加号，从一篇论文开始。</p>
          ) : (
            <ul className="rows" data-managing={managing}>
              {projects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  selected={project.id === selectedId && !homeActive}
                  renaming={project.id === renamingId}
                  onSelect={props.onSelect}
                  onStartRename={props.onStartRename}
                  onCommitRename={props.onCommitRename}
                  onCancelRename={props.onCancelRename}
                  onRequestDelete={props.onRequestDelete}
                />
              ))}
            </ul>
          )}
        </section>
      </nav>

      <div className="sidebar-foot">
        <button
          type="button"
          className="btn btn-quiet"
          aria-pressed={managing}
          onClick={props.onToggleManage}
        >
          <Settings2 size={14} aria-hidden="true" />
          管理项目
        </button>
        <ThemeSwitch pref={props.themePref} onChange={props.onThemeChange} />
      </div>
    </aside>
  );
}
