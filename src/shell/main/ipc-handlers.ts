// U15 — main-process IPC RECEIVER side: the typed handlers behind every channel
// in the shared contract (開発ガイド §5.33 / 受け入れ基準4,6). Each handler takes
// the SHARED argument type and returns the SHARED return type (no string drift:
// the channel constants are imported from the one contract module).
//
// All effectful collaborators (the ipc registrar, the file dialogs, the fs read,
// the save pipeline env, the auto-save scheduler) are INJECTED via `IpcDeps` so
// the receiver logic is unit-testable WITHOUT a live Electron runtime
// (受け入れ基準7 / 開発ガイド §5.41). `registerIpcHandlers` is what main/index.ts
// calls with the real Electron bindings.

import { MAX_BASE_MAP_IMAGE_BYTES } from '../../domain/basemap/index';
import { isParsed, parseManifest } from '../../domain/persistence/boundary';
import {
  DEFAULT_MAX_GENERATIONS,
  countBackupFeatures,
  countBackups,
  describeBackups,
  memoizedFeatureCount,
  parseBackupFileName,
  type BackupFileStat,
} from '../io/backup';
import { appPrefsWriteFailedMessage } from '../io/app-prefs';
import { loadTmapBytes } from '../io/load';
import { saveTmap, type SaveEnv } from '../io/save';
import {
  MAX_TMAP_BYTES,
  MAX_TMAP_ENTRY_BYTES,
  MAX_TMAP_TOTAL_BYTES,
  type ReadTmapCaps,
} from '../io/tmap';
import {
  DEFAULT_APP_PREFS,
  IPC_CHANNEL,
  type AppPrefs,
  type AppPrefsWriteResult,
  type AutoSaveConfig,
  type BackupCount,
  type BackupEntry,
  type BackupListing,
  type CloseResponseAck,
  type ConfigureAutoSaveResponse,
  type DiagnosticLogRecord,
  type IpcChannel,
  type LoadResponse,
  type SaveRequest,
  type SaveResponse,
} from '../ipc/contract';
import { SHELL_MAIN_STRINGS } from './strings';

/** A registrar: binds a channel to an async handler (Electron `ipcMain.handle`). */
export type IpcRegistrar = (
  channel: IpcChannel,
  handler: (...args: never[]) => unknown,
) => void;

/**
 * The subset of Electron's `IpcMainInvokeEvent` the close-bridge handlers read:
 * the sender webContents' numeric id. Used to verify a close ACK / verdict comes
 * from the window that was actually asked (所見3 event.sender 検証) — a defensive
 * measure in the single-window app so a different webContents cannot spoof a
 * requestId and drive another window's close.
 */
interface IpcSenderEvent {
  readonly sender: { readonly id: number };
}

/** Dialog port: returns a chosen path or `undefined` when the user cancels. */
export interface DialogPort {
  /**
   * Open a save dialog (Save As); `undefined` = cancelled.
   *
   * `defaultPath` は **世代から開いたあとの保存**だけが渡す（増分 8D）: 既定のファイル名を
   * 元の保存ファイルの名前にする（設計書 §E.1 の V14 の規則 ②）。
   */
  showSaveDialog: (defaultPath?: string) => Promise<string | undefined>;
  /** Open an open dialog (Load); `undefined` = cancelled. */
  showOpenDialog: () => Promise<string | undefined>;
  /** Open an IMAGE open-dialog (FR-04 base-map差し替え); `undefined` = cancelled. */
  showOpenImageDialog: () => Promise<string | undefined>;
}

/** File read port: read raw bytes; rejects/throws are caught by the handler. */
export interface ReadFilePort {
  readFile: (path: string) => Promise<Uint8Array>;
  /**
   * The file's SIZE in bytes without reading its contents (a `stat`). FR-04 uses it
   * to enforce the base-map byte cap BEFORE reading a picked image, so a multi-GB
   * file is never read + structured-cloned across IPC only to be rejected in the
   * renderer (handleOpenImage). Rejects/throws are caught by the handler (honest null).
   */
  statSize: (path: string) => Promise<number>;
  /**
   * 大きさと更新時刻（増分 8D の手直し）。世代の地物数を「パス・大きさ・更新時刻」の鍵で
   * 覚えておき、2 回目からは読まないために使う。無ければ大きさだけで鍵を作る。
   */
  statInfo?: ((path: string) => Promise<BackupFileStat>) | undefined;
}

/** A holder for the "current document path" so plain Save targets it (FR-105). */
export interface CurrentPathRef {
  get: () => string | undefined;
  set: (path: string | undefined) => void;
}

/**
 * UC1 round-2: one STAGED load destination. A successful read no longer promotes the
 * current save target; it stages `{ token, path }` here and hands `token` back to the
 * renderer. Only when the renderer commits that token from its load commit point
 * (reflectProject 成功) does {@link handleCommitLoadedPath} promote `currentPath` to
 * `path`. `senderId` records the webContents that initiated the load so the commit can
 * be verified to come from the same window (所見3 event.sender 検証, the FR-107 流儀).
 */
export interface PendingLoadEntry {
  readonly token: string;
  readonly path: string;
  /**
   * The `webContents.id` that initiated the load, when threaded (所見3 検証用). Explicitly
   * allows `undefined` (exactOptionalPropertyTypes) so a direct handler call without an
   * event — the unit-test path — can stage the entry without a sender, in which case the
   * commit falls back to token-only verification.
   */
  readonly senderId?: number | undefined;
  /**
   * **世代から開いた読み込みだけ**が持つ、元の保存ファイルの絶対パス（増分 8D）。
   * これがある読み込みを確定しても `currentPath` は **世代のパスにならず未確定へ戻る**
   * （次の保存は「名前を付けて保存」）。一覧の対象と、名前を付けて保存の既定の名前は
   * この元のファイルになる。
   */
  readonly restoredFrom?: string | undefined;
}

/** A single-slot holder for the STAGED (not yet committed) load destination. */
export interface PendingLoadPathRef {
  get: () => PendingLoadEntry | undefined;
  set: (entry: PendingLoadEntry | undefined) => void;
}

