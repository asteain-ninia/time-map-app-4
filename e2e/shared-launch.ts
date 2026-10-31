// E2E の起動の使い回し（開発ガイド §1.12）。
//
// `launchApp` はふつう検査ごとに Electron を起動して閉じる。`E2E_LAUNCH_MODE` を指定すると
// 次の動きになる（**既定は今までどおり**）:
//
//   survey  起動し直すのは今までどおり。検査の終わりに本体の状態の控えを取り、起動直後との
//           差を記録するだけ（「検査ごとの残すもの」の表を作る）。
//   shared  検査の終わりに控えを取り、起動直後と同じならアプリを閉じず、次の検査の開始時に
//           画面を再読み込みして渡す。違えばその場で閉じて起動し直す。
//
// **見張りが毎回の真実**であり、残すものの表には頼らない。控えに入っていない状態は
// 見逃すので、入れた項目と入れていない項目は `docs/開発ガイド.md` §1.12 に一覧してある。
//
// 起動し直す条件:
//   - 控えが起動直後と違う／控えを取れなかった
//   - 検査が失敗した（Playwright が worker ごと捨てるので、アプリも一緒に消える）
//   - 起動の引数や、子プロセスへ渡す環境変数が前と違う（`E2E_SAVE_AS_PATH` は起動時にしか
//     読まれない。`extraEnv` だけでなく、親から受け継ぐ分も比べる）
//   - 同じ検査の中で 2 回目の launchApp を呼んだ（閉じて開き直す検査）
//   - 検査に `FRESH_LAUNCH` の印がある（起動や終了そのものを確かめる検査）
//   - 前の検査が app.close() を呼ばずに終わった
//
// 同じ userData で本体を 2 つ動かさない（画面の保存領域を掴まれて、次の検査の控えが取れずに
// 赤くなる）。閉じ忘れた本体も、閉じるのに失敗した本体も、**止めてから**次を起動し、事実を記録へ
// 書く（`not-closed`、`close-failed`）。無関係な次の検査は赤にせず、`scripts/e2e-shared.mjs` が
// 終わりの集計で赤にする。

import { spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from '@playwright/test';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';

/**
 * 起動や終了そのものを確かめる検査に付ける印。
 *
 *     test.describe('…', { annotation: FRESH_LAUNCH }, () => { … });
 *
 * 印のない検査は見張りに任せる。
 */
export const FRESH_LAUNCH = {
  type: 'fresh-launch',
  description: '起動や終了そのものを確かめるので、毎回起動し直す',
} as const;

export type LaunchMode = 'fresh' | 'survey' | 'shared';

export function launchMode(): LaunchMode {
  const raw = process.env['E2E_LAUNCH_MODE'];
  return raw === 'survey' || raw === 'shared' ? raw : 'fresh';
}

// ---------------------------------------------------------------------------
// 控え（本体の状態を平らな「項目 → 文字列」にしたもの）
// ---------------------------------------------------------------------------

export type StateSnapshot = Readonly<Record<string, string>>;

/** `src/shell/main/e2e-main-probe.ts` の `E2E_MAIN_PROBE_KEY`。ここは Electron を読まない。 */
const PROBE_KEY = '__E2E_MAIN_PROBE__';

/**
 * userData の中で比べないもの。多くは **Chromium が自分で書くもの**で、起動中ずっと動く。
 * Web の保存領域（localStorage など）は、ファイルでなく画面の側から読んで比べる。
 */
const CHROMIUM_OWNED = new Set([
  'blob_storage',
  'Cache',
  'Code Cache',
  'Cookies',
  'Cookies-journal',
  'Crashpad',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Dictionaries',
  'DIPS',
  'DIPS-journal',
  'GPUCache',
  'GrShaderCache',
  'IndexedDB',
  'Local State',
  'Local Storage',
  'lockfile',
  'Network',
  'Network Persistent State',
  'Preferences',
  'Session Storage',
  'Shared Dictionary',
  'shared_proto_db',
  'SharedStorage',
  'ShaderCache',
  'TransportSecurity',
  'Trust Tokens',
  'Trust Tokens-journal',
  'VideoDecodeStats',
  'WebStorage',
  // 診断ログ。起動のたびと再読み込みのたびに 1 行増え、起動し直しても消えない（ワーカーごとに
  // 同じ userData を使い続ける）。アプリは書くだけで読まないので、残っても次の検査に効かない。
  'logs',
]);

function userDataEntries(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (current === dir && CHROMIUM_OWNED.has(entry.name)) continue;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const key = `userData:${relative(dir, full).replaceAll('\\', '/')}`;
      try {
        const bytes = readFileSync(full);
        out[key] = `${String(statSync(full).size)}:${createHash('sha1').update(bytes).digest('hex').slice(0, 12)}`;
      } catch (error) {
        out[key] = `読めない: ${String(error)}`;
      }
    }
  };
  walk(dir);
  return out;
}

