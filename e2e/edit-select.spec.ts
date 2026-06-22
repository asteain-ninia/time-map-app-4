// HB-15 回帰ロック — 編集モードのクリック選択 behavioural E2E.
//
// ROOT (教訓 5.7 合成ルートの結線漏れ): the screen→world math (HB-7) and the live
// domain-lookup (live-lookup.ts) were correct, but App.tsx drove the map pointer
// dispatcher with EMPTY_HIT_TESTER / NOOP_SELECTION_PORT, so an edit-mode click on a
// vertex / feature resolved to nothing and could never select. HB-15 wires the LIVE
// hit-test (box-corrected screen↔world + featuresAt/verticesAt/leafAtPoint, 頂点優先)
// and the LIVE SelectionPort (vertex → replaceVertexSelection, body → setActiveFeature)
// into the dispatcher.
//
// This spec LOCKS the挙動 end to end through the REAL built composite:
//   1. commit one 面 (face) with four DISTINCT screen clicks (the HB-7 path), so its
//      vertices live at known SCREEN positions under the live camera;
//   2. enter 編集モード (no tool — plain selection), real-click ONE known vertex's
//      screen position → assert app-active-vertex is non-empty (THAT vertex selected);
//   3. real-click the face BODY centre → assert app-active-feature is the face.
// A re-regression of the wiring (back to NOOP) reddens here even though the math
// stays green (the classic 教訓 5.7 失敗: logic exists but the UI never calls it).

import { test, expect } from '@playwright/test';

import { launchApp } from './helpers';

/** Leave View → 編集モード (no edit tool armed, so map clicks are plain selection). */
async function enterEditMode(page: import('@playwright/test').Page): Promise<void> {
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
async function enterAddArea(page: import('@playwright/test').Page): Promise<void> {
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

test.describe('HB-15 — 編集モードで頂点/地物を実クリックして選択できる', () => {
  test('クリックした既知頂点が選択され、地物本体クリックで地物が選択される', async () => {
    const { app, page } = await launchApp();
    try {
      // The add + map input layers share the SAME client box (both inset:0 over the
      // map cell), so the corner SCREEN positions computed now stay valid after we
      // switch to 編集モード and click them on the map input layer (camera unchanged).
      await enterAddArea(page);
      const addLayer = page.getByTestId('add-input-layer');
      await expect(addLayer).toBeVisible();
      const ab = await addLayer.boundingBox();
      expect(ab).not.toBeNull();
      const a = ab!;
      const cx = a.x + a.width / 2;
      const cy = a.y + a.height / 2;
      // Four DISTINCT corners of a ~240px square (the HB-7 path). The first corner is
      // the vertex we will later click in 編集モード.
      const corners: ReadonlyArray<readonly [number, number]> = [
        [cx - 120, cy - 120],
        [cx + 120, cy - 120],
        [cx + 120, cy + 120],
        [cx - 120, cy + 120],
      ];
      for (const [px, py] of corners) await page.mouse.click(px, py);
      await page.getByTestId('add-complete').click();
      await page.getByTestId('add-save').click();

      // The add committed and selection re-resolved to the new face (教訓 5.11).
      const activeFeature = page.getByTestId('app-active-feature');
      await expect(activeFeature).toHaveText(/\S/);
      const faceId = ((await activeFeature.textContent()) ?? '').trim();
      expect(faceId.length).toBeGreaterThan(0);

      // 編集モード (plain selection). Click EMPTY space first to clear the post-commit
      // selection, so the subsequent vertex click is an unambiguous fresh selection.
      await enterEditMode(page);
      await page.mouse.click(a.x + 8, a.y + 8); // top-left empty corner of the map cell
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');

      // 1) Real-click the FIRST committed vertex's screen position. The live hit-test
      //    (頂点優先, screen-px grab radius) must resolve it → app-active-vertex non-empty.
      const [vx, vy] = corners[0]!;
      await page.mouse.click(vx, vy);
      await expect(page.getByTestId('app-active-vertex')).toHaveText(/\S/);
      // Its owner is the committed face (the vertex belongs to that leaf).
      await expect(page.getByTestId('app-active-vertex-owner')).toHaveText(faceId);

      // 2) Real-click the face BODY centre (away from any vertex). The leaf body
      //    hit-test must select the face as the active feature (FR-79).
      await page.mouse.click(cx, cy);
      await expect(activeFeature).toHaveText(faceId);
      // A body click selects the feature, not a vertex → vertex marker cleared.
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');
    } finally {
      await app.close();
    }
  });

  // HB-15 OVERLAY REGRESSION: the bottom-left 経度シフト panel (a child of
  // `.map-area__overlay`, whose `> *` rule re-enables pointer events) grew to ~526×174
  // with the HB3-1 readout + hint + wide preset buttons and sat over the map's lower
  // centre. Every body click there hit the panel's TEXT, never the map-input-layer /
  // dispatcher — so 編集モードで地物本体をクリックしても選択できなかった (the hit-test never
  // ran). The panel is now click-through except on its controls. This locks that a click
  // ON the readout TEXT falls through to the map underneath.
  test('経度シフトパネルのテキスト上のクリックは地図へ貫通する (HB-15 オーバーレイ回帰)', async () => {
    const { app, page } = await launchApp();
    try {
      // Commit one face at the CENTRE (the readout sits bottom-left, away from it).
      await enterAddArea(page);
      const addLayer = page.getByTestId('add-input-layer');
      await expect(addLayer).toBeVisible();
      const a = (await addLayer.boundingBox())!;
      const cx = a.x + a.width / 2;
      const cy = a.y + a.height / 2;
      for (const [dx, dy] of [
        [-120, -120],
        [120, -120],
        [120, 120],
        [-120, 120],
      ] as const) {
        await page.mouse.click(cx + dx, cy + dy);
      }
      await page.getByTestId('add-complete').click();
      await page.getByTestId('add-save').click();
      const activeFeature = page.getByTestId('app-active-feature');
      await expect(activeFeature).toHaveText(/\S/);
      const faceId = ((await activeFeature.textContent()) ?? '').trim();

      // 編集モード, then re-select the centre face so the selection is non-empty.
      await enterEditMode(page);
      await page.mouse.click(cx, cy);
      await expect(activeFeature).toHaveText(faceId);

      // Click ON the 経度シフト readout TEXT. The empty map is behind it (the only face is
      // at the centre), so a CLICK-THROUGH lands on empty space and CLEARS the selection.
      // If the panel swallowed the click (the regression), the selection would NOT change.
      const readout = page.getByTestId('center-lon-readout');
      await expect(readout).toBeVisible();
      const rb = (await readout.boundingBox())!;
      await page.mouse.click(rb.x + rb.width / 2, rb.y + rb.height / 2);
      await expect(activeFeature).toHaveText('');
    } finally {
      await app.close();
    }
  });
});
