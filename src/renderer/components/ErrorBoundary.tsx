import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

/** Catches render-time errors, logs them to renderer.log, and offers a reload. */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const msg = `[ErrorBoundary] ${error.message}\n${error.stack ?? ''}\nComponent stack: ${info.componentStack ?? ''}`;
    try { window.drafting?.writeLog?.(msg); } catch { /* noop */ }
    console.error(msg);
  }

  render() {
    if (this.state.hasError && this.state.error) {
      return (
        <div style={{ padding: 32, maxWidth: 720, margin: '0 auto', fontFamily: 'var(--font-ui)' }}>
          <h2 style={{ fontSize: 18, marginBottom: 8 }}>Something went wrong</h2>
          <p style={{ color: 'var(--fg-2)', marginBottom: 16 }}>
            Your files are safe on disk. The details below have been written to the log. Reloading the window usually clears this.
          </p>
          <button className="btn primary" onClick={() => window.location.reload()}>Reload window</button>
          <pre style={{ marginTop: 20, padding: 12, background: 'var(--bg-2)', borderRadius: 6, fontSize: 12, whiteSpace: 'pre-wrap', color: 'var(--fg-1)' }}>
            {this.state.error.message}{'\n'}{this.state.error.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
