// U15 — the typed IPC CONTRACT: the SINGLE SOURCE OF TRUTH for every channel
// name, argument type and return type that crosses the Electron process
// boundary (開発ガイド §5.33). Renderer (caller), preload (exposer) and main
// (receiver) all import THIS module so the three参照 the same definitions and
// never rely on a string coinciding by accident.
//
// Layer: shell. Pure type/const module — it imports domain persistence TYPES
// only (the parsed manifest shape it transports), never Electron and never a
// fs/IO module, so both the renderer-side and the main-side can import it
// without dragging Node into the renderer.
//
// 教訓5.33適用: changing a channel name here is a SINGLE change unit — the
// const map below is the only place a channel string is written; preload and
// main read it. The両側 tests (ipc-contract.test.ts + preload exposure test)
// fail if a name drifts on one side only (受け入れ基準4).

import type { ParseResult } from '../../domain/persistence/boundary';
import type { Manifest } from '../../domain/persistence/schema';

// --- channel names (the ONE place the strings live) -------------------------
//
// Namespaced under `tmap:` so they cannot collide with Electron's own internal
// channels. The renderer never sees these strings — preload wraps them.
export const IPC_CHANNEL = {
  /** Save to the current path (Ctrl+S相当). Main may open a dialog if no path. */
  Save: 'tmap:save',
  /** Save As — main opens a save dialog to pick a fresh path (FR-105). */
  SaveAs: 'tmap:save-as',
  /** Load — main opens an open dialog, reads + Zod-validates the file (FR-105). */
  Load: 'tmap:load',
  /** Drag & drop load — renderer hands a dropped absolute path to main (FR-105). */
  LoadDropped: 'tmap:load-dropped',
  /**
   * FR-04 ベースマップ差し替え: main opens an IMAGE open-dialog (PNG / JPEG), reads
   * the chosen file and returns its raw bytes. The renderer validates + adopts them
   * (image-only replacement, 投影/範囲は維持). Cancel / read-failure resolves `null`
   * so the flow is an honest no-op. Main opens the dialog (spec §やること: ダイアログ
   * 起動はメイン側) — the renderer never touches `fs` (FR-02 サンドボックス).
   */
  OpenImage: 'tmap:open-image',
  /** Push the auto-save interval / generation cap from settings into main. */
  ConfigureAutoSave: 'tmap:configure-auto-save',
  /**
   * One-way MAIN→RENDERER event: the auto-save scheduler fired. The renderer
   * responds by performing a `save` (it owns the live manifest/asset bytes), so
   * the auto-save routes through the SAME atomic save path as a manual save
   * (FR-108 / 受け入れ基準3). Unlike the others this is a `send`/`on` event, not
   * an `invoke` round-trip — but the channel name still lives ONLY here so the
   * sender (main) and the preload subscriber never rely on a coincidental string.
   */
  AutoSaveTick: 'tmap:auto-save-tick',
  /**
   * Renderer→main diagnostic-log append (FR-117 / FR-02). The renderer's
   * {@link DiagnosticLogger} sink invokes this to persist ONE log entry to a local
   * JSONL file under the app's userData. Best-effort: main appends and resolves
   * even on write failure; the renderer sink swallows any rejection so an
   * error-logging path can never itself crash (log.ts:99). NEVER an external send —
   * main writes to the local disk only (FR-02 オフライン・ローカルのみ).
   */
  AppendLog: 'tmap:append-log',
  /**
   * FR-107 close ブリッジ — one-way MAIN→RENDERER event: ウィンドウの close 要求
   * (× / Alt+F4 / タスクバー / OS シャットダウン) が来たので、レンダラは未保存確認
   * ガード (quitGuard) を走らせ、その判定を {@link IPC_CHANNEL.CloseResponse} に
   * **同じ requestId 付きで** 返す。main は preventDefault して応答を待ち、許可の時
   * だけ one-shot で再 close する（close-guard.ts）。`AutoSaveTick` と同じ
   * `send`/`on` の一方向イベントなので `ipcMain.handle` の受信側は持たない。
   */
  CloseRequest: 'tmap:close-request',
  /**
   * FR-107 close ブリッジ — RENDERER→MAIN: 1 件の close 要求に対する **受領 ACK**
   * ({@link CloseAckPayload})。preload は CloseRequest を受けた時点で（判定より前に・
   * 同期的に）これを送る。ACK が届く = 生きた購読者が実在する、の証。main は短い ACK
   * タイムアウトで「購読者不在」を検出し、その時だけ確認を省略して閉じる（close-guard.ts の
   * ADR: 片方向 rendererLoaded ラッチによる fail-OPEN / fail-CLOSED の両方を根治する要）。
   */
  CloseAck: 'tmap:close-ack',
  /**
   * FR-107 close ブリッジ — RENDERER→MAIN: 1 件の close 要求に対する判定
   * ({@link CloseVerdict})。invoke の戻り値は ack のみで、判定そのものは payload。
   */
  CloseResponse: 'tmap:close-response',
  /**
   * UC1 round-2 保存「宛先」の遅延昇格 — RENDERER→MAIN invoke: 読み込みが実際に
   * ドメインへ反映された **commit point**（reflectProject 成功 = 確定後）で、レンダラは
   * その読み込みの {@link LoadResponse.commitToken} を返し「この読み込み先を現在の保存先
   * へ昇格してよい」と告げる。main は読み取り成功だけでは currentPath を昇格せず、保留
   * トークンと一致した時だけ昇格する（FR-107 の ACK 分離と同じ commit-point 思想）。
   * これにより「A を開く→不整合 B を開く→修復中止→Ctrl+S」で、開くのを拒否した B.gimoza を
   * A の内容で丸ごと上書き破壊する経路を断つ（読み取り成功=即昇格を廃止）。
   */
  CommitLoadedPath: 'tmap:commit-loaded-path',
  /**
   * **アプリ側の設定を読む**（増分 6 の手直し。司令塔の決定 (2)、2026-09-07）。
   *
   * 初回起動のガイドの「今後表示しない」は **プロジェクトファイルにしか載っていなかった**
   * ので、押しても次の起動でまた出た（保存していないプロジェクトなら行き先が無い）。
   * この 2 本は userData の小さな JSON 1 枚を読み書きするだけの口で、
   * **プロジェクトの中身とは無関係**（FR-02 のとおり書き先はローカルの userData だけ）。
   */
  ReadAppPrefs: 'tmap:read-app-prefs',
  /** アプリ側の設定を書く（部分更新。書いたあとの全体を返す）。 */
  WriteAppPrefs: 'tmap:write-app-prefs',
  /**
   * **いまの保存先の世代を一覧する**（増分 8D。設計書 §E.1 の V14）。
   *
   * 世代（`<名前>.bak.<時刻>-<連番>`）は保存のたびに作られていたのに、描画プロセスから
   * 一覧する口も戻す口も無かった。主プロセスが保存先の隣を読み、新しい順に返す。
   * 返す 1 件ごとに **その場限りの id** を振り、`OpenBackup` はその id しか受け取らない。
   */
  ListBackups: 'tmap:list-backups',
  /**
   * **一覧で選んだ世代を開く**（増分 8D）。引数は `ListBackups` が **直前に返した id だけ**。
   * 任意のパスは受け取らない（主プロセスが id → パスの表を持ち、表に無い id は断る）。
   * 開いたファイルは **保存先にならない**（次の保存は必ず「名前を付けて保存」）。
   */
  OpenBackup: 'tmap:open-backup',
  /**
   * 一覧の 1 行の **地物数を数える**（増分 8D の手直し）。一覧そのものは中身を読まずに
   * すぐ返し、地物数は板を出したあとで 1 行ずつ埋める（100 世代で 4〜6 秒、板が出なかった）。
   * 引数は `ListBackups` が返した id だけ。
   */
  CountBackupFeatures: 'tmap:count-backup-features',
  /**
   * 「以前の保存から開く」の 1 回が **終わった**ことを主プロセスへ伝える（増分 8D の手直し）。
   * 一覧に出している世代は、その間だけ保存の間引きから外している（確認の「保存」が、選んだ
   * 世代を消さないように）。やめた・開き終えた、のどちらでも呼ぶ。
   */
  EndBackupChoice: 'tmap:end-backup-choice',
  /**
   * いまの保存先の世代の **数だけ** を返す（増分 8D の手直し。設定の「いまの世代の数」）。
   * ファイルを 1 つも開かない。id も振らない。
   */
  CountBackups: 'tmap:count-backups',
  /**
   * **新規にした**ことを主プロセスへ伝える（増分 8D の手直し）。主プロセスは保存先・世代から
   * 戻した元のファイル・一覧の基準の候補を捨てる。これが無いと、新規のあとの「名前を付けて
   * 保存」の既定に前のファイルの名前が出て、一覧と世代の数も前のファイルのものになっていた。
   */
  ForgetSaveTarget: 'tmap:forget-save-target',
} as const;

