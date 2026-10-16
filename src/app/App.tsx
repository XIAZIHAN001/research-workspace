import { PanelLeftOpen } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CreateProjectDialog } from '../features/projects/CreateProjectDialog';
import { ProjectView } from '../features/projects/ProjectView';
import { Sidebar } from '../features/projects/Sidebar';
import { useProjects } from '../features/projects/useProjects';
import { HomeView } from '../features/home/HomeView';
import { useAvatar } from '../features/home/useAvatar';
import { useWelcome } from '../features/home/useWelcome';
import { useTheme } from '../features/theme/useTheme';
import { EditPaperDialog } from '../features/papers/EditPaperDialog';
import { ImportPaperDialog } from '../features/library/ImportPaperDialog';
import { LibraryView } from '../features/library/LibraryView';
import {
  commitImport,
  describeEditFailure,
  type ImportCommit,
} from '../features/library/importPaperFlow';
import { probePdf } from '../features/reader/pdfjs';
import type { ProbePdf } from '../features/library/importPdf';
import { ReaderBoundary } from '../features/reader/ReaderBoundary';
import { ReaderView } from '../features/reader/ReaderView';
import type { PaperEdit } from '../domain/papers';
import type { Project } from '../domain/project';
import { daysBetween } from '../domain/time';
import type { ProjectsStore } from '../services/projectsStore';
import { createPdfBlobStore, type PdfBlobStore } from '../services/pdfStore';
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
  /** PDF storage; injected in tests, IndexedDB in the app. */
  blobs?: PdfBlobStore;
  /** Parses a PDF to validate it; injected in tests, pdf.js in the app. */
  probe?: ProbePdf;
}

type View = 'home' | 'project' | 'library' | 'reader';

/** Which file the import dialog is collecting, and where the paper should end up. */
interface ImportRequest {
  mode: 'new' | 'attach';
  /** The paper being given a file, in `attach` mode. */
  paperId: string | null;
  /** The project to add to, when the import started from one. */
  projectId: string | null;
}

/** How long the reader waits after the last page change before it saves the position. */
const READING_SAVE_DELAY = 800;

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

