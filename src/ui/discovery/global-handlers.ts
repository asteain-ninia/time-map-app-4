// U41 — global error handlers for non-React paths (FR-117, 受け入れ基準3, ui).
//
// 機能宣言: React エラー境界が捕捉しない経路 (非同期処理・イベントハンドラ・IPC 呼び出し
// 境界・ファイル/外部入力処理) で発生する例外を捕捉する共通ハンドラを提供する。捕捉した
// 例外はすべて単一のエラー処理経路 (errors.handleError) を通し、日本語メッセージで通知し
// ログへ記録する (FR-115 / FR-117).
//
// 適用 (教訓 5.6「状態変化の検出は結果状態で判定する」/ 全経路網羅, 引用: 特定の入力経路
// だけでゲートしない): window の 'error' と 'unhandledrejection' を両方購読し、加えて
// イベントハンドラ・IPC・IO 呼び出しを安全に包む wrap* ヘルパーを提供して、想定される
// 例外経路を列挙して網羅する。どの経路も同じ handleError を通すのでメッセージ/ログが
// 経路間でドリフトしない。
//
// install* は副作用 (addEventListener) を持つが、内部の変換は errors.handleError に委ね
// 純粋に近い。テストは wrap* と onError コールバックで検証し、物理リスナ登録は薄く保つ
// (教訓 5.41).

import {
  ERROR_ORIGIN,
  ERROR_SEVERITY,
  handleError,
  type ErrorOrigin,
  type UserNotification,
} from './errors';
import type { DiagnosticLogger } from './log';
import { ERROR_HANDLING_STRINGS } from './strings';

/** Minimal event-target surface so this is testable without a real `window`. */
export interface ErrorEventTarget {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

export interface GlobalErrorHandlerOptions {
  readonly logger: DiagnosticLogger;
  /** Called with the notification for each caught error (UI shows it). */
  readonly onError: (notification: UserNotification) => void;
  /** Supplies the現在 作中時刻 (現在時刻) for the log context (教訓 5.15). */
  readonly contextTimeLabel?: () => string;
}

/** Extract a日本語 message + cause from a caught value (origin-agnostic). */
function notify(
  options: GlobalErrorHandlerOptions,
  origin: ErrorOrigin,
  cause: unknown,
  summary: string,
): UserNotification {
  const notification = handleError(options.logger, {
    origin,
    // Uncaught exceptions on these paths are treated as unexpected/internal:
    // they append the report hint (FR-115). A path that knows its error is
    // recoverable should call handleError directly with Recoverable instead.
    severity: ERROR_SEVERITY.Unrecoverable,
    message: ERROR_HANDLING_STRINGS.unexpectedLead,
    cause,
    contextSummary: summary,
    ...(options.contextTimeLabel !== undefined
      ? { contextTime: options.contextTimeLabel() }
      : {}),
  });
  options.onError(notification);
  return notification;
}

/**
 * Install window-level handlers for the two browser/renderer paths React's
 * boundary does NOT see: synchronous uncaught errors ('error') and unhandled
 * Promise rejections ('unhandledrejection'). Returns an uninstall function.
 * (教訓 5.6: both paths, not one.)
 */
export function installGlobalErrorHandlers(
  target: ErrorEventTarget,
  options: GlobalErrorHandlerOptions,
): () => void {
  const onErrorEvent = (event: unknown): void => {
    const cause =
      typeof event === 'object' && event !== null && 'error' in event
        ? (event as { error: unknown }).error
        : event;
    notify(options, ERROR_ORIGIN.Event, cause, 'window error');
  };
  const onRejection = (event: unknown): void => {
    const cause =
      typeof event === 'object' && event !== null && 'reason' in event
        ? (event as { reason: unknown }).reason
        : event;
    notify(options, ERROR_ORIGIN.Async, cause, 'unhandled rejection');
  };

  target.addEventListener('error', onErrorEvent);
  target.addEventListener('unhandledrejection', onRejection);

  return () => {
    target.removeEventListener('error', onErrorEvent);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}

/**
 * Wrap an event-handler so a thrown exception is funneled to the single error
 * path instead of escaping (教訓 5.6: the イベントハンドラ path is covered). The
 * wrapped handler returns undefined on error so the caller never sees the throw.
 */
export function wrapEventHandler<A extends unknown[]>(
  options: GlobalErrorHandlerOptions,
  summary: string,
  handler: (...args: A) => void,
): (...args: A) => void {
  return (...args: A) => {
    try {
      handler(...args);
    } catch (cause) {
      notify(options, ERROR_ORIGIN.Event, cause, summary);
    }
  };
}

/**
 * Wrap an async IPC/IO call so a rejection is funneled to the single error path
 * (教訓 5.6: the IPC / IO boundary paths are covered). On failure the returned
 * promise resolves to `undefined` (the notification is already shown/logged), so
 * the caller can branch on the value rather than catch.
 */
export async function wrapAsyncBoundary<T>(
  options: GlobalErrorHandlerOptions,
  origin: typeof ERROR_ORIGIN.Ipc | typeof ERROR_ORIGIN.Io,
  summary: string,
  call: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await call();
  } catch (cause) {
    notify(options, origin, cause, summary);
    return undefined;
  }
}
