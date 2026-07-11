// U41 — the DiagnosticLogger → shell FILE-SINK bridge (FR-117 / FR-02, ui).
//
// 機能宣言: メモリ内リングバッファ ({@link DiagnosticLogger}) に注入する {@link LogSink} を、
// 本番の型付き IPC (`window.timeMapApi.appendLog`) へ橋渡しする薄い接着層。各ログエントリを
// ローカルの JSONL ファイル追記経路 (U15 IPC → main) へ流し、外部送信は一切しない (FR-02).
// あわせて起動時のセッション開始マーカー (バージョン・日時) を logger へ記録する結線を提供する。
//
// 適用 (教訓 5.7「ロジックがあっても UI から呼ばれず機能しない状態を作らない」, 引用: ロジック側に
// メソッドがあっても、UI からの呼び出しがなければ機能しない): DiagnosticLogger は sink 注入点を
// 備えていたが本番は sink 無しで生成され、ログがディスクに残らなかった。本モジュールが sink を
// 供給し App の合成ルートから結線して、その欠落を埋める。
//
// 適用 (教訓 5.41「検証不能になった範囲は別手段で補う」): window API への到達判定 / sink の
// ベストエフォート化 / セッションマーカー整形を純粋関数として分離し、フェイク API で Vitest 単体
// テスト可能にする。物理 IPC は App の合成ルートでのみ結線する。

import { DiagnosticLogger, LOG_LEVEL, type LogEntry, type LogSink } from './log';
import type { TimeMapApi } from '../../shell/ipc/contract';

/** The single diagnostic-log message recorded at session start (バージョン・日時 マーカー). */
export const SESSION_START_MESSAGE = 'セッション開始';

/** The minimal window-API surface the file sink needs (the U15 typed IPC method). */
export type DiagnosticLogAppendApi = Pick<TimeMapApi, 'appendLog'>;

/**
 * Build a {@link LogSink} that forwards each entry to the shell via the typed IPC
 * `appendLog`. Best-effort by contract (FR-117 / log.ts:99): a synchronous throw is
 * swallowed AND the returned promise's rejection is swallowed — the latter is
 * essential, because an unhandled rejection would be caught by the global error
 * handler, re-logged, and loop back into this sink. A `LogEntry` is passed as-is
 * (it is structurally a `DiagnosticLogRecord`), so the transport type is fixed at
 * this single call site (教訓 5.33 / 5.34).
 */
export function createDiagnosticLogSink(api: DiagnosticLogAppendApi): LogSink {
  return {
    write(entry: LogEntry): void {
      try {
        const result = api.appendLog(entry);
        // Detach a rejection handler without awaiting: a failed LOCAL persist must
        // never resurface as an unhandledrejection (which would feed back into the
        // logger → this sink, an infinite loop). `void` marks the promise handled.
        if (result !== undefined && typeof result.then === 'function') {
          void result.catch(() => {});
        }
      } catch {
        // Reaching the bridge threw synchronously (e.g. a partial mock). Swallowed:
        // the in-memory record already happened and an error-logging path can't crash.
      }
    },
  };
}

/**
 * Resolve the file sink from a host global (production: `globalThis`, which carries
 * the contextBridge-exposed `timeMapApi`). Returns `undefined` when the typed IPC
 * bridge is absent — e.g. under vitest/jsdom — so the caller keeps the logger
 * memory-only (従来どおり). Mirrors FileOpsController's `liveApi` global lookup.
 */
export function resolveDiagnosticLogSink(host: unknown): LogSink | undefined {
  const api = (host as { timeMapApi?: Partial<DiagnosticLogAppendApi> }).timeMapApi;
  if (api === undefined || typeof api.appendLog !== 'function') return undefined;
  return createDiagnosticLogSink(api as DiagnosticLogAppendApi);
}

/**
 * Record the session-start marker (FR-117): ONE info entry carrying the app version
 * (in the context summary) and stamped with the real time via the logger's clock
 * (`recordedAtMs` = 日時). Routed through the SAME logger → file sink so a diagnostic
 * log file opens with a session boundary the user can correlate. Non-sensitive only.
 */
export function logSessionStart(
  logger: DiagnosticLogger,
  info: { readonly version: string; readonly contextTimeLabel?: string },
): LogEntry {
  return logger.log(LOG_LEVEL.Info, SESSION_START_MESSAGE, {
    summary: `version=${info.version}`,
    ...(info.contextTimeLabel !== undefined ? { contextTime: info.contextTimeLabel } : {}),
  });
}