/** main プロセスで評価する読み取り。外の変数は使えない（関数の文字列が送られる）。 */
async function readMainState(app: ElectronApplication, probeKey: string): Promise<Record<string, unknown>> {
  return app.evaluate(
    async ({ app: electronApp, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, session, shell }, key) => {
      const hash = (text: string): string => {
        let h = 5381;
        for (let i = 0; i < text.length; i += 1) h = (Math.imul(h, 33) ^ text.charCodeAt(i)) >>> 0;
        return `${String(text.length)}:${h.toString(36)}`;
      };
      const functionsOf = (target: object): Record<string, string> => {
        const out: Record<string, string> = {};
        for (const name of Object.keys(target).sort()) {
          const value = (target as Record<string, unknown>)[name];
          out[name] = typeof value === 'function' ? hash(String(value)) : typeof value;
        }
        return out;
      };
      const emitterCounts = (emitter: NodeJS.EventEmitter): Record<string, number> => {
        const out: Record<string, number> = {};
        for (const name of emitter.eventNames().map(String).sort()) out[name] = emitter.listenerCount(name);
        return out;
      };
      const flattenMenu = (menu: Electron.Menu | null): unknown =>
        menu === null
          ? null
          : menu.items.map((item) => ({
              role: item.role ?? null,
              label: item.label,
              accelerator: item.accelerator ?? null,
              enabled: item.enabled,
              visible: item.visible,
              checked: item.checked,
              sub: flattenMenu(item.submenu ?? null),
            }));
      const invokeHandlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, unknown> })._invokeHandlers;
      const probe = (globalThis as unknown as Record<string, { read: () => unknown } | undefined>)[key];
      const windows = BrowserWindow.getAllWindows().map((win) => {
        const wc = win.webContents;
        return {
          bounds: win.getBounds(),
          contentSize: win.getContentSize(),
          minimumSize: win.getMinimumSize(),
          maximumSize: win.getMaximumSize(),
          visible: win.isVisible(),
          focused: win.isFocused(),
          minimized: win.isMinimized(),
          maximized: win.isMaximized(),
          fullScreen: win.isFullScreen(),
          menuBarVisible: win.isMenuBarVisible(),
          menuBarAutoHide: win.isMenuBarAutoHide(),
          alwaysOnTop: win.isAlwaysOnTop(),
          resizable: win.isResizable(),
          closable: win.isClosable(),
          windowListeners: emitterCounts(win),
          contents: {
            url: wc.getURL(),
            loading: wc.isLoading(),
            crashed: wc.isCrashed(),
            zoomFactor: wc.getZoomFactor(),
            zoomLevel: wc.getZoomLevel(),
            devTools: wc.isDevToolsOpened(),
            audioMuted: wc.isAudioMuted(),
            backgroundThrottling: wc.getBackgroundThrottling(),
            frameRate: wc.getFrameRate(),
            historyLength: wc.navigationHistory.length(),
            listeners: emitterCounts(wc),
          },
        };
      });
      const cookies = await session.defaultSession.cookies.get({});
      return {
        probe: probe === undefined ? '読み口が無い' : probe.read(),
        windowCount: BrowserWindow.getAllWindows().length,
        windows,
        menu: flattenMenu(Menu.getApplicationMenu()),
        dialogFunctions: functionsOf(dialog),
        shellFunctions: functionsOf(shell),
        ipcInvokeChannels: invokeHandlers === undefined ? null : [...invokeHandlers.keys()].sort(),
        ipcInvokeHandlers:
          invokeHandlers === undefined
            ? null
            : [...invokeHandlers.entries()].map(([name, fn]) => `${name}=${hash(String(fn))}`).sort(),
        ipcListeners: emitterCounts(ipcMain),
        appListeners: emitterCounts(electronApp),
        processEnv: hash(JSON.stringify(Object.entries(process.env).sort())),
        processArgv: process.argv.join(' '),
        processCwd: process.cwd(),
        mainGlobals: Object.getOwnPropertyNames(globalThis).sort().join(','),
        appName: electronApp.getName(),
        userDataPath: electronApp.getPath('userData'),
        themeSource: nativeTheme.themeSource,
        cookieCount: cookies.length,
        sessionUserAgent: session.defaultSession.getUserAgent(),
      };
    },
    probeKey,
  );
}

