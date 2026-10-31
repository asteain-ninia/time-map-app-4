// U43 — shared E2E helper: launch the BUILT Electron app headless and return the
// app handle + the renderer page. Every spec uses this so the launch contract
// (offscreen, E2E_TEST=1, sandbox kept on) lives in one place (単一の真実源).
//
// 2026-09-03 (UI 再設計の下準備 P-1): 「モードに入る → 面ツール → 頂点を打つ → 完了 →
// 保存」の手順もここへ一本化した。追加ツールの導線を作り直したとき、直す場所が
// spec 28 本 → このファイル 1 箇所になる。spec 側は「どこに・どんな形を描くか」
// (座標・頂点数・上位領域・名前) だけを渡す。
//
// 2026-09-06 (増分 5b): **モードの 3 ボタンが鍵 1 個＋道具の 1 段になった**（裁定 1）。
// 画面から「追加モード」「編集モード」のボタンは消え、内部の `mode` は道具から
// 導出される（設計書 §D.1）:
//
//     mode = 鍵が閉じている ? 'view' : （面／線／点の道具）? 'add' : 'edit'
//
// したがって下の 4 つのヘルパの中身はこうなった。**spec 側の呼び出しは変えていない**
// ―― これが P-1（導線を作り直したとき、直す場所を 1 か所にする）の効き目である。
//   - `leaveViewMode`  … 鍵を開ける（`mode-view` は据え置き。T-1）
//   - `enterAddMode`   … 鍵を開けて **面の道具を構える**（＝ mode が add になる）
//   - `enterEditMode`  … 鍵を開けて、追加の道具を構えていれば「選択」へ戻す
//   - `returnToViewMode` … 鍵を閉める
// どれも冪等（すでにその状態なら何もしない）。

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from 'playwright';
import { expect } from '@playwright/test';

// **道具の一覧は実装から引く**（増分 5 の手直し F3 / 教訓 5.29 単一真実源）。
// 3 つの spec がレールの 11 個をそれぞれ手で並べていたので、道具を足したり順を変えたり
// したときに **spec だけが古いまま緑で通る**（走らせている顔ぶれが減ったことに誰も
// 気づけない）。`ALL_TOOLS` は `src/ui/shell/tools.ts` の並び順の単一の真実源である。
import { ALL_TOOLS } from '../src/ui/shell/tools';
import { launchKeyOf, launchMode, launchShared } from './shared-launch';


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
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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
  /**
   * 子プロセスへ足す環境変数。`E2E_SAVE_AS_PATH`（名前を付けて保存の行き先を
   * ネイティブダイアログ抜きで決める E2E 専用の脱出口）のように、**起動時にしか
   * 効かない条件**を渡すために開けてある。既定は何も足さない。
   */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /**
   * 初回起動のガイドを **畳まない**。ガイドそのものを見る検査（本番の初回起動で
   * 本当に出るか・地図に重なっていないか）のために開けてある。既定は畳む。
   */
  readonly keepFirstRunGuide?: boolean;
}

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  // 初回起動のガイド（FR-118 / 設計書 §H.3。増分 6）は **既定で出る**。既定の設定で
  // 起動するたびに出るので、**launchApp の 1 か所で畳む** ―― spec ごとに畳む形にすると、
  // 次に spec を足した人が忘れて「板の外を押したのに何も起きない」で悩む（増分 5 の
  // 「板を先に閉じる」の申し送りと同じ型）。**「今後表示しない」ではなく「閉じる」**を
  // 押す ―― 設定を書くと、設定そのものを見る検査が汚れる。
  // 既定はここで終わる（検査ごとに起動し直す）。使い回しは E2E_LAUNCH_MODE を指定したときだけ
  // （e2e/shared-launch.ts、開発ガイド §1.12）。
  const childEnv = childEnvFor(options);
  if (launchMode() === 'fresh') {
    const launched = await startElectron(options, childEnv);
    if (options.keepFirstRunGuide !== true) await dismissFirstRunGuide(launched.page);
    return launched;
  }
  return launchShared({
    start: () => startElectron(options, childEnv),
    waitForShell,
    settleFirstRun: async (page) => {
      if (options.keepFirstRunGuide !== true) await dismissFirstRunGuide(page);
    },
    userDataDir,
    launchKey: launchKeyOf(options.extraArgs ?? [], childEnv),
  });
}

/** 殻（`app-shell`）が載るまで待つ。 */
async function waitForShell(page: Page): Promise<void> {
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
}

/** 子プロセスへ渡す環境変数の全部（親から受け継ぐ分＋E2E_TEST＋`extraEnv`）。 */
function childEnvFor(options: LaunchOptions): Record<string, string> {
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
  for (const [key, value] of Object.entries(options.extraEnv ?? {})) childEnv[key] = value;
  return childEnv;
}

async function startElectron(options: LaunchOptions, childEnv: Record<string, string>): Promise<LaunchedApp> {
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
  await waitForShell(page);
  return { app, page };
}

/**
 * 初回起動のガイドが出ていたら閉じる（冪等）。ガイド自身を見る spec は先に読むこと。
 *
 * **出るのを待ってから閉じる**（2026-09-07 の手直し）。ガイドを出すかどうかは
 * アプリ側の設定（userData の JSON）を **読んでから**決まるようになったので、
 * 「いま DOM に無ければ何もしない」形だと **読み終わる前に素通りして**、あとから
 * 出たガイドが次の操作を覆う。待つのは板が本当に出るまでで、時間切れなら
 * 「もう出ない設定になっている」と読んで何もしない（冪等さは保つ）。
 */
export async function dismissFirstRunGuide(page: Page): Promise<void> {
  const close = page.getByTestId('first-run-guide-close');
  try {
    await close.waitFor({ state: 'visible', timeout: 5_000 });
  } catch {
    return;
  }
  await close.click();
  await expect(page.getByTestId('first-run-guide')).toHaveCount(0);
}

// ---------------------------------------------------------------------------
// モード切替 (すべて冪等)
// ---------------------------------------------------------------------------

/**
 * 地物の削除の確認が出ていたら「削除」を押す（冪等）。
 *
 * **削除は 3 経路とも確認を通る**（増分 1 の手直し A8。所有者の裁定「消す前に何が起きるかを
 * 必ず見せる」）。Delete キー・右クリックの「削除」・素性欄のボタンのどれも、同じ
 * `DeleteConfirmDialog` を出してから消す。頂点の削除は別の操作なので確認は出ない
 * ——だからこの関数は「出ていたら押す」形にしてあり、頂点削除の後に呼んでも何もしない。
 */
export async function confirmDeleteIfAsked(page: Page): Promise<void> {
  // **増分 7**: 削除の確認は「影響の一覧」の板になった（設計書 §A.3 / 中身 6）。
  // 器は地物・錨・輪郭・頂点の削除で 1 つなので、ここも 1 か所で受ける。
  const impact = page.getByTestId('delete-impact-confirm');
  if ((await impact.count()) > 0) {
    await impact.first().click();
    await expect(page.getByTestId('delete-impact')).toHaveCount(0);
    return;
  }
  const confirm = page.getByRole('button', { name: '削除を確定' });
  if ((await confirm.count()) === 0) return;
  await confirm.first().click();
  await expect(confirm).toHaveCount(0);
}

