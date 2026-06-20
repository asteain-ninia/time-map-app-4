// P1 回帰ロック — ウィンドウ・リサイズ後にクリック座標がズレない behavioural E2E.
//
// ROOT (Codex #1 / 教訓 5.7 二重管理ではなく結線漏れ): the renderer VIEWPORT (CSS
// width/height + dpr) was set ONCE at mount in `createAddHostPorts` and never
// re-synced. After a window / layout resize the screen↔world transform AND every
// hit-test still resolved against the STALE mount-time box, so a click at a known
// screen position mapped to the WRONG world point (add / select 両経路の同根). The
// fix installs a ResizeObserver (+ a window `resize` listener for a dpr change)
// that re-syncs `renderer.setViewport(...)` to the LIVE canvas box and repaints,
// keeping the transform/hit-test matched to the live canvas (単一真実源).
//
// This spec LOCKS the挙動 end to end through the REAL built composite:
//   1. commit one 面 (face) centred in the map (the live add導線);
//   2. enter 編集モード and real-click the map CENTRE → the face is selected
//      (baseline: the centre maps to the face under the original viewport);
//   3. RESIZE the Electron window to a markedly different size;
//   4. real-click the map's NEW CENTRE → the face is STILL selected. The camera
//      centre is preserved across a viewport resize, so the face centre stays under
//      the surface centre — but ONLY if the renderer viewport tracked the resize.
//      With the stale-viewport bug the new centre resolves to a different world
//      point and the face is NOT selected, so this reddens on a re-regression.

import { test, expect, type Page } from '@playwright/test';

import { launchApp, commitOneFace } from './helpers';

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

/** The current centre of the map input layer's on-screen box. */
async function mapCentre(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const inputLayer = page.getByTestId('map-input-layer');
  await expect(inputLayer).toBeVisible();
  const box = await inputLayer.boundingBox();
  expect(box).not.toBeNull();
  const b = box!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, width: b.width, height: b.height };
}

test.describe('P1 — ウィンドウ・リサイズ後もクリック座標が一致する', () => {
  test('リサイズ前後で地図中心クリックが同じ地物を選択する', async () => {
    const { app, page } = await launchApp();
    try {
      // 1) Commit one face. The add layer corners are computed from the SAME centred
      //    box, so the face is a ~240px square centred in the map under the boot camera.
      await commitOneFace(page);
      const activeFeature = page.getByTestId('app-active-feature');
      const faceId = ((await activeFeature.textContent()) ?? '').trim();
      expect(faceId.length).toBeGreaterThan(0);

      // 2) 編集モード. Clear the post-commit selection by clicking an empty corner, then
      //    confirm the map CENTRE selects the face body (the baseline mapping).
      await enterEditMode(page);
      const before = await mapCentre(page);
      await page.mouse.click(before.x - before.width / 2 + 8, before.y - before.height / 2 + 8);
      await expect(activeFeature).not.toHaveText(faceId);

      await page.mouse.click(before.x, before.y);
      await expect(activeFeature).toHaveText(faceId);

      // Clear again so the post-resize click is an unambiguous fresh selection.
      await page.mouse.click(before.x - before.width / 2 + 8, before.y - before.height / 2 + 8);
      await expect(activeFeature).not.toHaveText(faceId);

      // 3) Resize the REAL Electron window to a markedly different content size. The
      //    map area is `inset:0` over its grid cell, so the canvas (and its
      //    ResizeObserver) sees the new box and the renderer re-syncs its viewport.
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win !== undefined) win.setContentSize(900, 650);
      });

      // Wait for the layout to settle to the new box (width actually changed).
      await expect
        .poll(async () => {
          const box = await page.getByTestId('map-input-layer').boundingBox();
          return box === null ? before.width : Math.round(box.width);
        })
        .not.toBe(Math.round(before.width));

      // The resize must move the map centre by MORE than the face half-width (120px)
      // on at least one axis, so the OLD centre no longer lies on the face. This is
      // what makes the test a real discriminator: with the stale-viewport bug the
      // hit-test still projects the face to the OLD centre, so clicking the NEW centre
      // (>120px away) lands off the face and the selection misses; with the fix the
      // face re-projects to the NEW centre and the click hits (再発防止 assertion).
      const after = await mapCentre(page);
      const movedX = Math.abs(after.x - before.x);
      const movedY = Math.abs(after.y - before.y);
      expect(Math.max(movedX, movedY)).toBeGreaterThan(120);

      // 4) Click the NEW map centre. The camera centre was preserved across the
      //    viewport resize, so the face centre is still under the surface centre —
      //    the click must select the SAME face.
      await page.mouse.click(after.x, after.y);
      await expect(activeFeature).toHaveText(faceId);
    } finally {
      await app.close();
    }
  });
});