/**
 * MED (save/load レースの宛先巻き戻し): a monotonic counter BUMPED every time a load
 * commit moves the save target ({@link handleCommitLoadedPath}). A save captures it at
 * START and, on completion, promotes `currentPath` to its own target ONLY if the counter
 * is unchanged. This stops a save that was in flight when a destructive load committed
 * from rolling the save destination BACK onto the just-superseded file: the load commit
 * is the more-recent truth about "which file is the live project", so a stale save's
 * completion must not clobber it. Symmetric with the renderer's onSaved context guard.
 */
export interface LoadCommitCounterRef {
  /** Read the current load-commit count (a save captures this at its start). */
  get: () => number;
  /** Bump — called on each load commit that moves the save target (a破壊的置換). */
  bump: () => void;
}

/**
 * 世代の一覧で **描画プロセスへ渡した id** と、その実体（増分 8D）。`ListBackups` の
 * たびに丸ごと差し替える ―― 前の一覧の id は次の一覧を作った時点で使えなくなる。
 * `OpenBackup` はこの表に載っている id しか受け取らない（任意のパスを受け取らない）。
 */
export interface IssuedBackup {
  /** 世代の絶対パス。 */
  readonly path: string;
  /** 元の保存ファイルの絶対パス。 */
  readonly sourcePath: string;
  /** 元の保存ファイルの名前（拡張子込み）。 */
  readonly sourceName: string;
  /** その世代を保存した時刻（epoch ms）。 */
  readonly savedAtMs: number;
}

/** {@link IssuedBackup} の表の置き場（1 枚）。 */
export interface BackupListingRef {
  get: () => ReadonlyMap<string, IssuedBackup>;
  set: (listing: ReadonlyMap<string, IssuedBackup>) => void;
}

/**
 * 「世代から戻した元のファイル」（増分 8D）。世代を開いて確定すると `currentPath` は
 * 未確定へ戻るので、**どのファイルの世代を一覧するか**と**名前を付けて保存の既定の名前**
 * を覚えておく場所が別に要る。次に保存できたとき・別のファイルを開いたときに消える。
 */
export interface RestoredSourceRef {
  get: () => string | undefined;
  set: (path: string | undefined) => void;
}

/** Everything the receiver needs, injected so it runs without Electron. */
export interface IpcDeps {
  readonly registrar: IpcRegistrar;
  readonly dialog: DialogPort;
  readonly readFile: ReadFilePort;
  readonly saveEnv: SaveEnv;
  readonly currentPath: CurrentPathRef;
  /**
   * UC1 round-2: the STAGED load-destination holder. `readAndParse` writes it (never
   * `currentPath` directly) on a successful read; `handleCommitLoadedPath` promotes it
   * to `currentPath` only when the renderer echoes the matching token at its commit point.
   */
  readonly pendingLoadPath: PendingLoadPathRef;
  /**
   * UC1 round-2: mint a fresh, unguessable token per successful load (合成ルートで
   * `randomUUID` を束縛). The token is handed to the renderer via `LoadResponse.commitToken`
   * and echoed back to commit the save destination — so only the window that received it
   * can move the target (the token is the primary guard; senderId is defense-in-depth).
   */
  readonly newLoadToken: () => string;
  /**
   * MED (save/load レース): the load-commit generation counter. `runSave` captures it at
   * save start and skips its own `currentPath` promotion if a load committed (bumped it)
   * during the async write — so a stale save never rolls the destination back.
   */
  readonly loadCommitCounter: LoadCommitCounterRef;
  /** 世代の一覧で渡した id の表（増分 8D）。 */
  readonly backupListing: BackupListingRef;
  /** 世代から戻した元のファイル（増分 8D）。 */
  readonly restoredSource: RestoredSourceRef;
  /**
   * 世代の一覧の **基準の候補**（増分 8D の手直し）。普通に開こうとして **まだ確定していない**
   * ファイル（壊れていて開けなかった・修復でやめた）と、一覧の板で利用者が選んだ元のファイル。
   * 保存先でも世代から戻した元のファイルでもないときだけ、一覧の基準に使う。保存先には
   * ならない。読み込みの確定・新規で消える。
   */
  readonly sourceCandidate: RestoredSourceRef;
  /**
   * 世代の地物数の覚え書き（鍵は「パス・大きさ・更新時刻」。増分 8D の手直し）。無ければ
   * 覚えない（毎回読む）。
   */
  readonly backupFeatureMemo?: Map<string, number | null> | undefined;
  /** Apply auto-save config (interval/generations) — wired to the scheduler. */
  readonly applyAutoSaveConfig: (config: AutoSaveConfig) => void;
  /** Generation cap to use for backups; settings-driven (既定 10). */
  readonly maxGenerations?: number;
  /**
   * Append ONE diagnostic log entry to the LOCAL JSONL file (FR-117 / FR-02).
   * Wired to the diagnostic-log fs adapter in main/index.ts. Best-effort: the
   * implementation swallows write failures, so this must never reject.
   */
  readonly appendDiagnosticLog: (record: DiagnosticLogRecord) => Promise<void>;
  /**
   * アプリ側の設定（userData の JSON 1 枚）の読み書き（決定 (2)）。合成ルートで
   * fs のアダプタに束縛する。**どちらも失敗を例外にしない**（初回はファイルが無い）。
   */
  readonly readAppPrefs: () => Promise<AppPrefs>;
  /** 書けたかどうかを返す（増分 8D の手直し。書けなかった値は効かせない）。 */
  readonly writeAppPrefs: (patch: Partial<AppPrefs>) => Promise<AppPrefsWriteResult>;
  /**
   * FR-107 close ブリッジ: レンダラの終了確認判定（{@link CloseVerdict} 形の生
   * payload）の受け口。合成ルートで close ガードのハブ (close-guard.ts) に束縛する。
   * payload は **信用しない** ので検証はハブ側で行う（main はレンダラ入力を素通し
   * しない）。ここに置くのは「ipcMain.handle の登録は 1 箇所に集約する」ため
   * （ウィンドウ再作成でハンドラが多重登録されない）。
   */
  readonly acceptCloseVerdict: (payload: unknown, senderId: number) => void;
  /**
   * FR-107 close ブリッジ: レンダラの **受領 ACK**（{@link CloseAckPayload} 形の生
   * payload）の受け口。判定より前に届き、close ガードが「生きた購読者が居る」ことを
   * 確定する（購読者不在を短い ACK タイムアウトで検出する — close-guard.ts の ADR）。
   * verdict と同じく検証はハブ側。`senderId` は応答を送った webContents.id（所見3
   * event.sender 検証: 要求を発行したウィンドウからの応答のみ受理する）。
   */
  readonly acceptCloseAck: (payload: unknown, senderId: number) => void;
  /**
   * U15 sender allowlist (Codex MED): true iff the invoking `event.sender` is one
   * of OUR app windows' webContents. Every invoke handler is gated on it — an
   * untrusted sender (devtools, an injected frame) gets an inert refusal (a
   * cancelled/no-op response, never a throw). Optional: absent (unit tests /
   * legacy callers) ⇒ every sender is trusted, preserving prior behaviour.
   */
  readonly isTrustedSender?: (senderId: number) => boolean;
}