/**
 * オプションバーの「深さ ▾」を開く（増分 5a）。既に開いていれば何もしない。
 *
 * **なぜヘルパが要るか**: 深さの操作（スライダー・＋−・この地物の上下だけ見る）は
 * アプリバーに出しっぱなしだったが、アプリバーを 32px 固定にするためオプションバーの
 * ポップオーバーへ降ろした（設計書 §B.4）。押せることは変わらないので、spec 側は
 * 「開く 1 手」だけを足せばよい ―― その 1 手をここに集める（P-1: 導線を作り直したとき
 * に直す場所を 1 か所にする）。
 */
export async function openDepthOptions(page: Page): Promise<void> {
  const button = page.getByTestId('option-depth-button');
  await expect(button).toBeVisible();
  if ((await button.getAttribute('aria-expanded')) !== 'true') {
    await button.click();
  }
  await expect(button).toHaveAttribute('aria-expanded', 'true');
}

/**
 * 測量の「座標 ▾」を開く（増分 5a）。既に開いていれば何もしない。
 *
 * 度分秒・十進の読み取りと表示形式の切替は、40px の帯に収まらないのでここへ畳んだ
 * （設計書 §C.4 の「設定: 度分秒 ▾」）。距離はポップオーバーの外に出したままである。
 */
export async function openSurveyCoords(page: Page): Promise<void> {
  const button = page.getByTestId('survey-coords-button');
  await expect(button).toBeVisible();
  if ((await button.getAttribute('aria-expanded')) !== 'true') {
    await button.click();
  }
  await expect(button).toHaveAttribute('aria-expanded', 'true');
}

/** 追加の 3 道具（画面の並び順）。「追加モードに居るか」はこの 3 つの押下で決まる。 */
const ADD_TOOL_TESTIDS = ['tool-add.area', 'tool-add.line', 'tool-add.point'] as const;

/** 鍵が閉じている（＝読むだけ）か。 */
async function isLocked(page: Page): Promise<boolean> {
  const lock = page.getByTestId('mode-view');
  await expect(lock).toBeVisible();
  return (await lock.getAttribute('aria-pressed')) === 'true';
}

/**
 * 鍵を開ける（読むだけ → 直せる）。既に開いていれば何もしない。
 *
 * `mode-view` の testid は据え置き（T-1: 役割＝編集を止めるトグルは変わっていない）。
 */
export async function leaveViewMode(page: Page): Promise<void> {
  if (!(await isLocked(page))) return;
  await page.getByTestId('mode-view').click();
  await expect(page.getByTestId('mode-view')).toHaveAttribute('aria-pressed', 'false');
}

/**
 * 追加モードに入る ＝ **鍵を開けて面の道具を構える**（増分 5b）。
 *
 * 内部の `mode` は道具から導出されるので、「モードに入ってから道具を選ぶ」の 2 手は
 * 「道具を押す」の 1 手になった。既にいずれかの追加道具を構えていれば何もしない
 * （押し直すと下書きが捨てられる）。This is the SAME live導線 the regression suite
 * drives (no overlay bypass).
 */
export async function enterAddMode(page: Page): Promise<void> {
  await leaveViewMode(page);
  for (const id of ADD_TOOL_TESTIDS) {
    if ((await page.getByTestId(id).getAttribute('aria-pressed')) === 'true') return;
  }
  const area = page.getByTestId('tool-add.area');
  await expect(area).toBeEnabled();
  await area.click();
  await expect(area).toHaveAttribute('aria-pressed', 'true');
}

/**
 * 編集モードに入る ＝ **鍵を開けて、追加の道具を構えていれば「選択」へ戻す**（増分 5b）。
 *
 * 鍵を開けただけで `mode` は `edit` になる（追加の道具を構えていない限り）ので、
 * ふつうは 1 手で終わる。
 */
export async function enterEditMode(page: Page): Promise<void> {
  await leaveViewMode(page);
  for (const id of ADD_TOOL_TESTIDS) {
    if ((await page.getByTestId(id).getAttribute('aria-pressed')) === 'true') {
      await page.getByTestId('tool-edit.select').click();
      break;
    }
  }
  await expect(page.getByTestId('app-mode')).toHaveText('edit');
}

/**
 * **「頂点」の道具を構える**（B114。「選択」では頂点に当たらない）。鍵が閉じていれば開ける。
 * 持ち替えても地物の選択は残るので、地物を選んだ後でも前でも呼べる。
 */
export async function armVertexTool(page: Page): Promise<void> {
  await leaveViewMode(page);
  const tool = page.getByTestId('tool-edit.vertex');
  if ((await tool.getAttribute('aria-pressed')) !== 'true') await tool.click();
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
}

/**
 * 鍵を閉める（＝読むだけへ戻る）。追加/ナイフの入力層 (地図セル全面の透明な層) が
 * 外れるのを best-effort で待つ — 残っていると以後のタイムライン・ツールバーの
 * クリックを奪う。待ちきれなくても失敗にはしない (探索用の spec は独自に記録する)。
 */
export async function returnToViewMode(page: Page): Promise<void> {
  const lock = page.getByTestId('mode-view');
  if ((await lock.getAttribute('aria-pressed')) !== 'true') {
    await lock.click().catch(() => undefined);
    // **鍵を閉じようとしたら「捨てますか」を聞かれることがある**（増分 5 の手直し
    // 2 回目 / 設計書 §D.4.1 の 3）。確定できる点数まで打った下書きを持っていると、
    // 答えるまで鍵は閉じない。このヘルパの役目は「読むだけへ行くこと」なので、
    // 聞かれたら「捨てる」と答えて先へ進む。
    await answerDraftDiscardIfAsked(page, 'yes');
  }
  await page
    .getByTestId('add-input-layer')
    .waitFor({ state: 'detached', timeout: 4000 })
    .catch(() => undefined);
}

/**
 * 「描きかけを捨てますか」の板が出ていたら答える（冪等）。
 *
 * 板は 追加・分ける・輪郭・穴あけ の 4 道具が同じ器（`shell/DraftDiscardConfirm`）で
 * 出すので、`data-testid` の末尾で拾う ―― 道具ごとに `if` を並べると、道具を足したときに
 * ここへ足し忘れて「なぜかヘルパが固まる」になる（教訓 5.19: 分岐は 1 か所の表で持つ）。
 */
