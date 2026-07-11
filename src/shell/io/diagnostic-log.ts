// U41 — DIAGNOSTIC LOG FILE SINK (FR-117 / FR-02, shell). The local, offline-only
// persistence backing the renderer's {@link DiagnosticLogger} sink: each caught
// error / session marker is appended as ONE JSONL line under the app's userData,
// with per-DAY file rotation and a bounded number of retained generations.
//
// 機能宣言: renderer から IPC で届く 1 エントリ (`DiagnosticLogRecord`) を
//   userData/logs/diagnostic-YYYY-MM-DD.jsonl
// に 1 行 1 エントリ (JSONL) で追記し、起動時に古い世代 (既定 7 世代より前) を削除する。
// すべてローカル完結で外部送信しない (FR-02). 書き込み・削除はベストエフォートで、失敗しても
// 例外を投げない (アプリを止めない — log.ts:99 の sink 契約と同じ規律).
//
// MAIN は RENDERER を信頼しない (Codex MED-1/MED-2): 侵害/バグで appendLog を巨大
// メッセージで連打されてもディスクを埋められないよう、main 側で強制する三段の上限を持つ —
//   (1) フィールド正規化 (`normalizeDiagnosticLogRecord`): unknown を受け、既知キーのみ拾い、
//       文字列 coerce + 文字数上限 (message 4096 / context 各値 1024 / level 32)、
//       recordedAtMs は有限数検証。未知キーは剥がす。
//   (2) 1 行のバイト上限 (`capDiagnosticLogLine`): JSONL 1 行 16KB。超過は message から
//       切り詰め、`truncated: true` フラグを付与する。
//   (3) 1 日ファイルのバイト上限: 既定 10MB。上限を跨ぐ append は行+打ち切りマーカー 1 行を
//       書いて終了し、以降の append は黙って落とす (マーカーはちょうど 1 回).
//
// 適用 (教訓 5.41「検証不能になった範囲は別手段で補う」, 引用: ファイル I/O は…アダプタ分離・
// モックで単体テスト対象にして補う): 物理 fs は {@link DiagnosticLogFs} ポートとして注入分離し、
// ファイル名生成・正規化・行/世代選別を純粋関数として Vitest 単体テスト可能にする。
// `nodeDiagnosticLogFs` が本番の `node:fs/promises` 束ね。
//
// 適用 (教訓 5.15「タイムスタンプはコンテキスト上の時刻を参照する」): 日付ローテーションの
// 基準時刻は注入クロック (`now`) から取り、実時刻源を一元化する (既定 `Date`).

import {
  appendFile as fsAppendFile,
  mkdir as fsMkdir,
  readdir as fsReaddir,
  rm as fsRm,
  stat as fsStat,
} from 'node:fs/promises';
import { join } from 'node:path';

import type { DiagnosticLogRecord, DiagnosticLogRecordContext } from '../ipc/contract';

/** Filename prefix of a diagnostic log file. */
export const DIAGNOSTIC_LOG_PREFIX = 'diagnostic-';
/** Filename extension of a diagnostic log file (1 行 1 エントリ JSON). */
export const DIAGNOSTIC_LOG_EXT = '.jsonl';
/** Default number of daily generations to retain; older files are pruned at startup. */
export const DEFAULT_DIAGNOSTIC_LOG_GENERATIONS = 7;

// --- write-amount limits, enforced by MAIN (Codex MED-1/MED-2) ---------------

/** Char cap the normalizer enforces on `level` (a short severity token). */
export const MAX_LOG_LEVEL_CHARS = 32;
/** Char cap the normalizer enforces on `message` (≒4KB). */
export const MAX_LOG_MESSAGE_CHARS = 4096;
/** Char cap the normalizer enforces on EACH context value (≒1KB). */
export const MAX_LOG_CONTEXT_VALUE_CHARS = 1024;
/** Byte cap of ONE encoded JSONL line; an over-cap line is cut + flagged `truncated`. */
export const MAX_LOG_LINE_BYTES = 16 * 1024;
/** Default byte cap of ONE daily log file; appends beyond it are silently dropped. */
export const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
/** The message of the ONE marker line appended when a daily file reaches its cap. */
export const DIAGNOSTIC_LOG_FILE_CAP_MESSAGE =
  '診断ログが1日あたりの上限サイズに達したため、以降の記録を停止します';

