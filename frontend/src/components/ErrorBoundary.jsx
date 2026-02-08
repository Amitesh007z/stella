// ─── Stella Protocol — React Error Boundary ──────────────────
// Catches uncaught component errors and shows a friendly fallback
// instead of a white screen.

import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[Stella] Uncaught UI error:', error, info?.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg-primary, #0b1120)',
          color: 'var(--text-primary, #e2e8f0)',
          fontFamily: 'var(--font-sans, system-ui)',
          padding: 32,
        }}>
          <div style={{ maxWidth: 500, textAlign: 'center' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>⚠</div>
            <h2 style={{ fontSize: 22, marginBottom: 8 }}>Something went wrong</h2>
            <p style={{ color: 'var(--text-muted, #94a3b8)', fontSize: 14, marginBottom: 8 }}>
              An unexpected error occurred in the Stella UI.
            </p>
            <pre style={{
              textAlign: 'left',
              background: 'var(--bg-card, #1e293b)',
              padding: 12,
              borderRadius: 8,
              fontSize: 11,
              lineHeight: 1.5,
              overflow: 'auto',
              maxHeight: 160,
              marginBottom: 16,
              color: 'var(--error, #ef4444)',
            }}>
              {this.state.error?.message || 'Unknown error'}
            </pre>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button
                onClick={this.handleReset}
                style={{
                  padding: '8px 20px',
                  borderRadius: 6,
                  border: 'none',
                  background: 'var(--accent, #d4553a)',
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                Try Again
              </button>
              <button
                onClick={() => window.location.assign('/')}
                style={{
                  padding: '8px 20px',
                  borderRadius: 6,
                  border: '1px solid var(--border, #334155)',
                  background: 'transparent',
                  color: 'var(--text-primary, #e2e8f0)',
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                Go to Dashboard
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
