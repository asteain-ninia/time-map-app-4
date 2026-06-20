// U41 — the single error → user-notification + log conversion (FR-115 / FR-117).
//
// 機能宣言: アプリ横断のエラー → ユーザー通知変換を単一の共通経路に集約する。回復可能な
// エラー (入力不正・検証拒否) は具体的な対処を案内し、回復不能・想定外の内部エラーには
// 「開発者へ報告してください」を付与する (FR-115). ドメイン処理が返す拒否理由・失敗も
// この共通経路でユーザー通知へ変換する。エラー発生時はログへ記録する (FR-117).
//
// 適用 (教訓 5.6「状態変化の検出は結果状態で判定する」/ 全経路網羅): React 描画中・非同期・
// イベント・IPC・外部入力の各経路で起きうる例外を、ORIGIN を列挙した `ErrorOrigin` で
// 受け、どの経路でも同じ `handleError` を通す。特定経路だけで捕捉せず、想定経路を列挙して
// 網羅する。
//
// 適用 (教訓 5.12「判断用メッセージを無関係な操作で消さない」): 変換結果 (UserNotification)
// は判断用メッセージとして扱い、`dismissOn` で消す契機を「同種操作の再試行」「明示的な
// 閉じる」「成功した置換操作」に限定する語彙を持たせる。無関係なクリックでは消さない。
//
// 純粋に近い: handleError は注入された logger へ記録する副作用のみを持ち、戻り値の通知は
// 入力から決定的に導かれる (NFR 5.8). ログ記録を除けば純粋関数として検証できる。

import { DiagnosticLogger, LOG_LEVEL, type LogContext } from './log';
import { ERROR_HANDLING_STRINGS } from './strings';

/**
 * Where the error came from. EVERY catch path tags its origin with one of these
 * (教訓 5.6: enumerate all paths, do not gate on one). Code branches on the
 * constants, never bare literals (教訓 5.19).
 */
export const ERROR_ORIGIN = {
  /** A React render-tree exception (caught by the error boundary). */
  Render: 'render',
  /** An async/Promise rejection (unhandledrejection / awaited call). */
  Async: 'async',
  /** A DOM/event-handler exception outside React's boundary. */
  Event: 'event',
  /** An IPC call boundary failure (renderer ↔ main). */
  Ipc: 'ipc',
  /** File / external-input processing (load / import). */
  Io: 'io',
  /** A domain rejection/failure surfaced as a notification (not thrown). */
  DomainRejection: 'domainRejection',
} as const;

export type ErrorOrigin = (typeof ERROR_ORIGIN)[keyof typeof ERROR_ORIGIN];

/**
 * Whether the error is user-recoverable. Recoverable ⇒ actionable guidance, no
 * report hint. Unrecoverable/unexpected ⇒ append「開発者へ報告してください」
 * (FR-115). This is the single dimension that decides the report hint.
 */
export const ERROR_SEVERITY = {
  /** User can fix it (bad input / validation rejection). */
  Recoverable: 'recoverable',
  /** Unexpected / internal — append the report hint. */
  Unrecoverable: 'unrecoverable',
} as const;

export type ErrorSeverity =
  (typeof ERROR_SEVERITY)[keyof typeof ERROR_SEVERITY];

/** When a notification may be dismissed (教訓 5.12: 限定された消去契機). */
export const DISMISS_ON = {
  /** Retry of the same kind of operation. */
  Retry: 'retry',
  /** An explicit close by the user. */
  ExplicitClose: 'explicitClose',
  /** A successful operation that replaces this one. */
  SuccessfulReplace: 'successfulReplace',
} as const;

export type DismissOn = (typeof DISMISS_ON)[keyof typeof DISMISS_ON];

/**
 * The dismissal contract for a判断用 notification: the ONLY triggers that may
 * clear it (教訓 5.12). An unrelated click/mouse move is NOT in this set, so the
 * UI keeps the message until one of these. Always includes ExplicitClose.
 */
export const JUDGEMENT_DISMISS_TRIGGERS: readonly DismissOn[] = [
  DISMISS_ON.Retry,
  DISMISS_ON.ExplicitClose,
  DISMISS_ON.SuccessfulReplace,
];

