import { createRoot } from 'react-dom/client';
import './styles/global.css';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';

function logToMain(message: string) {
  try {
    window.drafting?.writeLog?.(message);
  } catch {
    /* IPC not ready */
  }
}

window.addEventListener('error', (event) => {
  logToMain(`[window error] ${event.message}\n  at ${event.filename}:${event.lineno}:${event.colno}\n  ${event.error?.stack ?? event.error ?? ''}`);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason instanceof Error ? `${event.reason.message}\n${event.reason.stack}` : String(event.reason);
  logToMain(`[unhandled rejection] ${reason}`);
});

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');

createRoot(container).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