export async function answerDraftDiscardIfAsked(
  page: Page,
  answer: 'yes' | 'no',
): Promise<boolean> {
  const button = page.locator(`[data-testid$="-draft-discard-${answer}"]`);
  if ((await button.count()) === 0) return false;
  await button.first().click();
  await expect(page.locator('[data-testid$="-draft-discard-confirm"]')).toHaveCount(0);
  return true;
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
  // **保存は 1 コマ遅れて走る**（B39 の直しで追加の［保存］にも進行表示を掛けた）。押した直後は
  // まだ前の選択が残っているので、素性欄が閉じる（＝保存が走り終えた）のを待ってから読む。
  await expect(page.getByTestId('add-property-form')).toHaveCount(0);
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
 * **既に確定した正方形の面と重ならない、次の正方形の中心**を返す（増分 3 / FR-29）。
 *
 * 増分 3 で FR-29（他の末端地物の内部には頂点を設置できない）が**実際に効くようになった**。
 * それまでは効いていなかったので、spec は 2 つ目の面を 1 つ目の真上に描いていられた。
 * いまは黙って頂点が置けず「確定」が押せないまま終わるので、**2 つ目以降は前の面の外へ**
 * 置く。左右に並べるのは、地図セルが縦に狭い（上下は帯に当たりやすい）ため。
 *
 * @param cx 直前の面の中心 x
 * @param half 直前の面の半径（px）
 * @param nextHalf 次の面の半径（px。既定は同じ）
 * @param gap 面と面のあいだの隙間（px）
 */
export function besideSquareX(
  cx: number,
  half: number,
  nextHalf: number = half,
  gap = 16,
): number {
  return cx + half + gap + nextHalf;
}

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
// 時刻を動かす
// ---------------------------------------------------------------------------

/**
 * 現在時刻を指定の年へ飛ばす（直接ジャンプの入力欄経由）。
 *
 * **年だけを指定する**（月日は未指定のまま）ので、着地する現在時刻も年だけになる。
 * 増分 2 以降は「年ちょうどでないと保存できない」ので、ここで月日を補ってはいけない。
 * この手順は存続期間の spec に写しがあったものを helpers へ寄せたものである。
 */
/**
 * 素性欄の畳んだ節を開く（増分 2 の手直し D2 / 設計書 §C.6）。
 *
 * 節（見た目・歴史の錨・詳細文書・詳しい属性）は **初期は折りたたみ** なので、中の
 * 部品を押す検査は先にここを通す。既に開いていれば何もしない（何度呼んでも同じ）。
 */
/**
 * 素性欄の中の部品を、**上下に固定した部品（見出し・保存列）をよけてから**押す。
 *
 * 素性欄は上端の見出しと下端の保存列が `position: sticky` で貼り付く器である。中身が
 * その帯に重なっていると押せない（教訓 5.61）。人は少しスクロールしてから押すが、
 * Playwright の「見えるところまで動かす」は **器の中に入ってさえいれば動かさない**ので、
 * 固定部品に覆われたまま押しにいって失敗する。ここで「前面に出るまで動かす」を先に済ませる。
 *
 * **`force` では押さない。** 覆われたまま押す形にすると、本当に届かない不具合
 * （＝教訓 5.61 そのもの）を検査が通してしまう。どのスクロール位置でも前面に出ない
 * ときは、その事実を理由にして落とす。
 */
export async function clickClearOfStickyBars(target: Locator): Promise<void> {
  const bringToFront = async (): Promise<void> => {
    await target.evaluate((el) => {
      let container: HTMLElement | null = el.parentElement;
      while (container !== null && container.scrollHeight <= container.clientHeight) {
        container = container.parentElement;
      }
      if (container === null) return;
      const good = (): boolean => {
        const box = container!.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        if (r.top < box.top || r.bottom > box.bottom) return false;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit !== null && (hit === el || el.contains(hit));
      };
      const before = container.scrollTop;
      const max = container.scrollHeight - container.clientHeight;
      for (let t = 0; t <= max; t += 4) {
        container.scrollTop = t;
        if (good()) return;
      }
      container.scrollTop = before;
    });
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await bringToFront();
    try {
      await target.click({ timeout: 3_000 });
      return;
    } catch {
      // 次の回で位置合わせからやり直す。
    }
  }
  await bringToFront();
  await target.click();
}

export async function openPropertySection(page: Page, testId: string): Promise<void> {
  const section = page.getByTestId(testId);
  const open = await section.evaluate((el) => (el as HTMLDetailsElement).open);
  if (open) return;
  // 素性欄は **上端に見出しが、下端に保存列が固定** されている（`position: sticky`）。
  // 節の見出しは、そのあいだの「空いている帯」に来たときだけ押せる（教訓 5.61）。
  //
  // **位置を計算して 1 回寄せる形では足りない。** 理由が 3 つある:
  //   1. `position: sticky` の部品は「はみ出しそうになったときだけ」貼り付くので、
  //      **動かす前に測った位置は動かしたあとの位置ではない**（実測: スクロール 0 では
  //      保存列が見出しのすぐ下に居て、空き帯が 5px しか無いように見えた）。
  //   2. 固定部品の高さは中身で変わる（予告・断りの行が 1 行にも 2 行にもなる）。
  //   3. 素性欄は対象が変わるとスクロールを先頭へ戻すので、寄せた直後に打ち消されうる。
  //
  // だから **「前面に出るまで動かして、押してみる」を数回くり返す**（人がやることと
  // 同じ）。それでも押せないなら、その節は本当に届かない ―― そのときは Playwright の
  // 断りをそのまま出す（黙って `force` で押さない。押せないこと自体が不具合だからである）。
  const summary = section.locator('summary').first();
  const bringToFront = async (): Promise<void> => {
    await summary.evaluate((el) => {
      let container: HTMLElement | null = el.parentElement;
      while (container !== null && container.scrollHeight <= container.clientHeight) {
        container = container.parentElement;
      }
      if (container === null) {
        el.scrollIntoView({ block: 'center' });
        return;
      }
      // **器の中に丸ごと入っていて、かつ前面に出ている**位置を探す。
      // 「前面に出ている」だけでは足りない ―― 端に半分かかっていると、Playwright が
      // 押す直前に自分で「見えるところまで」動かし直し、こちらの位置決めが消える。
      const good = (): boolean => {
        const box2 = container!.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        if (r.top < box2.top || r.bottom > box2.bottom) return false;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit !== null && (hit === el || el.contains(hit));
      };
      const before = container.scrollTop;
      const max = container.scrollHeight - container.clientHeight;
      for (let t = 0; t <= max; t += 4) {
        container.scrollTop = t;
        if (good()) return;
      }
      container.scrollTop = before;
    });
  };
  let clicked = false;
  for (let attempt = 0; attempt < 3 && !clicked; attempt += 1) {
    await bringToFront();
    try {
      await summary.click({ timeout: 3_000 });
      clicked = true;
    } catch {
      // 次の回で位置合わせからやり直す。
    }
  }
  if (!clicked) {
    // **押せる位置が本当に 1 つも無いのかを、先に確かめる。**
    //
    // Playwright は押す直前に自分でも「見えるところまで」動かすので、こちらの位置合わせと
    // 押し合いになることがある（`position: sticky` の部品と、素性欄が対象の変化で
    // スクロールを先頭へ戻す動きが重なる）。それは **検査の都合**であって不具合ではない。
    // 一方「どのスクロール位置でも固定部品の下から出てこない」は **本物の不具合**
    // （教訓 5.61）なので、その 2 つをここで分ける。
    const probe = await summary.evaluate((el) => {
      let container: HTMLElement | null = el.parentElement;
      while (container !== null && container.scrollHeight <= container.clientHeight) {
        container = container.parentElement;
      }
      if (container === null) return { reachable: true, detail: '(器が無い)' };
      const before = container.scrollTop;
      const max = container.scrollHeight - container.clientHeight;
      let found = false;
      const blockers = new Set<string>();
      for (let t = 0; t <= max && !found; t += 4) {
        container.scrollTop = t;
        const box = container.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        if (r.top < box.top || r.bottom > box.bottom) continue;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        found = hit !== null && (hit === el || el.contains(hit));
        if (!found && hit !== null) {
          blockers.add(hit.getAttribute('data-testid') ?? String(hit.className));
        }
      }
      const head = document.querySelector('[data-testid="property-panel-head"]');
      const bar = document.querySelector('[data-testid="property-save-bar"]');
      container.scrollTop = Math.floor(max / 2);
      const h = head?.getBoundingClientRect();
      const b = bar?.getBoundingClientRect();
      const detail = `器 ${String(Math.round(container.clientHeight))}px / 見出し ${String(
        h === undefined ? -1 : Math.round(h.height),
      )}px / 保存列 ${String(b === undefined ? -1 : Math.round(b.height))}px / 空き帯 ${String(
        h === undefined || b === undefined ? -1 : Math.round(b.top - h.bottom),
      )}px / 見出しの高さ ${String(Math.round(el.getBoundingClientRect().height))}px / 覆っていたもの ${[
        ...blockers,
      ].join(', ')}`;
      container.scrollTop = before;
      return { reachable: found, detail };
    });
    expect(
      probe.reachable,
      `節「${testId}」の見出しが、どのスクロール位置でも固定部品の下から出てこない（教訓 5.61）: ${probe.detail}`,
    ).toBe(true);
    // 届くことは確かめたので、開く操作そのものは DOM の click で通す。
    await summary.evaluate((el) => {
      (el as HTMLElement).click();
    });
  }
  await expect(section).toHaveJSProperty('open', true);
}

export async function jumpToYear(page: Page, year: number): Promise<void> {
  await requestYear(page, year);
  await expect(page.getByTestId('timeline-current')).toHaveText(
    year < 0 ? `紀元前${String(-year)}年` : `${String(year)}年`,
  );
}

/**
 * 年を **頼むだけ**（動いたことを確かめない）。
 *
 * 打ちかけの下書きがあると「捨てますか」の板が出て、**答えるまで年は動かない**
 * （2026-09-07 の手直し。教訓 5.71: 確認は行動の前）。そういう場面を書く spec は
 * こちらを使う ―― `jumpToYear` は「動いたこと」まで確かめるので必ず失敗する。
 */
export async function requestYear(page: Page, year: number): Promise<void> {
  await page.getByLabel('直接ジャンプ 年', { exact: true }).fill(String(year));
  // 完全一致で拾うのは、未指定のトグル（「直接ジャンプ 月 未指定」等）を拾わないため。
  await page.getByRole('button', { name: 'ジャンプ', exact: true }).click();
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

/** 末端地物の中身の問い合わせ (src/ui/e2e/leaf-report.ts の LeafReportQuery の写し)。 */
export interface LeafReportQuery {
  readonly ids?: readonly string[];
  readonly names?: readonly string[];
  readonly probes?: readonly { readonly lon: number; readonly lat: number }[];
}

/** 末端地物 1 件の中身 (src/ui/e2e/leaf-report.ts の LeafReportEntry の写し)。 */
export interface LeafReportEntry {
  readonly id: string;
  readonly name: string;
  readonly kindLabel: string | null;
  readonly color: unknown;
  readonly anchorStartYears: readonly number[] | null;
  readonly areaKm2: number | null;
  readonly polygonCount: number;
  readonly ringCount: number;
}

/** src/ui/e2e/leaf-report.ts の LeafReport の写し。 */
export interface LeafReport {
  readonly entries: readonly LeafReportEntry[];
  readonly totalAreaKm2: number;
  readonly maxPairOverlapKm2: number;
  readonly probeOwners: readonly (string | null)[];
}

/**
 * **いま見ている年**の末端地物を id か名前で選んで、中身をドメインの値で読む (T-2 の隠し観測。
 * 増分 8B の手直し)。分割の検査が一覧の件数や板の文といった表示だけに頼らないための口。
 */
export async function leafReport(page: Page, query: LeafReportQuery): Promise<LeafReport> {
  await page.waitForFunction(
    () =>
      typeof (globalThis as { __E2E_HARNESS__?: { getLeafReport?: unknown } }).__E2E_HARNESS__
        ?.getLeafReport === 'function',
    undefined,
    { timeout: 15_000 },
  );
  return page.evaluate((q) => {
    const harness = (
      globalThis as {
        __E2E_HARNESS__?: { getLeafReport?: (query: LeafReportQuery) => LeafReport };
      }
    ).__E2E_HARNESS__;
    if (harness?.getLeafReport === undefined) {
      throw new Error('window.__E2E_HARNESS__.getLeafReport が無い (E2E_TEST=1 で起動したか)');
    }
    return harness.getLeafReport(q);
  }, query);
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

// ---------------------------------------------------------------------------
// 地物一覧の件数 (増分 4: 仮想スクロールで「行の DOM 数 ≠ 件数」になった)
// ---------------------------------------------------------------------------

/**
 * 地物一覧に **何件載っているか**。
 *
 * ⚠️ **行の DOM を数えてはいけない**（増分 4）。台帳は仮想スクロールになったので、
 * 5,000 件でも DOM に載るのは窓に入るぶん＋前後 2 行だけである。件数の真実源は
 * `unified-list-count` の表示（`${総数}件` / 絞り込み中は `${一致}/${総数}件`）で、
 * ここが唯一の読み口である。返すのは **いま一覧に出ている件数**（絞り込み中なら一致数）。
 */
export async function listedFeatureCount(page: Page): Promise<number> {
  if ((await page.getByTestId('unified-list-empty').count()) > 0) return 0;
  const text = (await page.getByTestId('unified-list-count').textContent()) ?? '';
  const m = /^(?:(\d+)\s*\/\s*)?(\d+)件$/.exec(text.trim());
  if (m === null) throw new Error(`一覧の件数表示が読めない: ${JSON.stringify(text)}`);
  return Number(m[1] ?? m[2]);
}

/**
 * **輪郭（穴・飛び地）を消す確認が出ていたら、そのまま確定する**（増分 7 の中身 7）。
 *
 * リングの削除は押した瞬間に消していたが、N-05 の手当てで **影響の一覧を出してから**
 * 確定する形になった（とくに「最後の外周を消すと面ごと消える」を事前に文で出す）。
 * 出ていなければ何もしない。
 */
export async function confirmRingDeleteIfAsked(page: Page): Promise<void> {
  const confirm = page.getByTestId('ring-delete-impact-confirm');
  if ((await confirm.count()) === 0) return;
  await confirm.first().click();
  await expect(page.getByTestId('ring-delete-impact')).toHaveCount(0);
}

/**
 * **所属変更の 3 択の板が出ていたら、そのまま確定する**（増分 7）。
 *
 * ［所属を変える］は増分 7 から **押した瞬間には確定せず、3 択の板を開く**（中身 1）。
 * 地図で拾った新しい上位領域は「既存から選ぶ」枝の初期値になっているので、板を
 * そのまま確定すれば従来と同じ結果になる。板が出ていなければ何もしない ―― 探索の
 * spec は「押せたら押す」形で書かれているので、出る・出ないの両方を通す。
 *
 * 戻り値は **板が出ていたか**。
 */
export async function confirmReparentDialogIfOpen(page: Page): Promise<boolean> {
  const dialog = page.getByTestId('reparent-options-dialog');
  if ((await dialog.count()) === 0) return false;
  const confirm = page.getByTestId('reparent-options-confirm');
  if (await confirm.isEnabled().catch(() => false)) {
    await confirm.click().catch(() => undefined);
  } else {
    // 確定できない枝（相手が選ばれていない等）は、板を閉じて元の局面へ戻す。
    await page.getByTestId('reparent-options-cancel').click().catch(() => undefined);
  }
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  return true;
}

/**
 * `count` 件の合成地物を載せる（増分 4）。受け入れ条件の「**5,000 行の合成データで
 * 台帳の DOM ノードが 20 個以下**」を実アプリで測るための投入口で、読み込みと同じ
 * 1 本（reflect）を通る。`E2E_TEST=1` のときだけ生える（本番では何も無い）。
 */
export async function loadSyntheticProject(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (globalThis as { __E2E_HARNESS__?: { loadSyntheticProject?: unknown } })
        .__E2E_HARNESS__?.loadSyntheticProject === 'function',
    undefined,
    { timeout: 15_000 },
  );
  await page.evaluate((n) => {
    const harness = (
      globalThis as {
        __E2E_HARNESS__?: { loadSyntheticProject?: (count: number) => void };
      }
    ).__E2E_HARNESS__;
    if (harness?.loadSyntheticProject === undefined) {
      throw new Error('window.__E2E_HARNESS__.loadSyntheticProject が無い (E2E_TEST=1 で起動したか)');
    }
    harness.loadSyntheticProject(n);
  }, count);
}


/**
 * 1 段に並ぶ道具の `data-testid`（レールの順）。**「測る」は別の軸**（`survey-toggle`）
 * なので入っていない ―― 入れると「鍵で灰色になるか」の検査が測るまで巻き込む。
 */
export const ALL_TOOL_TESTIDS: readonly string[] = ALL_TOOLS.map((t) => `tool-${t}`);

/**
 * **1 地物が `count` 本の錨を持つ**合成データを載せる（増分 6）。設計書 §F.2 の
 * 受け入れ条件（5 万錨で再集計 16ms 以内・ヒットテスト 1ms 以内）を実アプリで測る
 * ための投入口。`asAggregateChild` を立てると、実データの 86 件と同じ
 * 「自分の履歴を持たず親の系列に入っている」形になる。
 */
export async function loadSyntheticAnchors(
  page: Page,
  count: number,
  options?: {
    readonly asAggregateChild?: boolean;
    /** 先頭の何本を **同じ年の別の月**へ置くか（束の吹き出しの相手）。 */
    readonly withinOneYear?: number;
  },
): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (globalThis as { __E2E_HARNESS__?: { loadSyntheticAnchors?: unknown } })
        .__E2E_HARNESS__?.loadSyntheticAnchors === 'function',
    undefined,
    { timeout: 15_000 },
  );
  await page.evaluate(
    ({ n, opts }) => {
      const harness = (
        globalThis as {
          __E2E_HARNESS__?: {
            loadSyntheticAnchors?: (
              count: number,
              options?: {
                readonly asAggregateChild?: boolean;
                readonly withinOneYear?: number;
              },
            ) => void;
          };
        }
      ).__E2E_HARNESS__;
      if (harness?.loadSyntheticAnchors === undefined) {
        throw new Error('window.__E2E_HARNESS__.loadSyntheticAnchors が無い');
      }
      harness.loadSyntheticAnchors(n, opts);
    },
    { n: count, opts: options },
  );
}

