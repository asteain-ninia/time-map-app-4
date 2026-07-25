// FR-107 close ブリッジ（終了確認ガード）の behavioural E2E — 実機 composite 経由.
//
// 修正前は `createWindow` に `window.on('close')` が無く、× / Alt+F4 / タスクバー /
// OS シャットダウンは **未保存確認を一切通さずに** ウィンドウを閉じていた（残 HIGH の
// データ損失リスク）。ここでは実物の main プロセス上で `win.close()` を発火させ、
//   (1) 未保存があるとウィンドウは閉じず、レンダラに 3 択ダイアログが出る,
//   (2) キャンセルを選ぶとウィンドウは開いたまま（= 閉じない契約）,
//   (3) 「保存せずに続行」を選ぶと実際に閉じる（ガードは通せんぼではない）,
//   (4) 未保存が無ければダイアログ無しで閉じる,
//   (5) ダイアログ表示中に close が再来しても 2 枚目のダイアログは開かない,
// を実測で固定する。
//
// ⚠️ ハーネス制約（正直な限界）:
//   - `win.close()` は「× ボタン / Alt+F4 / タスクバーの閉じる」と **同じ**
//     `close` イベント経路（Electron が発火する window close）だが、OS 由来の
//     シャットダウン（WM_QUERYENDSESSION）そのものは Playwright から発火できない。
//     OS シャットダウンは同じ close イベントを通るのでコードパスは共有だが、
//     「Windows がガードの preventDefault を尊重するか」は実機手動確認の領域。
//   - `electronApp.close()` は main で `app.quit()` を評価してプロセス終了を待つ実装
//     （playwright-core 実測）。未保存のままだとガードが quit を止めて teardown が
//     固まるため、合成ルートは **E2E_TEST の時だけ** quit 由来の close を素通しにする
//     （src/shell/main/index.ts の before-quit）。したがってこの spec が検証するのは
//     `window.close()` 経路（= × / Alt+F4 相当）であり、quit 経路の E2E ではない。
//     quit 経路の状態機械は close-guard.test.ts の単体テストで固定している（教訓 5.41
//     の二重固め: E2E が赤いとき「UI 結線」か「ガード判定」かを切り分けられる）。

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';

import { launchApp, commitOneFace } from './helpers';

/** Fire the REAL window close event from main (× / Alt+F4 と同じ経路). */
async function requestClose(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win !== undefined) win.close();
  });
}

/**
 * 所見1 [HIGH] fail-OPEN の再現子: **開始したが commit しないナビゲーション**。
 * 元 document（App + 未保存編集）は生きているのに、旧実装の片方向 rendererLoaded ラッチは
 * did-finish-load を二度と受けず恒久 false のまま → close が確認を省略して閉じていた
 * （実機 probe: 編集 → loadURL(TEST-NET-1) → 300ms 後 stop() → close で 3 択なしに即クローズ）。
 * TEST-NET-1 (192.0.2.1, RFC 5737 の到達不能アドレス) への遷移は did-start-loading を
 * 即発火させるが、stop() で commit 前に中断するので現 document は破棄されず生き残る。
 */
async function startAndAbortNavigation(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win === undefined) return;
    // fire-and-forget: stop() で中断されると loadURL は reject するので握る（await しない）。
    void win.webContents.loadURL('http://192.0.2.1/never-commits').catch(() => undefined);
    await new Promise<void>((r) => setTimeout(r, 300));
    // commit 前に中断 — 現 document（App+編集）はそのまま生き残る。
    win.webContents.stop();
  });
}

/** The number of live windows as MAIN sees it (the only truth for "closed"). */
async function liveWindows(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

/**
 * Give main a round-trip's worth of time to have acted on a close request, so
 * "the window is still open" is an observation and not an un-awaited race.
 */
async function settle(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => new Promise<void>((r) => setTimeout(r, 300)));
}

/**
 * The 3-choice unsaved warning (the SAME dialog 開く / 新規 use, 教訓 5.6).
 *
 * ⚠️ 実測知見: `unsaved-modal-root` は `DraggablePanel`(絶対配置) を包むだけの器なので
 * 自身のボックスが 0×0 になり、Playwright の可視判定では **hidden** と出る（要素は
 * 存在する）。可視性の主張はパネル本体 `unsaved-dialog` に対して行う。
 */