export function App({ store, welcomeProvider = mockWelcomeProvider, blobs, probe }: AppProps) {
  const { projects, papers, selected, persisted, issue, actions } = useProjects(store);
  const theme = useTheme();
  const sidebar = useSidebar();
  const avatar = useAvatar();
  const now = useNow();
  // One blob store per app instance: the reader keys its loading effect on this identity.
  const blobStore = useMemo(() => blobs ?? createPdfBlobStore(), [blobs]);

  const [view, setView] = useState<View>('home');
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);
  const [readingPaperId, setReadingPaperId] = useState<string | null>(null);
  const [importRequest, setImportRequest] = useState<ImportRequest | null>(null);
  const [editingPaperId, setEditingPaperId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const paperList = useMemo(
    () =>
      Object.values(papers).sort((one, other) =>
        one.title.localeCompare(other.title, 'zh-Hans-CN'),
      ),
    [papers],
  );
  const readingPaper = readingPaperId === null ? null : (papers[readingPaperId] ?? null);
  const editingPaper = editingPaperId === null ? null : (papers[editingPaperId] ?? null);

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

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => {
      setNotice(null);
    }, 8000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [notice]);

  // Reading position: kept in a ref until the page has been still for a moment, so a fast
  // scroll does not write the workspace on every page it passes.
  const savedPosition = useRef<{ paperId: string; page: number } | null>(null);
  const positionTimer = useRef<number | null>(null);

  const flushReadingPosition = useCallback(
    (paperId: string) => {
      if (positionTimer.current !== null) {
        window.clearTimeout(positionTimer.current);
        positionTimer.current = null;
      }
      const pending = savedPosition.current;
      savedPosition.current = null;
      if (pending !== null && pending.paperId === paperId) {
        actions.updatePaper(paperId, { reading: { page: pending.page, updatedAt: Date.now() } });
      }
    },
    [actions],
  );

  const handleReadingPosition = useCallback(
    (page: number) => {
      if (readingPaperId === null) return;
      const paperId = readingPaperId;
      savedPosition.current = { paperId, page };
      if (positionTimer.current !== null) window.clearTimeout(positionTimer.current);
      positionTimer.current = window.setTimeout(() => {
        flushReadingPosition(paperId);
      }, READING_SAVE_DELAY);
    },
    [flushReadingPosition, readingPaperId],
  );

  const closeReader = useCallback(() => {
    if (readingPaperId !== null) flushReadingPosition(readingPaperId);
    setView(selected === null ? 'home' : 'project');
  }, [flushReadingPosition, readingPaperId, selected]);

  const showProject = (view === 'project' || view === 'reader') && selected !== null;
  const closeOverlay = () => {
    if (sidebar.narrow) sidebar.setOpen(false);
  };

  const selectProject = (id: string) => {
    actions.select(id);
    setView('project');
    closeOverlay();
  };

  const openReader = (paperId: string) => {
    setReadingPaperId(paperId);
    setView('reader');
    closeOverlay();
  };

  const confirmDelete = () => {
    if (pendingDelete === null) return;
    // Removing another project must not pull the user away from the page they are reading.
    const removingOpenProject = pendingDelete.id === selected?.id;
    actions.remove(pendingDelete.id);
    setPendingDelete(null);
    if (removingOpenProject) {
      setReadingPaperId(null);
      setView('home');
    }
  };

  const handleCommitted = (commit: ImportCommit) => {
    if (commit.status === 'refused') {
      setNotice(commit.message);
      return;
    }
    if (commit.status === 'created') {
      setNotice('论文已导入。');
    } else if (commit.status === 'recognised') {
      setNotice(
        `这个 DOI/arXiv ID 对应已有论文《${papers[commit.paperId]?.title ?? ''}》，文件已补充给它。`,
      );
    } else {
      setNotice('文件已保存。');
    }
    openReader(commit.paperId);
  };

  const savePaperEdit = (paperId: string, edit: PaperEdit): string | null => {
    const result = actions.updatePaper(paperId, edit);
    return result.ok ? null : describeEditFailure(result.failure);
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
        homeActive={view === 'home'}
        libraryActive={view === 'library'}
        now={now}
        managing={managing}
        renamingId={renamingId}
        themePref={theme.pref}
        onHome={() => {
          setView('home');
          closeOverlay();
        }}
        onLibrary={() => {
          setView('library');
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

        {notice !== null && (
          <p className="banner" role="status">
            {notice}
          </p>
        )}

        {view === 'reader' && readingPaper !== null ? (
          <ReaderBoundary onClose={closeReader}>
            <ReaderView
              key={readingPaper.id}
              paper={readingPaper}
              blobs={blobStore}
              onClose={closeReader}
              onReadingPosition={handleReadingPosition}
              onReplaceFile={() => {
                setImportRequest({
                  mode: 'attach',
                  paperId: readingPaper.id,
                  projectId: selected?.id ?? null,
                });
              }}
            />
          </ReaderBoundary>
        ) : view === 'library' ? (
          <LibraryView
            papers={paperList}
            projects={projects}
            preferredProjectId={selected?.id ?? null}
            onOpenReader={openReader}
            onEditPaper={setEditingPaperId}
            onImportFile={(paperId) => {
              setImportRequest({ mode: 'attach', paperId, projectId: null });
            }}
            onImportNew={() => {
              setImportRequest({ mode: 'new', paperId: null, projectId: selected?.id ?? null });
            }}
            onLinkToProject={(paperId, projectId) => {
              actions.linkPaper(projectId, paperId);
              const project = projects.find((candidate) => candidate.id === projectId);
              setNotice(
                `已经把《${papers[paperId]?.title ?? ''}》加入《${project?.name ?? ''}》。`,
              );
            }}
          />
        ) : showProject ? (
          <ProjectView
            project={selected}
            papers={papers}
            onOpenReader={openReader}
            onImportFile={(paperId) => {
              setImportRequest({ mode: 'attach', paperId, projectId: selected.id });
            }}
            onEditPaper={setEditingPaperId}
            onUnlinkPaper={(paperId) => {
              actions.unlinkPaper(selected.id, paperId);
            }}
            onImportNew={() => {
              setImportRequest({ mode: 'new', paperId: null, projectId: selected.id });
            }}
            onLinkFromLibrary={() => {
              setView('library');
            }}
          />
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

      <ImportPaperDialog
        open={importRequest !== null}
        onClose={() => {
          setImportRequest(null);
        }}
        mode={importRequest?.mode ?? 'new'}
        targetPaper={
          importRequest?.paperId === null || importRequest?.paperId === undefined
            ? null
            : (papers[importRequest.paperId] ?? null)
        }
        projects={projects}
        initialProjectId={importRequest?.projectId ?? null}
        papers={papers}
        blobs={blobStore}
        probe={probe ?? probePdf}
        onCommit={(intent, fields, pdf) =>
          commitImport(
            {
              papers,
              updatePaper: actions.updatePaper,
              referencePaper: actions.referencePaper,
              addPaper: actions.addPaper,
              linkPaper: actions.linkPaper,
            },
            intent,
            fields,
            pdf,
          )
        }
        onCommitted={handleCommitted}
      />

      <EditPaperDialog
        open={editingPaper !== null}
        paper={editingPaper}
        onClose={() => {
          setEditingPaperId(null);
        }}
        onSave={(edit) => (editingPaper === null ? null : savePaperEdit(editingPaper.id, edit))}
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
