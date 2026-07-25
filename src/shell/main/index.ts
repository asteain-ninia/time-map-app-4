import { copyFile, readdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, dialog, ipcMain, Menu, type MenuItemConstructorOptions } from 'electron';

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
import {
  devToolsBindingEnabled,
  installApplicationMenu,
  isDevToolsChord,
  type ApplicationMenuApi,
} from './app-menu';
import { CLOSE_DECISION, createCloseGuardHub } from './close-guard';
import {
  registerIpcHandlers,
  type CurrentPathRef,
  type IpcDeps,
  type LoadCommitCounterRef,
  type PendingLoadEntry,
  type PendingLoadPathRef,
} from './ipc-handlers';
import { acquireSingleInstanceLock, revealWindow } from './single-instance';
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

// --- ユニット U3: 単一インスタンスロック（lost-update 根治 / v3 同型）-------------
//
// 二重起動して同じ .tmap を開くと「後勝ち保存」で先の編集が消える（本アプリ最後の
// 既知データ損失経路）。**起動最初期**（whenReady / createWindow より前）にロックを取り、
// 取れなければ即 quit する。判定ロジックは Electron-free な ./single-instance に置き（単体
// テスト済み）、ここは実物 app / BrowserWindow の束縛だけを行う（開発ガイド §5.41 合成ルート）。
//
// 🔴 共有 userData ゲート（最重要）: Playwright の `_electron.launch` はアプリを起動する際に
// `--user-data-dir` を渡さない（playwright-core .../electron/loader.js 実測: chromium スイッチ
// のみ追加）。したがって E2E/SMOKE の複数 Electron 起動は **既定 userData を共有** する。
// requestSingleInstanceLock は userData パス単位のロックなので、この環境でロックを取ると
// 連続する（あるいは並列 worker の）起動が互いのロックを奪って殺し合い、フル e2e が壊滅する。
// よって E2E/SMOKE では skipLock=true で **ロックを一切取らない**（製品挙動は不変）。ロック
// 挙動自体は single-instance.test.ts（app モック）で状態機械レベルに固定している。
//
// 不変条件（FR-107 close ガードとの非干渉）: 取得失敗時の app.quit() は **ウィンドウ生成前** に
// 起きるため、close ガード（createWindow で window に貼る）は一切関与しない。
const shouldBootApp = acquireSingleInstanceLock({
  app,
  skipLock: E2E_TEST || SMOKE_TEST,
  // 2つ目の起動を検知したら 1つ目の（唯一の）ウィンドウを前面化する（v3 同型: minimized
  // なら restore → focus）。§7.4 非目標により argv の .tmap パス処理は行わない（focus のみ）。
  onSecondInstance: () => {
    const primary = BrowserWindow.getAllWindows()[0];
    if (primary !== undefined) revealWindow(primary);
  },
  log: (message) => {
    console.warn(message);
  },
});

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

