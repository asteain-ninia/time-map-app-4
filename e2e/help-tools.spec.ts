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

import { launchApp, loadSyntheticProject } from './helpers';

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

  // **増分 4 で行き先が変わった**（E-6）。「地物を検索」は独立したモーダルをやめ、
  // **地物一覧の絞り込み欄へ焦点を入れるだけ**になった。母集団が一覧と 2 つある状態
  // （N-41）と、年を属性の検索対象に入れていた罠（C10）がこれで構造的に消える。
  //
  // **焦点が入るところで終わらせない**（2026-09-05 の手直し F4。審査 Grok 3.3）。旧版は
  // 打った文字が欄に入ることまでしか見ていなかったので、「メニューは正しい欄へ連れて行くが、
  // その欄が一覧を絞っていない」状態を素通りさせる。地物を載せてから **行が本当に減る**
  // ところまで見る（この経路が果たす仕事は「絞り込める場所へ連れて行く」ことだからである）。
  test('ツール → 地物を検索 は地物一覧の絞り込み欄へ焦点を入れ、そこで絞り込める（E-6）', async () => {
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 12);

      // 独立した検索モーダルはもう無い。
      await clickMenuCommand(page, 'tools', 'tools.search');
      await expect(page.getByTestId('search-panel')).toHaveCount(0);

      // 一覧の区画へ寄り、絞り込み欄に焦点が入っている（打てばそのまま絞り込める）。
      await expect(page.getByTestId('sidebar-tab-list')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      const filter = page.getByTestId('unified-list-filter');
      await expect(filter).toBeFocused();

      // **件数の表示で見る**（DOM の行数では見ない ―― 一覧は仮想スクロールなので、
      // 窓に入っている行しか DOM に無い）。
      const count = page.getByTestId('unified-list-count');
      await expect(count).toHaveText('12件');

      // 焦点はもう欄にあるので、そのまま打てば絞り込まれる。
      await page.keyboard.type('0003');
      await expect(filter).toHaveValue('0003');
      await expect(count).toHaveText('1 / 12件');
      await expect(page.getByTestId('feature-list-item-syn-0003')).toContainText(
        '合成地物0003',
      );
    } finally {
      await app.close();
    }
  });

  // 増分 4 / 設計書 §C.2 の 26: どこへでも移動（Ctrl+P）。**数字だけなら年の候補だけ**
  // を出す ―― 現状の検索は年を属性の検索対象に入れていたので数字 1 文字でほぼ全件が
  // 一致した（C10）。同じ罠を作り直していないことを実アプリで見る。
  test('ツール → どこへでも移動 に「1」と打つと年の候補だけが出る（C10 の罠を作らない）', async () => {
    const { app, page } = await launchApp();
    try {
      // **打鍵からも開く**（設計書 §I.2 の Ctrl+P）。メニューからしか開かないと、
      // 「全機能への保険の経路」という役目を果たさない。
      await page.keyboard.press('Control+p');
      const palette = page.getByTestId('jump-palette');
      await expect(palette).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(palette).toHaveCount(0);

      await clickMenuCommand(page, 'tools', 'tools.jump');
      await expect(palette).toBeVisible();
      await page.getByTestId('jump-palette-input').fill('1');
      const items = palette.locator('[data-kind]');
      await expect(items).toHaveCount(1);
      await expect(items.first()).toHaveAttribute('data-kind', 'year');
      // Escape で閉じる（Esc の階段）。
      await page.keyboard.press('Escape');
      await expect(palette).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  // 増分 4 の手直し C1〜C3。**地物がある状態で**中身まで見る ―― 空のプロジェクトでは
  // 「候補が 0 件」と「候補が出ない不具合」の区別が付かない（`>` の候補が常に 0 件
  // だった粗は、まさにそれで見逃されていた）。
  test('どこへでも移動: 地物名で飛べる / > でコマンドが出る / 外を押すと閉じる', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 30);
      await page.keyboard.press('Control+p');
      const palette = page.getByTestId('jump-palette');
      await expect(palette).toBeVisible();

      // ①地物名で飛ぶ（＝一覧と同じ母集団から選べている）。
      await page.getByTestId('jump-palette-input').fill('合成地物0007');
      await expect(palette.locator('[data-kind="feature"]').first()).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(palette).toHaveCount(0);
      await expect(page.getByTestId('app-active-feature')).toHaveText('syn-0007');

      // ②`>` でコマンドが出る（旧: 初回描画の空の登録簿が凍って **常に 0 件**）。
      await page.keyboard.press('Control+p');
      await page.getByTestId('jump-palette-input').fill('>');
      await expect(palette.locator('[data-kind="command"]').first()).toBeVisible();
      // 読むだけでは編集のコマンドが候補に出ない（K-6 の関門を通っている）。
      await expect(page.getByTestId('app-mode')).toHaveText('view');
      await expect(
        palette.locator('[data-testid="jump-palette-item-edit.delete"]'),
      ).toHaveCount(0);

      // ③**外を押すと閉じる**（旧: 焦点が body へ行って Escape も効かず、開いている
      // あいだは大域の鍵盤も止まるので、閉じる手段が 1 つも無くなった）。
      await page.getByTestId('statusbar').click();
      await expect(palette).toHaveCount(0);

      // ④閉じるボタンでも閉じる（閉じ方が画面から分かる）。
      await page.keyboard.press('Control+p');
      await expect(palette).toBeVisible();
      await page.getByTestId('jump-palette-close').click();
      await expect(palette).toHaveCount(0);
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