/** 時刻レールの観測（`window.__E2E__.getAnchorLaneStats`）。 */
export interface RailLaneStats {
  readonly featureId: string;
  readonly inherited: boolean;
  readonly anchorCount: number;
  readonly inView: number;
  readonly width: number;
  readonly markCount: number;
  readonly denseCount: number;
  readonly shapeCount: number;
  readonly maxCount: number;
  readonly lastAggregateMs: number;
  readonly aggregateCount: number;
  readonly sourceCount: number;
  readonly lastSourceMs: number;
  readonly lastHitTestMs: number;
  readonly laneHeightPx: number;
}

/** 同じく表示範囲（`window.__E2E__.getRailView`）。 */
export interface RailViewSnapshot {
  readonly minYear: number;
  readonly maxYear: number;
  readonly spanDays: number;
  readonly pixelLength: number;
  readonly fold: string;
  readonly currentYear: number;
  readonly editTime: string;
}

export async function railLaneStats(page: Page): Promise<RailLaneStats> {
  return page.evaluate(() => {
    const e2e = (globalThis as { __E2E__?: { getAnchorLaneStats?: () => RailLaneStats } })
      .__E2E__;
    if (e2e?.getAnchorLaneStats === undefined) {
      throw new Error('window.__E2E__.getAnchorLaneStats が無い');
    }
    return e2e.getAnchorLaneStats();
  });
}

