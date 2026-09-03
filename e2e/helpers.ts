// U43 — shared E2E helper: launch the BUILT Electron app headless and return the
// app handle + the renderer page. Every spec uses this so the launch contract
// (offscreen, E2E_TEST=1, sandbox kept on) lives in one place (単一の真実源).
//
// 2026-09-03 (UI 再設計の下準備 P-1): 「モードに入る → 面ツール → 頂点を打つ → 完了 →
// 保存」の手順もここへ一本化した。追加ツールの導線を作り直したとき、直す場所が
// spec 28 本 → このファイル 1 箇所になる。spec 側は「どこに・どんな形を描くか」
// (座標・頂点数・上位領域・名前) だけを渡す。
//
// モード切替の前提 (src/ui/shell/useShell.ts): mode-view は View↔Edit を切り替え、
// mode-add / mode-edit は **同じモードを再選択すると View へ戻る** (toggleMode)。
// したがってここの関数はすべて冪等 (既に押されていれば押さない) に書いてある。

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { expect } from '@playwright/test';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 隔離した userData ディレクトリ (ワーカープロセスごとに 1 つ)。
 *
 * WHY: Playwright の `_electron.launch` は `--user-data-dir` を渡さないので、放っておくと
 * E2E は **利用者が実際に使っているアプリと同じ userData** を使う。実害は 2 つあった:
 *   1. 実データ汚染 — 設定・診断ログ (FR-117 は userData/logs へ書く)・キャッシュを、
 *      130 本のテストが本番の置き場所に書き込む。
 *   2. 起動時エラー — テスト中に利用者がアプリを起動すると GPU シェーダーキャッシュの
 *      フォルダを奪い合い、`Unable to move the cache: アクセスが拒否されました (0x5)` /
 *      `Gpu Cache Creation failed` が出る (機能影響はないが実機報告として上がった)。
 *
 * ワーカー**プロセスごと**に 1 つにするのは、同一ワーカー内で再起動するテスト
 * (保存 → 再起動 → 読込 のような持続性の検証) が userData を跨いで壊れないようにするため。
 * ワーカー間は別ディレクトリなので並列実行でも衝突しない。プロセス終了時に破棄する。
 */
const userDataDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-userdata-'));
process.on('exit', () => {
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    // 後始末の失敗はテスト結果に影響させない (一時ディレクトリは OS が回収する)。
  }
});

export interface LaunchedApp {
  readonly app: ElectronApplication;
  readonly page: Page;
}

/**
 * Launch the built app (out/main/index.cjs via package `main`) under Playwright's
 * Electron driver. The window renders offscreen (E2E_TEST=1) so this runs with no
 * display. GPU/sandbox launch flags match the smoke runner so the headless CI box
 * boots deterministically. Returns once the renderer's first window is available.
 */
/** {@link launchApp} の追加指定（既定は何も足さない）。 */
export interface LaunchOptions {
  /**
   * Electron へ追加で渡す起動引数。表示倍率を変えた検査
   * （`--force-device-scale-factor=1.25`）のように、**起動時にしか効かない条件**を
   * 試すために開けてある。既定の起動は 1 つも足さない。
   */
  readonly extraArgs?: readonly string[];
}

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  // Build the child env from the current one, then DELETE the run-as-node leak.
  // Electron treats ELECTRON_RUN_AS_NODE as set even when empty (""), which makes
  // `require('electron')` in main return a path string instead of the app — and
  // Playwright's `--remote-debugging-port` then errors with "bad option". Removing
  // the key entirely (not blanking it) is the only correct fix.
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) childEnv[key] = value;
  }
  delete childEnv['ELECTRON_RUN_AS_NODE'];
  childEnv['E2E_TEST'] = '1';

  const app = await electron.launch({
    args: [
      '.',
      // 利用者の実 userData を汚さず、同時起動ともキャッシュを奪い合わない (上の注記)。
      `--user-data-dir=${userDataDir}`,
      '--disable-gpu',
      '--no-sandbox',
      '--disable-software-rasterizer',
      ...(options.extraArgs ?? []),
    ],
    cwd: projectRoot,
    env: childEnv,
  });
  const page = await app.firstWindow();
  // Wait until the renderer bundle has executed and React mounted the shell.
  //
  // COLD-LAUNCH BUDGET: the FIRST Electron launch in a batch pays the cold-start
  // cost (electron-vite build artifacts loaded, V8 warm-up, renderer bundle parse),
  // which on a loaded/headless CI box can exceed the 30s DEFAULT waitForSelector
  // timeout and flake the whole gate. We give this wait an EXPLICIT budget sized to
  // the per-test cap (playwright.config.ts timeout: 60_000) minus launch overhead,
  // so the shell-mount wait — not an undersized default — is what governs (and a
  // genuinely stuck launch still fails fast via the per-test timeout). Paired with
  // retries:1 in the config so a single cold-start outlier cannot redden the gate.
  await page.waitForSelector('[data-testid="app-shell"]', {
    state: 'attached',
    timeout: 45_000,
  });
  return { app, page };
}

