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

/**
 * 1 段に並ぶ道具の testid（増分 5b）。**読むだけの関門は「全部灰色」で見る** ――
 * 旧版は「そのモードの道具が出ているか」で見ていたが、道具はモードで入れ替わらなく
 * なったので、出ているかどうかでは何も分からない。
 */
const ALL_TOOL_TESTIDS = [
  'tool-edit.select',
  'tool-edit.vertex',
  'tool-edit.move',
  'tool-add.area',
  'tool-add.line',
  'tool-add.point',
  'tool-edit.ring',
  'tool-edit.knife',
  'tool-edit.drill',
  'tool-edit.reparent',
  'tool-edit.merge',
] as const;

test.describe('HB-4 — 表示専用解除で編集ツールが活性化する (live UI)', () => {
  test('boot in View: edit tools disabled, then the toolbar 表示専用 toggle enables 追加モード and a face is added via the real UI', async () => {
    const { app, page } = await launchApp();
    try {
      // 1. BOOT STATE — the composite starts in 表示専用 (View). The named導線
      //    (the 表示専用 toolbar button) is enabled and pressed; the add/edit mode
      //    toggles AND every add tool are disabled together (教訓 5.13 single gate).
      // **増分 5b**: モードの 2 ボタンは廃止され、鍵 1 個＋道具の 1 段になった。
      // 「読むだけで編集の入口が閉じている」は **道具が全部灰色である**ことで見る。
      await expect(page.getByTestId('app-mode')).toHaveText('view');
      const viewToggle = page.getByTestId('mode-view');
      await expect(viewToggle).toBeEnabled();
      await expect(viewToggle).toHaveAttribute('aria-pressed', 'true');
      for (const tool of ALL_TOOL_TESTIDS) {
        await expect(page.getByTestId(tool), `${tool} が読むだけで押せる`).toBeDisabled();
      }

      // 2. LEAVE View through the live导线 (a real click on the toolbar button).
      //    The mode flips to 編集モード (the sensible editable default the導线
      //    contract lands in — SAME as useShell.setViewOnly) and the mode toggles
      //    become enabled — the cause (mode) AND the effect (buttons) both observable.
      await viewToggle.click();
      await expect(page.getByTestId('app-mode')).toHaveText('edit');
      await expect(viewToggle).toHaveAttribute('aria-pressed', 'false');
      for (const tool of ALL_TOOL_TESTIDS) {
        await expect(page.getByTestId(tool), `${tool} が直せる状態でも押せない`).toBeEnabled();
      }

      // 3. 面の道具を構えると、内部の mode が add になる（設計書 §D.1 の導出式）。
      //    **「追加モードに入ってから道具を選ぶ」の 2 手が 1 手になった**のがここ。
      const areaTool = page.getByTestId('tool-add.area');
      await areaTool.click();
      await expect(areaTool).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('app-mode')).toHaveText('add');

      // 4. ADD A FACE through the REAL UI path: 面ツール → 四隅クリック → 完了 → 保存.
      //    This proves editing is genuinely reachable end-to-end (D23 evidence: a
      //    committed feature, not a controller 直叩き). The active tool hook shows
      //    the selection; the committed-feature marker confirms the save landed.
      //    **道具はもう構えてある**（手順 3 が構えた）。もう一度押すと外れるので押さない。
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
      await expect(page.getByTestId('tool-add.area')).toBeEnabled();
      await expect(page.getByTestId('tool-edit.knife')).toBeEnabled();

      // Re-dispatch the SAME menu命令: it toggles back to View (the reversal
      // contract), proving it is a real toggle, not a one-way switch.
      await page.getByTestId('menu-view').click();
      await expect(items).toBeVisible();
      await expect(toggleItem).toBeEnabled();
      await toggleItem.click();
      await expect(page.getByTestId('app-mode')).toHaveText('view');
      await expect(page.getByTestId('tool-add.area')).toBeDisabled();
      await expect(page.getByTestId('tool-edit.knife')).toBeDisabled();
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
      // **増分 5b**: この群に居るのは鍵 1 個だけになった（testid は据え置き＝T-1）。
      const modeGroup = page.getByTestId('toolbar-modes');
      await expect(modeGroup).toBeVisible();
      await expect(modeGroup.getByTestId('tooltip')).toHaveCount(0);
      await expect(modeGroup.locator('[role="tooltip"]')).toHaveCount(0);
      await expect(
        page.getByTestId('tooltip').filter({ has: page.getByTestId('mode-view') }),
      ).toHaveCount(0);

      // They still function: 鍵を開けて、面の道具を構える。
      await expect(page.getByTestId('app-mode')).toHaveText('view');
      await page.getByTestId('mode-view').click();
      await expect(page.getByTestId('app-mode')).toHaveText('edit');
      await page.getByTestId('tool-add.area').click();
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
  // **2026-09-05（増分 4 の手直し B12）でここが「無効なボタンが出る」側になった。**
  // 所有者の裁定「読むだけでも選べる・読める・直せない」に合わせて、鍵を閉めても
  // 選択を保つようにしたので（`store.setMode`）、素性欄は地物を出したまま、値を変える
  // 入力と削除ボタンだけが無効になる。上の注記が予告していた書き換えである。
  test('表示専用でも選択と素性欄は残り、削除ボタンは出るが押せない', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId, cx, cy } = await commitOneFace(page);
      await enterEditMode(page);
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);

      const deleteButton = page.getByRole('button', { name: '地物を削除' });
      await expect(deleteButton).toBeEnabled();

      // 「読むだけ」へ。**選択は残る**（読める）が、削除は押せない（直せない）。
      await returnToViewMode(page);
      await expect(page.getByTestId('app-mode')).toHaveText('view');
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      await expect(deleteButton).toBeDisabled();
      // 押しても確認ダイアログは開かない（disabled 属性だけに頼らない＝K-6）。
      await deleteButton.click({ force: true });
      await expect(page.getByRole('button', { name: '削除を確定' })).toHaveCount(0);

      // 「直せる」へ戻すと、選び直さなくても押せる（選択が保たれている証）。
      await enterEditMode(page);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      await expect(deleteButton).toBeEnabled();
    } finally {
      await app.close();
    }
  });
});
