// U41 — production wiring for the global (non-React) error handlers (FR-117).
//
// 機能宣言: アプリ起動時に {@link installGlobalErrorHandlers} を「1回だけ」結線し、
// 捕捉した例外を既存のユーザー通知経路 (globalThis.alert — FileOpsController.notify と
// 同じ sink) と単一のログ経路 (errors.handleError 経由) へ流す。返す uninstall を起動点の
// cleanup で呼ぶことで二重 install / リスナリークを防ぐ (教訓 5.2 全経路で破棄).
//
// 適用 (教訓 5.7「ロジックがあっても UI から呼ばれず機能しない状態を作らない」): 本ユニットは
// installGlobalErrorHandlers が本番から一度も呼ばれていなかった結線漏れ (FR-117) を埋める
// 薄い接着層で、通知/ログの規則は何も再実装しない — onError は既存 sink へ委譲するだけ
// (単一真実源). 新規トースト UI は作らない (§7.4 非目標).
//
// 純粋に近い / テスト容易: window の代わりに {@link ErrorEventTarget} を受けるので、
// リスナ登録・uninstall・sink への到達を Vitest 単体で検証できる (教訓 5.41).

import type { UserNotification } from './errors';
import {
  installGlobalErrorHandlers,
  type ErrorEventTarget,
} from './global-handlers';
import type { DiagnosticLogger } from './log';

export interface GlobalErrorWiringOptions {
  /** The single shared diagnostic logger (FR-117): caught errors are recorded here. */
  readonly logger: DiagnosticLogger;
  /** Supplies the作中時刻 (現在時刻) for the log context (教訓 5.15). */
  readonly contextTimeLabel?: () => string;
  /**
   * The existing user-notification sink. Defaults to `globalThis.alert` — the SAME
   * surface {@link FileOpsController} routes its FR-115 notices through — so no new
   * toast UI is introduced (§7.4 非目標). Injectable for tests.
   */
  readonly notify?: (message: string) => void;
}

/** Surface a notification's日本語 message through the existing alert sink. */
function alertNotify(message: string): void {
  if (typeof globalThis.alert === 'function') globalThis.alert(message);
}

/**
 * Install the window-level (non-React) error handlers ONCE and route each caught
 * error's notification to the existing user-notification sink (FR-117). Returns an
 * uninstall function so the app's startup effect can remove both listeners on
 * cleanup — preventing a double install / listener leak across re-mounts (教訓 5.2).
 *
 * This is the production结線 that was missing: {@link installGlobalErrorHandlers}
 * (unhandledrejection / error 捕捉) had no caller, so void-ed IPC/IO rejections were
 * silent (教訓 5.7). We add no new sink — `onError` just forwards the notification
 * message to the existing surface (default `globalThis.alert`, as
 * {@link FileOpsController} does).
 */
export function wireGlobalErrorHandlers(
  target: ErrorEventTarget,
  options: GlobalErrorWiringOptions,
): () => void {
  const notify = options.notify ?? alertNotify;
  return installGlobalErrorHandlers(target, {
    logger: options.logger,
    // Forward the already-converted日本語 message to the existing sink; the report
    // hint / severity styling is decided in the single handleError path, not here.
    onError: (notification: UserNotification) => notify(notification.message),
    ...(options.contextTimeLabel !== undefined
      ? { contextTimeLabel: options.contextTimeLabel }
      : {}),
  });
}