export async function railView(page: Page): Promise<RailViewSnapshot> {
  return page.evaluate(() => {
    const e2e = (globalThis as { __E2E__?: { getRailView?: () => RailViewSnapshot } }).__E2E__;
    if (e2e?.getRailView === undefined) throw new Error('window.__E2E__.getRailView が無い');
    return e2e.getRailView();
  });
}

export async function railMarkPositions(page: Page): Promise<readonly number[]> {
  return page.evaluate(() => {
    const e2e = (globalThis as { __E2E__?: { getAnchorMarkPositions?: () => number[] } })
      .__E2E__;
    if (e2e?.getAnchorMarkPositions === undefined) {
      throw new Error('window.__E2E__.getAnchorMarkPositions が無い');
    }
    return e2e.getAnchorMarkPositions();
  });
}

/**
 * 起動直後のカメラで、地図セルの中の **世界（経度 ±180 / 緯度 ±90）が占める帯**。
 *
 * **なぜ要るか**（増分 1 の教訓を増分 6 で踏み直した）: 地図セルの縦横の比によって、
 * 世界は幅いっぱいにも高さいっぱいにもならない。**増分 6 で時刻レールが 89.2px 縮んだ
 * ぶん地図が縦に伸び、上下に「世界の外」の帯ができた** ―― セルの上端から 40px の点は
 * 北緯 90 度より上になり、そこへ頂点を置こうとした spec が「そこは世界の外です」で
 * 落ちた。**固定 px で置かず、この帯から解くこと。**
 *
 * ⚠️ **前提: カメラが起動直後のまま**（世界全体が収まる視点）。パン・ズーム・全体表示の
 * あとは別の帯になるので、そのときは `map-input-layer` の `data-zoom` / `data-pan-*` から
 * 実際の変換を読むこと。
 */
export function worldBandIn(box: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number } {
  const perDeg = Math.min(box.width / 360, box.height / 180);
  const halfW = (perDeg * 360) / 2;
  const halfH = (perDeg * 180) / 2;
  const xc = box.x + box.width / 2;
  const yc = box.y + box.height / 2;
  return { left: xc - halfW, right: xc + halfW, top: yc - halfH, bottom: yc + halfH };
}

/**
 * 地図セルの中に **常設で置いてある部品**（設計書 §B.5 の台帳 #10・#11。増分 6）。
 *
 * K-2 の 5×5 の走査は「地図の点が入力層に届く」ことを見るが、**台帳に載っている常設の
 * 部品は押せてよい**（それが #10 の存在理由である）。走査の期待値へこの顔ぶれを足す
 * ―― 決め打ちで書くと、台帳に部品を足したとき検査だけが古いまま緑で通る。
 */