export type IpcChannel = (typeof IPC_CHANNEL)[keyof typeof IPC_CHANNEL];

/**
 * 一方向 MAIN→RENDERER イベントのチャネル（`webContents.send` / `ipcRenderer.on`)。
 * `invoke` の往復ではないので **受信側 `ipcMain.handle` を持たない** — 受信側の
 * 「契約の全チャネルにハンドラがあるか」テストはこの一覧を除外して比較する
 * (教訓 5.33: 除外リストをテストに直書きせず、契約 1 箇所で宣言する)。
 */
export const MAIN_TO_RENDERER_CHANNELS: readonly IpcChannel[] = [
  IPC_CHANNEL.AutoSaveTick,
  IPC_CHANNEL.CloseRequest,
];

// --- payload shapes ---------------------------------------------------------

/**
 * A save request carries the already-serialized manifest (a plain, JSON-safe
 * value produced by U14 `serialize`) plus the base-map image to embed in the
 * `.gimoza` ZIP. There are no attached images: FR-98 の改定（2026-11-03）で地物の
 * 資料の本文は本アプリの外が正本になり、本アプリは複製も保持もしない. The
 * renderer never touches `fs`; it ships bytes through this typed channel and
 * main performs the atomic write.
 */
export interface SaveRequest {
  /** The validated/serialized manifest value (FR-103 / FR-104). */
  readonly manifest: Manifest;
  /** Base-map image bytes (the ZIP base-map asset). */
  readonly baseMapImage: Uint8Array;
}