async function readRendererState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async () => {
    const entriesOf = (store: Storage): string[] => {
      const out: string[] = [];
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key !== null) out.push(`${key}=${store.getItem(key) ?? ''}`);
      }
      return out.sort();
    };
    const registrations = await navigator.serviceWorker?.getRegistrations?.().catch(() => []);
    return {
      localStorage: entriesOf(localStorage),
      sessionStorage: entriesOf(sessionStorage),
      cookie: document.cookie,
      indexedDb: (await indexedDB.databases()).map((db) => db.name ?? '').sort(),
      cacheStorage: (await caches.keys()).sort(),
      serviceWorkers: registrations?.length ?? 0,
      historyLength: history.length,
      viewport: `${String(innerWidth)}x${String(innerHeight)}`,
      devicePixelRatio,
    };
  });
}

/**
 * 葉の値を文字列にする。**文字列だけ引用符で囲む**ので、null と文字列 "null"、1 と "1"、
 * 空の配列の印 `[]` と文字列 "[]" が同じにならない。
 */
function encodeLeaf(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** 平らにする。`windows.0.bounds.x` のような項目名で差が読めるように。 */
function flatten(prefix: string, value: unknown, out: Record<string, string>): void {
  if (value !== null && typeof value === 'object') {
    const entries = Array.isArray(value)
      ? value.map((item, index) => [String(index), item] as const)
      : Object.entries(value);
    if (entries.length === 0) out[prefix] = Array.isArray(value) ? '[]' : '{}';
    for (const [key, item] of entries) flatten(`${prefix}.${key}`, item, out);
    return;
  }
  out[prefix] = encodeLeaf(value);
}

/** Playwright の側に残る状態を見張るための控え（検査が呼んだかどうかを印で覚える）。 */
interface DriverState {
  /** 検査が呼んだ、画面の再読み込みを生き延びる API の名前。 */
  readonly stickyCalls: Set<string>;
  /** 押したまま離していないキーとマウスのボタン。 */
  readonly pressed: Set<string>;
}

async function takeSnapshot(
  app: ElectronApplication,
  page: Page,
  driver: DriverState,
  userDataDir: string,
): Promise<StateSnapshot> {
  const out: Record<string, string> = {};
  flatten('main', await readMainState(app, PROBE_KEY), out);
  flatten('renderer', await readRendererState(page), out);
  flatten(
    'driver',
    {
      viewportSize: page.viewportSize(),
      pageClosed: page.isClosed(),
      windows: app.windows().length,
      contextPages: app.context().pages().length,
      stickyCalls: [...driver.stickyCalls].sort(),
      pressed: [...driver.pressed].sort(),
    },
    out,
  );
  Object.assign(out, userDataEntries(userDataDir));
  return out;
}

export function diffSnapshots(before: StateSnapshot, after: StateSnapshot): Record<string, [string, string]> {
  const out: Record<string, [string, string]> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[key] ?? '(無し)';
    const b = after[key] ?? '(無し)';
    if (a !== b) out[key] = [a.slice(0, 200), b.slice(0, 200)];
  }
  return out;
}