const READ_FAILED_MSG = SHELL_MAIN_STRINGS.readFailed;
/**
 * 一覧に載っていない id で世代を開こうとした（増分 8D）。主プロセスは任意のパスを
 * 受け取らないので、ここへ来るのは古い一覧の id か、壊れた呼び出しだけである。
 */
export const UNKNOWN_BACKUP_MSG =
  SHELL_MAIN_STRINGS.unknownBackup;
/**
 * 一覧で選んだ世代のファイルが、開く直前に見つからなかった（増分 8D の手直し）。一覧を出した
 * あとで、ほかのソフトや手で消された・名前が変わったときだけ起きる（アプリ自身の保存の
 * 間引きは、一覧に出している世代を消さない）。
 */
export const BACKUP_GONE_MSG =
  SHELL_MAIN_STRINGS.backupGone;
const FILE_TOO_LARGE_MSG = SHELL_MAIN_STRINGS.fileTooLarge(Math.floor(MAX_TMAP_BYTES / (1024 * 1024)));

/**
 * Codex 全体レビュー MED「main IPC 保存側 runtime validation 欠如」への対処: the
 * renderer-supplied {@link SaveRequest} is UNTRUSTED at this boundary (a renderer
 * bug — or a compromised renderer — must not make main atomic-write a file the
 * loader would then reject, 教訓6.4.15 片側shim の再発防止). Checks, in order:
 *   1. structural shape (the base-map bytes are a real Uint8Array),
 *   2. per-entry byte caps INCLUDING the manifest JSON itself (Sol review #4:
 *      the reader caps the manifest entry too, so an over-cap manifest would
 *      save fine yet never re-open — the exact WRITE⊆READ break this guards),
 *   3. the manifest round-trips through the SAME Zod boundary the loader uses
 *      (parseManifest): never write a `.gimoza` that cannot be re-opened.
 * Returns a Japanese message on failure, or `null` when the request is sound.
 * `caps` is test-injectable; production uses the reader's own constants.
 */
export function validateSaveRequest(req: SaveRequest, caps: ReadTmapCaps = {}): string | null {
  const maxEntry = caps.maxEntryBytes ?? MAX_TMAP_ENTRY_BYTES;
  const maxTotal = caps.maxTotalBytes ?? MAX_TMAP_TOTAL_BYTES;
  if (typeof req !== 'object' || req === null) return SHELL_MAIN_STRINGS.saveRequestInvalid;
  if (!(req.baseMapImage instanceof Uint8Array)) return SHELL_MAIN_STRINGS.saveRequestInvalid;
  if (req.baseMapImage.length > maxEntry) {
    return SHELL_MAIN_STRINGS.baseMapTooLarge;
  }
  let totalBytes = req.baseMapImage.length;
  // The manifest ENTRY cap (Sol review #4): measured on the SAME JSON bytes the
  // writer will embed (strToU8(JSON.stringify(...)) in buildTmap). Buffer.byteLength
  // counts UTF-8 bytes without materialising them. A cyclic / non-serializable
  // manifest throws here — reject rather than let buildTmap crash mid-save.
  let manifestBytes: number;
  try {
    manifestBytes = Buffer.byteLength(JSON.stringify(req.manifest), 'utf8');
  } catch {
    return SHELL_MAIN_STRINGS.saveDataInvalid;
  }
  if (manifestBytes > maxEntry) {
    return SHELL_MAIN_STRINGS.manifestTooLarge;
  }
  // 展開後「合計」も読込側 (MAX_TMAP_TOTAL_BYTES) と対称に検査 (Sol 2周目 #2):
  // 各エントリは上限内でも合計が読込上限を超えるファイルは「保存できたのに
  // 二度と開けない」— WRITE⊆READ の破れをここで塞ぐ。
  //
  // 残余 (Sol 3周目 #3・受容): これは展開後データの合計であり、生成される ZIP は
  // これに数百バイトのヘッダ/ディレクトリ overhead を足したサイズになる。両上限が
  // 同じ 1 GiB のため、展開合計がちょうど 1 GiB 近傍の場合のみ「保存成功→読込側の
  // コンテナ上限をわずかに超過」が起こり得る。実データは数十MB級でこの境界には
  // 到達せず、overhead 分を引いた別上限を設けるのは局所的すぎるため導入しない。
  totalBytes += manifestBytes;
  if (totalBytes > maxTotal) {
    return SHELL_MAIN_STRINGS.projectTooLarge;
  }
  // WRITE⊆READ symmetry: the exact Zod boundary the loader runs. Rejecting here is
  // strictly better than writing a file the user can never re-open (第6波 HIGH の
  // 「自分の正当ファイルが二度と開けない」と同じ非対称クラスの封鎖).
  if (!isParsed(parseManifest(req.manifest))) {
    return SHELL_MAIN_STRINGS.saveDataInvalid;
  }
  return null;
}

// --- the handler implementations (exported for direct unit testing) ---------

/** Save to the current path, or open Save-As if there is none yet (FR-105). */
export async function handleSave(deps: IpcDeps, req: SaveRequest): Promise<SaveResponse> {
  const existing = deps.currentPath.get();
  const target = existing ?? (await askSaveTarget(deps));
  if (target === undefined) return { ok: false, reason: 'cancelled' };
  return runSave(deps, target, req);
}

/** Save As: always open a dialog to pick a fresh path (FR-105). */
export async function handleSaveAs(deps: IpcDeps, req: SaveRequest): Promise<SaveResponse> {
  const target = await askSaveTarget(deps);
  if (target === undefined) return { ok: false, reason: 'cancelled' };
  return runSave(deps, target, req);
}