/** Outcome of a save (atomic write). Discriminated so failure is explicit. */
export type SaveResponse =
  | { readonly ok: true; readonly path: string }
  // User dismissed the save/Save-As dialog: not an error, not a success.
  | { readonly ok: false; readonly reason: 'cancelled' }
  | { readonly ok: false; readonly reason: 'write-failed'; readonly message: string };

/**
 * Outcome of a load. Success carries the parsed (Zod-validated, FR-104/116)
 * manifest plus the extracted base-map image. Failure carries a reason and a
 * 日本語 message (拒否理由は通知と戻り値の両方で, 教訓5.26).
 */
export type LoadResponse =
  | {
      readonly ok: true;
      readonly path: string;
      readonly manifest: Manifest;
      readonly baseMapImage: Uint8Array;
      /**
       * UC1 round-2 保存宛先の遅延昇格: an opaque token main mints per successful read.
       * Main STAGES `{ token, path }` instead of promoting the save target on read; the
       * renderer echoes this token back via {@link TimeMapApi.commitLoadedPath} at the
       * commit point (reflectProject 成功) so main promotes `currentPath` to `path` ONLY
       * for a load that actually reached the domain. Optional so every non-production
       * `LoadResponse` construction (tests / fixtures) stays valid; when absent the
       * renderer simply skips the commit (a safe degrade — save keeps the prior target).
       */
      readonly commitToken?: string;
      /**
       * **世代から開いたときだけ**付く（増分 8D）。何の、いつの世代かを画面に出すための
       * 情報で、このとき `path` は世代そのもののパスである ―― 描画プロセスはこれを
       * **保存先にしてはいけない**（アプリバーは「〈元の名前〉（…の世代から復旧・保存先は
       * 未確定）」と出し、次の保存は「名前を付けて保存」へ落ちる）。
       */
      readonly restoredFrom?: RestoredFrom;
    }
  | { readonly ok: false; readonly reason: 'cancelled' }
  | {
      readonly ok: false;
      readonly reason: 'read-failed' | 'corrupt' | 'invalid';
      readonly message: string;
      // For the `invalid` case, the structured parse result (FR-104).
      readonly parse?: ParseResult;
    };

