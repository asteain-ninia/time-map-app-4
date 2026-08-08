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
import { DEFAULT_MAX_GENERATIONS } from '../io/backup';
import { loadTmapBytes } from '../io/load';
import { saveTmap, type SaveEnv } from '../io/save';
import { ATTACHMENTS_DIR } from '../io/entry-paths';
import {
  MAX_TMAP_BYTES,
  MAX_TMAP_ENTRY_BYTES,
  MAX_TMAP_TOTAL_BYTES,
  type ReadTmapCaps,
} from '../io/tmap';

/**
 * ZIP のファイル名フィールドは 65,535 バイト(UTF-8)が仕様上限。超過は zipSync が
 * throw して保存 IPC が例外終了するため(Sol 2周目 #3)、添付名は
 * `assets/attachments/` プレフィックスを足してもこの上限に収まる長さに制限する。
 */
const MAX_ATTACHMENT_NAME_BYTES = 65535 - Buffer.byteLength(ATTACHMENTS_DIR, 'utf8');
import {
  IPC_CHANNEL,
  type AutoSaveConfig,
  type CloseResponseAck,
  type ConfigureAutoSaveResponse,
  type DiagnosticLogRecord,
  type IpcChannel,
  type LoadResponse,
  type SaveRequest,
  type SaveResponse,
} from '../ipc/contract';

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
  /** Open a save dialog (Save As); `undefined` = cancelled. */
  showSaveDialog: () => Promise<string | undefined>;
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

const READ_FAILED_MSG = 'ファイルの読み込みに失敗しました。';
const FILE_TOO_LARGE_MSG = `ファイルが大きすぎます（上限 ${Math.floor(MAX_TMAP_BYTES / (1024 * 1024))} MB）。`;

/**
 * Codex 全体レビュー MED「main IPC 保存側 runtime validation 欠如」への対処: the
 * renderer-supplied {@link SaveRequest} is UNTRUSTED at this boundary (a renderer
 * bug — or a compromised renderer — must not make main atomic-write a file the
 * loader would then reject, 教訓6.4.15 片側shim の再発防止). Checks, in order:
 *   1. structural shape (bytes are real Uint8Arrays; attachments well-formed),
 *   2. attachment names: non-empty, no path separators, and not the special `.` /
 *      `..` SEGMENTS (a hostile name would otherwise become a ZIP entry path
 *      outside `assets/attachments/`). A mere `..` SUBSTRING (e.g. `map..v2.png`)
 *      is a legal basename once separators are banned, so it is NOT rejected
 *      (Sol review #5: the reader accepts such names — reject would strand them),
 *   3. per-entry byte caps INCLUDING the manifest JSON itself (Sol review #4:
 *      the reader caps the manifest entry too, so an over-cap manifest would
 *      save fine yet never re-open — the exact WRITE⊆READ break this guards),
 *   4. the manifest round-trips through the SAME Zod boundary the loader uses
 *      (parseManifest): never write a `.tmap` that cannot be re-opened.
 * Returns a Japanese message on failure, or `null` when the request is sound.
 * `caps` is test-injectable; production uses the reader's own constants.
 */
export function validateSaveRequest(req: SaveRequest, caps: ReadTmapCaps = {}): string | null {
  const maxEntry = caps.maxEntryBytes ?? MAX_TMAP_ENTRY_BYTES;
  const maxTotal = caps.maxTotalBytes ?? MAX_TMAP_TOTAL_BYTES;
  if (typeof req !== 'object' || req === null) return '保存要求の形式が不正です。';
  if (!(req.baseMapImage instanceof Uint8Array)) return '保存要求の形式が不正です。';
  if (req.baseMapImage.length > maxEntry) {
    return '背景地図画像が大きすぎるため保存できません。';
  }
  if (!Array.isArray(req.attachments)) return '保存要求の形式が不正です。';
  let totalBytes = req.baseMapImage.length;
  for (const asset of req.attachments) {
    if (typeof asset !== 'object' || asset === null) return '保存要求の形式が不正です。';
    const { name, bytes } = asset as { name: unknown; bytes: unknown };
    if (typeof name !== 'string' || name.length === 0) return '保存要求の形式が不正です。';
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      return `添付資産名が不正です: ${name}`;
    }
    // ZIP 仕様のファイル名上限 (Sol 2周目 #3): 超過は zipSync throw → IPC 例外終了。
    if (Buffer.byteLength(name, 'utf8') > MAX_ATTACHMENT_NAME_BYTES) {
      return `添付資産名が長すぎます: ${name.slice(0, 32)}…`;
    }
    if (!(bytes instanceof Uint8Array)) return '保存要求の形式が不正です。';
    if (bytes.length > maxEntry) {
      return `添付資産 ${name} が大きすぎるため保存できません。`;
    }
    totalBytes += bytes.length;
  }
  // The manifest ENTRY cap (Sol review #4): measured on the SAME JSON bytes the
  // writer will embed (strToU8(JSON.stringify(...)) in buildTmap). Buffer.byteLength
  // counts UTF-8 bytes without materialising them. A cyclic / non-serializable
  // manifest throws here — reject rather than let buildTmap crash mid-save.
  let manifestBytes: number;
  try {
    manifestBytes = Buffer.byteLength(JSON.stringify(req.manifest), 'utf8');
  } catch {
    return '保存データが検証に失敗しました。お手数ですが開発者へ報告してください。';
  }
  if (manifestBytes > maxEntry) {
    return 'プロジェクトデータが大きすぎるため保存できません。';
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
    return 'プロジェクト全体のサイズが大きすぎるため保存できません。';
  }
  // WRITE⊆READ symmetry: the exact Zod boundary the loader runs. Rejecting here is
  // strictly better than writing a file the user can never re-open (第6波 HIGH の
  // 「自分の正当ファイルが二度と開けない」と同じ非対称クラスの封鎖).
  if (!isParsed(parseManifest(req.manifest))) {
    return '保存データが検証に失敗しました。お手数ですが開発者へ報告してください。';
  }
  return null;
}

// --- the handler implementations (exported for direct unit testing) ---------

/** Save to the current path, or open Save-As if there is none yet (FR-105). */
export async function handleSave(deps: IpcDeps, req: SaveRequest): Promise<SaveResponse> {
  const existing = deps.currentPath.get();
  const target = existing ?? (await deps.dialog.showSaveDialog());
  if (target === undefined) return { ok: false, reason: 'cancelled' };
  return runSave(deps, target, req);
}

/** Save As: always open a dialog to pick a fresh path (FR-105). */
export async function handleSaveAs(deps: IpcDeps, req: SaveRequest): Promise<SaveResponse> {
  const target = await deps.dialog.showSaveDialog();
  if (target === undefined) return { ok: false, reason: 'cancelled' };
  return runSave(deps, target, req);
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
        attachments: req.attachments,
      },
      deps.maxGenerations ?? DEFAULT_MAX_GENERATIONS,
    );
  } catch (error) {
    return {
      ok: false,
      reason: 'write-failed',
      message: `保存に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (result.ok && deps.loadCommitCounter.get() === commitGenAtStart) {
    deps.currentPath.set(target);
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
): Promise<LoadResponse> {
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
  deps.pendingLoadPath.set({ token, path, senderId });
  return { ...response, commitToken: token };
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
    deps.currentPath.set(pending.path);
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