/**
 * 保存のダイアログを開く。**世代から戻したあと**だけ、元の保存ファイルを既定にする
 * （増分 8D / 設計書 §E.1 の V14 の規則 ②「既定のファイル名は元の名前」）。それ以外は
 * これまでどおり何も渡さない。
 */
function askSaveTarget(deps: IpcDeps): Promise<string | undefined> {
  const restored = deps.restoredSource.get();
  return restored === undefined
    ? deps.dialog.showSaveDialog()
    : deps.dialog.showSaveDialog(restored);
}

async function runSave(deps: IpcDeps, target: string, req: SaveRequest): Promise<SaveResponse> {
  // Runtime boundary validation (Codex MED): never hand untrusted renderer bytes /
  // manifest straight to the atomic writer. Rejecting BEFORE the write means the
  // on-disk file (and its backups) are untouched by a malformed request.
  const invalid = validateSaveRequest(req);
  if (invalid !== null) return { ok: false, reason: 'write-failed', message: invalid };
  // MED (save/load レース): snapshot the load-commit generation at save START. If a load
  // commits (a破壊的置換) during the awaited write, the counter advances and this save must
  // NOT promote its own (now-stale) target — the load commit is the more-recent truth
  // about which file is live. The file at `target` is still written correctly (that is
  // what THIS save was for); we only suppress the `currentPath` move-back.
  const commitGenAtStart = deps.loadCommitCounter.get();
  // Awaited: the save pipeline's file I/O is now async (node:fs/promises) so the
  // main-process event loop is not frozen during a save (bughunt4). The handler
  // resolves only after the awaited atomic write + backup complete.
  //
  // Belt (Sol 2周目 #3): a residual throw anywhere in the pipeline (e.g. a ZIP
  // builder limit the validation missed) must surface as the CONTRACT's
  // write-failed response, never as an IPC promise rejection the renderer cannot
  // classify.
  let result: Awaited<ReturnType<typeof saveTmap>>;
  try {
    result = await saveTmap(
      deps.saveEnv,
      target,
      {
        manifest: req.manifest,
        baseMapImage: req.baseMapImage,
      },
      deps.maxGenerations ?? DEFAULT_MAX_GENERATIONS,
      // 増分 8D の手直し: 「以前の保存から開く」の一覧に出している世代は間引かない。未保存の
      // 確認で「保存」を選んだとき、その保存がいま選んだ世代を消していた（重 3）。
      protectedBackupPaths(deps),
    );
  } catch (error) {
    return {
      ok: false,
      reason: 'write-failed',
      message: SHELL_MAIN_STRINGS.saveFailed(error instanceof Error ? error.message : String(error)),
    };
  }
  if (result.ok && deps.loadCommitCounter.get() === commitGenAtStart) {
    deps.currentPath.set(target);
    // 書けた先が保存先になったので、「世代から戻した元のファイル」の覚え書きは役目を終える
    // （以後の一覧は新しい保存先の世代、名前を付けて保存の既定も付けない）。
    deps.restoredSource.set(undefined);
  }
  // Strip the internal `backup` field before returning over IPC (contract shape).
  return result.ok
    ? { ok: true, path: result.path }
    : { ok: false, reason: 'write-failed', message: result.message };
}

/** Load: open a dialog, read bytes, route through the Zod boundary (FR-105). */
export async function handleLoad(deps: IpcDeps, senderId?: number): Promise<LoadResponse> {
  const path = await deps.dialog.showOpenDialog();
  if (path === undefined) return { ok: false, reason: 'cancelled' };
  return readAndParse(deps, path, senderId);
}

/** Drag & drop load: the dropped absolute path is read + validated (FR-105). */
export async function handleLoadDropped(
  deps: IpcDeps,
  droppedPath: string,
  senderId?: number,
): Promise<LoadResponse> {
  return readAndParse(deps, droppedPath, senderId);
}

async function readAndParse(
  deps: IpcDeps,
  path: string,
  senderId?: number,
  restore?: IssuedBackup,
): Promise<LoadResponse> {
  // 増分 8D の手直し: 世代のファイル（`<名前>.bak.<時刻>-<連番>`）を D&D や「開く」で
  // **直接** 開いたときも、一覧から開いたときと同じ扱いにする（保存先にしない・既定の名前は
  // 元のファイル）。普通に昇格させると、次の Ctrl+S が世代そのものを上書きしていた。
  const asBackup = restore ?? backupFromFileName(deps, path);
  if (restore === undefined) {
    // 開こうとしたファイルを、一覧の基準の候補として覚える（壊れて開けなかったときに、
    // 「以前の保存から開く」がそのファイルの世代を出せるように）。確定すれば消える。
    deps.sourceCandidate.set(asBackup?.sourcePath ?? path);
  }
  let bytes: Uint8Array;
  try {
    // Size cap BEFORE the read (Codex MED「巨大ファイルで main 停止」— the
    // handleOpenImage F3 pattern): a multi-GB pick/drop must never be read into
    // main + structured-cloned across IPC + fed to unzipSync. readTmap re-checks
    // the actual byte length (TOCTOU belt) and bounds each entry's EXPANSION.
    const sizeBytes = await deps.readFile.statSize(path);
    if (sizeBytes > MAX_TMAP_BYTES) {
      return { ok: false, reason: 'read-failed', message: FILE_TOO_LARGE_MSG };
    }
    bytes = await deps.readFile.readFile(path);
  } catch {
    return { ok: false, reason: 'read-failed', message: READ_FAILED_MSG };
  }
  const response = loadTmapBytes(path, bytes);
  if (!response.ok) return response;
  // UC1 round-2 commit-point (HIGH): DO NOT promote the current save target here. A
  // successful read only means the file PARSED — the renderer may still abort at the
  // FR-106 repair dialog (or the load may throw at reflect), in which case the domain,
  // the assets AND the displayed map stay on the PREVIOUS project (round-1). If we
  // promoted `currentPath` on read, a subsequent Ctrl+S — which the renderer routes as a
  // plain Save because its own load context never changed — would atomic-write the
  // PREVIOUS project's content onto the file the user just refused to open, destroying
  // it, and there is no IPC to roll `currentPath` back. Instead STAGE the path under a
  // fresh token and hand the token back; the renderer commits it (CommitLoadedPath) ONLY
  // from reflectProject — the SAME commit point that promotes the loaded asset bytes — so
  // the save destination moves iff the load actually became the live project.
  const token = deps.newLoadToken();
  if (asBackup === undefined) {
    deps.pendingLoadPath.set({ token, path, senderId });
    return { ...response, commitToken: token };
  }
  // 増分 8D: 世代から開いた読み込みは、確定しても保存先を **世代のパスにしない**。
  // 元のファイルを覚えておき、画面へは「何の、いつの世代か」を返す。
  deps.pendingLoadPath.set({ token, path, senderId, restoredFrom: asBackup.sourcePath });
  return {
    ...response,
    commitToken: token,
    restoredFrom: { sourceName: asBackup.sourceName, savedAtMs: asBackup.savedAtMs },
  };
}