/**
 * 世代の一覧の 1 行（増分 8D。設計書 §E.1 の V14 の型）。
 *
 * **パスは載せない**。描画プロセスが持つのは開くための `id` だけで、`id` は主プロセスが
 * 一覧を作るたびに振り直す（前の一覧の id は次の一覧を作った時点で使えなくなる）。
 */
export interface BackupEntry {
  /** `OpenBackup` に渡す、その場限りの印。 */
  readonly id: string;
  /** 保存した時刻（epoch ms。実時間）。 */
  readonly savedAtMs: number;
  /** ファイルの大きさ（バイト）。 */
  readonly byteSize: number;
  /**
   * 地物の数。中身が読めなかった世代は null（画面は「—」）。**まだ数えていない**世代では
   * 鍵ごと無い（画面は「…」。`CountBackupFeatures` で後から埋める）。前に数えた世代は、
   * パス・大きさ・更新時刻が同じなら覚えた数がはじめから入っている。
   */
  readonly featureCount?: number | null;
  /** 元の保存ファイルの名前（拡張子込み。例 `derle-world.gimoza`）。 */
  readonly sourceName: string;
}

/**
 * `ListBackups` の頼み方（増分 8D の手直し）。**パスは載せない** ―― 選ぶのは主プロセスの
 * ダイアログで、描画プロセスはどのファイルかを知らない。
 */
export interface BackupListRequest {
  /**
   * 主プロセスの「開く」ダイアログで **元のファイルを選ばせ**、その隣の世代を一覧する。
   * 元のファイルが壊れて開けないときの入口（保存先は変えない）。
   */
  readonly pickSource?: boolean;
}

/**
 * `ListBackups` の答え（増分 8D の手直し）。「世代が 0 個」と「どのファイルの世代を見ればよい
 * か分からない」を分ける ―― 後者で「戻せる世代はまだありません」と言うのは事実に反する。
 */
export type BackupListing =
  | { readonly basis: 'none' }
  | {
      readonly basis: 'file';
      /** 元の保存ファイルの名前（拡張子込み）。 */
      readonly sourceName: string;
      /** 新しい順。 */
      readonly entries: readonly BackupEntry[];
    };

/** `CountBackups` の答え（増分 8D の手直し）。 */
export type BackupCount =
  | { readonly basis: 'none' }
  | { readonly basis: 'file'; readonly sourceName: string; readonly count: number };

/** 世代から開いたときの「何の、いつの世代か」（{@link LoadResponse} の `restoredFrom`）。 */
export interface RestoredFrom {
  /** 元の保存ファイルの名前（拡張子込み）。 */
  readonly sourceName: string;
  /** その世代を保存した時刻（epoch ms）。 */
  readonly savedAtMs: number;
}

/** Auto-save configuration pushed from the settings unit (FR-108). */
export interface AutoSaveConfig {
  /** Interval in milliseconds (settings-derived; NOT hardcoded here). */
  readonly intervalMs: number;
  /** Generation cap for timestamped backups (settings-derived). */
  readonly maxGenerations: number;
}

