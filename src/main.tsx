import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { createProjectsStore } from './services/projectsStore';
import { recoverInterruptedRestore } from './services/backupService';
import { createIndexedDbJournal } from './services/restoreJournal';
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
import './styles/backup.css';

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
  let recovery: Awaited<ReturnType<typeof recoverInterruptedRestore>>;
  try {
    recovery = await recoverInterruptedRestore({ journal: createIndexedDbJournal() });
  } catch {
    // A browser without usable storage still gets the interface; it will say so itself.
    recovery = 'none';
  }
  createRoot(container as HTMLElement).render(
    <StrictMode>
      <App
        store={createProjectsStore()}
        restoreNotice={recovery === 'none' ? undefined : recovery}
      />
    </StrictMode>,
  );
}

void bootstrap();