/**
 * 名前が世代の形なら、一覧から開いたときと同じ「世代の素性」を作る（増分 8D の手直し）。
 * 世代でなければ undefined。
 */
function backupFromFileName(deps: IpcDeps, path: string): IssuedBackup | undefined {
  const { dir, name } = deps.saveEnv.splitPath(path);
  const parsed = parseBackupFileName(name);
  if (parsed === undefined) return undefined;
  return {
    path,
    sourcePath: deps.saveEnv.joinPath(dir, parsed.baseName),
    sourceName: parsed.baseName,
    savedAtMs: parsed.savedAtMs,
  };
}

/**
 * 一覧の基準（どのファイルの世代を見るか）。いまの保存先 → 世代から戻した元のファイル →
 * 開こうとしてまだ確定していないファイル（壊れて開けなかった・利用者が板で選んだ）の順。
 */
function backupBasisOf(deps: IpcDeps): string | undefined {
  return deps.currentPath.get() ?? deps.restoredSource.get() ?? deps.sourceCandidate.get();
}

/** 一覧に出している世代の絶対パス（この間は保存の間引きから外す）。 */
function protectedBackupPaths(deps: IpcDeps): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const issued of deps.backupListing.get().values()) paths.add(issued.path);
  return paths;
}

/** 大きさと更新時刻を測る口（無ければ大きさだけ）。 */
function statOf(deps: IpcDeps): (path: string) => Promise<BackupFileStat> {
  const statInfo = deps.readFile.statInfo;
  if (statInfo !== undefined) return statInfo;
  return async (path) => ({ size: await deps.readFile.statSize(path), mtimeMs: -1 });
}

/** `ListBackups` の頼み方のうち「元のファイルを選ばせる」か（描画プロセスの値は信用しない）。 */
function wantsPickSource(request: unknown): boolean {
  return (
    typeof request === 'object' &&
    request !== null &&
    (request as { readonly pickSource?: unknown }).pickSource === true
  );
}

/**
 * 世代を新しい順に返す（増分 8D / 設計書 §E.1 の V14）。
 *
 * 基準は {@link backupBasisOf}。決められなければ `basis: 'none'`（「世代が 0 個」とは
 * 言わない ―― 元のファイルが壊れて開けないときに「無い」と言うのは事実に反する）。
 * `pickSource` なら主プロセスの「開く」ダイアログで元のファイルを選ばせ、その隣を見る
 * （**保存先は変えない**。選んだファイルは基準の候補として覚える）。
 *
 * **中身は読まない**（地物数は {@link handleCountBackupFeatures} が後から埋める。前に数えた
 * 世代は覚えた数を添える）。返す行ごとにその場限りの id を振り、id → 実体の表を
 * **丸ごと差し替える**（前の一覧の id はここで無効になる）。パスは描画プロセスへ渡さない。
 * この表に載っている世代は、{@link handleEndBackupChoice} などで表が空になるまで
 * **保存の間引きから外す**。
 */
export async function handleListBackups(
  deps: IpcDeps,
  request?: unknown,
): Promise<BackupListing> {
  let source = backupBasisOf(deps);
  if (wantsPickSource(request)) {
    let picked: string | undefined;
    try {
      picked = await deps.dialog.showOpenDialog();
    } catch {
      picked = undefined;
    }
    if (picked !== undefined) {
      source = backupFromFileName(deps, picked)?.sourcePath ?? picked;
      deps.sourceCandidate.set(source);
    }
  }
  if (source === undefined) {
    deps.backupListing.set(new Map());
    return { basis: 'none' };
  }
  const { dir, name } = deps.saveEnv.splitPath(source);
  const rows = await describeBackups(
    { listDir: deps.saveEnv.backupFs.listDir, stat: statOf(deps) },
    deps.saveEnv.joinPath,
    dir,
    name,
  ).catch(() => []);
  const listing = new Map<string, IssuedBackup>();
  const entries: BackupEntry[] = [];
  for (const row of rows) {
    const id = deps.newLoadToken();
    listing.set(id, { path: row.path, sourcePath: source, sourceName: name, savedAtMs: row.savedAtMs });
    const known = memoizedFeatureCount(deps.backupFeatureMemo, row);
    entries.push({
      id,
      savedAtMs: row.savedAtMs,
      byteSize: row.byteSize,
      sourceName: name,
      ...(known === undefined ? {} : { featureCount: known }),
    });
  }
  deps.backupListing.set(listing);
  return { basis: 'file', sourceName: name, entries };
}

/**
 * 一覧の 1 行の地物数を数える（増分 8D の手直し）。id は直前の一覧が振ったものだけ。
 * 読めない・一覧に無い id は null。
 */
export async function handleCountBackupFeatures(
  deps: IpcDeps,
  id: unknown,
): Promise<number | null> {
  const issued = typeof id === 'string' ? deps.backupListing.get().get(id) : undefined;
  if (issued === undefined) return null;
  return countBackupFeatures(
    { stat: statOf(deps), readFile: deps.readFile.readFile },
    issued.path,
    deps.backupFeatureMemo,
  );
}

/**
 * 「以前の保存から開く」の 1 回が終わった（増分 8D の手直し）。一覧の表を空にして、
 * 世代を保存の間引きから外すのをやめる。やめた・開き終えた、のどちらでも呼ばれる。
 */
export function handleEndBackupChoice(deps: IpcDeps): void {
  deps.backupListing.set(new Map());
}