// --- FR-107 close ブリッジ (終了確認ガードの起動経路) ------------------------
//
// ここが「× / Alt+F4 / タスクバー / OS シャットダウンで未保存確認が出ない」残 HIGH の
// 根治点。判断ロジックは Electron-free な ./close-guard に置き（単体テスト済み）、
// ここは実物（BrowserWindow / webContents / app / タイマー / ログ）の束縛だけを行う
// （開発ガイド §5.41 合成ルート）。ハブは **モジュール 1 個**: `ipcMain.handle` は
// チャネルごとに 1 回しか登録できないので、応答の受け口は wireIpc の 1 箇所に集約し、
// 要求 ID でウィンドウごとのガードへ振り分ける（ウィンドウ再作成でも多重登録なし）。
const closeGuardHub = createCloseGuardHub({
  newRequestId: () => randomUUID(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => {
    clearTimeout(timer as NodeJS.Timeout);
  },
  log: (message) => {
    logCloseGuard(message);
  },
});

/**
 * close ガードの診断ログ 1 行。コンソール（開発・E2E で観測可能）と FR-117 の
 * ローカル診断ログの両方へ流す。ファイル側は best-effort（起動前・書き込み失敗でも
 * 終了判断には影響させない — ログの失敗でウィンドウが閉じられなくなってはならない）。
 */
function logCloseGuard(message: string): void {
  console.warn(message);
  const env = diagnosticLogEnv;
  if (env === undefined) return;
  void appendDiagnosticLog(env, {
    level: 'warning',
    message,
    recordedAtMs: Date.now(),
    context: { summary: 'close-guard' },
  }).catch(() => undefined);
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    // FR-114: 800×600 minimum, from the single shared constant (domain).
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    // HB3-24: hide the native OS menu bar (the app's own メニューバー is the primary
    // surface). NOTE: on win32/linux `wireApplicationMenu` now removes the application
    // menu ENTIRELY, so there is nothing left for Alt to reveal and this flag is a
    // belt-and-braces no-op there; it still matters on darwin (minimal menu) and it
    // keeps the window from ever flashing a native bar if a menu is reintroduced.
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

  // FR-107: 未保存確認を通さずに閉じさせない。close は既定で preventDefault し、
  // レンダラのガードが許可した時だけ one-shot で再 close する（close-guard.ts）。
  // リスナはこの window インスタンスに閉じているので、ウィンドウ再作成（activate）や
  // dev リロードで多重登録されない（'closed' で dispose し、保留とタイマーを畳む）。
  const closeGuard = closeGuardHub.attach({
    requestGuard: (requestId) => {
      window.webContents.send(IPC_CHANNEL.CloseRequest, requestId);
    },
    closeWindow: () => {
      window.close();
    },
    quitApp: () => {
      app.quit();
    },
    // **物理的な** 生存だけを見る。「購読者が生きているか（照会に答え得るか）」は
    // ここでは判定しない — それは即時 ACK でやる（close-guard.ts の ADR: 旧
    // rendererLoaded 片方向ラッチは中断ナビゲーションで恒久 false になり fail-OPEN を
    // 生んだ / did-finish-load 後の購読者不在で fail-CLOSED wedge を生んだ）。破棄済み /
    // クラッシュ済みなら照会しても無駄なので即 allow する用途に限る。
    rendererReachable: () =>
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      !window.webContents.isCrashed(),
    // 所見3 event.sender 検証: この window の webContents.id。ハブは要求を送った先の id を
    // 控え、ACK / 判定がこの id から来たものだけ受理する（別 webContents の詐称応答を無視）。
    senderId: () => window.webContents.id,
    // 所見1 HIGH: ACK タイムアウト（レンダラがフリーズ or 購読者不在で ACK が返らない）時に
    // レンダラ不要の **ネイティブ確認ダイアログ** を出す（既定=[キャンセル]=閉じない）。旧実装は
    // ここで黙って閉じ、巨大 checkConsistency 等でフリーズした未保存レンダラをデータ損失させて
    // いた（fail-closed 契約の破れ）。ユーザーが「終了する」を明示選択した時だけ閉じる。
    //   ⚠️ E2E / SMOKE ではモーダルダイアログが Playwright / 自動終了から操作できず、全 spec の
    //   teardown がタイムアウトまで固まる。この環境では即 true（従来の allowWithoutRenderer 相当
    //   = ACK が無ければ閉じる）に倒す。× 経路の close ブリッジ本体は e2e/close-guard.spec.ts で
    //   実測でき、ACK タイムアウト経路（生きた renderer では発火しない）は close-guard.test.ts の
    //   単体テストで状態機械レベルに固定している。
    confirmUnresponsiveClose: async () => {
      if (E2E_TEST || SMOKE_TEST) return true;
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        buttons: ['キャンセル', '終了する'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'アプリが応答していません',
        message: 'アプリが応答していません。',
        detail: '未保存の変更があれば失われる可能性があります。終了しますか？',
      });
      // response は buttons のインデックス（0=キャンセル / 1=終了する）。
      return response === 1;
    },
  });
  window.on('close', (event) => {
    if (closeGuard.onCloseAttempt() === CLOSE_DECISION.Block) {
      event.preventDefault();
    }
  });
  // 照会中に document 破棄が始まったら（ナビゲーション / 再読み込み）、その照会は虚空へ
  // 行く。ガードは中止して idle へ戻す（**自動では閉じない** = 中断ナビゲーションで
  // fail-open しない。所見1 の核心）。照会中でなければ no-op。
  window.webContents.on('did-start-loading', () => {
    closeGuard.noteRendererReloading();
  });
  // 照会中にレンダラが落ちたら、未保存データはプロセスごと失われているので確認を省略して
  // 閉じる（ダイアログのまま window が固まらない）。照会中でなければ no-op（通常操作中の
  // クラッシュで勝手に閉じない）。
  window.webContents.on('render-process-gone', () => {
    closeGuard.noteRendererGone();
  });
  window.on('closed', () => {
    closeGuard.dispose();
  });

  window.on('ready-to-show', () => {
    window.show();
  });

  // Offline-only: load the dev server in development, bundled HTML otherwise.
  // No external URLs are ever loaded.
  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];

  // 開発時のみ DevTools 導線を戻す（既定メニュー撤去で toggleDevTools ロールが消えたため）。
  // 製品ビルド（loadFile 経路）では入らないので、閉鎖はそのまま。判定は app-menu.ts の純粋関数。
  if (devToolsBindingEnabled(devServerUrl)) {
    window.webContents.on('before-input-event', (_event, input) => {
      if (isDevToolsChord(input)) {
        window.webContents.toggleDevTools();
      }
    });
  }

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

