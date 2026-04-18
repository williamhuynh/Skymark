import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Sidebar } from './Sidebar';
import { ErrorBoundary } from './ErrorBoundary';
import './styles.css';

const view = window.location.hash.replace(/^#/, '') || 'main';
const Root = view === 'sidebar' ? Sidebar : App;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </StrictMode>,
);
