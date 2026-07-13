// fr96 回帰ロック — 右クリックコンテキストメニューの本結線 behavioural E2E.
//
// THE POINT (FR-96 / 教訓 5.7): the U36 composition + dispatch and the MapContextMenu
// DYNAMIC render existed and were unit-tested, but until the App supplied
// composeFor/onSelectItem a real right-click only ever opened the LEGACY 2-item menu.
// This spec proves the WHOLE flow in the REAL built Electron app:
//
//   1. 頂点右クリック → the dynamic menu offers「頂点を削除」→ clicking it deletes
//      EXACTLY that vertex (the feature survives, its handle count drops 4→3, and the
//      vertex selection clears while the feature stays active — the runEditDelete
//      survive branch, 教訓 5.11).
//   2. 地物本体右クリック → the dynamic leaf item set (削除/プロパティ編集/分割/所属
//      変更/結合(グレー)) opens; then a KNIFE DRAFT owns the input and a right-click
//      opens NOTHING and leaves the selection untouched (the 段階7 suspended gate =
//      shortcutsSuspended OR-chain threaded into the live context-menu port).
//
// The add/edit導線 helpers mirror edit-select.spec.ts (単一真実源 of the E2E pattern).

import { test, expect, type Page } from '@playwright/test';

import { launchApp } from './helpers';

/** Leave View → 編集モード (no edit tool armed, so map clicks are plain selection). */
async function enterEditMode(page: Page): Promise<void> {
  const viewToggle = page.getByTestId('mode-view');
  await expect(viewToggle).toBeVisible();
  if ((await viewToggle.getAttribute('aria-pressed')) === 'true') {
    await viewToggle.click();
  }
  const editMode = page.getByTestId('mode-edit');
  await expect(editMode).toBeEnabled();
  await editMode.click();
  await expect(editMode).toHaveAttribute('aria-pressed', 'true');
}

/** Enter 追加モード → 面ツール (the live add導線, no overlay bypass). */
async function enterAddArea(page: Page): Promise<void> {
  const viewToggle = page.getByTestId('mode-view');
  await expect(viewToggle).toBeVisible();
  if ((await viewToggle.getAttribute('aria-pressed')) === 'true') {
    await viewToggle.click();
  }
  const addMode = page.getByTestId('mode-add');
  await expect(addMode).toBeEnabled();
  await addMode.click();
  await page.getByTestId('tool-add.area').click();
}

/** Commit one ~240px square face; returns its centre + the four corner screen points. */
async function commitSquareFace(page: Page): Promise<{
  faceId: string;
  cx: number;
  cy: number;
  corners: ReadonlyArray<readonly [number, number]>;
}> {
  await enterAddArea(page);
  const addLayer = page.getByTestId('add-input-layer');
  await expect(addLayer).toBeVisible();
  const box = (await addLayer.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const corners: ReadonlyArray<readonly [number, number]> = [
    [cx - 120, cy - 120],
    [cx + 120, cy - 120],
    [cx + 120, cy + 120],
    [cx - 120, cy + 120],
  ];
  for (const [px, py] of corners) await page.mouse.click(px, py);
  await page.getByTestId('add-complete').click();
  await page.getByTestId('add-save').click();
  const activeFeature = page.getByTestId('app-active-feature');
  await expect(activeFeature).toHaveText(/\S/);
  const faceId = ((await activeFeature.textContent()) ?? '').trim();
  expect(faceId.length).toBeGreaterThan(0);
  return { faceId, cx, cy, corners };
}

/** The live vertex-handle count of the ACTIVE feature (the __E2E__ render hook). */
async function vertexHandleCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hook = (window as unknown as {
      __E2E__?: { getVertexHandlePositions(): readonly unknown[] };
    }).__E2E__;
    return hook ? hook.getVertexHandlePositions().length : -1;
  });
}