export type ConfigureAutoSaveResponse = { readonly ok: true };

/**
 * A single diagnostic log entry transported to main for LOCAL file persistence
 * (FR-117). It structurally mirrors the renderer's `LogEntry`
 * (src/ui/discovery/log.ts): the contract lives in the SHELL layer and must not
 * import the ui type (import/no-restricted-paths), so the shape is restated here
 * as a plain JSON-safe record — a `LogEntry` is assignable to it (the ui-side
 * test pins that assignability at compile time, 教訓 5.33). `level` is
 * transported as a string (the ui owns the level semantics). Main does NOT trust
 * the inbound value: it re-normalizes it (known fields only, string coercion +
 * length caps — diagnostic-log.ts) before writing ONE JSONL line; it carries only
 * non-sensitive summaries, never project content (FR-02 / FR-117).
 */
export interface DiagnosticLogRecord {
  /** Severity ('info' | 'warning' | 'error' on the ui side). */
  readonly level: string;
  readonly message: string;
  /** System real time of recording (ms epoch). */
  readonly recordedAtMs: number;
  readonly context: DiagnosticLogRecordContext;
  /**
   * Set by MAIN ONLY (diagnostic-log.ts) when the entry had to be cut to fit the
   * per-line / per-file byte caps. Never supplied by the renderer — main's
   * normalizer strips it from inbound records — so its presence in a persisted
   * file reliably means "main truncated this entry".
   */
  readonly truncated?: true;
}

/** The non-sensitive context captured with a {@link DiagnosticLogRecord}. */
export interface DiagnosticLogRecordContext {
  /** The作中時刻 (現在時刻) at the moment of the operation, as a display string. */
  readonly contextTime?: string;
  /** A short operation-context summary (e.g. the action name). */
  readonly summary?: string;
  /** The underlying cause/stack as a string, if any (診断用). */
  readonly cause?: string;
}

/**
 * FR-107 close ブリッジ: 1 件の close 要求に対するレンダラの判定。`requestId` は
 * main が発行した要求 ID をそのまま返す（失効した応答 — タイムアウト後に遅れて
 * 届いたもの等 — を main 側で確実に捨てるため）。`allow: true` の時だけ閉じる。
 */
export interface CloseVerdict {
  readonly requestId: string;
  /** true = 閉じてよい（未保存確認を通過）。false = 閉じない。 */
  readonly allow: boolean;
}

/**
 * FR-107 close ブリッジ: close 要求に対する **受領 ACK**。判定（allow）は持たない —
 * 「生きた購読者が居る」ことだけを、判定が出るより前に main へ即報せる（close-guard.ts の
 * 購読者不在検出）。`requestId` は main が発行した要求 ID をそのまま返す。
 */
export interface CloseAckPayload {
  readonly requestId: string;
}

/**
 * {@link IPC_CHANNEL.CloseResponse} / {@link IPC_CHANNEL.CloseAck} の ack（判定・受領
 * そのものは payload 側で、invoke の戻り値は「main が受け取った」ことだけを表す）。
 */
export type CloseResponseAck = { readonly ok: true };

/**
 * Unsubscribe handle returned by a one-way event subscription. Calling it
 * detaches the listener so the renderer can clean up (e.g. on unmount).
 */
export type Unsubscribe = () => void;

/**
 * The full typed surface exposed to the renderer through `contextBridge`. This
 * interface is the contract the preload exposure test pins (受け入れ基準4): the
 * preload object must structurally satisfy `TimeMapApi`, and main must register
 * a handler for every channel. Save-As takes no path argument: main owns the
 * dialog (spec §やること: ダイアログ起動はメイン側).
 */
/**
 * **アプリ側の設定**（プロジェクトではなく、この PC のこのアプリに属する覚え書き）。
 * userData の `app-prefs.json` 1 枚に入る。増やすときはここに項目を足す。
 */
