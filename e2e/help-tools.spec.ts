// HB-8 / HB-9 — behavioural regression: the ツール (設定 / 検索) と ヘルプ
// (バージョン情報 / ショートカット一覧 / 診断情報) menu items are ACTIVE and a real
// click OPENS the corresponding view. The human bug: every one of these items
// rendered permanently grayed because no unit registered a handler (未登録==無効,
// the HB-4 class of dead command). This spec drives the live built composite
// through Playwright for Electron (the same launch contract as the rest of e2e/),
// and asserts the STATE CHANGE — menu item enabled → real click → view visible —
// using real input (click). It locks the regression: if any of the five handlers
// stops being registered, its menu item grays out and this reddens.

import { test, expect, type Page } from '@playwright/test';

import { launchApp } from './helpers';

/** Open a top menu, assert the given command item is enabled, and click it. */
async function clickMenuCommand(page: Page, menu: string, commandId: string): Promise<void> {
  await page.getByTestId(`menu-${menu}`).click();
  const items = page.getByTestId(`menu-items-${menu}`);
  await expect(items).toBeVisible();
  const item = items.locator(`[data-command="${commandId}"]`);
  await expect(item).toBeVisible();
  // The core HB-8/HB-9 assertion: the item is ENABLED (it was 未登録==無効 before).
  await expect(item).toBeEnabled();
  await item.click();
}

test.describe('HB-8 / HB-9 — ツール / ヘルプ コマンドが活性で実クリックで開く (live UI)', () => {
  test('ツール → 設定 opens the settings dialog', async () => {
    const { app, page } = await launchApp();
    try {
      await clickMenuCommand(page, 'tools', 'tools.settings');
      // The U38 dialog is mounted and its project/app tabs are present.
      await expect(page.getByTestId('settings-dialog')).toBeVisible();
      await expect(page.getByTestId('settings-tab-project')).toBeVisible();
      await expect(page.getByTestId('settings-tab-app')).toBeVisible();
      // A real interaction: switching to the app tab shows an app-scope field.
      await page.getByTestId('settings-tab-app').click();
      await expect(page.getByTestId('settings-app')).toBeVisible();
      // Close via cancel (every exit path closes — 教訓 5.2).
      await page.getByTestId('settings-cancel').click();
      await expect(page.getByTestId('settings-dialog')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('ツール → 地物を検索 opens the search panel and a real search runs', async () => {
    const { app, page } = await launchApp();
    try {
      await clickMenuCommand(page, 'tools', 'tools.search');
      await expect(page.getByTestId('search-panel')).toBeVisible();
      // Real input: type a query and click 検索; the result section appears.
      await page.getByTestId('search-panel-input').fill('ローマ');
      await page.getByTestId('search-panel-run').click();
      await expect(page.getByTestId('search-panel-results')).toBeVisible();
      await page.getByTestId('search-panel-close').click();
      await expect(page.getByTestId('search-panel')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('ヘルプ → バージョン情報 shows the app version', async () => {
    const { app, page } = await launchApp();
    try {
      await clickMenuCommand(page, 'help', 'help.about');
      await expect(page.getByTestId('about-panel')).toBeVisible();
      // The injected version is a non-empty string (package.json version).
      await expect(page.getByTestId('about-panel-version')).toHaveText(/\S/);
      await page.getByTestId('about-panel-close').click();
      await expect(page.getByTestId('about-panel')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('ヘルプ → ショートカット一覧 lists the menu accelerators', async () => {
    const { app, page } = await launchApp();
    try {
      await clickMenuCommand(page, 'help', 'help.shortcuts');
      await expect(page.getByTestId('shortcuts-panel')).toBeVisible();
      // At least one row is present and the 保存 accelerator is shown from the live
      // keymap (single source of truth — STANDARD_MENUS).
      await expect(page.getByTestId('shortcuts-panel-row').first()).toBeVisible();
      await expect(page.getByTestId('shortcuts-panel-key-file.save')).toHaveText(/\S/);
      await page.getByTestId('shortcuts-panel-close').click();
      await expect(page.getByTestId('shortcuts-panel')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('ヘルプ → 診断情報 shows a non-sensitive overview', async () => {
    const { app, page } = await launchApp();
    try {
      await clickMenuCommand(page, 'help', 'help.diagnostics');
      await expect(page.getByTestId('diagnostics-panel')).toBeVisible();
      // Boot is a fresh empty project: zero features, no unsaved changes.
      await expect(page.getByTestId('diagnostics-feature-count')).toHaveText('0');
      await expect(page.getByTestId('diagnostics-unsaved')).toHaveText('なし');
      await page.getByTestId('diagnostics-panel-close').click();
      await expect(page.getByTestId('diagnostics-panel')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});
