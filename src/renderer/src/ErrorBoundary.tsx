import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[skymark] render crashed:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="app">
          <section className="meeting">
            <div className="card">
              <h2>Something broke</h2>
              <p className="help">{this.state.error.message}</p>
              <div className="row">
                <button onClick={() => window.location.reload()}>Reload</button>
              </div>
            </div>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