/**
 * The minimal filesystem port the diagnostic log needs, injected so the append /
 * prune procedures are unit-testable WITHOUT a real disk (教訓 5.41). Every op is
 * async; `nodeDiagnosticLogFs` is the production binding over `node:fs/promises`.
 */
export interface DiagnosticLogFs {
  /** Append `text` to `path`, creating the file if it does not exist. */
  appendFile: (path: string, text: string) => Promise<void>;
  /** Ensure `dir` exists (recursive; a no-op when it already does). */
  mkdir: (dir: string) => Promise<void>;
  /** List the entries of `dir`. */
  readdir: (dir: string) => Promise<string[]>;
  /** Remove `path` (best-effort; must not throw when it is missing). */
  remove: (path: string) => Promise<void>;
  /** Size of `path` in bytes; MUST resolve 0 when the file does not exist. */
  fileSize: (path: string) => Promise<number>;
}

/**
 * Production fs port over `node:fs/promises`. `appendFile` writes UTF-8; `mkdir`
 * is recursive so the logs directory is created on first write; `remove` uses
 * `force` so pruning a already-gone file never throws; `fileSize` treats a
 * missing file/directory as size 0 (a fresh day's file).
 */
export const nodeDiagnosticLogFs: DiagnosticLogFs = {
  appendFile: async (path, text) => {
    await fsAppendFile(path, text, 'utf8');
  },
  mkdir: async (dir) => {
    await fsMkdir(dir, { recursive: true });
  },
  readdir: (dir) => fsReaddir(dir),
  remove: async (path) => {
    await fsRm(path, { force: true });
  },
  fileSize: async (path) => {
    try {
      return (await fsStat(path)).size;
    } catch {
      // ENOENT (missing file or dir) = the day's file has not been created yet.
      return 0;
    }
  },
};

/** Everything the append / prune procedures need, injected (教訓 5.41). */
export interface DiagnosticLogEnv {
  /** The injected filesystem port. */
  readonly fs: DiagnosticLogFs;
  /** The logs directory (production: `app.getPath('userData')/logs`). */
  readonly dir: string;
  /** Real-time clock for the date-rotation filename; defaults to `Date` (教訓 5.15). */
  readonly now?: () => Date;
  /** How many daily generations to retain when pruning; defaults to 7. */
  readonly keepGenerations?: number;
  /** Byte cap of one daily file; defaults to {@link MAX_LOG_FILE_BYTES} (test seam). */
  readonly maxFileBytes?: number;
}

// --- pure helpers (unit-testable without any fs) ----------------------------

/**
 * The date-rotated file name for `date`: `diagnostic-YYYY-MM-DD.jsonl`. Uses the
 * date's LOCAL calendar components so the rotation boundary matches the user's day.
 */
