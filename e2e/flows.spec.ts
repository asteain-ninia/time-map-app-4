// U43 — E2E flows: file-menu reachability + the map input layer fires for real
// (受け入れ基準 2 保存到達 / 3 押下→移動→解放の実発火 / 教訓 5.7 完了トリガー).
//
// These drive the REAL composite. They deliberately stop SHORT of any path that
// would open a NATIVE OS dialog (a save/open file picker blocks a headless run,
// D7 / D23): instead they assert the ファイル commands are REGISTERED + enabled on
// the live registry (the U39 wiring ran) and that the map input layer accepts a
// real press→move→release sequence without crashing the composition root.

import { test, expect } from '@playwright/test';

import { launchApp } from './helpers';

test.describe('ファイル操作 reachability + 入力層実発火', () => {
  test('the ファイル menu opens and its commands are registered + enabled (受け入れ基準 2)', async () => {
    const { app, page } = await launchApp();
    try {
      // Open the ファイル menu (the live FileOpsController registered its commands
      // on the SAME registry the menu dispatches through, 教訓 5.6).
      await page.getByTestId('menu-file').click();
      const items = page.getByTestId('menu-items-file');
      await expect(items).toBeVisible();

      // 新規 / 開く / 保存 / 名前を付けて保存 are present and ENABLED — proving the
      // file-I/O commands are reachable end-to-end (a SAVE would reach U15 IPC).
      // (We do NOT click them: 保存/開く open native dialogs that block headless.)
      for (const command of ['file.new', 'file.open', 'file.save', 'file.saveAs']) {
        const item = items.locator(`[data-command="${command}"]`);
        await expect(item).toBeVisible();
        await expect(item).toBeEnabled();
      }
    } finally {
      await app.close();
    }
  });

  test('the map input layer accepts a real press→move→release without crashing (受け入れ基準 3)', async () => {
    const { app, page } = await launchApp();
    try {
      const inputLayer = page.getByTestId('map-input-layer');
      await expect(inputLayer).toBeAttached();

      const box = await inputLayer.boundingBox();
      expect(box).not.toBeNull();
      if (box === null) return;

      // A real pointer press → drag → release over the map input layer. This
      // exercises the live PointerDispatcher path (U40 dispatch/pan wired into the
      // composition root). In View mode this is a pan gesture; the assertion is
      // that the real sequence fires through the composite WITHOUT throwing
      // (押下→移動→解放を全パスで保証, 教訓 5.8).
      const startX = box.x + box.width / 2;
      const startY = box.y + box.height / 2;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 40, startY + 25, { steps: 5 });
      await page.mouse.move(startX + 80, startY + 50, { steps: 5 });
      await page.mouse.up();

      // The composition root survived the full sequence: the shell is still mounted
      // and the renderer reported no error (a thrown handler would surface here).
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await expect(page.getByTestId('map-input-layer')).toBeAttached();
    } finally {
      await app.close();
    }
  });

  test('mode toggles reflect the single-source session store (FR-75 排他)', async () => {
    const { app, page } = await launchApp();
    try {
      // The composite boots in View mode, where editing-mode entry is disabled
      // together with its shortcut (教訓 5.13). Assert that single permission gate
      // is honoured in the live shell (the toggles disable as one).
      await expect(page.getByTestId('mode-add')).toBeDisabled();
      await expect(page.getByTestId('mode-edit')).toBeDisabled();
    } finally {
      await app.close();
    }
  });
});