// ---------------------------------------------------------------------------
// 記録
// ---------------------------------------------------------------------------

const LOG_PATH = process.env['E2E_LAUNCH_LOG'] ?? join(process.cwd(), 'test-results', 'shared-launch-log.jsonl');

/** 同じ記録の置き場に前の実行の分が残っていても、集計が取り違えないための印。 */
const RUN_ID = process.env['E2E_LAUNCH_RUN'] ?? null;

function log(record: Record<string, unknown>): void {
  if (launchMode() === 'fresh') return;
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `${JSON.stringify({ run: RUN_ID, ...record })}\n`);
  } catch {
    // 記録の失敗で検査を落とさない。
  }
}

function currentTest(): TestInfo | null {
  try {
    return test.info();
  } catch {
    return null;
  }
}

function testLabel(info: TestInfo | null): string {
  return info === null ? '(検査の外)' : info.titlePath.join(' › ');
}

function testKey(info: TestInfo | null): string {
  return info === null ? '' : `${info.testId}#${String(info.retry)}`;
}

// ---------------------------------------------------------------------------
// 使い回し
// ---------------------------------------------------------------------------

export interface LaunchedPair {
  readonly app: ElectronApplication;
  readonly page: Page;
}

export interface LaunchPorts {
  /** Electron を起動して、殻が載るまで待つ（初回ガイドは畳まない）。 */
  readonly start: () => Promise<LaunchedPair>;
  /** 殻が載るのを待つ（再読み込みのあと）。 */
  readonly waitForShell: (page: Page) => Promise<void>;
  /** 初回ガイドの扱い（`keepFirstRunGuide` を見て畳む）。 */
  readonly settleFirstRun: (page: Page) => Promise<void>;
  readonly userDataDir: string;
  /** 起動の条件の違いを見分ける文字列（{@link launchKeyOf}）。 */
  readonly launchKey: string;
}

/**
 * 起動の条件を見分ける文字列。**子プロセスへ実際に渡す環境変数の全部**で作る。`extraEnv` だけだと、
 * 親の `process.env` を変えて起動する検査に、前の値で起動した本体が渡ってしまう。
 */
export function launchKeyOf(extraArgs: readonly string[], childEnv: Readonly<Record<string, string>>): string {
  const entries = Object.entries(childEnv).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([extraArgs, entries]);
}

interface Slot {
  readonly app: ElectronApplication;
  readonly page: Page;
  /** 起動の時点で取っておく。ワーカーの終わりには `app.process()` がもう読めない。 */
  readonly proc: ChildProcess;
  readonly realClose: () => Promise<void>;
  readonly driver: DriverState;
  readonly launchKey: string;
  readonly listenerBaseline: Map<object, Map<string, readonly unknown[]>>;
  readonly noReuse: boolean;
  baseline: StateSnapshot;
  /** いま使っている検査（返却済みなら null）。 */
  ownerKey: string | null;
  /** 最後に使った検査。 */
  lastOwnerKey: string;
  /** 最後に使った検査の情報（閉じ忘れの記録と、その検査が失敗したかどうかの判定に使う）。 */
  lastOwnerInfo: TestInfo | null;
  uses: number;
  closed: boolean;
  /**
   * 使っている検査の最中にプロセスが終わった（検査が自分で止めた）。検査が終わったあとに
   * 終わった分（ワーカーの終わりに Playwright が止めた）は false のままで、閉じ忘れと数える。
   */
  exitedDuringOwner: boolean;
}

/** このワーカーが抱えている、次へ渡せるアプリ。 */
let held: Slot | null = null;

/** このワーカーで動いている本体の全部（検査が使っている最中のものも、返却済みのものも）。 */
const live = new Set<Slot>();

function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