/**
 * UC1 round-2: the STAGED load destination (one slot). A successful read stages
 * `{ token, path, senderId }` here instead of promoting {@link currentDocumentPath}; the
 * renderer commits the token at its load commit point to promote it. Uncommitted (e.g.
 * a repair-aborted load) it just lingers until the next load overwrites it and is never
 * read by Save (which reads {@link currentDocumentPath}).
 */
let pendingLoadPathEntry: PendingLoadEntry | undefined;

/**
 * MED (save/load レース): monotonic count of load commits that moved the save target. A
 * save captures it at start and skips its own `currentPath` promotion if it advanced
 * during the write — so a stale save never rolls the destination back onto a file a
 * concurrent load just superseded.
 */
let loadCommitCount = 0;

/**
 * FR-117 診断ログの環境。`wireIpc` が起動時（app ready 後 — `app.getPath` を使うため）
 * に一度だけ設定し、close ガードのログ（{@link logCloseGuard}）も同じ 1 個を読む
 * （単一の真実源: ログ先が 2 つに割れない）。設定前は `undefined` = ファイル出力なし。
 */
let diagnosticLogEnv: DiagnosticLogEnv | undefined;

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

  // UC1 round-2: the staged load-destination holder + per-load token source. The real
  // `randomUUID` makes the commit token unguessable, so only the renderer that received
  // it (via LoadResponse.commitToken) can promote the save target.
  const pendingLoadPath: PendingLoadPathRef = {
    get: () => pendingLoadPathEntry,
    set: (entry) => {
      pendingLoadPathEntry = entry;
    },
  };

  // MED (save/load レース): the load-commit generation counter shared by runSave (captures
  // at start) and handleCommitLoadedPath (bumps on a destructive load commit).
  const loadCommitCounter: LoadCommitCounterRef = {
    get: () => loadCommitCount,
    bump: () => {
      loadCommitCount += 1;
    },
  };

  // FR-117 ROOT FIX (教訓 5.7 合成ルートの結線漏れ): the renderer's DiagnosticLogger
  // sink invokes AppendLog; bind it to the LOCAL file adapter here so warnings the
  // user sees on real hardware are actually persisted to disk (previously the logger
  // was constructed with NO sink, so nothing reached the filesystem). Old generations
  // are pruned once at startup (best-effort — never blocks launch).
  // Set the module-level single source (the close-guard logger reads the SAME env).
  diagnosticLogEnv = buildDiagnosticLogEnv();
  const logEnv = diagnosticLogEnv;
  void pruneDiagnosticLogs(logEnv);

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
    readFile: {
      readFile: (path) => readFile(path),
      // FR-04 pre-read size cap: the file's size without reading it (handleOpenImage
      // stats a picked base-map image and refuses past the 64 MB cap before the read).
      statSize: (path) => stat(path).then((s) => s.size),
    },
    saveEnv: buildSaveEnv(),
    currentPath,
    pendingLoadPath,
    newLoadToken: () => randomUUID(),
    loadCommitCounter,
    applyAutoSaveConfig,
    get maxGenerations(): number {
      return maxGenerations;
    },
    appendDiagnosticLog: (record) => appendDiagnosticLog(logEnv, record),
    // FR-107 close ブリッジ: レンダラの終了確認判定をガードのハブへ渡す（受け口は
    // ここ 1 箇所 = ipcMain.handle の多重登録なし）。payload の検証はハブ側。
    acceptCloseVerdict: (payload, senderId) => {
      closeGuardHub.acceptVerdict(payload, senderId);
    },
    // FR-107 close ブリッジ: レンダラの **受領 ACK** を同じハブへ渡す（購読者不在検出）。
    // senderId（event.sender.id）も渡し、要求元ウィンドウからの応答か検証する（所見3）。
    acceptCloseAck: (payload, senderId) => {
      closeGuardHub.acceptAck(payload, senderId);
    },
  };

  registerIpcHandlers(deps);
}

