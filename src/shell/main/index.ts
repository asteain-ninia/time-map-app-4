import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';

// Electron main process. Shell layer may import domain only (never ui/render).

// Smoke-test mode (SMOKE_TEST=1): drive whenReady -> createWindow -> preload
// load under sandbox -> renderer finishes loading, observe success/failure
// mechanically, and exit with a deterministic code. This makes acceptance
// criteria 1 (empty-window launch) and 5 (security settings under which the
// window renders) verifiable without a human visually inspecting a GUI.
const SMOKE_TEST = process.env['SMOKE_TEST'] === '1';
const SMOKE_TIMEOUT_MS = 30_000;

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
    minWidth: 800,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      // Renderer security: isolate context, no Node integration, full sandbox.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // In smoke mode render offscreen so the launch path can be verified
      // without a display/compositor. This does not relax any security flag.
      ...(SMOKE_TEST ? { offscreen: true } : {}),
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

app.whenReady().then(() => {
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
