// U43 — shared E2E helper: launch the BUILT Electron app headless and return the
// app handle + the renderer page. Every spec uses this so the launch contract
// (offscreen, E2E_TEST=1, sandbox kept on) lives in one place (単一の真実源).

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
export async function launchApp(): Promise<LaunchedApp> {
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

/**
 * Leave the default View mode and select 追加モード (add). In View the add/edit
 * toggles are disabled; toggling 表示専用 off enables them, then 追加モード arms add.
 * This is the SAME live導線 the regression suite drives (no overlay bypass).
 */
export async function enterAddMode(page: Page): Promise<void> {
  const viewToggle = page.getByTestId('mode-view');
  await expect(viewToggle).toBeVisible();
  if ((await viewToggle.getAttribute('aria-pressed')) === 'true') {
    await viewToggle.click();
  }
  const addMode = page.getByTestId('mode-add');
  await expect(addMode).toBeEnabled();
  await addMode.click();
  await expect(addMode).toHaveAttribute('aria-pressed', 'true');
}

/**
 * Commit ONE real 面 (face) feature through the LIVE add flow so it renders on the
 * map canvas (D23 evidence: a committed feature is genuinely drawn, not faked).
 * Drives the same press/click path a user does — 追加モード → 面ツール → 4 corners →
 * 完了 → 保存 — and waits until the live selection re-resolves to the new feature
 * (the committed-feature signal, 教訓 5.11). Returns once the feature is committed.
 */
export async function commitOneFace(page: Page): Promise<void> {
  await enterAddMode(page);
  await page.getByTestId('tool-add.area').click();
  const addLayer = page.getByTestId('add-input-layer');
  await expect(addLayer).toBeVisible();
  const box = await addLayer.boundingBox();
  expect(box).not.toBeNull();
  const b = box!;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  // A square ~240×240 px centred in the layer (clearly visible on the canvas).
  const corners: ReadonlyArray<readonly [number, number]> = [
    [cx - 120, cy - 120],
    [cx + 120, cy - 120],
    [cx + 120, cy + 120],
    [cx - 120, cy + 120],
  ];
  for (const [px, py] of corners) await page.mouse.click(px, py);
  const complete = page.getByTestId('add-complete');
  await expect(complete).toBeEnabled();
  await complete.click();
  await page.getByTestId('add-save').click();

  // The add committed and the live selection re-resolved to the new face: the
  // hidden observability marker is now non-empty (a real committed feature).
  // `toHaveText(/\S/)` polls under the configured expect timeout (15s) and fails
  // fast on a genuine miss — unlike a bare `toPass()`, which defaults to a 0
  // timeout and would poll until the 60s test deadline.
  await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);
}
