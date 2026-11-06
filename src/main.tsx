import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { recoverInterruptedRestore, readPdfReferences } from './services/backupService';
import { collectStartupPdfGarbage } from './services/pdfGarbageCollection';
import { createIndexedDbJournal } from './services/restoreJournal';
import { workspaceAccess } from './services/workspaceAccess';
import { initializeWorkspace } from './services/workspaceStartup';
import { createPdfBlobStore } from './services/pdfStore';
// KaTeX's stylesheet and fonts travel with the bundle: the app is local-first and must typeset
// mathematics with no network request. It comes before reader.css so the app's own rules on
// sizing and colour can win where they need to.
import 'katex/dist/katex.min.css';
import './styles/tokens.css';
import './styles/spring.css';
import './styles/base.css';
import './styles/glass.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/reader.css';
import './styles/knowledge.css';
import './styles/knowledge-ai.css';
import './styles/backup.css';
import './styles/desktop.css';
// Scroll edge fades for the app's scrolling surfaces. Before apple.css so the presentation
// layer can still win where the two ever disagree.
import './styles/scroll-edges.css';
// Presentation only, imported last: it settles the surface hierarchy, type ladder and accent
// on top of the component stylesheets without touching any behaviour.
import './styles/apple.css';

const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root element');

/**
 * A restore interrupted by a crash is settled before any store reads storage.
 *
 * The stores load once, from the values that are on disk when they are created; deciding
 * between "finished", "never started" and "half written" has to happen before that read, or
 * the page would run on a mixture and then write it back.
 */
async function bootstrap(): Promise<void> {
  const root = createRoot(container as HTMLElement);
  let diagnostic = '';
  const blobs = createPdfBlobStore();
  workspaceAccess.bindLifecycle(window, () => {
    window.location.reload();
  });
  const status = await initializeWorkspace(
    async (recovery) => {
      // Import the application only after the recovery boundary. No store constructors,
      // migration/quarantine writes, effects or welcome setup can run on a blocked startup.
      const [{ App }, { createProjectsStore }] = await Promise.all([
        import('./app/App'),
        import('./services/projectsStore'),
      ]);
      root.render(
        <StrictMode>
          <App
            store={createProjectsStore()}
            blobs={blobs}
            restoreNotice={recovery === 'none' ? undefined : recovery}
          />
        </StrictMode>,
      );
    },
    {
      access: workspaceAccess,
      maintain: () => collectStartupPdfGarbage(blobs, readPdfReferences),
      recover: () =>
        recoverInterruptedRestore({
          journal: createIndexedDbJournal(),
          blobs,
          onProblem: (detail) => {
            diagnostic = detail;
          },
        }),
    },
  );
  if (status.status === 'blocked') {
    root.render(
      <main className="backup-result" role="alert">
        <h1>工作区已暂停</h1>
        <p>无法安全确认工作区恢复状态，未启动工作区，也未允许正常数据写入。</p>
        <p>{diagnostic || status.detail}</p>
        <p>
          请先关闭其他工作区窗口，检查浏览器存储权限后重试。不要清除网站数据、恢复日志或重新安装覆盖数据。
        </p>
        <p>
          若仍失败，请保留当前浏览器配置目录，并将此诊断交给维护人员；确认副本可恢复后再进行人工恢复。
        </p>
        <button
          type="button"
          onClick={() => {
            window.location.reload();
          }}
        >
          重新检查
        </button>
      </main>,
    );
  }
}

void bootstrap();
