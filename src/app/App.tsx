import { PanelLeftOpen } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
import { BackupDialog } from '../features/backup/BackupDialog';
import { useKnowledgeApi } from '../features/knowledge/useKnowledgeApi';
import { createKnowledgeStore, type KnowledgeStore } from '../services/knowledgeStore';
import { createAnnotation } from '../domain/annotation';
import type { AiClient } from '../features/reader/useAiReading';
import type { PaperEdit } from '../domain/papers';
import { makeId } from '../services/ids';
import type { Project } from '../domain/project';
import type { ProjectsState } from '../domain/projectsState';
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
  /** The assistant's transport; injected in tests, the local service in the app. */
  ai?: AiClient;
  /** The knowledge graph's storage; created on first use when not supplied. */
  knowledgeStore?: KnowledgeStore;
  /** Set when start-up had to finish or roll back a restore that was interrupted. */
  restoreNotice?: 'completed' | 'clean' | 'rolled-back' | 'blocked';
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

export function App({
  store,
  welcomeProvider = mockWelcomeProvider,
  blobs,
  probe,
  ai,
  knowledgeStore,
  restoreNotice,
}: AppProps) {
  const { projects, papers, annotations, selected, persisted, issue, actions } = useProjects(store);
  const theme = useTheme();
  const sidebar = useSidebar();
  const avatar = useAvatar();
  const now = useNow();
  // One blob store per app instance: the reader keys its loading effect on this identity.
  const blobStore = useMemo(() => blobs ?? createPdfBlobStore(), [blobs]);
  const knowledge = useMemo(() => knowledgeStore ?? createKnowledgeStore(), [knowledgeStore]);
  // Subscribed at the top so a dispatch anywhere re-renders the project view, the reader and
  // the sidebar from the same snapshot.
  useSyncExternalStore(knowledge.subscribe, knowledge.getSnapshot);
  const knowledgeApi = useKnowledgeApi(knowledge, makeId);

  const [view, setView] = useState<View>('home');
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);
  const [readingPaperId, setReadingPaperId] = useState<string | null>(null);
  /** Where to land in the reader, set when opening a paper from a concept's evidence. */
  const [readingFocus, setReadingFocus] = useState<{ page: number; quote: string } | null>(null);
  const [importRequest, setImportRequest] = useState<ImportRequest | null>(null);
  const [editingPaperId, setEditingPaperId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [projectZone, setProjectZone] = useState<'papers' | 'knowledge'>('papers');
  const [knowledgeMode, setKnowledgeMode] = useState<'list' | 'graph'>('list');
  const [knowledgeSelectedId, setKnowledgeSelectedId] = useState<string | null>(null);
  const [backupOpen, setBackupOpen] = useState(false);

  const paperList = useMemo(
    () =>
      Object.values(papers).sort((one, other) =>
        one.title.localeCompare(other.title, 'zh-Hans-CN'),
      ),
    [papers],
  );
  /** The workspace in the shape the backup service reads — the same state the stores persist. */
  const projectsState = useMemo<ProjectsState>(
    () => ({ projects, papers, annotations, selectedId: selected?.id ?? null }),
    [projects, papers, annotations, selected?.id],
  );
  const readingPaper = readingPaperId === null ? null : (papers[readingPaperId] ?? null);
  // Notes follow the paper, so every project that opens it sees the same ones.
  const paperAnnotations = useMemo(
    () =>
      readingPaper === null
        ? []
        : annotations.filter((annotation) => annotation.paperId === readingPaper.id),
    [annotations, readingPaper],
  );
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
    // The focus is a one-shot instruction for the open that asked for it; leaving it set would
    // make the next ordinary open jump to a quotation nobody asked for.
    setReadingFocus(null);
    setView(selected === null ? 'home' : 'project');
  }, [flushReadingPosition, readingPaperId, selected]);

  const showProject = (view === 'project' || view === 'reader') && selected !== null;
  const closeOverlay = () => {
    if (sidebar.narrow) sidebar.setOpen(false);
  };

  const selectProject = (id: string) => {
    if (id !== selected?.id) {
      setProjectZone('papers');
      setKnowledgeSelectedId(null);
    }
    actions.select(id);
    setView('project');
    closeOverlay();
  };

  /** Follow a concept into another project that shares it, without losing the concept. */
  const openProjectKnowledge = (projectId: string) => {
    actions.select(projectId);
    setProjectZone('knowledge');
    setView('project');
    closeOverlay();
  };

  const openReader = (paperId: string, focus?: { page: number; quote: string }) => {
    setReadingPaperId(paperId);
    setReadingFocus(focus ?? null);
    setView('reader');
    closeOverlay();
  };

  const confirmDelete = () => {
    if (pendingDelete === null) return;
    // Removing another project must not pull the user away from the page they are reading.
    const removingOpenProject = pendingDelete.id === selected?.id;
    const projectId = pendingDelete.id;
    actions.remove(projectId);
    // The knowledge graph is shared between projects: removing one unlinks it from the concepts
    // it names and deletes nothing. Another project's knowledge survives untouched.
    knowledge.dispatch({ type: 'project/detach', projectId, at: Date.now() });
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
        onBackup={() => {
          setBackupOpen(true);
        }}
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

        {(restoreNotice === 'rolled-back' || restoreNotice === 'blocked') && (
          <p className="banner banner-warning" role="status">
            {restoreNotice === 'rolled-back'
              ? '上一次恢复在写入过程中中断，启动时已把数据还原到恢复前的状态。'
              : '上一次恢复中断，且自动还原没有完全成功。恢复日志仍保留着，请先导出备份再继续操作。'}
          </p>
        )}

        {view === 'reader' && readingPaper !== null ? (
          <ReaderBoundary onClose={closeReader}>
            <ReaderView
              key={readingPaper.id}
              paper={readingPaper}
              blobs={blobStore}
              aiClient={ai}
              theme={theme.resolved}
              focus={readingFocus}
              onClose={closeReader}
              onReadingPosition={handleReadingPosition}
              onReplaceFile={() => {
                setImportRequest({
                  mode: 'attach',
                  paperId: readingPaper.id,
                  projectId: selected?.id ?? null,
                });
              }}
              annotations={paperAnnotations}
              onCreateAnnotation={(anchor, draft) => {
                const created = createAnnotation(
                  {
                    paperId: readingPaper.id,
                    pdfSha256: readingPaper.pdf?.sha256 ?? '',
                    page: anchor.page,
                    quote: anchor.quote,
                    prefix: anchor.prefix,
                    suffix: anchor.suffix,
                    rects: anchor.rects,
                    kind: draft.kind,
                    note: draft.note,
                  },
                  makeId,
                  Date.now(),
                );
                // Nothing usable was selected; the reader has already said why.
                if (created === null) return;
                actions.addAnnotation(created);
              }}
              onEditAnnotation={actions.updateAnnotation}
              onDeleteAnnotation={(annotation) => {
                actions.removeAnnotation(annotation.id);
              }}
              canSaveConcept={selected !== null}
              onSaveConcept={(suggestion) => {
                if (selected === null) return;
                const projectId = selected.id;
                const conceptId = knowledgeApi.createConcept({
                  name: suggestion.title,
                  summary: suggestion.quick,
                  projectIds: [projectId],
                  origin: 'ai',
                  status: 'suggested',
                });
                const anchor = suggestion.anchor;
                if (anchor === null) return;
                knowledgeApi.addEvidence({
                  conceptId,
                  paperId: readingPaper.id,
                  pdfSha256: readingPaper.pdf?.sha256 ?? '',
                  page: suggestion.page,
                  quote: anchor.quote,
                  prefix: anchor.prefix,
                  suffix: anchor.suffix,
                  rects: anchor.rects,
                  source: 'difficulty',
                  suggestionId: suggestion.id,
                  note: suggestion.why,
                });
                setNotice(
                  `已经把「${suggestion.title}」记为概念（待确认），可以在项目页的「知识」里查看。`,
                );
              }}
              onSaveAiNote={(anchor, draft) => {
                // An explanation the reader chose to keep becomes an ordinary annotation with
                // the same anchor — same file, same page, same boxes — but marked as coming
                // from the assistant, so it can never be mistaken for something they wrote.
                const created = createAnnotation(
                  {
                    paperId: readingPaper.id,
                    pdfSha256: readingPaper.pdf?.sha256 ?? '',
                    page: anchor.page,
                    quote: anchor.quote,
                    prefix: anchor.prefix,
                    suffix: anchor.suffix,
                    rects: anchor.rects,
                    kind: 'insight',
                    note: draft.note,
                    origin: 'assistant',
                    sourceLabel: draft.sourceLabel,
                  },
                  makeId,
                  Date.now(),
                );
                if (created === null) return;
                actions.addAnnotation(created);
                setNotice('已保存为笔记，并标记为 AI 辅助。');
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
              const project = projects.find((candidate) => candidate.id === projectId);
              const title = papers[paperId]?.title ?? '';
              // Linking a paper a project already has changes nothing, and saying "added" would
              // be a small lie the reader would notice the next time they looked at the project.
              const alreadyThere =
                project !== undefined &&
                (project.corePaperId === paperId || project.relatedPaperIds.includes(paperId));
              actions.linkPaper(projectId, paperId);
              setNotice(
                alreadyThere
                  ? `《${title}》已经在《${project?.name ?? ''}》里了。`
                  : `已经把《${title}》加入《${project?.name ?? ''}》。`,
              );
            }}
          />
        ) : showProject ? (
          <ProjectView
            project={selected}
            papers={papers}
            annotations={annotations}
            knowledge={knowledgeApi}
            projects={projects}
            zone={projectZone}
            onZoneChange={setProjectZone}
            knowledgeMode={knowledgeMode}
            knowledgeSelectedId={knowledgeSelectedId}
            onKnowledgeMode={setKnowledgeMode}
            onKnowledgeSelect={setKnowledgeSelectedId}
            onOpenProject={openProjectKnowledge}
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
          setProjectZone('papers');
          setKnowledgeSelectedId(null);
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

      {backupOpen && (
        <BackupDialog
          open
          onClose={() => {
            setBackupOpen(false);
          }}
          projects={projectsState}
          knowledge={knowledgeApi.state}
          blobs={blobStore}
          onReload={() => {
            window.location.reload();
          }}
        />
      )}
    </div>
  );
}
