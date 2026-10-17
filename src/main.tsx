import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { createProjectsStore } from './services/projectsStore';
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

const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <App store={createProjectsStore()} />
  </StrictMode>,
);