export const MAP_CELL_PARTS: readonly string[] = [
  'map-zoom-in',
  'map-zoom-out',
  'map-fit-all',
  'map-scale-bar',
];

/**
 * **まとめ役 1 件の錨に `childCount` 件の子が居候する**合成データを載せる
 * （増分 7 の手直し A / 司令塔の決定 (1)(2)）。実データの「デーレ共和国 60 州」と
 * 同じ形なので、記録の置き場（親の錨から子の系列へ写す）が効いているかを画面から
 * 数えられる。
 */
export async function loadSyntheticNested(
  page: Page,
  childCount: number,
  years?: readonly number[],
): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (globalThis as { __E2E_HARNESS__?: { loadSyntheticNested?: unknown } })
        .__E2E_HARNESS__?.loadSyntheticNested === 'function',
    undefined,
    { timeout: 15_000 },
  );
  await page.evaluate(
    ({ n, ys }) => {
      const harness = (
        globalThis as {
          __E2E_HARNESS__?: {
            loadSyntheticNested?: (count: number, years?: readonly number[]) => void;
          };
        }
      ).__E2E_HARNESS__;
      if (harness?.loadSyntheticNested === undefined) {
        throw new Error('window.__E2E_HARNESS__.loadSyntheticNested が無い (E2E_TEST=1 で起動したか)');
      }
      harness.loadSyntheticNested(n, ys);
    },
    { n: childCount, ys: years },
  );
}

// ---------------------------------------------------------------------------
// 増分 8A — 頂点の候補一覧（設計書 §B.5 の台帳 #12）と、頂点の印の観測
// ---------------------------------------------------------------------------

/** 世界座標（経緯度）。 */
export interface WorldPos {
  readonly lon: number;
  readonly lat: number;
}

/** 最後に描いたフレームの頂点の印の世界座標（`__E2E__.getVertexHandlePositions`）。 */
export async function vertexHandlePositions(page: Page): Promise<WorldPos[]> {
  return page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E__?: { getVertexHandlePositions: () => { lon: number; lat: number }[] };
    }).__E2E__;
    return e2e === undefined ? [] : e2e.getVertexHandlePositions();
  });
}

/**
 * 増分 8A の手直し（GPT #3）: いま見ている年の **確定済みの** 地物 `featureId` が引いている頂点を
 * id → 座標で読む（`__E2E__.getCommittedVertices`）。頂点の印には id が無いので、
 * 「どの頂点が動いたか」を id で照合するときに使う。
 */
export async function committedVertices(
  page: Page,
  featureId: string,
): Promise<Map<string, WorldPos>> {
  const rows = await page.evaluate((id) => {
    const e2e = (window as unknown as {
      __E2E__?: {
        getCommittedVertices: (f: string) => { id: string; lon: number; lat: number }[];
      };
    }).__E2E__;
    return e2e === undefined ? [] : e2e.getCommittedVertices(id);
  }, featureId);
  return new Map(rows.map((r) => [r.id, { lon: r.lon, lat: r.lat }]));
}

/** いま選んでいる頂点の id の全部（`__E2E__.getSelectedVertexIds`。並びは問わないので整列して返す）。 */
export async function selectedVertexIds(page: Page): Promise<string[]> {
  const ids = await page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E__?: { getSelectedVertexIds: () => string[] };
    }).__E2E__;
    return e2e === undefined ? [] : e2e.getSelectedVertexIds();
  });
  return [...ids].sort();
}

/** `before` の頂点のうち、`after` で座標が変わった・引かれなくなったものの id（整列）。 */
export function changedVertexIds(
  before: ReadonlyMap<string, WorldPos>,
  after: ReadonlyMap<string, WorldPos>,
): string[] {
  const out: string[] = [];
  for (const [id, p] of before) {
    const q = after.get(id);
    if (q === undefined || q.lon !== p.lon || q.lat !== p.lat) out.push(id);
  }
  return out.sort();
}

/** いま描いているカメラ（地図の入力層の `data-zoom` / `data-pan-x` / `data-pan-y`）。 */
export async function liveCamera(
  page: Page,
): Promise<{ zoom: number; centerLon: number; centerLat: number }> {
  const layer = page.getByTestId('map-input-layer');
  return {
    zoom: Number((await layer.getAttribute('data-zoom')) ?? '0'),
    centerLon: Number((await layer.getAttribute('data-pan-x')) ?? '0'),
    centerLat: Number((await layer.getAttribute('data-pan-y')) ?? '0'),
  };
}

/** 世界座標 → 窓の座標（描画と同じ式。`render/vtransform.ts` の `worldToScreen`）。 */
export async function worldToClient(page: Page, world: WorldPos): Promise<{ x: number; y: number }> {
  const cam = await liveCamera(page);
  const box = (await page.getByTestId('map-input-layer').boundingBox())!;
  return {
    x: box.x + box.width / 2 + (world.lon - cam.centerLon) * cam.zoom,
    y: box.y + box.height / 2 - (world.lat - cam.centerLat) * cam.zoom,
  };
}

/**
 * **頂点の候補一覧を出す**（K-2 の走査と中身の検査の入口）。合成地物 1 件（一辺 0.05° の
 * 小さな四角）を載せ、一覧から選んで視点を合わせる ―― ズームの上限でも四角は数 px なので、
 * 真ん中を押せば 4 隅が全部掴める距離に入る。押した窓の座標を返す。
 */
export async function openVertexCandidatesOnTinySquare(
  page: Page,
): Promise<{ x: number; y: number }> {
  await loadSyntheticProject(page, 1);
  await armVertexTool(page);
  await page.getByTestId('sidebar-tab-list').click();
  await page.getByTestId('unified-list-filter').fill('合成地物0000');
  await page.getByTestId('feature-list-item-syn-0000').click();
  await expect(page.getByTestId('app-active-feature')).toHaveText('syn-0000');
  await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(4);
  const handles = await vertexHandlePositions(page);
  const centre = {
    lon: handles.reduce((s, h) => s + h.lon, 0) / handles.length,
    lat: handles.reduce((s, h) => s + h.lat, 0) / handles.length,
  };
  const at = await worldToClient(page, centre);
  await page.mouse.click(at.x, at.y);
  await expect(page.getByTestId('vertex-candidates')).toBeVisible();
  return at;
}

/**
 * **保存の前の確認の板**（設計書 §B.5 の台帳 #27。増分 7 の手直し 2 回目）を開く。本体の取り込みで、
 * 台帳の K-2 走査（`inc5-shell.spec.ts`）と「板 × 打鍵」（`inc7-fix-ui.spec.ts`）に載せるために足した。
 * 手順は `inc7-fix2.spec.ts` の A-4 と同じ: 外の国を 1000 年に連邦の下へ入れ、連邦の開始年を
 * 900 年へ動かす（900〜1000 年の下位領域の一覧に、まだ居ない外の国が載る＝年をまたぐ食い違い）。
 * そのうえで Ctrl+S を押す。板は **行き先を決める前** に出るので、保存の行き先の差し替えは要らない。
 */