// ---------------------------------------------------------------------------
// モード切替 (すべて冪等)
// ---------------------------------------------------------------------------

/**
 * 表示専用 (View) を抜ける。View なら mode-view を押す (useShell.setViewOnly(false) は
 * 編集モードに着地する)。View でなければ何もしない。
 */
export async function leaveViewMode(page: Page): Promise<void> {
  const viewToggle = page.getByTestId('mode-view');
  await expect(viewToggle).toBeVisible();
  if ((await viewToggle.getAttribute('aria-pressed')) === 'true') {
    await viewToggle.click();
  }
}

/**
 * 追加モードに入る。View を抜けてから mode-add を押す。既に追加モードなら押さない
 * (再選択は View へ戻ってしまう)。This is the SAME live導線 the regression suite drives
 * (no overlay bypass).
 */
export async function enterAddMode(page: Page): Promise<void> {
  const addMode = page.getByTestId('mode-add');
  if ((await addMode.getAttribute('aria-pressed')) === 'true') return;
  await leaveViewMode(page);
  if ((await addMode.getAttribute('aria-pressed')) !== 'true') {
    await expect(addMode).toBeEnabled();
    await addMode.click();
  }
  await expect(addMode).toHaveAttribute('aria-pressed', 'true');
}

/**
 * 編集モードに入る。View を抜けると既定で編集モードに着地するので、着地していなければ
 * mode-edit を押す。既に編集モードなら押さない (再選択は View へ戻ってしまう)。
 */
export async function enterEditMode(page: Page): Promise<void> {
  const editMode = page.getByTestId('mode-edit');
  if ((await editMode.getAttribute('aria-pressed')) === 'true') return;
  await leaveViewMode(page);
  if ((await editMode.getAttribute('aria-pressed')) !== 'true') {
    await expect(editMode).toBeEnabled();
    await editMode.click();
  }
  await expect(editMode).toHaveAttribute('aria-pressed', 'true');
}

/**
 * 表示専用 (View) へ戻る。追加/ナイフの入力層 (地図セル全面の透明な層) が外れるのを
 * best-effort で待つ — 残っていると以後のタイムライン・ツールバーのクリックを奪う。
 * 待ちきれなくても失敗にはしない (探索用の spec は独自に記録する)。
 */
