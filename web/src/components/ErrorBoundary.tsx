/**
 * Error boundary.
 *
 * A render-time exception anywhere below this point shows a readable panel instead
 * of a white screen — the hard requirement from the task brief.
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the component stack available in the devtools console.
    console.error('UI render error:', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ padding: 24 }}>
        <div className="panel" style={{ borderColor: 'var(--err)' }}>
          <h2 style={{ color: 'var(--err)' }}>介面發生錯誤（未白屏）</h2>
          <p className="mono">{error.message}</p>
          <p className="hint">
            這是 UI 端的例外，與音訊引擎無關。按下方按鈕可重置介面；你的專案檔不會被改動。
          </p>
          <button className="primary" onClick={() => this.setState({ error: null })}>
            重置介面
          </button>
        </div>
      </div>
    );
  }
}
