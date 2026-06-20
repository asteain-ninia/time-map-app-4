// U41 — the React error boundary (FR-117, 受け入れ基準3, ui layer).
//
// 機能宣言: React UI ツリーに対するエラー境界。描画中の例外を捕捉してアプリ全体の
// クラッシュを防ぎ、日本語のフォールバック UI を表示する。捕捉した例外は単一のエラー処理
// 経路 (errors.handleRenderError) を通してログへ記録し、回復不能/想定外として
// 「開発者へ報告してください」を付与する (FR-115).
//
// 適用 (教訓 5.6 全経路網羅): React 描画中の経路は本境界が、それ以外 (非同期/イベント/
// IPC/IO) は globalErrorHandlers が捕捉する。両者は同じ errors.handleError 系を通すので
// メッセージ/ログ/報告案内が経路間でドリフトしない。
//
// クラスコンポーネント: React のエラー境界は getDerivedStateFromError /
// componentDidCatch を持つクラスでのみ実装できる (関数コンポーネントでは不可)。これは
// 仕様上の必然であり、本ユニットで唯一のクラスコンポーネント。

import { Component, type ErrorInfo, type ReactNode } from 'react';

import { handleRenderError, type UserNotification } from './errors';
import type { DiagnosticLogger } from './log';
import { ERROR_HANDLING_STRINGS } from './strings';

export interface ErrorBoundaryProps {
  /** The shared diagnostic logger (FR-117): caught errors are recorded here. */
  readonly logger: DiagnosticLogger;
  /** The subtree to protect. */
  readonly children: ReactNode;
  /**
   * Optional supplier of the現在 作中時刻 (現在時刻) for the log context
   * (教訓 5.15). Called at catch time so the recorded作中時刻 is current.
   */
  readonly contextTimeLabel?: () => string;
  /** Optional custom fallback renderer (receives the notification). */
  readonly renderFallback?: (notification: UserNotification) => ReactNode;
}

interface ErrorBoundaryState {
  readonly notification: UserNotification | null;
}

/**
 * Catches render-time exceptions in its subtree, logs them through the single
 * error pipeline, and shows a日本語 fallback instead of crashing the whole app
 * (FR-117). The rest of the app (outside this subtree) keeps running.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { notification: null };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const contextTime = this.props.contextTimeLabel?.();
    const notification = handleRenderError(
      this.props.logger,
      // Include the component stack as part of the cause for diagnostics.
      info.componentStack != null
        ? new Error(`${error.message}\n${info.componentStack}`, { cause: error })
        : error,
      contextTime,
    );
    this.setState({ notification });
  }

  override render(): ReactNode {
    const { notification } = this.state;
    if (notification === null) {
      return this.props.children;
    }
    if (this.props.renderFallback !== undefined) {
      return this.props.renderFallback(notification);
    }
    return (
      <div role="alert" className="error-boundary-fallback" data-testid="error-boundary-fallback">
        <h2>{ERROR_HANDLING_STRINGS.fallbackTitle}</h2>
        <p>{notification.message}</p>
      </div>
    );
  }
}