/** その検査が失敗したか。失敗で途中で抜けた検査の `app.close()` は、呼ばれなくて当然である。 */
function ownerFailed(info: TestInfo | null): boolean {
  if (info === null) return false;
  return info.errors.length > 0 || (info.status !== 'passed' && info.status !== 'skipped' && info.status !== undefined);
}

/**
 * ワーカーの終わりに、残っている本体を止める。Playwright も止めるが、その前に helpers.ts の
 * 後始末が userData を消しに行くと、掴まれていて消せずに一時フォルダが残る。この登録は
 * helpers.ts より先に走る（このファイルを先に読み込むので）。
 *
 * 最後の検査の閉じ忘れは次の起動で見つけられないので、ここで記録する。ここへ来る前に Playwright が
 * 本体を止めていることが多いので、動いているかどうかでは判定しない。失敗した検査の分は集計で
 * 数えない（検査はすでに赤で、やり直しで緑になった実行を赤に変えてしまう）。
 */
export function stopAllAtExit(): void {
  for (const slot of live) {
    try {
      if (slot.ownerKey !== null && !slot.exitedDuringOwner) {
        log({
          ev: 'not-closed',
          test: testLabel(slot.lastOwnerInfo),
          nextTest: null,
          ownerFailed: ownerFailed(slot.lastOwnerInfo),
          worker: slot.lastOwnerInfo?.workerIndex ?? null,
        });
      }
      if (!hasExited(slot.proc)) slot.proc.kill();
    } catch {
      // すでに終わっている。後始末の失敗はテスト結果に影響させない。
    }
  }
}

process.on('exit', stopAllAtExit);