export async function openPreSaveBoard(page: Page): Promise<void> {
  const parentId = 'syn-nest-parent';
  const parentName = '合成の連邦';
  const outsiderId = 'syn-nest-outsider';
  const outsiderName = '合成の外の国';
  const reveal = async (name: string, featureId: string): Promise<void> => {
    await page.getByTestId('sidebar-tab-list').click();
    await page.getByTestId('unified-list-filter').fill(name);
    await expect(page.getByTestId(`feature-list-item-${featureId}`)).toBeVisible();
  };
  await loadSyntheticNested(page, 2, [1000]);
  await enterEditMode(page);
  await jumpToYear(page, 1000);
  await reveal(outsiderName, outsiderId);
  await page.getByTestId(`ledger-mark-${outsiderId}`).check();
  await page.getByTestId('tool-edit.reparent').click();
  await page.getByTestId('reparent-confirm').click();
  await page.getByTestId(`reparent-parent-existing-pick-item-${parentId}`).click();
  await page.getByTestId('reparent-options-confirm').click();
  await expect(page.getByTestId('reparent-options-dialog')).toHaveCount(0);
  await page.getByTestId('tool-edit.select').click();
  await reveal(parentName, parentId);
  await page.getByTestId(`feature-list-item-${parentId}`).click();
  await expect(page.getByTestId('app-active-feature')).toHaveText(parentId);
  await page.getByTestId('sidebar-tab-properties').click();
  await openPropertySection(page, 'anchor-section');
  await clickClearOfStickyBars(page.getByTestId('anchor-interval-summary-syn-nest-a-1000'));
  await page.getByTestId('anchor-interval-start-syn-nest-a-1000-year').fill('900');
  await clickClearOfStickyBars(page.getByTestId('anchor-interval-start-syn-nest-a-1000-confirm'));
  await jumpToYear(page, 900);
  await reveal(parentName, parentId);
  await page.getByTestId('unified-list-filter').fill('');
  await page.getByTestId('ledger-scroller').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('pre-save-dialog')).toBeVisible();
}

// ---------------------------------------------------------------------------
// 見た目の点検（増分 8E 後半）。巡回（`__tour__`）と `e2e/inc8e-visual-unity.spec.ts` が同じ測り方を使う。
// ---------------------------------------------------------------------------

/** 見えている操作部品 1 個の実寸と計算済みのスタイル。 */
export interface ControlMetrics {
  tag: string;
  type: string | null;
  testid: string | null;
  cls: string;
  text: string;
  w: number;
  h: number;
  /** 文字の行数（縦に重ならない行を数える。同じ行で字の大きさが違っても 1 行）。 */
  lines: number;
  /** 文字が枠の幅からはみ出しているか。 */
  clipped: boolean;
  fontSize: string;
  border: string;
  radius: string;
  bg: string;
  color: string;
  whiteSpace: string;
  /** 窓の外へ出ているか（スクロールの中に居るだけのものも真になる）。 */
  offscreen: boolean;
  /** 実際にスクロールできる祖先の中に居るか（窓の外に居ても、送れば届く）。 */
  inScroller: boolean;
  disabled: boolean;
  pressed: boolean;
  /** 自分と祖先の `opacity` を掛けた値。 */
  opacity: number;
  /**
   * 文字と実際の背景のコントラスト比（小数 1 桁）。中の文字ごとに、祖先の地と透明度を重ね合わせて計算した
   * いちばん低い値。文字が無ければ null。
   */
  contrast: number | null;
}

/** 見えている見出し 1 個の実寸と計算済みのスタイル。 */
export interface HeadingMetrics {
  tag: string;
  text: string;
  h: number;
  fontSize: string;
  fontWeight: string;
  margin: string;
}

/** いま見えている操作部品と見出しを実機で測る（寸法は jsdom では測れない。教訓 5.49）。 */
export async function readControlMetrics(
  page: Page,
): Promise<{ controls: ControlMetrics[]; headings: HeadingMetrics[] }> {
  return page.evaluate(() => {
    const round = (n: number): number => Math.round(n * 10) / 10;
    const textLines = (el: Element): number => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = Array.from(range.getClientRects())
        .filter((r) => r.width > 0 && r.height > 0)
        .sort((a, b) => a.top - b.top);
      let lines = 0;
      let bottom = Number.NEGATIVE_INFINITY;
      for (const r of rects) {
        // 上の行の下端より下から始まるものだけを新しい行と数える（2px は字の高さの違いの遊び）
        if (r.top >= bottom - 2) {
          lines += 1;
          bottom = r.bottom;
        } else {
          bottom = Math.max(bottom, r.bottom);
        }
      }
      return lines;
    };
    type Rgba = readonly [number, number, number, number];
    const parseColor = (text: string): Rgba => {
      const parts = /rgba?\(([^)]+)\)/.exec(text)?.[1]?.split(/[,\s/]+/).filter(Boolean).map(Number) ?? [];
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? (parts.length === 0 ? 0 : 1)];
    };
    const over = (top: Rgba, under: Rgba): Rgba => {
      const a = top[3];
      return [
        top[0] * a + under[0] * (1 - a),
        top[1] * a + under[1] * (1 - a),
        top[2] * a + under[2] * (1 - a),
        1,
      ];
    };
    const luminance = (c: Rgba): number => {
      const channel = (v: number): number => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
    };
    /**
     * 要素の文字の色と地が画面でどんな色になるかを、根から順に重ねて計算する。各段の `opacity` はその段の
     * 中身全体を 1 つ下の段の絵へ混ぜる（`background` の透明度と `opacity` の両方を効かせる）。
     */
    const contrastOf = (el: Element): number => {
      const chain: Element[] = [];
      for (let n: Element | null = el; n !== null; n = n.parentElement) chain.unshift(n);
      const backdrops: Rgba[] = [];
      let paint: Rgba = [255, 255, 255, 1];
      for (const node of chain) {
        backdrops.push(paint);
        paint = over(parseColor(getComputedStyle(node).backgroundColor), paint);
      }
      const toScreen = (color: Rgba): Rgba => {
        let c = color;
        for (let i = chain.length - 1; i >= 0; i -= 1) {
          const element = chain[i] as Element;
          const o = Number(getComputedStyle(element).opacity);
          c = over([c[0], c[1], c[2], o], backdrops[i] as Rgba);
        }
        return c;
      };
      const fg = toScreen(over(parseColor(getComputedStyle(el).color), paint));
      const bg = toScreen(paint);
      const a = luminance(fg);
      const b = luminance(bg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    /** 中の文字を持つ要素ごとのコントラスト比のいちばん低い値。入力欄は自分の値。 */
    const lowestContrast = (el: HTMLElement): number | null => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'select' || tag === 'textarea' || tag === 'input') {
        const type = el.getAttribute('type');
        if (type === 'checkbox' || type === 'radio' || type === 'range' || type === 'color') return null;
        return contrastOf(el);
      }
      let lowest: number | null = null;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if ((node.textContent ?? '').trim() === '') continue;
        const parent = node.parentElement;
        if (parent === null || parent.closest('[hidden]') !== null) continue;
        if (parent.getBoundingClientRect().width === 0) continue;
        const value = contrastOf(parent);
        if (lowest === null || value < lowest) lowest = value;
      }
      return lowest;
    };
    const opacityOf = (el: Element): number => {
      let o = 1;
      for (let n: Element | null = el; n !== null; n = n.parentElement) {
        o *= Number(getComputedStyle(n).opacity);
      }
      return o;
    };
    const inScroller = (el: Element): boolean => {
      for (let n = el.parentElement; n !== null; n = n.parentElement) {
        const y = getComputedStyle(n).overflowY;
        if ((y === 'auto' || y === 'scroll') && n.scrollHeight > n.clientHeight + 1) return true;
        const x = getComputedStyle(n).overflowX;
        if ((x === 'auto' || x === 'scroll') && n.scrollWidth > n.clientWidth + 1) return true;
      }
      return false;
    };
    const controls: ControlMetrics[] = [];
    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>(
        'button,select,input,textarea,summary,[role="button"],[role="tab"],[role="menuitem"]',
      ),
    )) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden') continue;
      controls.push({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        testid: el.getAttribute('data-testid'),
        cls: typeof el.className === 'string' ? el.className : '',
        text: (el.innerText ?? '').trim().slice(0, 40),
        w: round(rect.width),
        h: round(rect.height),
        lines: textLines(el),
        clipped: el.scrollWidth > el.clientWidth + 1,
        fontSize: cs.fontSize,
        border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
        radius: cs.borderTopLeftRadius,
        bg: cs.backgroundColor,
        color: cs.color,
        whiteSpace: cs.whiteSpace,
        offscreen:
          rect.right > window.innerWidth + 1 ||
          rect.bottom > window.innerHeight + 1 ||
          rect.left < -1 ||
          rect.top < -1,
        inScroller: inScroller(el),
        disabled: (el as HTMLButtonElement).disabled === true,
        pressed: el.getAttribute('aria-pressed') === 'true',
        opacity: Math.round(opacityOf(el) * 100) / 100,
        contrast: ((value: number | null): number | null =>
          value === null ? null : Math.floor(value * 10) / 10)(lowestContrast(el)),
      });
    }
    const headings: HeadingMetrics[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'))) {
      const rect = el.getBoundingClientRect();
      if (rect.height === 0) continue;
      const cs = getComputedStyle(el);
      headings.push({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText ?? '').trim().slice(0, 30),
        h: round(rect.height),
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        margin: cs.margin,
      });
    }
    return { controls, headings };
  });
}

