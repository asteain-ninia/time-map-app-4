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
import { DEFAULT_MAX_GENERATIONS } from '../io/backup';
import { loadTmapBytes } from '../io/load';
import { saveTmap, type SaveEnv } from '../io/save';
import {
  IPC_CHANNEL,
  type AutoSaveConfig,
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

/** Everything the receiver needs, injected so it runs without Electron. */
export interface IpcDeps {
  readonly registrar: IpcRegistrar;
  readonly dialog: DialogPort;
  readonly readFile: ReadFilePort;
  readonly saveEnv: SaveEnv;
  readonly currentPath: CurrentPathRef;
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
}

const READ_FAILED_MSG = 'ファイルの読み込みに失敗しました。';

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
  // Awaited: the save pipeline's file I/O is now async (node:fs/promises) so the
  // main-process event loop is not frozen during a save (bughunt4). The handler
  // resolves only after the awaited atomic write + backup complete.
  const result = await saveTmap(
    deps.saveEnv,
    target,
    {
      manifest: req.manifest,
      baseMapImage: req.baseMapImage,
      attachments: req.attachments,
    },
    deps.maxGenerations ?? DEFAULT_MAX_GENERATIONS,
  );
  if (result.ok) deps.currentPath.set(target);
  // Strip the internal `backup` field before returning over IPC (contract shape).
  return result.ok
    ? { ok: true, path: result.path }
    : { ok: false, reason: 'write-failed', message: result.message };
}

/** Load: open a dialog, read bytes, route through the Zod boundary (FR-105). */
export async function handleLoad(deps: IpcDeps): Promise<LoadResponse> {
  const path = await deps.dialog.showOpenDialog();
  if (path === undefined) return { ok: false, reason: 'cancelled' };
  return readAndParse(deps, path);
}

/** Drag & drop load: the dropped absolute path is read + validated (FR-105). */
export async function handleLoadDropped(
  deps: IpcDeps,
  droppedPath: string,
): Promise<LoadResponse> {
  return readAndParse(deps, droppedPath);
}

async function readAndParse(deps: IpcDeps, path: string): Promise<LoadResponse> {
  let bytes: Uint8Array;
  try {
    bytes = await deps.readFile.readFile(path);
  } catch {
    return { ok: false, reason: 'read-failed', message: READ_FAILED_MSG };
  }
  const response = loadTmapBytes(path, bytes);
  if (response.ok) deps.currentPath.set(path);
  return response;
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
  deps.registrar(IPC_CHANNEL.Save, ((_event: never, req: SaveRequest) =>
    handleSave(deps, req)) as (...args: never[]) => unknown);
  deps.registrar(IPC_CHANNEL.SaveAs, ((_event: never, req: SaveRequest) =>
    handleSaveAs(deps, req)) as (...args: never[]) => unknown);
  deps.registrar(IPC_CHANNEL.Load, (() => handleLoad(deps)) as (...args: never[]) => unknown);
  deps.registrar(IPC_CHANNEL.LoadDropped, ((_event: never, p: string) =>
    handleLoadDropped(deps, p)) as (...args: never[]) => unknown);
  deps.registrar(IPC_CHANNEL.OpenImage, (() =>
    handleOpenImage(deps)) as (...args: never[]) => unknown);
  deps.registrar(IPC_CHANNEL.ConfigureAutoSave, ((_event: never, c: AutoSaveConfig) =>
    handleConfigureAutoSave(deps, c)) as (...args: never[]) => unknown);
  deps.registrar(IPC_CHANNEL.AppendLog, ((_event: never, record: DiagnosticLogRecord) =>
    handleAppendLog(deps, record)) as (...args: never[]) => unknown);
}