function unsavedDialog(page: Page) {
  return page.getByTestId('unsaved-dialog');
}

test.describe('FR-107 終了確認ガード（close ブリッジ）', () => {
  test('未保存のまま閉じようとすると閉じず、未保存警告が出る（キャンセルで開いたまま）', async () => {
    const { app, page } = await launchApp();
    try {
      await commitOneFace(page); // 実編集 → projectDirty
      await expect(unsavedDialog(page)).toBeHidden();

      await requestClose(app);

      // 修正前: ここでウィンドウが消える（ダイアログは出ない）= データ損失。
      await expect(unsavedDialog(page)).toBeVisible();
      expect(await liveWindows(app)).toBe(1);

      // キャンセル → 閉じない（現状維持）。
      await page.getByTestId('unsaved-cancel').click();
      await expect(unsavedDialog(page)).toBeHidden();
      await settle(app);
      expect(await liveWindows(app)).toBe(1);
      await expect(page.getByTestId('app-shell')).toBeVisible();
    } finally {
      await app.close().catch(() => undefined);
    }
  });

  test('警告表示中に close が再来しても 2 枚目のダイアログは開かない（二重照会防止）', async () => {
    const { app, page } = await launchApp();
    try {
      await commitOneFace(page);
      await requestClose(app);
      await expect(unsavedDialog(page)).toBeVisible();

      // 2 回目・3 回目の × 相当。main は照会中なので新しい IPC を送らない。
      await requestClose(app);
      await requestClose(app);
      await settle(app);

      expect(await page.getByTestId('unsaved-modal-root').count()).toBe(1);
      expect(await liveWindows(app)).toBe(1);

      // 最初のダイアログは生きたまま（resolver が孤児化していない）: キャンセルが効く。
      await page.getByTestId('unsaved-cancel').click();
      await expect(unsavedDialog(page)).toBeHidden();
      expect(await liveWindows(app)).toBe(1);
    } finally {
      await app.close().catch(() => undefined);
    }
  });

  test('「保存せずに続行」を選ぶと実際に閉じる（ガードは通せんぼではない）', async () => {
    const { app, page } = await launchApp();
    try {
      await commitOneFace(page);
      await requestClose(app);
      await expect(unsavedDialog(page)).toBeVisible();

      await page.getByTestId('unsaved-discard').click();

      // 許可 → main が one-shot フラグ付きで再 close → ウィンドウが消える。
      await expect
        .poll(async () => app.windows().length, { timeout: 15_000 })
        .toBe(0);
    } finally {
      await app.close().catch(() => undefined);
    }
  });

  test('所見1: 中断ナビゲーション後も未保存確認が出る（fail-OPEN しない）', async () => {
    const { app, page } = await launchApp();
    try {
      await commitOneFace(page); // 実編集 → projectDirty
      await expect(unsavedDialog(page)).toBeHidden();

      // 開始したが commit しないナビゲーション（webContents.stop で中断）。旧実装なら
      // これで rendererLoaded が恒久 false になり、次の close が確認を省略して閉じた。
      await startAndAbortNavigation(app);
      // 元 document（App）は生き残っている（中断ナビは現 document を破棄しない）。
      await expect(page.getByTestId('app-shell')).toBeVisible();

      await requestClose(app);

      // 根治後: 生きている購読者が即 ACK を返すので、ロード状態に依存せず 3 択が出る。
      // 旧実装ではここでウィンドウが消える（ダイアログ無し）= データ損失。
      await expect(unsavedDialog(page)).toBeVisible();
      expect(await liveWindows(app)).toBe(1);

      // キャンセルで開いたまま（確認は本当に機能している）。
      await page.getByTestId('unsaved-cancel').click();
      await expect(unsavedDialog(page)).toBeHidden();
      await settle(app);
      expect(await liveWindows(app)).toBe(1);
    } finally {
      await app.close().catch(() => undefined);
    }
  });

  test('未保存が無ければ確認なしで閉じる（クリーンなプロジェクトを妨げない）', async () => {
    const { app, page } = await launchApp();
    try {
      // 起動直後は未編集 = クリーン。
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await requestClose(app);

      await expect
        .poll(async () => app.windows().length, { timeout: 15_000 })
        .toBe(0);
    } finally {
      await app.close().catch(() => undefined);
    }
  });
});