export interface AppPrefs {
  /** 初回起動のガイドを出すか（「今後表示しない」で false になる）。 */
  readonly showFirstRunGuide: boolean;
  /**
   * 自動保存の間隔（分）。増分 8D（設計書 G-5 / FR-108、V12 の④）。**アプリ全体の設定**
   * なので保存ファイルではなくここに置く（どのプロジェクトを開いても同じ間隔）。
   */
  readonly autoSaveIntervalMinutes: number;
  /** 保存ファイルごとに残す世代の数（増分 8D。FR-108）。 */
  readonly backupGenerations: number;
}

/** 自動保存の間隔（分）の範囲（両端を含む）。主プロセスの読み込みと設定画面が同じ値を引く。 */
export const AUTO_SAVE_INTERVAL_MINUTES_RANGE = { min: 1, max: 120 } as const;
/**
 * 残す世代の数の範囲（両端を含む）。**下限は 2**（増分 8D の手直し）: 世代は保存の **あと** に
 * 本体を写すので、いちばん新しい世代はいつも「いまのファイルの写し」で、本当に前の状態は
 * 世代数 − 1 個しか無い。1 にすると、アプリの保存で壊れたときに戻す先が 1 つも無い。
 */
export const BACKUP_GENERATIONS_RANGE = { min: 2, max: 100 } as const;

/**
 * アプリ側の設定を書いた結果（増分 8D の手直し）。**書けたかどうかを返す** ―― 以前は書けなくても
 * 「いまの値」を返していたので、画面は「適用しました」と出し、再起動すると既定へ戻って
 * 次の保存で世代がまとめて消えた。書けなかったときは主プロセスも値を効かせない。
 */
export type AppPrefsWriteResult =
  | { readonly ok: true; readonly prefs: AppPrefs }
  | {
      readonly ok: false;
      /** いまディスクにある（＝効いている）値。 */
      readonly prefs: AppPrefs;
      /** 画面に出す理由（日本語）。 */
      readonly message: string;
    };

/**
 * 読めなかったとき・まだ無いときの既定（＝ガイドは出る・5 分ごと・10 世代）。
 * 5 分と 10 世代は FR-108 の既定値で、`io/autosave.ts` と `io/backup.ts` の既定と同じ
 * （app-prefs.test.ts が突き合わせる）。
 */
export const DEFAULT_APP_PREFS: AppPrefs = {
  showFirstRunGuide: true,
  autoSaveIntervalMinutes: 5,
  backupGenerations: 10,
};

