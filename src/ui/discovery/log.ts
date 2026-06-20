// U41 — error/diagnostic logging + diagnostics snapshot (FR-117 / FR-02, ui).
//
// 機能宣言: エラー発生時に診断に必要な情報 (発生時刻=実時刻、エラー種別、メッセージ、
// スタック/原因、操作文脈の要約) をログとして記録する経路を提供し、直近のログ・アプリ概況の
// スナップショットをユーザーが取得・参照できる手段を提供する。記録はオフライン完結し外部
// 送信しない (FR-02). ファイル永続化が必要な場合は依存する起動・シェル基盤の経路へ委譲し、
// 本ユニットはログ記録の規約とインタフェース (log(level, message, context)) を担う。
//
// 適用 (教訓 5.15「タイムスタンプはコンテキスト上の時刻を参照する」, 引用: 操作文脈として
// 記録する作中時刻はコンテキスト時刻 (現在時刻) を参照し、記録時刻 (システム実時刻) と
// 混同しない): 各ログエントリは `recordedAtMs` (システム実時刻=注入クロック) と
// `contextTime` (作中時刻=現在時刻、文字列要約) を別フィールドで保持し、両者を混同しない。
// 時刻源は注入する (実時刻は clock、作中時刻は呼び出し側=U16 から渡す)。
//
// 適用 (教訓 5.41「検証不能になった範囲は別手段で補う」): ファイル永続化・IPC は LogSink
// として注入分離し、メモリ内リングバッファ本体を純粋に近い形 (注入クロックのみ副作用) で
// Vitest 単体テスト可能にする。物理 I/O は委譲する。

/** Log severity levels. Code branches on these constants (教訓 5.19). */
export const LOG_LEVEL = {
  Info: 'info',
  Warning: 'warning',
  Error: 'error',
} as const;

export type LogLevel = (typeof LOG_LEVEL)[keyof typeof LOG_LEVEL];

/**
 * The context captured WITH a log entry. `contextTime` is the作中時刻 (現在時刻)
 * — a SEPARATE field from the record's real-time stamp (教訓 5.15). `summary` is
 * a short operation-context description. No personal/project content is placed
 * here by policy (FR-117 / FR-02) — callers pass only non-sensitive summaries.
 */
export interface LogContext {
  /** The作中時刻 (現在時刻) at the moment of the operation, as a display string. */
  readonly contextTime?: string;
  /** A short operation-context summary (e.g. the action name). */
  readonly summary?: string;
  /** The underlying cause/stack as a string, if any (診断用). */
  readonly cause?: string;
}

/** A recorded log entry. `recordedAtMs` is the SYSTEM real time (教訓 5.15). */
export interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  /** System real time of recording (ms epoch) — NOT the作中時刻. */
  readonly recordedAtMs: number;
  readonly context: LogContext;
}

/**
 * An optional persistence/forwarding sink. Implemented by the shell (file I/O
 * via IPC) — injected so the buffer itself stays free of physical I/O (教訓
 * 5.41). It is best-effort: a sink failure never throws into the caller (an
 * error-logging path must not itself crash). NEVER an external network call
 * (FR-02): the shell writes locally only.
 */
export interface LogSink {
  write(entry: LogEntry): void;
}

/** Injected real-time clock (so tests are deterministic — 教訓 5.41). */
export type Clock = () => number;

export interface DiagnosticLoggerOptions {
  /** Ring-buffer capacity (oldest entries drop). Default 100. */
  readonly capacity?: number;
  /** Real-time clock; defaults to Date.now (the ONE real-time source). */
  readonly clock?: Clock;
  /** Optional local persistence sink (shell file I/O); none ⇒ memory only. */
  readonly sink?: LogSink;
}

/** Default ring-buffer capacity. */
export const DEFAULT_LOG_CAPACITY = 100;

/**
 * An in-memory ring buffer of log entries + an optional local sink. This is the
 * single recording経路 the error pipeline (errors.ts) and any caller funnels
 * through (log(level, message, context)). Offline-only: it never sends anything
 * externally (FR-02); persistence is the injected local sink's concern.
 */
export class DiagnosticLogger {
  private readonly capacity: number;
  private readonly clock: Clock;
  private readonly sink: LogSink | undefined;
  private readonly entries: LogEntry[] = [];

  constructor(options: DiagnosticLoggerOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_LOG_CAPACITY;
    this.clock = options.clock ?? Date.now;
    this.sink = options.sink;
  }

  /**
   * Record one entry. `recordedAtMs` is stamped from the injected real-time
   * clock; the caller-supplied `context.contextTime` carries the作中時刻
   * separately (教訓 5.15). Best-effort persistence: a sink error is swallowed so
   * the logging path can never itself crash an error handler.
   */
  log(level: LogLevel, message: string, context: LogContext = {}): LogEntry {
    const entry: LogEntry = {
      level,
      message,
      recordedAtMs: this.clock(),
      context,
    };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.shift();
    }
    if (this.sink !== undefined) {
      try {
        this.sink.write(entry);
      } catch {
        // A failed local persist must not break the in-memory record or the
        // caller's error handling (教訓 5.41 / FR-117). Swallowed by design.
      }
    }
    return entry;
  }

  /** Snapshot of the recorded entries (newest last), for the diagnostics view. */
  snapshot(): readonly LogEntry[] {
    return [...this.entries];
  }

  /** Number of currently-buffered entries. */
  get size(): number {
    return this.entries.length;
  }

  /** Clear the in-memory buffer (e.g. user-requested log reset). */
  clear(): void {
    this.entries.length = 0;
  }
}

// --- diagnostics snapshot (FR-117 診断情報) ----------------------------------

/**
 * A non-sensitive application overview included in the diagnostics view. The
 * caller supplies only counts/flags — NEVER feature names, descriptions or other
 * project content (FR-117 / FR-02 privacy policy). Kept as a flat record so it is
 * trivially testable and never carries hidden objects.
 */
export interface AppOverview {
  /** Number of features currently loaded (a count, not their content). */
  readonly featureCount: number;
  /** The current作中時刻 as a display string (context time, 教訓 5.15). */
  readonly currentTimeLabel: string;
  /** Whether the project has unsaved changes (flag only). */
  readonly hasUnsavedChanges: boolean;
}

/** The full diagnostics snapshot the user can view/export (offline, FR-02). */
export interface DiagnosticsSnapshot {
  readonly log: readonly LogEntry[];
  readonly overview: AppOverview;
}

/** Build the diagnostics snapshot from the logger + a non-sensitive overview. */
export function buildDiagnosticsSnapshot(
  logger: DiagnosticLogger,
  overview: AppOverview,
): DiagnosticsSnapshot {
  return { log: logger.snapshot(), overview };
}