export function diagnosticLogFileName(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${DIAGNOSTIC_LOG_PREFIX}${year}-${month}-${day}${DIAGNOSTIC_LOG_EXT}`;
}

/** Serialize ONE record as a single JSONL line (trailing newline included). */
export function formatDiagnosticLogLine(record: DiagnosticLogRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/** UTF-8 byte length of a string (the caps are byte-based, not char-based). */
function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Coerce a primitive to a string; non-primitives (objects/functions…) → undefined. */
function coercePrimitiveString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/**
 * Normalize an UNTRUSTED inbound value into a well-formed {@link DiagnosticLogRecord}
 * (Codex MED-2 — main 側で強制, the renderer is not trusted): only the known fields
 * are picked (unknown keys are stripped, both top-level and in `context`), strings
 * are coerced from primitives and cut to the exported char caps, and `recordedAtMs`
 * must be a finite number (else 0). A renderer-supplied `truncated` flag is also
 * stripped — only main may assert it (via {@link capDiagnosticLogLine}). The result
 * is a fresh plain object, so nothing renderer-supplied is persisted unvetted.
 */
export function normalizeDiagnosticLogRecord(input: unknown): DiagnosticLogRecord {
  const raw: Record<string, unknown> =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const level = (coercePrimitiveString(raw['level']) ?? 'unknown').slice(0, MAX_LOG_LEVEL_CHARS);
  const message = (coercePrimitiveString(raw['message']) ?? '').slice(0, MAX_LOG_MESSAGE_CHARS);
  const rawTime = raw['recordedAtMs'];
  const recordedAtMs = typeof rawTime === 'number' && Number.isFinite(rawTime) ? rawTime : 0;
  const rawContext: Record<string, unknown> =
    typeof raw['context'] === 'object' && raw['context'] !== null
      ? (raw['context'] as Record<string, unknown>)
      : {};
  const contextTime = coercePrimitiveString(rawContext['contextTime'])?.slice(
    0,
    MAX_LOG_CONTEXT_VALUE_CHARS,
  );
  const summary = coercePrimitiveString(rawContext['summary'])?.slice(
    0,
    MAX_LOG_CONTEXT_VALUE_CHARS,
  );
  const cause = coercePrimitiveString(rawContext['cause'])?.slice(0, MAX_LOG_CONTEXT_VALUE_CHARS);
  const context: DiagnosticLogRecordContext = {
    ...(contextTime !== undefined ? { contextTime } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(cause !== undefined ? { cause } : {}),
  };
  return { level, message, recordedAtMs, context };
}

/**
 * Encode ONE record as a JSONL line of at most {@link MAX_LOG_LINE_BYTES} bytes
 * (Codex MED-1). A line within the cap is returned untouched (no flag). An
 * over-cap line — possible even after the char-level normalizer caps, because
 * JSON escaping can multiply bytes per char — is cut down (message halved
 * repeatedly, then context dropped, then level clamped) and flagged
 * `truncated: true` so the reader can tell the entry is partial.
 */
export function capDiagnosticLogLine(record: DiagnosticLogRecord): string {
  const plain = formatDiagnosticLogLine(record);
  if (utf8ByteLength(plain) <= MAX_LOG_LINE_BYTES) return plain;
  let message = record.message;
  let context = record.context;
  let level = record.level;
  for (;;) {
    const line = formatDiagnosticLogLine({
      level,
      message,
      recordedAtMs: record.recordedAtMs,
      context,
      truncated: true,
    });
    if (utf8ByteLength(line) <= MAX_LOG_LINE_BYTES) return line;
    // The message is the dominant field: halve it first. Then, if the (already
    // char-capped) context alone still overflows, drop it wholesale; finally clamp
    // a pathological level. After all three the skeleton is a few hundred bytes,
    // so the loop always terminates under the cap.
    if (message.length > 0) {
      message = message.slice(0, Math.floor(message.length / 2));
    } else if (Object.keys(context).length > 0) {
      context = {};
    } else if (level.length > MAX_LOG_LEVEL_CHARS) {
      level = level.slice(0, MAX_LOG_LEVEL_CHARS);
    } else {
      // Bare skeleton (empty message/context, short level, finite number) — cannot
      // exceed the cap; returned defensively so the loop can never spin.
      return line;
    }
  }
}

const LOG_NAME_RE = /^diagnostic-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

/**
 * The sortable `YYYY-MM-DD` date key of a diagnostic log file name, or `undefined`
 * when the name is not a diagnostic log file (so unrelated files in the directory
 * are never touched by the prune — cf. backup.ts のバックアップ以外を無視).
 */
export function diagnosticLogDateKey(name: string): string | undefined {
  const match = LOG_NAME_RE.exec(name);
  return match === null ? undefined : `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * Given a directory listing, return the diagnostic log file names to DELETE so
 * that at most `keep` NEWEST generations remain. Non-log files are ignored; the
 * newest `keep` are retained, everything older is returned. `keep <= 0` deletes all.
 */
export function selectDiagnosticLogsToDelete(names: readonly string[], keep: number): string[] {
  const logs = names
    .map((name) => ({ name, key: diagnosticLogDateKey(name) }))
    .filter((entry): entry is { name: string; key: string } => entry.key !== undefined)
    // Newest first (descending date key; the file name breaks a same-day tie).
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : a.name < b.name ? 1 : -1));
  if (keep <= 0) return logs.map((entry) => entry.name);
  return logs.slice(keep).map((entry) => entry.name);
}

