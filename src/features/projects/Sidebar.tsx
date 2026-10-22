import {
  HardDriveDownload,
  House,
  Library,
  NotebookPen,
  PanelLeftClose,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
} from 'lucide-react';
import { useMemo } from 'react';
import type { Project } from '../../domain/project';
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '../../app/config';
import { AvatarPicker } from '../home/AvatarPicker';
import type { useAvatar } from '../home/useAvatar';
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
  libraryActive: boolean;
  notesActive: boolean;
  /** How many notes exist across the workspace; shown beside the notes entry. */
  notesCount: number;
  now: number;
  managing: boolean;
  renamingId: string | null;
  /** The local figure, shown at the bottom-left like a desktop profile chip. */
  avatar: ReturnType<typeof useAvatar>;
  /** The name chosen in settings; the default when the reader has not chosen one. */
  userName?: string;
  onHome: () => void;
  onLibrary: () => void;
  onNotes: () => void;
  /** Opens the workspace-wide search dialog (also bound to Ctrl/Cmd+K). */
  onSearch: () => void;
  onCollapse: () => void;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onToggleManage: () => void;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, name: string) => void;
  onCancelRename: () => void;
  onRequestDelete: (project: Project) => void;
  /** Opens the export/restore dialog. */
  onBackup: () => void;
  onSettings: () => void;
  /** Current column width in CSS pixels; the drag handle writes back through it. */
  width: number;
  /** True while the sidebar is an overlay, where dragging the width makes no sense. */
  narrow: boolean;
  onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
  onNudgeWidth: (delta: number) => void;
  onResetWidth: () => void;
}

export function Sidebar(props: SidebarProps) {
  const {
    projects,
    selectedId,
    homeActive,
    libraryActive,
    notesActive,
    now,
    managing,
    renamingId,
    open,
  } = props;
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
          className="icon-btn sidebar-collapse"
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
          className="nav-item spot sidebar-search"
          aria-keyshortcuts="Control+K Meta+K"
          onClick={props.onSearch}
        >
          <Search size={15} aria-hidden="true" />
          <span>全局检索</span>
          <kbd className="sidebar-kbd">Ctrl K</kbd>
        </button>

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

        <button
          type="button"
          {...glowProps}
          className="nav-item spot"
          aria-current={libraryActive ? 'page' : undefined}
          onClick={props.onLibrary}
        >
          <Library size={15} aria-hidden="true" />
          <span>论文库</span>
        </button>

        <button
          type="button"
          {...glowProps}
          className="nav-item spot"
          aria-current={notesActive ? 'page' : undefined}
          onClick={props.onNotes}
        >
          <NotebookPen size={15} aria-hidden="true" />
          <span>全部笔记</span>
          {props.notesCount > 0 && <span className="row-meta">{props.notesCount}</span>}
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
            <p className="group-empty">还没有项目。点上方的加号，从一篇论文开始。</p>
          ) : (
            <ul className="rows" data-managing={managing}>
              {projects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  selected={project.id === selectedId && !homeActive && !libraryActive}
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
        <button type="button" className="btn btn-quiet" onClick={props.onBackup}>
          <HardDriveDownload size={14} aria-hidden="true" />
          备份与恢复
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          aria-pressed={managing}
          onClick={props.onToggleManage}
        >
          <Settings2 size={14} aria-hidden="true" />
          管理项目
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          aria-haspopup="dialog"
          onClick={props.onSettings}
        >
          <SlidersHorizontal size={14} aria-hidden="true" />
          设置
        </button>
      </div>

      <div className="sidebar-user">
        <AvatarPicker
          compact
          src={props.avatar.src}
          isCustom={props.avatar.isCustom}
          problem={props.avatar.problem}
          onUpload={props.avatar.upload}
          onReset={props.avatar.reset}
          onDismissProblem={props.avatar.dismiss}
        />
        <span className="sidebar-user__label" title={props.userName}>
          {props.userName ?? '本地工作区'}
        </span>
      </div>

      {/*
        The column's drag handle. It is a real control, not a decoration: it carries the role,
        the value and the keyboard shortcuts, so the width is adjustable without a pointer and
        a screen reader announces what it does. Hidden entirely while the sidebar is an overlay,
        where it would have nothing to resize.
      */}
      {!props.narrow && (
        <div
          className="sidebar-resize"
          role="separator"
          aria-label="调整侧栏宽度"
          aria-orientation="vertical"
          aria-valuenow={props.width}
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          tabIndex={0}
          onPointerDown={props.onResizeStart}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              props.onNudgeWidth(-16);
            } else if (event.key === 'ArrowRight') {
              event.preventDefault();
              props.onNudgeWidth(16);
            } else if (event.key === 'Home') {
              event.preventDefault();
              props.onNudgeWidth(SIDEBAR_MIN_WIDTH - props.width);
            } else if (event.key === 'End') {
              event.preventDefault();
              props.onNudgeWidth(SIDEBAR_MAX_WIDTH - props.width);
            } else if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              props.onResetWidth();
            }
          }}
          onDoubleClick={props.onResetWidth}
        >
          <span className="sidebar-resize__grip" aria-hidden="true" />
        </div>
      )}
    </aside>
  );
}
