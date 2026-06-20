// HB-4 — behavioral regression: the 表示専用 (View-only) 導線 actually enables the
// editing tools, and a 面 can be added through the REAL UI path (no controller
// 直叩き). The human bug: on boot the toolbar was grayed out except for the save
// commands and there was no working way into 編集 / 追加モード — the named導線
// (ViewToggleViewMode) did nothing in the menu and the edit tools stayed disabled.
//
// This spec drives the live built composite through Playwright for Electron (the
// same launch contract as the rest of e2e/, via launchApp) and asserts the STATE
// CHANGE — disabled → enabled, mode flip, a committed face — using real input
// (click / mouse) and the observation hooks (app-mode / per-tool disabled /
// app-active-feature). It locks the regression: if the toolbar grays out again or
// the導線 stops flipping the mode, this reddens.

import { test, expect } from '@playwright/test';

import { launchApp } from './helpers';

test.describe('HB-4 — 表示専用解除で編集ツールが活性化する (live UI)', () => {
  test('boot in View: edit tools disabled, then the toolbar 表示専用 toggle enables 追加モード and a face is added via the real UI', async () => {
    const { app, page } = await launchApp();
    try {
      // 1. BOOT STATE — the composite starts in 表示専用 (View). The named導線
      //    (the 表示専用 toolbar button) is enabled and pressed; the add/edit mode
      //    toggles AND every add tool are disabled together (教訓 5.13 single gate).
      await expect(page.getByTestId('app-mode')).toHaveText('view');
      const viewToggle = page.getByTestId('mode-view');
      await expect(viewToggle).toBeEnabled();
      await expect(viewToggle).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('mode-add')).toBeDisabled();
      await expect(page.getByTestId('mode-edit')).toBeDisabled();

      // 2. LEAVE View through the live导线 (a real click on the toolbar button).
      //    The mode flips to 編集モード (the sensible editable default the導线
      //    contract lands in — SAME as useShell.setViewOnly) and the mode toggles
      //    become enabled — the cause (mode) AND the effect (buttons) both observable.
      await viewToggle.click();
      await expect(page.getByTestId('app-mode')).toHaveText('edit');
      await expect(viewToggle).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByTestId('mode-add')).toBeEnabled();
      await expect(page.getByTestId('mode-edit')).toBeEnabled();

      // 3. ENTER 追加モード and confirm its tools are now ACTIVE (no longer grayed):
      //    every add-mode tool button is enabled.
      const addMode = page.getByTestId('mode-add');
      await addMode.click();
      await expect(addMode).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('app-mode')).toHaveText('add');
      for (const tool of ['add.point', 'add.line', 'add.area']) {
        await expect(page.getByTestId(`tool-${tool}`)).toBeEnabled();
      }

      // 4. ADD A FACE through the REAL UI path: 面ツール → 四隅クリック → 完了 → 保存.
      //    This proves editing is genuinely reachable end-to-end (D23 evidence: a
      //    committed feature, not a controller 直叩き). The active tool hook shows
      //    the selection; the committed-feature marker confirms the save landed.
      await page.getByTestId('tool-add.area').click();
      await expect(page.getByTestId('app-active-tool')).toHaveText('add.area');

      const addLayer = page.getByTestId('add-input-layer');
      await expect(addLayer).toBeVisible();
      const box = await addLayer.boundingBox();
      expect(box).not.toBeNull();
      const b = box!;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
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
      // hidden observability marker is now non-empty (a real committed feature
      // through the live add binding — the editing path is fully reachable).
      await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);
    } finally {
      await app.close();
    }
  });

  test('the 表示 menu 表示専用モード切替 command is registered + enabled and flips the mode (named導線 ViewToggleViewMode)', async () => {
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-mode')).toHaveText('view');

      // Open the 表示 menu and assert the view-mode-toggle item is ENABLED (it was
      // 未登録==無効 before HB-4 — a dead导线). A real click flips the mode out of
      // View, proving the menu命令 and the store are one truth (教訓 5.13).
      await page.getByTestId('menu-view').click();
      const items = page.getByTestId('menu-items-view');
      await expect(items).toBeVisible();
      const toggleItem = items.locator('[data-command="view.toggleViewMode"]');
      await expect(toggleItem).toBeVisible();
      await expect(toggleItem).toBeEnabled();
      await toggleItem.click();

      // The mode left View → 編集 (the SAME transition the toolbar导线 drives) and
      // the toolbar edit toggles activated together — the menu导线 reaches the SAME
      // gate/store the toolbar does (教訓 5.13 単一真実源).
      await expect(page.getByTestId('app-mode')).toHaveText('edit');
      await expect(page.getByTestId('mode-add')).toBeEnabled();
      await expect(page.getByTestId('mode-edit')).toBeEnabled();

      // Re-dispatch the SAME menu命令: it toggles back to View (the reversal
      // contract), proving it is a real toggle, not a one-way switch.
      await page.getByTestId('menu-view').click();
      await expect(items).toBeVisible();
      await expect(toggleItem).toBeEnabled();
      await toggleItem.click();
      await expect(page.getByTestId('app-mode')).toHaveText('view');
      await expect(page.getByTestId('mode-add')).toBeDisabled();
      await expect(page.getByTestId('mode-edit')).toBeDisabled();
    } finally {
      await app.close();
    }
  });
});
