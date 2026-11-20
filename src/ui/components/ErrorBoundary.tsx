import { Component, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/** Shows a recoverable screen instead of a blank page if rendering throws. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('Opening Trainer crashed:', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page narrow" role="alert">
        <h1>Something went wrong</h1>
        <p>Your progress is stored on this device and has not been lost.</p>
        <pre className="error small" style={{ whiteSpace: 'pre-wrap' }}>{this.state.error.message}</pre>
        <div className="btn-row wrap">
          <button className="btn primary" onClick={() => { window.location.hash = '#/'; window.location.reload(); }}>Go to start</button>
          <button className="btn" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}
