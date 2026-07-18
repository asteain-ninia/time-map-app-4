import { copyFile, readdir, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';

import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH } from '../../domain/window-constants';
import {
  appendDiagnosticLog,
  createAutoSaveScheduler,
  DEFAULT_AUTO_SAVE_INTERVAL_MS,
  DEFAULT_DIAGNOSTIC_LOG_GENERATIONS,
  DEFAULT_MAX_GENERATIONS,
  nodeDiagnosticLogFs,
  nodeFsOps,
  pruneDiagnosticLogs,
} from '../io';
import type { DiagnosticLogEnv, SaveEnv } from '../io';
import { registerIpcHandlers, type CurrentPathRef, type IpcDeps } from './ipc-handlers';
import { IPC_CHANNEL, type AutoSaveConfig } from '../ipc/contract';

// Electron main process. Shell layer may import domain only (never ui/render).

// Smoke-test mode (SMOKE_TEST=1): drive whenReady -> createWindow -> preload
// load under sandbox -> renderer finishes loading, observe success/failure
// mechanically, and exit with a deterministic code. This makes acceptance
// criteria 1 (empty-window launch) and 5 (security settings under which the
// window renders) verifiable without a human visually inspecting a GUI.
const SMOKE_TEST = process.env['SMOKE_TEST'] === '1';
const SMOKE_TIMEOUT_MS = 30_000;

// E2E mode (E2E_TEST=1): Playwright for Electron drives the REAL composition root
// headless. Like SMOKE_TEST it renders the window OFFSCREEN (no display needed),
// but UNLIKE smoke it does NOT auto-exit on did-finish-load — the app must stay
// alive so the test can interact with the renderer (U43 / 技術方針 2.14). No
// security flag is relaxed (sandbox / contextIsolation / nodeIntegration unchanged).
const E2E_TEST = process.env['E2E_TEST'] === '1';

function smokeFail(reason: string): void {
  console.error(`[smoke] FAIL: ${reason}`);
  app.exit(1);
}

function smokePass(): void {
  console.log('[smoke] PASS: window created, preload loaded, renderer finished load under sandbox');
  app.exit(0);
}

function attachSmokeProbes(window: BrowserWindow): void {
  // Verifies the launch path mechanically: createWindow succeeded, the preload
  // loaded under sandbox without error, and the renderer reached
  // `did-finish-load`. We deliberately do NOT gate on `ready-to-show`: that
  // event depends on a real compositor/display and never fires in a headless
  // (offscreen) run, whereas `did-finish-load` exercises the full
  // preload+renderer load path we need to confirm for AC1/AC5.
  const timer = setTimeout(() => {
    smokeFail(`timed out after ${String(SMOKE_TIMEOUT_MS)}ms before did-finish-load`);
  }, SMOKE_TIMEOUT_MS);

  // Any of these indicate the launch path is broken (preload/sandbox/load).
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    clearTimeout(timer);
    smokeFail(`did-fail-load code=${String(errorCode)} desc=${errorDescription}`);
  });
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    clearTimeout(timer);
    smokeFail(`preload-error path=${preloadPath} error=${error.message}`);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    clearTimeout(timer);
    smokeFail(`render-process-gone reason=${details.reason}`);
  });
  window.webContents.on('console-message', (_event, level, message) => {
    // level 3 === error
    if (level >= 3) {
      clearTimeout(timer);
      smokeFail(`renderer console error: ${message}`);
    }
  });

  window.webContents.on('did-finish-load', () => {
    clearTimeout(timer);
    smokePass();
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    // FR-114: 800×600 minimum, from the single shared constant (domain).
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    // HB3-24 [暫定]: hide the native OS menu bar by default (the app's own メニューバー
    // is the primary surface); Alt reveals it momentarily so native accelerators are
    // not lost entirely (ユーザー: ネイティブツールバーは消して良さそう, 中間策).
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      // Renderer security: isolate context, no Node integration, full sandbox.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // In smoke / E2E mode render offscreen so the launch + interaction path can
      // be verified without a display/compositor. This does not relax any security
      // flag (sandbox / contextIsolation / nodeIntegration stay as above).
      ...(SMOKE_TEST || E2E_TEST ? { offscreen: true } : {}),
    },
  });

  if (SMOKE_TEST) {
    attachSmokeProbes(window);
  }

  window.on('ready-to-show', () => {
    window.show();
  });

  // Offline-only: load the dev server in development, bundled HTML otherwise.
  // No external URLs are ever loaded.
  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl !== undefined) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// --- typed IPC wiring (U15) -------------------------------------------------
//
// Bind the shared-contract handlers to the real Electron collaborators: the
// dialogs, fs read, the atomic-save fs port (node:fs), the backup fs port, the
// real clock + unique token, and an auto-save scheduler. The receiver LOGIC is
// in ./ipc-handlers (Electron-free, unit-tested); this only supplies the live
// bindings (開発ガイド §5.41).
let currentDocumentPath: string | undefined;