test.describe('fr96 — 右クリックメニューの本結線（動的項目 + suspended ゲート）', () => {
  test('頂点右クリック →「頂点を削除」で頂点だけ消える（地物は残る）', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      const { faceId, corners } = await commitSquareFace(page);

      // 編集モード（素の選択）。setMode の reset契約で選択は一旦クリアされる。
      await enterEditMode(page);
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');

      // 実右クリックで頂点をヒット → promoteHit がその頂点を選択し、動的メニューが開く。
      const [vx, vy] = corners[0]!;
      await page.mouse.click(vx, vy, { button: 'right' });
      const menu = page.getByTestId('context-menu');
      await expect(menu).toBeVisible();
      // 頂点選択ありのメニューは「頂点を削除」を出す（「削除」= 地物全体は出さない —
      // データ損失ガード, compose.deleteItemFor）。
      const deleteVertex = menu.locator('[data-item-kind="deleteVertex"]');
      await expect(deleteVertex).toBeVisible();
      await expect(deleteVertex).toHaveText('頂点を削除');
      await expect(menu.locator('[data-item-kind="delete"]')).toHaveCount(0);
      // 右クリック昇格の観測（教訓 5.11: メニューのコマンド対象 = 右クリック対象）。
      await expect(page.getByTestId('app-active-vertex')).toHaveText(/\S/);
      await expect(page.getByTestId('app-active-vertex-owner')).toHaveText(faceId);

      // 発火 → runEditDelete の頂点削除ファネル（survive: 地物は残り頂点だけ消える）。
      await deleteVertex.click();
      await expect(menu).toHaveCount(0);
      // 地物はアクティブのまま（preference 昇格）、頂点選択はクリア（HOLE-1 の掃除）。
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');
      // 描画観測: アクティブ地物の頂点ハンドルが 4 → 3（頂点が本当に消えた）。
      await expect
        .poll(async () => vertexHandleCount(page), { timeout: 15_000 })
        .toBe(3);
    } finally {
      await app.close();
    }
  });

  test('本体右クリックは動的 leaf 項目を出し、ナイフドラフト中はメニュー不出現+選択不変', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      const { faceId, cx, cy } = await commitSquareFace(page);

      await enterEditMode(page);

      // --- 1. 素の編集モード: 本体右クリック → 動的 leaf 項目セットが開く。 ---
      await page.mouse.click(cx, cy, { button: 'right' });
      const menu = page.getByTestId('context-menu');
      await expect(menu).toBeVisible();
      await expect(menu.locator('[data-item-kind="delete"]')).toBeVisible();
      await expect(menu.locator('[data-item-kind="editProperties"]')).toBeVisible();
      await expect(menu.locator('[data-item-kind="split"]')).toBeVisible();
      await expect(menu.locator('[data-item-kind="changeAffiliation"]')).toBeVisible();
      // 結合はグレーアウト（対象1件 — FR-115 の disable 理由付き, 教訓 5.13）。
      await expect(menu.locator('[data-item-kind="merge"]')).toBeDisabled();
      // Escape で閉じる（メニュー自身の close 契機）。
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      // 右クリック昇格で本体の地物が選択されている。
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);

      // --- 2. ナイフを arm してドラフトを開始（flow ≠ Idle ⇒ suspended）。 ---
      await page.getByTestId('tool-edit.knife').click();
      // 対象面選択 → 分断線 1 点（確実に DrawingCut のドラフト中にする）。
      await page.mouse.click(cx, cy);
      await page.mouse.click(cx - 50, cy);
      const selectedBefore = ((await page
        .getByTestId('app-active-feature')
        .textContent()) ?? '').trim();

      // --- 3. ドラフト中の右クリック: メニューは開かず、選択も不変（段階7 優先規則:
      // promoteHit も open も走らない — suspended ゲート検出器）。 ---
      await page.mouse.click(cx + 40, cy + 40, { button: 'right' });
      await page.waitForTimeout(500);
      await expect(page.getByTestId('context-menu')).toHaveCount(0);
      await expect(page.getByTestId('app-active-feature')).toHaveText(selectedBefore);
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');
    } finally {
      await app.close();
    }
  });

  // Codex F1a 回帰ロック — メニュー表示中はグローバルショートカットが suspend される:
  // 開いたメニューを貫通する Ctrl+Z は、凍結モデルが指す対象そのものを undo で消し得た
  // (→ stale EditProperties)。suspend 後は Ctrl+Z が不発で、対象は生き残り、開いた
  // メニューの EditProperties は正常に発火する（positive path）。Escape はメニューの
  // capture 専有のまま（suspend と独立 — メニューを閉じるだけ、選択は消さない）。
  test('メニュー表示中の Ctrl+Z は不発（suspend）— 対象は残り EditProperties が正常動作', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      const { faceId, cx, cy } = await commitSquareFace(page);
      await enterEditMode(page);

      // undo 可能な履歴が 1 つある状態でメニューを開く。
      await expect(page.getByTestId('app-can-undo')).toHaveText('1');
      await page.mouse.click(cx, cy, { button: 'right' });
      const menu = page.getByTestId('context-menu');
      await expect(menu).toBeVisible();

      // メニュー表示中の Ctrl+Z: グローバル EditUndo は suspend されて不発 —
      // undo スタックは減らず、対象地物はドメインに残る。メニューも開いたまま。
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(400);
      await expect(page.getByTestId('app-can-undo')).toHaveText('1');
      await expect(menu).toBeVisible();

      // そのまま EditProperties を発火（positive path: live 存在検証を通過し、
      // プロパティタブへフォーカス+対象選択）。
      await menu.locator('[data-item-kind="editProperties"]').click();
      await expect(menu).toHaveCount(0);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      await expect(page.getByTestId('sidebar-tab-properties')).toHaveAttribute(
        'aria-selected',
        'true',
      );
      // 基本情報フォームが対象を表示（存在する地物が選択された証左）。
      await expect(
        page.getByTestId('sidebar-panel-properties').getByTestId('basic-info'),
      ).toBeVisible();

      // メニューを閉じた後は suspend が解け、Ctrl+Z が通常どおり効く（境界の解除）。
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('app-can-undo')).toHaveText('0');
    } finally {
      await app.close();
    }
  });
});