export async function returnToViewMode(page: Page): Promise<void> {
  const viewToggle = page.getByTestId('mode-view');
  if ((await viewToggle.getAttribute('aria-pressed')) !== 'true') {
    await viewToggle.click().catch(() => undefined);
  }
  await page
    .getByTestId('add-input-layer')
    .waitFor({ state: 'detached', timeout: 4000 })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// 面を描く
// ---------------------------------------------------------------------------

/** 画面座標 (px)。`page.mouse.click` に渡す値。 */
export type ScreenPoint = readonly [number, number];

/** 追加ツールの入力層 (add-input-layer) の bounding box。可視になるまで待つ。 */
export async function addInputLayerBox(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const addLayer = page.getByTestId('add-input-layer');
  await expect(addLayer).toBeVisible();
  const box = await addLayer.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

/** 中心 (cx, cy) と半径 half (px) の正方形の 4 隅 (左上から時計回り)。 */
export function squareCorners(cx: number, cy: number, half: number): readonly ScreenPoint[] {
  return [
    [cx - half, cy - half],
    [cx + half, cy - half],
    [cx + half, cy + half],
    [cx - half, cy + half],
  ];
}

/**
 * 追加モードに入り、面ツール (tool-add.area) を **新しい描画セッションで** 構える。
 * ツールボタンはトグルなので、前の確定後にまだ押されたままなら一度外してから押し直す
 * (押されたまま続けると前のドラフトを引き継ぐ)。入力層が可視になるまで待って返る。
 */
export async function armAddAreaTool(page: Page): Promise<void> {
  await enterAddMode(page);
  const areaTool = page.getByTestId('tool-add.area');
  await expect(areaTool).toBeVisible();
  if ((await areaTool.getAttribute('aria-pressed')) === 'true') {
    await areaTool.click(); // deselect → 前のセッションを捨てる
  }
  await areaTool.click(); // select → 新しい描画セッション
  await expect(areaTool).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('add-input-layer')).toBeVisible();
}

/**
 * 構え済みの追加ツールの入力層へ頂点を 1 つずつ実クリックで打つ (D23: 本物の
 * ポインタ入力)。入力層が可視であることを先に確かめる — 未マウントの層への最初の
 * クリックが落ちるのを防ぐ。
 */
export async function placeVertices(page: Page, points: ReadonlyArray<ScreenPoint>): Promise<void> {
  await expect(page.getByTestId('add-input-layer')).toBeVisible();
  for (const [px, py] of points) await page.mouse.click(px, py);
}

export interface DrawFaceOptions {
  /**
   * 頂点を打ったあと、隠しマーカー add-vertex-count が頂点数と一致することを確かめる
   * (既定 true)。クリックが 1 つでも落ちると「完了」は押せても形が変わるので、ここで
   * 早く・分かりやすく落とす。
   */
  readonly assertVertexCount?: boolean;
  /** 完了後・保存前に、プロパティフォームの上位領域 (add-parent) を option の index で選ぶ。 */
  readonly parentIndex?: number;
  /** 完了後・保存前に、プロパティフォームの名前 (add-name) を入れる。 */
  readonly name?: string;
  /**
   * 保存後、選択が新しい地物へ再解決される (app-active-feature が非空になる, 教訓 5.11)
   * のを待つ (既定 true)。`toHaveText(/\S/)` は expect のタイムアウト (15s) で確実に
   * 失敗する — bare `toPass()` はタイムアウト 0 で test の締切まで回り続ける。
   */
  readonly waitForSelection?: boolean;
}

/**
 * 構え済みの面ツールへ頂点を打ち、完了 → (上位領域・名前) → 保存 まで通す。
 * 返り値は確定した地物の id (`waitForSelection: false` のときは '')。
 * 面ツールは呼び出し側が {@link armAddAreaTool} で構えておく (描画途中で再度構えると
 * ドラフトがリセットされるため、ここでは構えない)。
 */
export async function drawFace(
  page: Page,
  corners: ReadonlyArray<ScreenPoint>,
  opts: DrawFaceOptions = {},
): Promise<string> {
  await placeVertices(page, corners);
  if (opts.assertVertexCount ?? true) {
    await expect(page.getByTestId('add-vertex-count')).toHaveText(String(corners.length));
  }
  const complete = page.getByTestId('add-complete');
  await expect(complete).toBeEnabled();
  await complete.click();
  if (opts.parentIndex !== undefined) {
    const parentSelect = page.getByTestId('add-parent');
    await expect(parentSelect).toBeVisible();
    await parentSelect.selectOption({ index: opts.parentIndex });
  }
  if (opts.name !== undefined) {
    await page.getByTestId('add-name').fill(opts.name);
  }
  await page.getByTestId('add-save').click();
  if (!(opts.waitForSelection ?? true)) return '';
  const activeFeature = page.getByTestId('app-active-feature');
  await expect(activeFeature).toHaveText(/\S/);
  return ((await activeFeature.textContent()) ?? '').trim();
}

/**
 * 面を 1 つ確定する: 追加モード → 面ツール → 頂点クリック → 完了 → 保存
 * (the LIVE add flow, so it renders on the map canvas — D23 evidence: a committed
 * feature is genuinely drawn, not faked)。返り値は確定した地物の id。
 */
export async function commitFace(
  page: Page,
  corners: ReadonlyArray<ScreenPoint>,
  opts: DrawFaceOptions = {},
): Promise<string> {
  await armAddAreaTool(page);
  return drawFace(page, corners, opts);
}

/** 中心 (cx, cy)・半径 half (px) の正方形の面を 1 つ確定する。返り値は地物 id。 */
export async function commitSquareFace(
  page: Page,
  cx: number,
  cy: number,
  half: number,
  opts: DrawFaceOptions = {},
): Promise<string> {
  return commitFace(page, squareCorners(cx, cy, half), opts);
}

export interface CommittedFace {
  /** 確定した地物の id (app-active-feature の値)。 */
  readonly faceId: string;
  /** 面の中心 (画面座標)。本体クリックの座標に使える。 */
  readonly cx: number;
  readonly cy: number;
  /** 打った 4 隅 (画面座標)。頂点クリックの座標に使える。 */
  readonly corners: readonly ScreenPoint[];
}

/** 既定の正方形の半径 (px)。入力層の中央に ~240×240 の面 (clearly visible on the canvas)。 */
export const DEFAULT_FACE_HALF = 120;

/**
 * 入力層の中央に既定サイズ (~240×240 px) の正方形の面を 1 つ確定する。
 * 「とにかく面が 1 つ要る」spec の入口。中心・4 隅・id を返す。
 */
export async function commitOneFace(page: Page): Promise<CommittedFace> {
  await armAddAreaTool(page);
  const b = await addInputLayerBox(page);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const corners = squareCorners(cx, cy, DEFAULT_FACE_HALF);
  const faceId = await drawFace(page, corners);
  return { faceId, cx, cy, corners };
}

// ---------------------------------------------------------------------------
// 実データの投入口 (E2E_TEST=1 のときだけ開く裏口。P-4)
// ---------------------------------------------------------------------------

/**
 * `window.__E2E_HARNESS__.loadProject(path)` の結果 (src/ui/e2e/harness.ts と同じ定義)。
 * 'loaded' = ドメインが差し替わった / 'not-loaded' = 拒否・中止・失敗で現状維持 /
 * 'busy' = 別の file 操作が進行中で落とされた。
 */
export type LoadProjectOutcome = 'loaded' | 'not-loaded' | 'busy';

/**
 * 絶対パスの .gimoza を、メニューの「開く」と同じ流れ (未保存ガード → 読込 → 修復判定 →
 * reflect → 保存先の昇格) で読み込む。ネイティブダイアログは開かない。
 *
 * 口は renderer の `window.__E2E_HARNESS__.loadProject` — main が E2E_TEST=1 のときだけ
 * preload に旗を渡し、preload が E2E ブリッジを公開し、FileOpsController がそれを見て登録する
 * (src/shell/ipc/e2e-harness.ts)。`launchApp` は E2E_TEST=1 で起動するので、ここでは口が
 * 生えるのを待ってから呼ぶ。読み込みの完了 (reflect まで) を待って結果を返す。
 *
 * ⚠️ 正準の実データ (derle-import/*.gimoza) を直接開かないこと。アプリは開いたファイルを
 * 保存先として昇格するので、テスト中の保存や自動保存で正準ファイルを上書きしうる。必ず
 * 一時ディレクトリへコピーしてから渡す (e2e/real-data.spec.ts の作法)。
 */
export async function loadProject(page: Page, projectPath: string): Promise<LoadProjectOutcome> {
  await page.waitForFunction(
    () =>
      typeof (globalThis as { __E2E_HARNESS__?: { loadProject?: unknown } }).__E2E_HARNESS__
        ?.loadProject === 'function',
    undefined,
    { timeout: 15_000 },
  );
  return page.evaluate(async (p) => {
    const harness = (
      globalThis as {
        __E2E_HARNESS__?: { loadProject?: (path: string) => Promise<LoadProjectOutcome> };
      }
    ).__E2E_HARNESS__;
    if (harness?.loadProject === undefined) {
      throw new Error('window.__E2E_HARNESS__.loadProject が無い (E2E_TEST=1 で起動したか)');
    }
    return harness.loadProject(p);
  }, projectPath);
}

/** 同じ表示名を持つ地物のかたまり (helpers 側の写し — src/ui/e2e/project-stats.ts が正)。 */
export interface DuplicateNameGroup {
  readonly name: string;
  readonly count: number;
}

/** いま開いているプロジェクトの規模 (src/ui/e2e/project-stats.ts の ProjectStats)。 */
export interface ProjectStats {
  readonly historyCount: number;
  readonly anchorCount: number;
  readonly featureCount: number;
  readonly leafCount: number;
  readonly aggregateCount: number;
  readonly uniqueNameCount: number;
  readonly duplicateNameGroups: readonly DuplicateNameGroup[];
  readonly duplicateNamedFeatureCount: number;
  readonly heaviestFeature: {
    readonly id: string;
    readonly name: string;
    readonly vertexCount: number;
    readonly ringCount: number;
  } | null;
}

/**
 * いま開いているプロジェクトの規模を読む (T-2 の隠し観測)。一覧の行は名前しか運ばず、頂点数は
 * 画面のどこにも出ないので、実データの規模を受け入れ条件にするにはこの口が要る。
 */
export async function projectStats(page: Page): Promise<ProjectStats> {
  await page.waitForFunction(
    () =>
      typeof (globalThis as { __E2E_HARNESS__?: { getProjectStats?: unknown } }).__E2E_HARNESS__
        ?.getProjectStats === 'function',
    undefined,
    { timeout: 15_000 },
  );
  return page.evaluate(() => {
    const harness = (
      globalThis as { __E2E_HARNESS__?: { getProjectStats?: () => ProjectStats } }
    ).__E2E_HARNESS__;
    if (harness?.getProjectStats === undefined) {
      throw new Error('window.__E2E_HARNESS__.getProjectStats が無い (E2E_TEST=1 で起動したか)');
    }
    return harness.getProjectStats();
  });
}

/**
 * アプリを起動し、指定の .gimoza (絶対パス) を読み込んだ状態で返す。読み込めなければ
 * その場で失敗する ('loaded' 以外は許さない — 不整合ファイルで修復ダイアログが出た場合も
 * ここで止まるので、そういう spec は `launchApp` + `loadProject` を直接使う)。
 */
export async function launchAppWithProject(projectPath: string): Promise<LaunchedApp> {
  const launched = await launchApp();
  const outcome = await loadProject(launched.page, projectPath);
  expect(outcome, `実データの読み込み結果 (${projectPath})`).toBe('loaded');
  return launched;
}