/**
 * いまの基準の世代の **数だけ** を返す（増分 8D の手直し。設定の「いまの世代の数」）。
 * ディレクトリの名前を見るだけで、ファイルを 1 つも開かない。id も振らない。
 */
export async function handleCountBackups(deps: IpcDeps): Promise<BackupCount> {
  const source = backupBasisOf(deps);
  if (source === undefined) return { basis: 'none' };
  const { dir, name } = deps.saveEnv.splitPath(source);
  const count = await countBackups(deps.saveEnv.backupFs.listDir, dir, name);
  return { basis: 'file', sourceName: name, count };
}

/**
 * 新規にした（増分 8D の手直し）。保存先・世代から戻した元のファイル・一覧の基準の候補・
 * 一覧の表・確定待ちの読み込みを **すべて捨てる**。保存中の書き込みが終わったときに保存先を
 * 前のファイルへ戻さないよう、確定の世代番号も進める（読み込みの確定と同じ扱い）。
 */
export function handleForgetSaveTarget(deps: IpcDeps): void {
  deps.currentPath.set(undefined);
  deps.restoredSource.set(undefined);
  deps.sourceCandidate.set(undefined);
  deps.pendingLoadPath.set(undefined);
  deps.backupListing.set(new Map());
  deps.loadCommitCounter.bump();
}

/**
 * 一覧で選んだ世代を開く（増分 8D）。**id は直前の {@link handleListBackups} が振った
 * ものとしか照合しない**。表に無い id・文字列でない値は断る（パスとして解釈する経路を
 * 持たない）。**読む直前にファイルがあるかを確かめ**、無ければ理由をはっきり言って止める
 * （増分 8D の手直し）。読めたら普通の読み込みと同じ検証を通し、確定の印は「世代から開いた」
 * 印つきで預ける（{@link handleCommitLoadedPath} が保存先を未確定へ戻す）。読み終えたら
 * 一覧の表を空にする（もう間引きから外しておく必要は無い）。
 */
export async function handleOpenBackup(
  deps: IpcDeps,
  id: unknown,
  senderId?: number,
): Promise<LoadResponse> {
  const issued = typeof id === 'string' ? deps.backupListing.get().get(id) : undefined;
  if (issued === undefined) {
    return { ok: false, reason: 'read-failed', message: UNKNOWN_BACKUP_MSG };
  }
  try {
    try {
      await deps.readFile.statSize(issued.path);
    } catch {
      return { ok: false, reason: 'read-failed', message: BACKUP_GONE_MSG };
    }
    return await readAndParse(deps, issued.path, senderId, issued);
  } finally {
    deps.backupListing.set(new Map());
  }
}

/**
 * UC1 round-2 commit-point: promote the STAGED load destination to the current save
 * target, but ONLY when the committing renderer echoes the exact token main minted for
 * that load AND (所見3 event.sender 検証) the commit comes from the window that initiated
 * it. A stale / mismatched token — a load the user aborted at the repair dialog, a stage
 * already replaced by a later load, or a duplicate commit — is ignored; the pending entry
 * is NEVER consulted by Save (that reads `currentPath`), so an uncommitted stage is inert
 * until the next load overwrites it. Idempotent: the entry is cleared on promotion.
 */
export function handleCommitLoadedPath(
  deps: IpcDeps,
  token: unknown,
  senderId: number,
): void {
  const pending = deps.pendingLoadPath.get();
  if (
    pending !== undefined &&
    typeof token === 'string' &&
    pending.token === token &&
    (pending.senderId === undefined || pending.senderId === senderId)
  ) {
    if (pending.restoredFrom === undefined) {
      deps.currentPath.set(pending.path);
      // 別のファイルを開いた。世代から戻した元のファイルの覚え書きは捨てる。
      deps.restoredSource.set(undefined);
    } else {
      // 増分 8D: 世代から開いた読み込み。**保存先は世代のパスにせず未確定へ戻す** ――
      // 普通の読み込みと同じに昇格すると、次の Ctrl+S が世代そのものを上書きする。
      deps.currentPath.set(undefined);
      deps.restoredSource.set(pending.restoredFrom);
    }
    // 増分 8D の手直し: 読み込みが確定した。開こうとしていたファイルの候補と、前の一覧の
    // id の表は役目を終える（前のファイルの一覧の id で、別のファイルを開いたあとも開けていた）。
    deps.sourceCandidate.set(undefined);
    deps.backupListing.set(new Map());
    deps.pendingLoadPath.set(undefined);
    // MED: a load commit moved the save target — advance the generation so any save that
    // was in flight when this happened does NOT roll `currentPath` back on completion.
    deps.loadCommitCounter.bump();
  }
}

/**
 * FR-04 base-map差し替え: open an IMAGE dialog, read the chosen file and return its
 * raw bytes. A cancelled dialog OR any failure resolves `null` (honest no-op — the
 * renderer flow then does nothing), never a throw. The renderer validates the bytes
 * (PNG / JPEG header + dimension caps) before adopting them, so no format check is
 * needed here — main is only the dialog + `fs` read boundary (FR-02).
 *
 * F3 (pre-read size cap): the picked file is `stat`-ed and REJECTED past
 * {@link MAX_BASE_MAP_IMAGE_BYTES} BEFORE it is read — a multi-GB file must never be
 * read into main + structured-cloned across IPC only to be rejected by the renderer
 * guard. The cap is the SAME single-source bound the renderer guard uses (教訓 5.29).
 * The READ length is re-checked against the SAME cap AFTER the read (TOCTOU): the file
 * can GROW between the stat and the read (a concurrent writer), so a stat-passing file
 * could still read back oversized — returning it would send unbounded bytes across IPC.
 * On a post-read overflow we return null (honest no-op), never the oversized bytes.
 *
 * F5 (honest-null contract): the dialog pick, the stat, and the read all sit in ONE
 * try, so a picker / stat FAILURE resolves null too — not just a read failure. The
 * dialog await used to sit outside the try, so a picker rejection propagated across
 * the IPC boundary instead of degrading to the honest no-op every other failure gives.
 */