// --- effectful procedures (best-effort, never throw) ------------------------

/**
 * Append ONE record to today's diagnostic log file (FR-117). The inbound value is
 * treated as UNTRUSTED `unknown` (it crossed the IPC boundary): it is normalized
 * (known fields / caps, MED-2), line-capped (MED-1) and then appended — unless the
 * daily file has reached its byte cap, in which case the append is silently
 * dropped; the append that CROSSES the cap also writes ONE cap-marker line so the
 * file records its own truncation. Best-effort: a failed write is swallowed so the
 * logging path can NEVER crash the app (log.ts:99 と同じ契約).
 */
export async function appendDiagnosticLog(env: DiagnosticLogEnv, record: unknown): Promise<void> {
  try {
    const now = env.now ?? (() => new Date());
    const cap = env.maxFileBytes ?? MAX_LOG_FILE_BYTES;
    const path = join(env.dir, diagnosticLogFileName(now()));
    const line = capDiagnosticLogLine(normalizeDiagnosticLogRecord(record));
    const size = await env.fs.fileSize(path);
    // Daily file cap reached: silently drop (the crossing append already wrote the
    // one marker line below, so the reader knows the file is cut — MED-1).
    if (size >= cap) return;
    await env.fs.mkdir(env.dir);
    if (size + utf8ByteLength(line) >= cap) {
      // This line crosses the cap: append it PLUS the single cap marker. Every
      // subsequent append sees size >= cap above and drops, so the marker is
      // written exactly once per day file (stateless, no flag to track).
      const marker = formatDiagnosticLogLine({
        level: 'info',
        message: DIAGNOSTIC_LOG_FILE_CAP_MESSAGE,
        recordedAtMs: now().getTime(),
        context: {},
        truncated: true,
      });
      await env.fs.appendFile(path, line + marker);
      return;
    }
    await env.fs.appendFile(path, line);
  } catch {
    // A failed LOCAL persist must not surface (FR-117): an error-logging path can
    // never itself crash the app. Swallowed by design (教訓 5.41 / log.ts:99).
  }
}

/**
 * Prune old diagnostic log generations at startup, keeping at most
 * `keepGenerations` (既定 7) NEWEST daily files INCLUDING today's expected file
 * (Codex LOW-3): the startup prune runs BEFORE the session marker creates today's
 * file, so today's expected name is counted into the retention window even when it
 * does not exist yet — otherwise 7 existing generations + today's new file would
 * briefly total 8. Today's (active) file itself is never deleted, even if
 * clock-skewed future-dated files outrank it. Best-effort: a missing directory or
 * a failed listing/removal is swallowed so startup is never blocked/crashed.
 */
export async function pruneDiagnosticLogs(env: DiagnosticLogEnv): Promise<void> {
  try {
    const keep = env.keepGenerations ?? DEFAULT_DIAGNOSTIC_LOG_GENERATIONS;
    const now = env.now ?? (() => new Date());
    let names: string[];
    try {
      names = await env.fs.readdir(env.dir);
    } catch {
      // The logs directory does not exist yet (fresh install) — nothing to prune.
      return;
    }
    // Reserve today's seat (LOW-3): count the expected file of TODAY into the
    // window so the post-prune append cannot exceed the generation cap.
    const todayName = diagnosticLogFileName(now());
    const withToday = names.includes(todayName) ? names : [...names, todayName];
    for (const name of selectDiagnosticLogsToDelete(withToday, keep)) {
      // Never delete the ACTIVE (today's) file — defensive against clock rollback
      // where future-dated files would outrank it in the newest-first ordering.
      if (name === todayName) continue;
      await env.fs.remove(join(env.dir, name));
    }
  } catch {
    // Best-effort startup housekeeping — never blocks or crashes startup (FR-117).
  }
}
