import { PanelLeftOpen } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CreateProjectDialog } from '../features/projects/CreateProjectDialog';
import { ProjectView } from '../features/projects/ProjectView';
import { Sidebar } from '../features/projects/Sidebar';
import { useProjects } from '../features/projects/useProjects';
import { HomeView } from '../features/home/HomeView';
import { useAvatar } from '../features/home/useAvatar';
import { useWelcome } from '../features/home/useWelcome';
import { useTheme } from '../features/theme/useTheme';
import type { Project } from '../domain/project';
import { daysBetween } from '../domain/time';
import type { ProjectsStore } from '../services/projectsStore';
import type { LoadIssue } from '../services/storage';
import {
  mockWelcomeProvider,
  type WelcomeContext,
  type WelcomeProvider,
} from '../services/welcome';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useNow } from '../ui/useNow';
import { PROJECTS_BACKUP_KEY, PROJECTS_CORRUPT_KEY } from './config';
import { useSidebar } from './useSidebar';

interface AppProps {
  store: ProjectsStore;
  welcomeProvider?: WelcomeProvider;
}

type View = 'home' | 'project';

/**
 * Plain-language notice for a payload that could not be loaded. It names the key the
 * original was copied to, because without it the user has no way to find the data again —
 * but it never shows the payload itself or any internal detail.
 */
function loadIssueNotice(issue: LoadIssue): string {
  const reason: Record<LoadIssue['kind'], string> = {
    unreadable: '本地保存的项目数据已损坏，无法读取。',
    invalid: '本地保存的项目数据格式不正确，无法读取。',
    'unsupported-version': '本地保存的项目数据由更新版本的应用写入，当前版本读不了。',
    'migration-failed': '本地保存的项目数据升级失败，已停止使用它。',
  };
  const kept =
    issue.kind === 'unsupported-version' || issue.kind === 'migration-failed'
      ? `原始数据已完整备份在本机（${PROJECTS_BACKUP_KEY}），没有被覆盖或删除。`
      : `原始数据仍保留在本机（隔离副本 ${PROJECTS_CORRUPT_KEY}），没有被删除。`;
  return `${reason[issue.kind]}${kept}在确认数据恢复之前，请不要清理浏览器数据。`;
}

export function App({ store, welcomeProvider = mockWelcomeProvider }: AppProps) {
  const { projects, papers, selected, persisted, issue, actions } = useProjects(store);
  const theme = useTheme();
  const sidebar = useSidebar();
  const avatar = useAvatar();
  const now = useNow();

  const [view, setView] = useState<View>('home');
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);

  // `now` ticks once a minute. Only the values derived from it feed the memo, so the
  // welcome line is requested again when the hour or the idle-day count changes, not every tick.
  const hour = new Date(now).getHours();
  const selectedName = selected?.name ?? null;
  const selectedRelated = selected?.relatedPaperIds.length ?? 0;
  const idleDays = selected === null ? 0 : daysBetween(selected.updatedAt, now);
  const projectCount = projects.length;
  const welcomeContext = useMemo<WelcomeContext>(
    () => ({
      hour,
      projectCount,
      current:
        selectedName === null
          ? null
          : { name: selectedName, idleDays, relatedCount: selectedRelated },
    }),
    [hour, projectCount, selectedName, idleDays, selectedRelated],
  );
  const welcome = useWelcome(welcomeProvider, welcomeContext);

  const showProject = view === 'project' && selected !== null;
  const closeOverlay = () => {
    if (sidebar.narrow) sidebar.setOpen(false);
  };

  const selectProject = (id: string) => {
    actions.select(id);
    setView('project');
    closeOverlay();
  };

  const confirmDelete = () => {
    if (pendingDelete === null) return;
    // Removing another project must not pull the user away from the page they are reading.
    const removingOpenProject = pendingDelete.id === selected?.id;
    actions.remove(pendingDelete.id);
    setPendingDelete(null);
    if (removingOpenProject) setView('home');
  };

  return (
    <div
      className="app"
      data-sidebar={sidebar.open ? 'open' : 'closed'}
      data-narrow={sidebar.narrow}
    >
      <Sidebar
        open={sidebar.open}
        projects={projects}
        selectedId={selected?.id ?? null}
        homeActive={!showProject}
        now={now}
        managing={managing}
        renamingId={renamingId}
        themePref={theme.pref}
        onHome={() => {
          setView('home');
          closeOverlay();
        }}
        onCollapse={() => {
          sidebar.setOpen(false);
        }}
        onCreate={() => {
          setCreating(true);
        }}
        onSelect={selectProject}
        onToggleManage={() => {
          setManaging((value) => !value);
        }}
        onStartRename={setRenamingId}
        onCommitRename={(id, name) => {
          actions.rename(id, name);
          setRenamingId(null);
        }}
        onCancelRename={() => {
          setRenamingId(null);
        }}
        onRequestDelete={setPendingDelete}
        onThemeChange={theme.setPref}
      />

      {sidebar.narrow && sidebar.open && (
        <button
          type="button"
          className="scrim"
          aria-label="关闭侧栏"
          tabIndex={-1}
          onClick={() => {
            sidebar.setOpen(false);
          }}
        />
      )}

      <main className="main">
        {!sidebar.open && (
          <button
            type="button"
            className="icon-btn reopen glass"
            aria-label="展开侧栏"
            aria-controls="sidebar"
            aria-expanded="false"
            title="展开侧栏"
            onClick={() => {
              sidebar.setOpen(true);
            }}
          >
            <PanelLeftOpen size={16} aria-hidden="true" />
          </button>
        )}

        {issue !== null && (
          <p className="banner" role="status">
            {loadIssueNotice(issue)}
          </p>
        )}

        {!persisted && (
          <p className="banner" role="status">
            浏览器没有保存最近的改动，关闭窗口后可能丢失。
          </p>
        )}

        {showProject ? (
          <ProjectView project={selected} corePaper={papers[selected.corePaperId] ?? null} />
        ) : (
          <HomeView
            avatar={avatar}
            welcome={welcome}
            selected={selected}
            onCreate={() => {
              setCreating(true);
            }}
            onOpenSelected={() => {
              setView('project');
            }}
          />
        )}
      </main>

      <CreateProjectDialog
        open={creating}
        onClose={() => {
          setCreating(false);
        }}
        onCreate={(title) => {
          const created = actions.create(title);
          if (created === null) return false;
          setView('project');
          closeOverlay();
          return true;
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除项目"
        confirmLabel="删除"
        danger
        onConfirm={confirmDelete}
        onClose={() => {
          setPendingDelete(null);
        }}
      >
        <p>确定删除《{pendingDelete?.name}》吗？项目记录会从本机移除，此操作无法撤销。</p>
      </ConfirmDialog>
    </div>
  );
}