export async function handleOpenImage(deps: IpcDeps): Promise<Uint8Array | null> {
  try {
    const path = await deps.dialog.showOpenImageDialog();
    if (path === undefined) return null;
    // Stat first: enforce the byte cap before the read/IPC transfer (F3).
    const sizeBytes = await deps.readFile.statSize(path);
    if (sizeBytes > MAX_BASE_MAP_IMAGE_BYTES) return null;
    const bytes = await deps.readFile.readFile(path);
    // Re-check the ACTUAL read length (F3 TOCTOU): the file may have grown between the
    // stat and the read, so a stat-passing pick can still read back oversized. Never
    // return oversized bytes across IPC — the renderer guard would reject them anyway.
    if (bytes.length > MAX_BASE_MAP_IMAGE_BYTES) return null;
    return bytes;
  } catch {
    return null;
  }
}

/** アプリ側の設定から自動保存の設定を作る（増分 8D）。分 → ミリ秒にするだけの純関数。 */
export function autoSaveConfigOf(prefs: AppPrefs): AutoSaveConfig {
  return {
    intervalMs: prefs.autoSaveIntervalMinutes * 60 * 1000,
    maxGenerations: prefs.backupGenerations,
  };
}

/**
 * 起動時に、保存してあったアプリ側の設定を自動保存へ効かせる（増分 8D）。これが無いと、
 * 設定画面で変えた間隔・世代数が **再起動のたびに既定へ戻る**。読めなくても既定で動く。
 */
export async function restoreAutoSaveConfig(deps: IpcDeps): Promise<void> {
  const prefs = await handleReadAppPrefs(deps);
  deps.applyAutoSaveConfig(autoSaveConfigOf(prefs));
}

/** Push auto-save config (interval/generations) into the scheduler (FR-108). */
export function handleConfigureAutoSave(
  deps: IpcDeps,
  config: AutoSaveConfig,
): ConfigureAutoSaveResponse {
  deps.applyAutoSaveConfig(config);
  return { ok: true };
}

/**
 * Append ONE diagnostic log entry to the local JSONL file (FR-117 / FR-02). The
 * append is best-effort: any failure is swallowed here too, so a diagnostic-log
 * write can never reject the IPC call (an error-logging path must not itself
 * surface an error). Returns nothing — the renderer sink ignores the result.
 */
export async function handleAppendLog(
  deps: IpcDeps,
  record: DiagnosticLogRecord,
): Promise<void> {
  try {
    await deps.appendDiagnosticLog(record);
  } catch {
    // The adapter is already best-effort; this is a defensive belt so a rejection
    // never crosses the IPC boundary back into the renderer (FR-117 / log.ts:99).
  }
}

/**
 * アプリ側の設定を読む（決定 (2)）。**読めなければ既定を返す** ―― 初回起動には
 * まだファイルが無いのがふつうで、それは異常ではない。
 */
export async function handleReadAppPrefs(deps: IpcDeps): Promise<AppPrefs> {
  try {
    return await deps.readAppPrefs();
  } catch {
    return DEFAULT_APP_PREFS;
  }
}

/**
 * アプリ側の設定を部分更新する。例外にはしないが、**書けたかどうかを返す**（増分 8D の
 * 手直し）。書けなかった値は効かせない ―― その起動の間だけ効いて再起動で既定へ戻ると、
 * 効いていた世代数と次の起動の世代数が食い違い、次の保存で世代がまとめて消える。
 */
export async function handleWriteAppPrefs(
  deps: IpcDeps,
  patch: Partial<AppPrefs>,
): Promise<AppPrefsWriteResult> {
  let result: AppPrefsWriteResult;
  try {
    result = await deps.writeAppPrefs(patch);
  } catch (error) {
    result = {
      ok: false,
      prefs: await handleReadAppPrefs(deps),
      message: appPrefsWriteFailedMessage(error),
    };
  }
  // 増分 8D: 自動保存の間隔・世代数は **書いたその場で効かせる**（設定の［適用］）。
  // 口はこの 1 本だけ ―― 描画プロセスが別に `configureAutoSave` を呼ぶ形にすると、
  // 保存した値と効いている値が 2 経路に割れる。手直し: 書けたとき、かつ自動保存の 2 項目を
  // 書いたときだけ（初回ガイドの「今後表示しない」で自動保存の時計を掛け直さない）。
  if (result.ok && touchesAutoSave(patch)) {
    deps.applyAutoSaveConfig(autoSaveConfigOf(result.prefs));
  }
  return result;
}

/** 部分更新に自動保存の 2 項目のどちらかが入っているか（描画プロセスの値は信用しない）。 */
function touchesAutoSave(patch: unknown): boolean {
  return (
    typeof patch === 'object' &&
    patch !== null &&
    ('autoSaveIntervalMinutes' in patch || 'backupGenerations' in patch)
  );
}

/** 信用しない送り手からの書き込みへの答え（何も書かない）。 */
const REFUSED_PREFS_WRITE: AppPrefsWriteResult = {
  ok: false,
  prefs: DEFAULT_APP_PREFS,
  message: SHELL_MAIN_STRINGS.prefsWriteRefused,
};

// --- registration: one handler per shared channel ---------------------------

/**
 * Register the typed IPC handlers on the injected registrar. Every channel in
 * {@link IPC_CHANNEL} is bound exactly once; the two-sided test asserts that the
 * set of registered channels equals the contract's channel set, so a channel
 * added to the contract without a handler (or vice versa) fails (受け入れ基準4).
 */
