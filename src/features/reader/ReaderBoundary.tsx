import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ReaderBoundaryProps {
  children: ReactNode;
  onClose: () => void;
}

interface ReaderBoundaryState {
  failed: boolean;
}

/**
 * Keeps a reader crash from taking the workspace with it.
 *
 * Rendering a broken PDF is the most likely place for an unexpected throw, and losing the
 * project list to it would be a much worse outcome than losing the page view. The message
 * stays on screen with a way back; the rest of the app never unmounts.
 */
export class ReaderBoundary extends Component<ReaderBoundaryProps, ReaderBoundaryState> {
  override state: ReaderBoundaryState = { failed: false };

  static getDerivedStateFromError(): ReaderBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The only console output the app produces, and only when something actually broke.
    console.error('阅读器渲染失败', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="reader-status" role="alert">
        <p>阅读器出错了，其它内容不受影响。可以返回后重新打开这篇论文。</p>
        <button type="button" className="btn" onClick={this.props.onClose}>
          返回
        </button>
      </div>
    );
  }
}