/**
 * いま見えている操作部品を **全部無効にしたとき** の測定（測ったらすぐ元へ戻す）。部品のクラスの色が土台の無効の
 * 色の組に勝っていないかを、その局面で無効になれない部品も含めて見る。
 */
export async function readControlMetricsAllDisabled(page: Page): Promise<ControlMetrics[]> {
  const MARK = 'data-probe-disabled';
  await page.evaluate((mark) => {
    for (const el of Array.from(document.querySelectorAll<HTMLButtonElement>('button,select,input,textarea'))) {
      if (!el.disabled) {
        el.setAttribute(mark, '');
        el.disabled = true;
      }
    }
  }, MARK);
  try {
    return (await readControlMetrics(page)).controls;
  } finally {
    await page.evaluate((mark) => {
      for (const el of Array.from(document.querySelectorAll<HTMLButtonElement>(`[${mark}]`))) {
        el.removeAttribute(mark);
        el.disabled = false;
      }
    }, MARK);
  }
}

/** 揃えた高さ（設計変数 24 / 28 / 32）と、道具のレール（32）・地図のズーム（40）。 */
const ALLOWED_CONTROL_HEIGHTS = [24, 28, 32, 40];

/**
 * 揃えた高さに乗らないボタン（細い行の中で行の高さに従うもの、中身で高さが決まる選択肢）と、その下限。名指しに絞る（教訓 5.83）。
 * 所属の候補と状態行のボタンはここへ入れない ―― 揃えた高さに乗っているので、普通の検査で見る。
 */
const ROW_BOUND_CONTROLS: readonly { readonly name: RegExp; readonly min: number }[] = [
  { name: /^ledger-(expand|kind|eye)-/, min: 16 },
  { name: /^feature-list-item-/, min: 16 },
  { name: /^conflict-row-select-/, min: 16 },
  // 分割の継承先の選択は、名前と説明の 2 行を持つ選択肢（下限は押せる高さ）。
  { name: /^knife-choose-/, min: 28 },
];

/** 1 ボタンの中に複数行の情報を並べる行（ラベルではない）。 */
const MULTI_LINE_ROW = /^(anchor-row-|conflict-row-select-|backup-row-|knife-choose-)/;

/** 確定の文そのものが板の幅より長いボタン（文言は総点検で直す。docs/現状.md の B103）。 */
const LONG_LABEL = new Set(['pre-save-confirm']);

/** 幅が決まっていて省略記号で切る前提のボタン（全文は吹き出しで読める）。 */
const CLIPS_BY_DESIGN = /^ledger-kind-/;

/** 土台の本文の色。無効なのにこの色なら、見た目が押せるボタンと同じになる。 */
const BODY_TEXT_COLOR = 'rgb(31, 39, 51)';

/** 読める文字として求めるコントラスト比。 */
export const MIN_CONTRAST = 4.5;

/** 測った操作部品の中で、見た目の決まりから外れているものを文にして返す（巡回と E2E が同じ判定を使う）。 */
export function controlProblems(controls: readonly ControlMetrics[]): string[] {
  const out: string[] = [];
  for (const c of controls) {
    const name = c.testid ?? `.${c.cls}`;
    const readable = c.tag === 'button' || c.tag === 'select' || c.tag === 'textarea' || c.tag === 'input';
    if (readable && c.contrast !== null && c.contrast < MIN_CONTRAST) {
      out.push(`${name}: コントラスト比 ${String(c.contrast)}「${c.text}」${c.disabled ? '（無効）' : ''}${c.pressed ? '（押されている）' : ''}`);
    }
    if (c.disabled && c.opacity < 1) out.push(`${name}: 無効に透明度を重ねている (${String(c.opacity)})`);
    if (c.offscreen && !c.inScroller) out.push(`${name}: 窓の外に出て、スクロールでも届かない「${c.text}」`);
    if (c.tag !== 'button') continue;
    if (c.disabled && c.color === BODY_TEXT_COLOR) out.push(`${name}: 無効なのに本文の色のまま「${c.text}」`);
    if (c.clipped && !CLIPS_BY_DESIGN.test(name)) out.push(`${name}: 文字が幅から切れる「${c.text}」`);
    if (c.border.includes('outset')) out.push(`${name}: ブラウザ既定の枠 (${c.border})`);
    if (c.radius === '0px' && !c.border.startsWith('0px')) out.push(`${name}: 角丸なしの枠`);
    const bound = ROW_BOUND_CONTROLS.find((r) => r.name.test(name));
    if (bound !== undefined) {
      if (c.h < bound.min) out.push(`${name}: 行の中のボタンが低すぎる ${String(c.h)}px`);
    } else if (!LONG_LABEL.has(name) && !ALLOWED_CONTROL_HEIGHTS.some((h) => Math.abs(c.h - h) <= 0.5)) {
      out.push(`${name}: 高さ ${String(c.h)}px`);
    }
    if (c.lines > 1 && !MULTI_LINE_ROW.test(name) && !LONG_LABEL.has(name)) {
      out.push(`${name}: ${String(c.lines)} 行に折り返す「${c.text}」`);
    }
  }
  return [...new Set(out)];
}