/** 再読み込みを生き延びる API を呼んだら印を付ける。 */
function watchStickyCalls(target: object, label: string, names: readonly string[], driver: DriverState): void {
  const record = target as Record<string, unknown>;
  for (const name of names) {
    const original = record[name];
    if (typeof original !== 'function') continue;
    record[name] = function patched(this: unknown, ...args: unknown[]): unknown {
      driver.stickyCalls.add(`${label}.${name}`);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
}

/** 押しっぱなしを覚える。`page.keyboard` と `page.mouse` は同じ物が続くので検査をまたいで残る。 */
function watchPressed(page: Page, driver: DriverState): void {
  const wrap = (target: object, down: string, up: string, nameOf: (args: unknown[]) => string): void => {
    const record = target as Record<string, unknown>;
    const originalDown = record[down] as (...a: unknown[]) => unknown;
    const originalUp = record[up] as (...a: unknown[]) => unknown;
    record[down] = function patchedDown(this: unknown, ...args: unknown[]): unknown {
      driver.pressed.add(nameOf(args));
      return originalDown.apply(this, args);
    };
    record[up] = function patchedUp(this: unknown, ...args: unknown[]): unknown {
      driver.pressed.delete(nameOf(args));
      return originalUp.apply(this, args);
    };
  };
  wrap(page.keyboard, 'down', 'up', (args) => `key:${String(args[0])}`);
  wrap(page.mouse, 'down', 'up', (args) => {
    const options = args[0] as { button?: string } | undefined;
    return `mouse:${options?.button ?? 'left'}`;
  });
}

interface ListenerHost {
  eventNames: () => (string | symbol)[];
  listeners: (event: string) => unknown[];
  removeListener: (event: string, listener: never) => unknown;
}

function listenerSnapshot(targets: readonly object[]): Map<object, Map<string, readonly unknown[]>> {
  const out = new Map<object, Map<string, readonly unknown[]>>();
  for (const target of targets) {
    const host = target as ListenerHost;
    const map = new Map<string, readonly unknown[]>();
    for (const name of host.eventNames()) map.set(String(name), [...host.listeners(String(name))]);
    out.set(target, map);
  }
  return out;
}

/** 検査が `page.on(...)` で足した受け手を外す（次の検査のダイアログなどへ答えないように）。 */
function stripListeners(baseline: Map<object, Map<string, readonly unknown[]>>): string[] {
  const removed: string[] = [];
  for (const [target, known] of baseline) {
    const host = target as ListenerHost;
    for (const rawName of host.eventNames()) {
      const name = String(rawName);
      const keep = known.get(name) ?? [];
      for (const listener of host.listeners(name)) {
        if (keep.includes(listener)) continue;
        host.removeListener(name, listener as never);
        removed.push(name);
      }
    }
  }
  return removed;
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what}: ${String(ms)}ms で終わらなかった`));
    }, ms);
  });
  return Promise.race([work, limit]).finally(() => {
    clearTimeout(timer);
  });
}

/** 本物の `close` を待つ上限。実データを開いた本体でも、ふつうは数秒で終わる。 */
const CLOSE_LIMIT_MS = 20_000;
/** `close` のあと、または強制終了のあとに、プロセスの終わりを待つ上限。 */
const EXIT_LIMIT_MS = 10_000;

function waitForExit(proc: ChildProcess, ms: number): Promise<boolean> {
  if (hasExited(proc)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      proc.off('exit', onExit);
      resolve(false);
    }, ms);
    proc.once('exit', onExit);
  });
}

/** 子のプロセスごと止める。Windows では本体だけ止めると木をたどれなくなるので、先に木ごと止める。 */
function forceKill(proc: ChildProcess): void {
  if (process.platform === 'win32' && proc.pid !== undefined) {
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
  if (!hasExited(proc)) proc.kill('SIGKILL');
}

/**
 * 本体を確実に止める。本物の `close` が失敗しても、返ってこなくても、プロセスが残っても、
 * 強制的に止めて `close-failed` を記録する。`close` の失敗の文面を返す（無ければ null）。
 *
 * **強制しても止められなければ例外を投げる。** 同じ userData で次を起動すると、前の本体が掴んだ
 * 保存領域のせいで別の赤になり、原因が読めなくなる。投げれば Playwright がワーカーごと捨てて、
 * 次のワーカーは別の userData で始まる。
 */
async function stopSlot(slot: Slot, requestedBy: TestInfo | null): Promise<string | null> {
  if (slot.closed) return null;
  const { proc } = slot;
  let error: string | null = null;
  if (!hasExited(proc)) {
    try {
      await withTimeout(slot.realClose(), CLOSE_LIMIT_MS, '本体の終了');
    } catch (cause) {
      error = String(cause);
    }
  }
  let exited = await waitForExit(proc, EXIT_LIMIT_MS);
  const forced = !exited;
  if (forced) {
    forceKill(proc);
    exited = await waitForExit(proc, EXIT_LIMIT_MS);
  }
  if (error !== null || forced) {
    log({
      ev: 'close-failed',
      test: testLabel(requestedBy),
      owner: testLabel(slot.lastOwnerInfo),
      error,
      forced,
      exited,
      worker: requestedBy?.workerIndex ?? null,
    });
  }
  if (!exited) {
    throw new Error(
      `[起動の使い回し] 前の本体（PID ${String(proc.pid)}）を止められなかったので、同じ userData で次を起動しない`,
    );
  }
  slot.closed = true;
  live.delete(slot);
  if (held === slot) held = null;
  return error;
}

/**
 * 前の検査が閉じずに終わった本体を止める。止めたら true（次は起動し直す）。
 * 同じ検査がまだ使っているものには触らない。検査が自分で止めた本体は閉じ忘れと数えない。
 */
async function stopForgotten(key: string, info: TestInfo | null): Promise<boolean> {
  let found = false;
  for (const slot of [...live]) {
    if (slot.ownerKey === null || slot.ownerKey === key) continue;
    found = true;
    if (!hasExited(slot.proc)) {
      log({
        ev: 'not-closed',
        test: testLabel(slot.lastOwnerInfo),
        nextTest: testLabel(info),
        ownerFailed: ownerFailed(slot.lastOwnerInfo),
        worker: info?.workerIndex ?? null,
      });
    }
    await stopSlot(slot, info);
  }
  return found;
}

async function startSlot(ports: LaunchPorts, noReuse: boolean, info: TestInfo | null): Promise<Slot> {
  const { app, page } = await ports.start();
  const realClose = app.close.bind(app);
  const driver: DriverState = { stickyCalls: new Set(), pressed: new Set() };
  await ports.settleFirstRun(page);
  const slot: Slot = {
    app,
    page,
    proc: app.process(),
    realClose,
    driver,
    launchKey: ports.launchKey,
    listenerBaseline: listenerSnapshot([page, app, app.context()]),
    noReuse,
    baseline: {},
    ownerKey: testKey(info),
    lastOwnerKey: testKey(info),
    lastOwnerInfo: info,
    uses: 1,
    closed: false,
    exitedDuringOwner: false,
  };
  live.add(slot);
  slot.proc.once('exit', () => {
    // `duration` は検査が終わるまで 0 のまま。
    slot.exitedDuringOwner = slot.ownerKey !== null && slot.lastOwnerInfo?.duration === 0;
  });
  slot.baseline = await takeSnapshot(app, page, driver, ports.userDataDir);
  // 印を付けるのは控えを取ったあと。ここまでは launchApp 自身の操作である。
  const context = app.context();
  watchStickyCalls(
    page,
    'page',
    [
      'addInitScript',
      'exposeBinding',
      'exposeFunction',
      'route',
      'routeFromHAR',
      'routeWebSocket',
      'setDefaultNavigationTimeout',
      'setDefaultTimeout',
      'setExtraHTTPHeaders',
      'emulateMedia',
      'pause',
    ],
    driver,
  );
  watchStickyCalls(
    context,
    'context',
    [
      'addCookies',
      'addInitScript',
      'exposeBinding',
      'exposeFunction',
      'grantPermissions',
      'route',
      'routeFromHAR',
      'routeWebSocket',
      'setDefaultNavigationTimeout',
      'setDefaultTimeout',
      'setExtraHTTPHeaders',
      'setGeolocation',
      'setHTTPCredentials',
      'setOffline',
    ],
    driver,
  );
  watchStickyCalls(context.clock, 'clock', ['install', 'fastForward', 'pauseAt', 'runFor', 'setFixedTime', 'setSystemTime'], driver);
  watchStickyCalls(context.tracing, 'tracing', ['startChunk', 'group'], driver);
  watchPressed(page, driver);
  return slot;
}

/** 検査の `app.close()` の中身。 */
async function checkIn(slot: Slot, ports: LaunchPorts): Promise<void> {
  if (slot.closed || slot.ownerKey === null) return;
  const info = currentTest();
  const mode = launchMode();
  const started = Date.now();
  slot.ownerKey = null;
  const removedListeners = stripListeners(slot.listenerBaseline);
  let left: Record<string, [string, string]> = {};
  let failure: string | null = null;
  try {
    const after = await withTimeout(
      takeSnapshot(slot.app, slot.page, slot.driver, ports.userDataDir),
      10_000,
      '終わりの控え',
    );
    left = diffSnapshots(slot.baseline, after);
  } catch (error) {
    failure = String(error);
  }
  const testFailed = info !== null && info.errors.length > 0;
  log({
    ev: 'checkin',
    mode,
    test: testLabel(info),
    file: info?.file ?? null,
    worker: info?.workerIndex ?? null,
    uses: slot.uses,
    left,
    failure,
    testFailed,
    removedListeners,
    ms: Date.now() - started,
  });
  const leftKeys = Object.keys(left);
  const keep =
    mode === 'shared' && !slot.noReuse && failure === null && !testFailed && leftKeys.length === 0;
  if (keep) {
    held = slot;
    return;
  }
  if (held === slot) held = null;
  if (mode === 'shared' && leftKeys.length > 0) {
    console.log(`[起動の使い回し] 起動し直す: ${testLabel(info)} が残した: ${leftKeys.slice(0, 6).join(', ')}`);
  }
  const closeError = await stopSlot(slot, info);
  // 検査自身の `app.close()` なので、失敗は今までどおりその検査へ返す。
  if (closeError !== null) throw new Error(closeError);
}

function hookClose(slot: Slot, ports: LaunchPorts): void {
  (slot.app as unknown as { close: () => Promise<void> }).close = (): Promise<void> => checkIn(slot, ports);
}

/** 抱えているアプリを、次の検査へ渡せる状態にする。駄目なら理由を返す。 */
async function tryReuse(slot: Slot, ports: LaunchPorts, info: TestInfo | null): Promise<string | null> {
  const { app, page } = slot;
  try {
    // 自動保存のタイマーは本体の中で動き続けるので、起動し直したときと同じ位相へ戻す。
    await app.evaluate((_electron, key) => {
      (globalThis as unknown as Record<string, { rearmAutoSaveTimer: () => void }>)[key]?.rearmAutoSaveTimer();
    }, PROBE_KEY);
    // マウスの位置は再読み込みを生き延びる。起動直後の (0, 0) へ戻す。
    await page.mouse.move(0, 0);
    await page.reload({ waitUntil: 'load' });
    await ports.waitForShell(page);
    await ports.settleFirstRun(page);
    const after = await takeSnapshot(app, page, slot.driver, ports.userDataDir);
    const left = diffSnapshots(slot.baseline, after);
    const keys = Object.keys(left);
    if (keys.length > 0) {
      // 終わりの控えのあとに書き込まれたもの（遅れて届いた保存やログ）。
      log({ ev: 'late-left', test: testLabel(info), left });
      return `再読み込みのあとの控えが違う: ${keys.slice(0, 6).join(', ')}`;
    }
    return null;
  } catch (error) {
    return `再読み込みに失敗: ${String(error)}`;
  }
}

export async function launchShared(ports: LaunchPorts): Promise<LaunchedPair> {
  const mode = launchMode();
  const info = currentTest();
  const started = Date.now();
  const fresh = info?.annotations.some((a) => a.type === FRESH_LAUNCH.type) === true;
  const key = testKey(info);

  // 先に、閉じ忘れの本体を止める（`held` が空くこともある）。
  const forgotten = await stopForgotten(key, info);

  let reason: string | null = null;
  const previous = held;
  if (mode !== 'shared') {
    reason = '使い回さない形';
  } else if (fresh) {
    reason = '起動を確かめる印がある';
  } else if (previous === null) {
    reason = 'このワーカーで最初／前が起動し直しになった';
  } else if (previous.lastOwnerKey === key) {
    reason = '同じ検査の 2 回目の起動';
  } else if (previous.launchKey !== ports.launchKey) {
    reason = '起動の引数か環境変数が前と違う';
  }
  if (forgotten) reason = '前の検査が閉じずに終わった';

  if (reason === null && previous !== null) {
    previous.ownerKey = key;
    previous.lastOwnerKey = key;
    previous.lastOwnerInfo = info;
    previous.uses += 1;
    const refused = await tryReuse(previous, ports, info);
    if (refused === null) {
      log({
        ev: 'launch',
        kind: 'reused',
        test: testLabel(info),
        file: info?.file ?? null,
        worker: info?.workerIndex ?? null,
        uses: previous.uses,
        ms: Date.now() - started,
      });
      return { app: previous.app, page: previous.page };
    }
    reason = refused;
  }

  // 抱えていたものは閉じる（同じ検査がまだ使っているものには触らない）。
  if (held !== null && (held.ownerKey === null || (previous === held && reason?.startsWith('再読み込み') === true))) {
    // 終了の失敗は stopSlot が止めて記録する。ここでは次の起動へ進む。
    await stopSlot(held, info);
  }

  const slot = await startSlot(ports, mode !== 'shared' || fresh, info);
  hookClose(slot, ports);
  log({
    ev: 'launch',
    kind: 'fresh',
    reason,
    test: testLabel(info),
    file: info?.file ?? null,
    worker: info?.workerIndex ?? null,
    ms: Date.now() - started,
  });
  return { app: slot.app, page: slot.page };
}