export interface TimeMapApi {
  readonly save: (req: SaveRequest) => Promise<SaveResponse>;
  readonly saveAs: (req: SaveRequest) => Promise<SaveResponse>;
  readonly load: () => Promise<LoadResponse>;
  readonly loadDropped: (droppedPath: string) => Promise<LoadResponse>;
  /**
   * FR-04: open a native IMAGE dialog (PNG / JPEG), read the chosen file and return
   * its raw bytes for a base-map replacement. Resolves `null` when the user cancels
   * OR the read fails — the renderer flow then does nothing (honest no-op). Main owns
   * the dialog + the `fs` read; the renderer only receives bytes (FR-02).
   */
  readonly openImage: () => Promise<Uint8Array | null>;
  readonly configureAutoSave: (config: AutoSaveConfig) => Promise<ConfigureAutoSaveResponse>;
  /**
   * Subscribe to the one-way auto-save tick (main→renderer). The renderer wires
   * this to perform a `save`, closing the FR-108 auto-save loop end-to-end
   * (受け入れ基準3). Returns an {@link Unsubscribe} that detaches the listener.
   * Under contextIsolation+sandbox the renderer cannot touch `ipcRenderer.on`
   * directly, so this typed wrapper is the ONLY way it can hear the tick.
   */
  readonly onAutoSaveTick: (listener: () => void) => Unsubscribe;
  /**
   * FR-107 終了確認ガードの起動経路。main が close を preventDefault した上でこの
   * イベントを送るので、レンダラは `runGuard()`（= 未保存確認 3 択ガード）を走らせ、
   * その結果を preload が {@link IPC_CHANNEL.CloseResponse} で main へ返す。
   * `runGuard` が reject / throw した場合も preload は **false（閉じない）** を返す
   * — 例外で「閉じる」方向へ倒さない（fail-closed）。返り値の {@link Unsubscribe}
   * でリスナを外せる（アンマウント時の多重購読防止）。
   */
  readonly onCloseRequest: (runGuard: () => Promise<boolean>) => Unsubscribe;
  /**
   * Append ONE diagnostic log entry to the local JSONL file (FR-117 / FR-02).
   * Wired as the {@link DiagnosticLogger} sink in the renderer. Best-effort: the
   * returned promise resolves even when the write failed (main swallows the
   * error), and the renderer sink additionally swallows any rejection so the
   * logging path can never crash. NEVER leaves the machine (local userData only).
   */
  readonly appendLog: (record: DiagnosticLogRecord) => Promise<void>;
  /**
   * UC1 round-2 保存宛先の遅延昇格: commit a loaded file as the current save target.
   * Called from the renderer's load commit point (reflectProject 成功 = ドメイン確定,
   * the SAME point that promotes the loaded asset bytes) with the read's
   * {@link LoadResponse.commitToken}. Main promotes `currentPath` to the staged path
   * ONLY when the token matches its pending entry (and comes from the same window that
   * initiated the load, 所見3), so a load aborted at the FR-106 repair dialog — or one
   * that never reached the domain — never moves the save destination. Best-effort:
   * fire-and-forget; a plain Save that follows is a separate action and IPC send-order
   * guarantees main sees this commit first.
   */
  readonly commitLoadedPath: (token: string) => Promise<void>;
  /**
   * アプリ側の設定を読む（決定 (2)）。読めなければ {@link DEFAULT_APP_PREFS} を返す
   * ―― 「読めなかった」を例外にしない（初回は当然まだファイルが無い）。
   */
  readonly readAppPrefs: () => Promise<AppPrefs>;
  /**
   * アプリ側の設定を部分更新する。例外にはしないが、**書けたかどうかを返す**（増分 8D の
   * 手直し）。書けなかったら値は効かせない。
   */
  readonly writeAppPrefs: (patch: Partial<AppPrefs>) => Promise<AppPrefsWriteResult>;
  /**
   * 世代を新しい順に返す（増分 8D）。どのファイルの世代かは主プロセスが決める（いまの保存先 →
   * 世代から戻した元のファイル → 開こうとして開けなかったファイル）。決められなければ
   * `basis: 'none'`。`pickSource` なら主プロセスのダイアログで元のファイルを選ばせる。
   * **前に受け取った id はこの呼び出しで無効になる**。
   */
  readonly listBackups: (request?: BackupListRequest) => Promise<BackupListing>;
  /**
   * {@link listBackups} が直前に返した id の世代を開く（増分 8D）。**それ以外の id は
   * 断られる**（`ok: false` / `read-failed`）。開けた結果は保存先にならない。
   */
  readonly openBackup: (id: string) => Promise<LoadResponse>;
  /** 一覧の 1 行の地物数（増分 8D の手直し）。読めなければ null。 */
  readonly countBackupFeatures: (id: string) => Promise<number | null>;
  /** 「以前の保存から開く」の 1 回が終わった（一覧の世代を間引きから外すのをやめる）。 */
  readonly endBackupChoice: () => Promise<void>;
  /** いまの保存先の世代の数だけ（中身を読まない。設定の「いまの世代の数」）。 */
  readonly countBackups: () => Promise<BackupCount>;
  /** 新規にした（主プロセスは保存先と、世代の一覧の基準を捨てる）。 */
  readonly forgetSaveTarget: () => Promise<void>;
}