/**
 * The user-facing notification produced by the single conversion. `message` is
 * the日本語 text (report hint already appended for unrecoverable). `dismissOn`
 * lists the permitted dismissal triggers (教訓 5.12). `severity`/`origin` are
 * retained so the UI can style/route and tests can assert.
 */
export interface UserNotification {
  readonly origin: ErrorOrigin;
  readonly severity: ErrorSeverity;
  readonly message: string;
  readonly dismissOn: readonly DismissOn[];
}

/** Input to the single error handler. */
export interface ErrorInput {
  readonly origin: ErrorOrigin;
  readonly severity: ErrorSeverity;
  /**
   * The core日本語 message. For recoverable errors this is the actionable
   * guidance; for unrecoverable errors the report hint is appended automatically.
   * Domain rejections pass their already-localized rejection message here.
   */
  readonly message: string;
  /** The underlying error/cause (for the log), if any. */
  readonly cause?: unknown;
  /** Non-sensitive operation-context summary for the log (FR-117). */
  readonly contextSummary?: string;
  /** The作中時刻 (現在時刻) display string for the log context (教訓 5.15). */
  readonly contextTime?: string;
}

/** Stringify an arbitrary thrown value into a log-safe cause string. */
export function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.stack ?? `${cause.name}: ${cause.message}`;
  }
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

/**
 * Build the user-facing message: recoverable shows actionable guidance as-is
 * (with a小さな prefix); unrecoverable appends the report hint (FR-115). This is
 * the ONE place the report-hint rule lives, so no path forgets it.
 */
export function buildUserMessage(
  severity: ErrorSeverity,
  coreMessage: string,
): string {
  if (severity === ERROR_SEVERITY.Recoverable) {
    return coreMessage;
  }
  // Unrecoverable / unexpected: ensure the report hint is present once.
  return coreMessage.includes(ERROR_HANDLING_STRINGS.reportHint)
    ? coreMessage
    : `${coreMessage} ${ERROR_HANDLING_STRINGS.reportHint}`;
}

/**
 * THE single error → notification + log conversion (受け入れ基準3). Every catch
 * path (render boundary, async, event, IPC, IO, domain rejection) calls THIS, so
 * the日本語 message, report-hint rule and logging never diverge per path
 * (教訓 5.6). Records to the injected logger (FR-117) with the real-time stamp and
 * the作中時刻 kept separate (教訓 5.15). Returns the notification to display.
 */
export function handleError(
  logger: DiagnosticLogger,
  input: ErrorInput,
): UserNotification {
  const message = buildUserMessage(input.severity, input.message);

  const context: LogContext = {
    ...(input.contextTime !== undefined ? { contextTime: input.contextTime } : {}),
    ...(input.contextSummary !== undefined ? { summary: input.contextSummary } : {}),
    ...(input.cause !== undefined ? { cause: describeCause(input.cause) } : {}),
  };

  const level =
    input.severity === ERROR_SEVERITY.Recoverable
      ? LOG_LEVEL.Warning
      : LOG_LEVEL.Error;
  logger.log(level, message, context);

  return {
    origin: input.origin,
    severity: input.severity,
    message,
    dismissOn: JUDGEMENT_DISMISS_TRIGGERS,
  };
}

/**
 * Convenience for the React error boundary: convert a render-time exception into
 * the fallback notification (always unrecoverable → report hint) and log it.
 */
export function handleRenderError(
  logger: DiagnosticLogger,
  cause: unknown,
  contextTime?: string,
): UserNotification {
  return handleError(logger, {
    origin: ERROR_ORIGIN.Render,
    severity: ERROR_SEVERITY.Unrecoverable,
    message: `${ERROR_HANDLING_STRINGS.unexpectedLead}`,
    cause,
    contextSummary: ERROR_HANDLING_STRINGS.fallbackTitle,
    ...(contextTime !== undefined ? { contextTime } : {}),
  });
}

/**
 * Whether a notification may be dismissed by a given trigger (教訓 5.12). The UI
 * asks this before clearing a判断用 message; an unrelated interaction is not in
 * `dismissOn`, so the message survives it.
 */
export function mayDismiss(
  notification: UserNotification,
  trigger: DismissOn,
): boolean {
  return notification.dismissOn.includes(trigger);
}
