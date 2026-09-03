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

import {
  addInputLayerBox,
  commitOneFace,
  drawFace,
  enterEditMode,
  launchApp,
  returnToViewMode,
  squareCorners,
} from './helpers';

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

      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      // 頂点クリック → 完了 → 保存 → 選択の再解決待ち は drawFace が担う。
      // The add committed and the live selection re-resolved to the new face: the
      // hidden observability marker is now non-empty (a real committed feature
      // through the live add binding — the editing path is fully reachable).
      await drawFace(page, squareCorners(cx, cy, 120));
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

  // HB-16 — the left toolbar's mode-toggle buttons must carry NO tooltip (the
  // hover bubble obstructed the click target), while the tool buttons keep theirs.
  // Behavioral: assert no tooltip element near the mode buttons, that they still
  // function on a real click, and that a tool button still has its tooltip.
  test('mode-toggle buttons have no tooltip and still work; tool tooltips remain (HB-16)', async () => {
    const { app, page } = await launchApp();
    try {
      // No tooltip wrapper (data-testid="tooltip") or role="tooltip" bubble inside the mode group.
      const modeGroup = page.getByTestId('toolbar-modes');
      await expect(modeGroup).toBeVisible();
      await expect(modeGroup.getByTestId('tooltip')).toHaveCount(0);
      await expect(modeGroup.locator('[role="tooltip"]')).toHaveCount(0);
      // The mode buttons themselves are not wrapped by a tooltip container.
      for (const id of ['mode-view', 'mode-add', 'mode-edit']) {
        // 「このボタンを内側に持つツールチップの包み」が 0 個 (祖先に tooltip が無い)。
        await expect(page.getByTestId('tooltip').filter({ has: page.getByTestId(id) })).toHaveCount(0);
      }

      // They still function: leave View via mode-view, then enter 追加モード.
      await expect(page.getByTestId('app-mode')).toHaveText('view');
      await page.getByTestId('mode-view').click();
      await expect(page.getByTestId('app-mode')).toHaveText('edit');
      await page.getByTestId('mode-add').click();
      await expect(page.getByTestId('app-mode')).toHaveText('add');

      // Tool buttons still carry their tooltip (regression: not all removed).
      const toolBtn = page.getByTestId('tool-add.point');
      await expect(page.getByTestId('tooltip').filter({ has: toolBtn })).toHaveCount(1);
    } finally {
      await app.close();
    }
  });
});

test.describe('K-6 — 「読むだけ」では削除に手が届かない (N-03 の回帰)', () => {
  // N-03 は「表示専用モードでも『地物を削除』だけが押せる」と報告されていたが、**実アプリ
  // では今のところ届かない**。モードを切り替えると store.setMode が選択を捨てる（結合点 #6）
  // ので、素性欄に地物が出ず、削除ボタンがそもそも描かれないためである。
  //
  // 欠陥は部品の契約のほうに実在した: DeleteFeatureButton は権限の入力を持たず、
  // PropertyPanel も権限を渡さずに onDeleteFeature を直接呼んでいた。つまり **「読むだけ」で
  // 地物が選ばれたまま素性欄が出る状態になった瞬間に押せるようになる**。設計書 §D.2 ★★ は
  // まさにそれ（鍵を閉めても選択を保つ）を予定しているので、いま塞いでおく。部品の契約は
  // src/ui/shell/view-only-gate.test.tsx の表と DeleteFeatureButton.test.tsx が固定する。
  //
  // 増分 5 で「鍵を閉めても選択を保つ」が入ったら、この test は「無効なボタンが出る」側へ
  // 書き換えること（toHaveCount(0) → toBeDisabled()）。
  test('表示専用では素性欄に地物が出ず、削除ボタンに手が届かない', async () => {
    const { app, page } = await launchApp();
    try {
      // 削除の対象を 1 つ作って選ぶ。**モードを切り替えると選択は捨てられる**ので、
      // 編集モードへ入ってから本体をクリックし直す。
      const { faceId, cx, cy } = await commitOneFace(page);
      await enterEditMode(page);
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);

      const deleteButton = page.getByRole('button', { name: '地物を削除' });
      await expect(deleteButton).toBeEnabled();

      // 「読むだけ」へ。選択が捨てられ、素性欄は案内文になり、削除ボタンは消える。
      await returnToViewMode(page);
      await expect(page.getByTestId('app-mode')).toHaveText('view');
      await expect(page.getByTestId('app-active-feature')).toHaveText('');
      await expect(deleteButton).toHaveCount(0);
      await expect(page.getByRole('button', { name: '削除を確定' })).toHaveCount(0);

      // 「直せる」へ戻して選び直すと、また押せる（検査が空振りしていない証）。
      await enterEditMode(page);
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      await expect(deleteButton).toBeEnabled();
    } finally {
      await app.close();
    }
  });
});