export function registerIpcHandlers(deps: IpcDeps): void {
  // U15 sender allowlist (Codex MED): every invoke handler is gated on the sender's
  // webContents id. An untrusted sender gets the channel's inert refusal value —
  // never a throw (a rejected invoke would surface as a preload failure and muddy
  // diagnosis, the handleCloseResponse 流儀).
  const trusted = (event: IpcSenderEvent): boolean =>
    deps.isTrustedSender === undefined || deps.isTrustedSender(event.sender.id);
  const REFUSED = { ok: false, reason: 'cancelled' } as const;

  deps.registrar(IPC_CHANNEL.Save, ((event: IpcSenderEvent, req: SaveRequest) =>
    trusted(event) ? handleSave(deps, req) : REFUSED) as (...args: never[]) => unknown);
  deps.registrar(IPC_CHANNEL.SaveAs, ((event: IpcSenderEvent, req: SaveRequest) =>
    trusted(event) ? handleSaveAs(deps, req) : REFUSED) as (...args: never[]) => unknown);
  // 所見3: the load handlers read event.sender.id and stage it with the pending path so
  // the later CommitLoadedPath can verify the commit comes from the same window.
  deps.registrar(IPC_CHANNEL.Load, ((event: IpcSenderEvent) =>
    trusted(event) ? handleLoad(deps, event.sender.id) : REFUSED) as (...args: never[]) => unknown);
  deps.registrar(IPC_CHANNEL.LoadDropped, ((event: IpcSenderEvent, p: string) =>
    trusted(event) ? handleLoadDropped(deps, p, event.sender.id) : REFUSED) as (...args: never[]) => unknown);
  // UC1 round-2 保存宛先の遅延昇格: the renderer commits a staged load path (event.sender.id
  // は要求元検証に使う — 所見3 の流儀).
  deps.registrar(IPC_CHANNEL.CommitLoadedPath, ((event: IpcSenderEvent, token: unknown) =>
    trusted(event)
      ? handleCommitLoadedPath(deps, token, event.sender.id)
      : undefined) as (...args: never[]) => unknown);
  deps.registrar(IPC_CHANNEL.OpenImage, ((event: IpcSenderEvent) =>
    trusted(event) ? handleOpenImage(deps) : null) as (...args: never[]) => unknown);
  deps.registrar(IPC_CHANNEL.ConfigureAutoSave, ((event: IpcSenderEvent, c: AutoSaveConfig) =>
    trusted(event)
      ? handleConfigureAutoSave(deps, c)
      : { ok: true }) as (...args: never[]) => unknown);
  deps.registrar(IPC_CHANNEL.AppendLog, ((event: IpcSenderEvent, record: DiagnosticLogRecord) =>
    trusted(event) ? handleAppendLog(deps, record) : undefined) as (...args: never[]) => unknown);
  deps.registrar(IPC_CHANNEL.ReadAppPrefs, ((event: IpcSenderEvent) =>
    trusted(event) ? handleReadAppPrefs(deps) : DEFAULT_APP_PREFS) as (
    ...args: never[]
  ) => unknown);
  deps.registrar(IPC_CHANNEL.WriteAppPrefs, ((event: IpcSenderEvent, patch: Partial<AppPrefs>) =>
    trusted(event) ? handleWriteAppPrefs(deps, patch) : REFUSED_PREFS_WRITE) as (
    ...args: never[]
  ) => unknown);
  // 増分 8D: 世代の一覧と、一覧の id で開く口。開く側は読み込みと同じく送り手の id を
  // 預け、確定の印がその窓から来たかを確かめる。
  const NO_BASIS = { basis: 'none' } as const;
  deps.registrar(IPC_CHANNEL.ListBackups, ((event: IpcSenderEvent, request: unknown) =>
    trusted(event) ? handleListBackups(deps, request) : NO_BASIS) as (...args: never[]) => unknown);
  deps.registrar(IPC_CHANNEL.OpenBackup, ((event: IpcSenderEvent, id: unknown) =>
    trusted(event) ? handleOpenBackup(deps, id, event.sender.id) : REFUSED) as (
    ...args: never[]
  ) => unknown);
  // 増分 8D の手直し: 地物数を後から埋める口・1 回の終わり・数だけ・新規。
  deps.registrar(IPC_CHANNEL.CountBackupFeatures, ((event: IpcSenderEvent, id: unknown) =>
    trusted(event) ? handleCountBackupFeatures(deps, id) : null) as (...args: never[]) => unknown);
  deps.registrar(IPC_CHANNEL.EndBackupChoice, ((event: IpcSenderEvent) =>
    trusted(event) ? handleEndBackupChoice(deps) : undefined) as (...args: never[]) => unknown);
  deps.registrar(IPC_CHANNEL.CountBackups, ((event: IpcSenderEvent) =>
    trusted(event) ? handleCountBackups(deps) : NO_BASIS) as (...args: never[]) => unknown);
  deps.registrar(IPC_CHANNEL.ForgetSaveTarget, ((event: IpcSenderEvent) =>
    trusted(event) ? handleForgetSaveTarget(deps) : undefined) as (...args: never[]) => unknown);
  // 所見3: close ブリッジの受け口だけ event.sender.id を読む（要求元 webContents の検証用）。
  // The hub verifies the sender AGAIN against the window it queried (defense in depth).
  deps.registrar(IPC_CHANNEL.CloseAck, ((event: IpcSenderEvent, payload: unknown) =>
    trusted(event)
      ? handleCloseAck(deps, payload, event.sender.id)
      : { ok: true }) as (...args: never[]) => unknown);
  deps.registrar(IPC_CHANNEL.CloseResponse, ((event: IpcSenderEvent, payload: unknown) =>
    trusted(event)
      ? handleCloseResponse(deps, payload, event.sender.id)
      : { ok: true }) as (...args: never[]) => unknown);
}

/**
 * FR-107 close ブリッジ: レンダラの **受領 ACK** を close ガードへ渡す（受信側）。
 * verdict と同じ流儀: 解釈・検証はガード側の責務、ここは素通しの継ぎ目で、ガードが
 * throw してもレンダラへ例外を返さない（ack は常に `{ok:true}`）。
 */
export function handleCloseAck(
  deps: IpcDeps,
  payload: unknown,
  senderId: number,
): CloseResponseAck {
  try {
    deps.acceptCloseAck(payload, senderId);
  } catch {
    // 握りつぶす（handleCloseResponse と同じ理由）。ガード側は自前でログする。
  }
  return { ok: true };
}

/**
 * FR-107 close ブリッジ: レンダラの終了確認判定を close ガードへ渡す（受信側）。
 * 判定の解釈・検証はガード側（close-guard.ts）の責務なので、ここは素通しの継ぎ目。
 * ガード側が throw してもレンダラへ例外を返さない: 応答の invoke が reject すると
 * preload 側の送信が失敗したように見え、原因の切り分けが濁る。ack は常に `{ok:true}`
 * で、「閉じる/閉じない」は ack ではなく payload と main の状態機械が決める。
 */
export function handleCloseResponse(
  deps: IpcDeps,
  payload: unknown,
  senderId: number,
): CloseResponseAck {
  try {
    deps.acceptCloseVerdict(payload, senderId);
  } catch {
    // 握りつぶす（上記コメント）。ガード側は自前でログする。
  }
  return { ok: true };
}