function buildSaveEnv(): SaveEnv {
  return {
    atomicFs: nodeFsOps,
    backupFs: {
      // Async (node:fs/promises): the backup listing / copy / prune no longer
      // block the main-process event loop (bughunt4).
      listDir: (dir) => readdir(dir),
      copyFile: async (sourcePath, destPath) => {
        await copyFile(sourcePath, destPath);
      },
      remove: async (path) => {
        await rm(path, { force: true });
      },
    },
    now: () => Date.now(),
    token: () => randomUUID(),
    splitPath: (fullPath) => ({ dir: dirname(fullPath), name: basename(fullPath) }),
    joinPath: (dir, name) => join(dir, name),
  };
}

/**
 * The diagnostic-log persistence environment (FR-117 / FR-02). Files live under
 * `userData/logs`, rotated per day and pruned to the default generation count. The
 * fs ops are the production `node:fs/promises` binding; the LOGIC (filename /
 * generation selection / append) is Electron-free and unit-tested (開発ガイド §5.41).
 */
function buildDiagnosticLogEnv(): DiagnosticLogEnv {
  return {
    fs: nodeDiagnosticLogFs,
    dir: join(app.getPath('userData'), 'logs'),
    now: () => new Date(),
    keepGenerations: DEFAULT_DIAGNOSTIC_LOG_GENERATIONS,
  };
}

function wireIpc(): void {
  const currentPath: CurrentPathRef = {
    get: () => currentDocumentPath,
    set: (path) => {
      currentDocumentPath = path;
    },
  };

  // FR-117 ROOT FIX (教訓 5.7 合成ルートの結線漏れ): the renderer's DiagnosticLogger
  // sink invokes AppendLog; bind it to the LOCAL file adapter here so warnings the
  // user sees on real hardware are actually persisted to disk (previously the logger
  // was constructed with NO sink, so nothing reached the filesystem). Old generations
  // are pruned once at startup (best-effort — never blocks launch).
  const diagnosticLogEnv = buildDiagnosticLogEnv();
  void pruneDiagnosticLogs(diagnosticLogEnv);

  // The auto-save scheduler drives the renderer to perform a save through the
  // same typed channel (the renderer owns the live manifest/asset bytes). Its
  // interval comes from settings (既定 5 分); only the default lives in code.
  const scheduler = createAutoSaveScheduler(() => {
    const target = BrowserWindow.getAllWindows()[0];
    if (target !== undefined) {
      // Channel name from the single-source contract (NOT a hardcoded string):
      // the preload subscriber (onAutoSaveTick) listens on this same constant.
      target.webContents.send(IPC_CHANNEL.AutoSaveTick);
    }
  });
  scheduler.reconfigure(DEFAULT_AUTO_SAVE_INTERVAL_MS);

  let maxGenerations = DEFAULT_MAX_GENERATIONS;

  const applyAutoSaveConfig = (config: AutoSaveConfig): void => {
    scheduler.reconfigure(config.intervalMs);
    maxGenerations = config.maxGenerations;
  };

  const deps: IpcDeps = {
    registrar: (channel, handler) => {
      // The contract handler is typed structurally (...never[]); Electron's
      // ipcMain.handle wants (event, ...any[]). They are call-compatible at
      // runtime; bridge the variance here at the single wiring point.
      ipcMain.handle(channel, handler as Parameters<typeof ipcMain.handle>[1]);
    },
    dialog: {
      showSaveDialog: async () => {
        const result = await dialog.showSaveDialog({ filters: [{ name: 'tmap', extensions: ['tmap'] }] });
        return result.canceled ? undefined : result.filePath;
      },
      showOpenDialog: async () => {
        const result = await dialog.showOpenDialog({
          properties: ['openFile'],
          filters: [{ name: 'tmap', extensions: ['tmap'] }],
        });
        return result.canceled || result.filePaths.length === 0 ? undefined : result.filePaths[0];
      },
      // FR-04 base-map差し替え: an IMAGE open-dialog (PNG / JPEG — the formats the
      // renderer guard accepts). No security flag relaxed; main only reads the file.
      showOpenImageDialog: async () => {
        const result = await dialog.showOpenDialog({
          properties: ['openFile'],
          filters: [{ name: 'image', extensions: ['png', 'jpg', 'jpeg'] }],
        });
        return result.canceled || result.filePaths.length === 0 ? undefined : result.filePaths[0];
      },
    },
    readFile: { readFile: (path) => readFile(path) },
    saveEnv: buildSaveEnv(),
    currentPath,
    applyAutoSaveConfig,
    get maxGenerations(): number {
      return maxGenerations;
    },
    appendDiagnosticLog: (record) => appendDiagnosticLog(diagnosticLogEnv, record),
  };

  registerIpcHandlers(deps);
}

app.whenReady().then(() => {
  wireIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}, (error: unknown) => {
  if (SMOKE_TEST) {
    smokeFail(`whenReady rejected: ${String(error)}`);
    return;
  }
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