/**
 * Bind the pure {@link installApplicationMenu} decision to Electron's real `Menu`
 * (開発ガイド §5.41 — the composition root supplies the live collaborators). This MUST
 * run before the first window: while Electron's DEFAULT application menu is installed it
 * owns Ctrl+R / Ctrl+Shift+R (reload — **編集中プロジェクトが吹き飛ぶ**), Ctrl+W (close),
 * Ctrl+0 / Ctrl+± (PAGE zoom — breaks the FR-16 座標対応) and Ctrl+Shift+I, and it eats
 * those chords before the renderer ever sees a keydown (実測: Ctrl+0 never reached the
 * app → D58).
 *
 * ⚠️ 適用範囲 — この単位が塞ぐのは「Ctrl+W という一経路」だけ。× / Alt+F4 / タスクバー
 * / OS シャットダウンの未保存確認は **FR-107 close ブリッジ**（`createWindow` の
 * `window.on('close')` → `closeGuardHub` → レンダラの 3 択ガード → 許可時のみ one-shot
 * 再 close）が担当する。両者は独立: メニュー撤去はキー所有権の話、close ブリッジは
 * ウィンドウ終了の話で、どちらが欠けても別経路が空く。
 */
function wireApplicationMenu(): void {
  const menuApi: ApplicationMenuApi<Menu> = {
    // The template is role-only, so it is structurally a subset of Electron's
    // MenuItemConstructorOptions; the cast is confined to this single binding point.
    buildFromTemplate: (template) =>
      Menu.buildFromTemplate(template as readonly MenuItemConstructorOptions[] as MenuItemConstructorOptions[]),
    setApplicationMenu: (menu) => {
      Menu.setApplicationMenu(menu);
    },
  };
  installApplicationMenu(menuApi, process.platform);
}

// U3: ロックを取れなかった 2つ目のプロセスは whenReady を待たず（ウィンドウを作らず）に
// 終了へ向かう。ここを通るのは 1つ目のプロセス、または共有 userData でロックをスキップした
// E2E/SMOKE だけ（`shouldBootApp === true`）。
if (shouldBootApp) {
  app.whenReady().then(() => {
    // Before any window exists — the default menu must never be live (data-loss root fix).
    wireApplicationMenu();
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
}

// FR-107 close ブリッジ × アプリ終了経路の整合.
//
// `app.quit()`（darwin の Cmd+Q / 明示終了）は before-quit の **後に** 各ウィンドウの
// close を発火する。その close も上のガードを通るので、未保存確認は quit 経路でも
// 迂回されない。ここでは「この close は quit 由来だ」とハブに記録するだけ: 許可された
// ときガードは `window.close()` ではなく `app.quit()` を再発行するので、close を
// preventDefault して中断された quit がそのまま再開する（darwin で window-all-closed
// が quit しない差異も吸収できる）。拒否されたらフラグはハブ側で畳まれる。
//
// ⚠️ E2E ハーネスの脱出口（製品挙動は変えない）: Playwright の `electronApp.close()` は
// main で `app.quit()` を評価して **プロセス終了を待つ**。未保存状態で終わる既存 spec の
// teardown がガードに阻まれると、全 spec がタイムアウトまで固まる（テスト基盤の都合）。
// E2E_TEST の時だけ quit 由来の close を素通しにする。× / Alt+F4 相当（`window.close()`）
// は素通ししないので、close ブリッジ本体は e2e/close-guard.spec.ts で実測できる。
app.on('before-quit', () => {
  if (E2E_TEST) {
    closeGuardHub.forceAllow('E2E teardown (app.quit)');
    return;
  }
  closeGuardHub.noteQuitRequested();
});

app.on('window-all-closed', () => {
  // ここに来るのは close ガードが許可した後だけ（拒否・無応答なら window は生きている）。
  // したがって無条件 quit のままで未保存確認は迂回されない。
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
