import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { createProjectsStore } from './services/projectsStore';
import './styles/tokens.css';
import './styles/spring.css';
import './styles/base.css';
import './styles/glass.css';
import './styles/layout.css';
import './styles/components.css';

const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <App store={createProjectsStore()} />
  </StrictMode>,
);
