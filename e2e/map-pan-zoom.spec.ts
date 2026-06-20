// HB-1 回帰ロック — behavioural E2E: a real drag PANS the live camera and a real
// wheel notch ZOOMS it (人間テスト発見バグ「パン/ホイールズームが効かない」).
//
// The earlier flows.spec only asserted that a press→move→release did not CRASH —
// it never checked the camera actually moved, so the dead wiring (U40
// PointerDispatcher never connected to the live U17 camera in App.tsx) shipped
// green. This spec closes that死角: it reads the live observation hooks
// (data-pan-x / data-pan-y / data-zoom, mirrored from the renderer camera on every
// pan/wheel, 既存 app-active-feature マーカーと同方式) and asserts they CHANGE under
// real `mouse.down → move → up` and `mouse.wheel` input.

import { test, expect } from '@playwright/test';

import { launchApp } from './helpers';

test.describe('HB-1: 地図のパン/ホイールズームが実入力で効く', () => {
  test('a real drag pans the live camera (data-pan-x/y change)', async () => {
    const { app, page } = await launchApp();
    try {
      // The composite boots in View mode, where a left-drag over the map input
      // layer is a pan (PAN_BUTTONS[View] ⊇ {Left}). The observation hooks live on
      // the input layer and are seeded from the initial camera on mount.
      const inputLayer = page.getByTestId('map-input-layer');
      await expect(inputLayer).toBeAttached();
      // The hook is published once the renderer mounts; wait for the baseline.
      await expect(inputLayer).toHaveAttribute('data-pan-x', /.+/);

      const box = await inputLayer.boundingBox();
      expect(box).not.toBeNull();
      const b = box!;

      const beforeX = Number(await inputLayer.getAttribute('data-pan-x'));
      const beforeY = Number(await inputLayer.getAttribute('data-pan-y'));

      // A genuine left-button drag across the centre of the map (well past the 4px
      // drag threshold so it is a pan, not a click).
      const startX = b.x + b.width / 2;
      const startY = b.y + b.height / 2;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 120, startY + 80, { steps: 8 });
      await page.mouse.move(startX + 200, startY + 140, { steps: 8 });
      await page.mouse.up();

      // The live camera centre moved: the pan offset hooks changed. Dragging the
      // pointer right+down moves the camera centre the OPPOSITE world direction
      // (content follows the finger), so centerLon decreased and centerLat
      // increased — but the regression-lock assertion is only that they MOVED.
      await expect
        .poll(async () => Number(await inputLayer.getAttribute('data-pan-x')))
        .not.toBe(beforeX);
      const afterY = Number(await inputLayer.getAttribute('data-pan-y'));
      expect(afterY).not.toBe(beforeY);
    } finally {
      await app.close();
    }
  });

  test('a real wheel notch zooms the live camera (data-zoom changes)', async () => {
    const { app, page } = await launchApp();
    try {
      const inputLayer = page.getByTestId('map-input-layer');
      await expect(inputLayer).toBeAttached();
      await expect(inputLayer).toHaveAttribute('data-zoom', /.+/);

      const box = await inputLayer.boundingBox();
      expect(box).not.toBeNull();
      const b = box!;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;

      const beforeZoom = Number(await inputLayer.getAttribute('data-zoom'));

      // Move the cursor over the map, then scroll UP (negative deltaY) = zoom IN.
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, -240);

      // The cursor-anchored wheel zoom changed the live magnification.
      await expect
        .poll(async () => Number(await inputLayer.getAttribute('data-zoom')))
        .not.toBe(beforeZoom);
      const zoomedIn = Number(await inputLayer.getAttribute('data-zoom'));
      expect(zoomedIn).toBeGreaterThan(beforeZoom);

      // A scroll DOWN (positive deltaY) = zoom OUT, reversing the direction.
      await page.mouse.wheel(0, 240);
      await expect
        .poll(async () => Number(await inputLayer.getAttribute('data-zoom')))
        .toBeLessThan(zoomedIn);
    } finally {
      await app.close();
    }
  });
});
