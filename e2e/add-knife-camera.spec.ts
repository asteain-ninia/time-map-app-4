// 回帰ロック — behavioural E2E: 追加(Add)描画フェーズ中でも中ボタンパン と ホイールズーム
// が実入力で効く (人間テスト発見バグ「追加/ナイフ描画中はパン/ズームが死ぬ」).
//
// ROOT CAUSE the fix closes: the add controller mounts a full-surface input bridge
// ABOVE the map while drawing (教訓 5.14). It captured pointer events for vertex
// placement but never forwarded the WHEEL / MIDDLE-button events to the U40
// PointerDispatcher (whose DOM listeners sit on the BACKGROUND map-input-layer, a
// sibling the overlay shadows), so during drawing 中ボタンパン / ホイールズーム died.
// The dispatcher's own map-pan-zoom.spec only exercised VIEW mode (no overlay), so
// the死角 shipped green.
//
// This spec drives REAL `mouse.wheel` and a REAL MIDDLE-button drag OVER THE ADD
// BRIDGE (the overlay element, not the background layer) and asserts the live camera
// observation hooks (data-zoom / data-pan-x/y on map-input-layer, mirrored from the
// renderer camera on every pan/wheel) actually CHANGE — proving the bridge forwards
// the camera-only events to the same live dispatcher.

import { test, expect } from '@playwright/test';

import { launchApp, enterAddMode } from './helpers';

test.describe('回帰: 追加描画中も中ボタンパン/ホイールズームが効く', () => {
  test('a wheel notch over the add bridge zooms the live camera', async () => {
    const { app, page } = await launchApp();
    try {
      const inputLayer = page.getByTestId('map-input-layer');
      await expect(inputLayer).toHaveAttribute('data-zoom', /.+/);

      // Enter the add drawing phase: the add bridge now covers the map.
      await enterAddMode(page);
      await page.getByTestId('tool-add.line').click();
      const bridge = page.getByTestId('add-input-layer');
      await expect(bridge).toBeVisible();
      const box = await bridge.boundingBox();
      expect(box).not.toBeNull();
      const b = box!;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;

      const beforeZoom = Number(await inputLayer.getAttribute('data-zoom'));

      // Scroll UP over the BRIDGE (the overlay element) = zoom IN. Before the fix
      // the bridge ate this event and the camera never moved.
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, -240);

      await expect
        .poll(async () => Number(await inputLayer.getAttribute('data-zoom')))
        .toBeGreaterThan(beforeZoom);
    } finally {
      await app.close();
    }
  });

  test('a middle-button drag over the add bridge pans the live camera', async () => {
    const { app, page } = await launchApp();
    try {
      const inputLayer = page.getByTestId('map-input-layer');
      await expect(inputLayer).toHaveAttribute('data-pan-x', /.+/);

      await enterAddMode(page);
      await page.getByTestId('tool-add.line').click();
      const bridge = page.getByTestId('add-input-layer');
      await expect(bridge).toBeVisible();
      const box = await bridge.boundingBox();
      expect(box).not.toBeNull();
      const b = box!;
      const startX = b.x + b.width / 2;
      const startY = b.y + b.height / 2;

      const beforeX = Number(await inputLayer.getAttribute('data-pan-x'));
      const beforeY = Number(await inputLayer.getAttribute('data-pan-y'));

      // A genuine MIDDLE-button drag (button 1) across the bridge — in Add mode the
      // middle button is the pan button (left is vertex placement). Well past the
      // 4px drag threshold so it is a pan, not a click.
      await page.mouse.move(startX, startY);
      await page.mouse.down({ button: 'middle' });
      await page.mouse.move(startX + 140, startY + 90, { steps: 8 });
      await page.mouse.move(startX + 220, startY + 150, { steps: 8 });
      await page.mouse.up({ button: 'middle' });

      // The live camera centre moved: the pan offset hooks changed.
      await expect
        .poll(async () => Number(await inputLayer.getAttribute('data-pan-x')))
        .not.toBe(beforeX);
      const afterY = Number(await inputLayer.getAttribute('data-pan-y'));
      expect(afterY).not.toBe(beforeY);
    } finally {
      await app.close();
    }
  });
});
