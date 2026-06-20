// HB-6 / HB-7 回帰ロック — 座標変換クラスタ behavioural E2E.
//
// HB-6 / HB-7 / HB-15 share ONE root: the screen↔world transform pair
// (src/render/vtransform.ts) and the canvas bounding-box offset correction
// (src/ui/add/host-ports.ts `screenToWorld`). The pure math is unit/property-
// tested (vtransform.test.ts: screen→world→screen 恒等 + cursor invariant). This
// spec locks the LIVE WIRING from real input so a re-regression in the composition
// (not just the math) reddens — the classic失敗 is the math being right while the
// UI never calls it with box-corrected coordinates (教訓 5.7 / 5.29):
//   - HB-6: ホイールズームの中心がカーソルにならない (中心固定) → cursor-anchored zoom
//           (zoomStepAtCursor): the world point under an OFF-CENTRE cursor stays
//           under the cursor across a real wheel notch.
//   - HB-7: 追加モードで頂点の追加位置がカーソルにならない → click(screen)→world写像が
//           箱オフセット補正込みで正しい (host-ports `screenToWorld`): four DISTINCT
//           off-centre corner clicks build a well-formed face (they do not collapse
//           to the viewport centre, which is the bug's signature).
//
// NOTE on HB-15 (編集モードで頂点が選択できない): the root screen→world写像 is the
// SAME one HB-7 exercises here, and it is correct. As of HB-15 the live map-CLICK
// hit-test + selection ARE now wired in the composition root (App.tsx backs the map
// pointer dispatcher with a real HitTester + SelectionPort over live-lookup), so the
// end-to-end "click a vertex → it selects"導線 is locked in its OWN spec
// (e2e/edit-select.spec.ts) — this cluster keeps its HB-6/HB-7 scope.

import { test, expect } from '@playwright/test';

import { commitOneFace, launchApp } from './helpers';

test.describe('HB-6 — ホイールズームの中心がカーソルになる (cursor-anchored)', () => {
  test('the world point under an off-centre cursor stays put across a wheel zoom', async () => {
    const { app, page } = await launchApp();
    try {
      const inputLayer = page.getByTestId('map-input-layer');
      await expect(inputLayer).toBeAttached();
      // The live camera hooks (data-pan-x = centerLon, data-pan-y = centerLat,
      // data-zoom = px/deg) are seeded on mount — wait for the baseline.
      await expect(inputLayer).toHaveAttribute('data-pan-x', /.+/);
      await expect(inputLayer).toHaveAttribute('data-zoom', /.+/);

      const box = await inputLayer.boundingBox();
      expect(box).not.toBeNull();
      const b = box!;

      // Read the live camera, then compute the world point under a deliberately
      // OFF-CENTRE cursor with the SAME equirectangular transform the renderer uses
      // (centerLon + (sx - vpW/2)/zoom ; centerLat - (sy - vpH/2)/zoom). The cursor
      // sits well away from the viewport centre so a "centre-fixed" zoom (the bug)
      // would visibly move this world point.
      const camBefore = {
        lon: Number(await inputLayer.getAttribute('data-pan-x')),
        lat: Number(await inputLayer.getAttribute('data-pan-y')),
        zoom: Number(await inputLayer.getAttribute('data-zoom')),
      };
      // Cursor at the upper-left quadrant of the layer (clearly off-centre).
      const cursorX = b.x + b.width * 0.3;
      const cursorY = b.y + b.height * 0.3;
      // Local (layer-relative) screen coords feed the transform; the renderer uses
      // the layer box, so subtract the box origin (the same offset host-ports does).
      const localX = cursorX - b.x;
      const localY = cursorY - b.y;
      const vpW = b.width;
      const vpH = b.height;
      const worldUnderCursor = {
        lon: camBefore.lon + (localX - vpW / 2) / camBefore.zoom,
        lat: camBefore.lat - (localY - vpH / 2) / camBefore.zoom,
      };

      // Real wheel zoom IN, anchored at the off-centre cursor.
      await page.mouse.move(cursorX, cursorY);
      await page.mouse.wheel(0, -240);
      await expect
        .poll(async () => Number(await inputLayer.getAttribute('data-zoom')))
        .toBeGreaterThan(camBefore.zoom);

      // Recompute where that SAME world point now lands on screen with the NEW
      // camera. Cursor-anchored zoom keeps it under the cursor → its screen position
      // must be ~unchanged (within a couple px of float/rounding slack). A centre-
      // fixed zoom (the HB-6 bug) would push it away from the cursor by many px.
      const camAfter = {
        lon: Number(await inputLayer.getAttribute('data-pan-x')),
        lat: Number(await inputLayer.getAttribute('data-pan-y')),
        zoom: Number(await inputLayer.getAttribute('data-zoom')),
      };
      const screenX = vpW / 2 + (worldUnderCursor.lon - camAfter.lon) * camAfter.zoom;
      const screenY = vpH / 2 - (worldUnderCursor.lat - camAfter.lat) * camAfter.zoom;
      expect(Math.abs(screenX - localX)).toBeLessThanOrEqual(2);
      expect(Math.abs(screenY - localY)).toBeLessThanOrEqual(2);
    } finally {
      await app.close();
    }
  });
});

test.describe('HB-7 — 追加モードのクリック位置が world に正しく写像される', () => {
  test('a face committed by four DISTINCT off-centre clicks lands as a well-formed feature (clicks do not collapse to the viewport centre)', async () => {
    const { app, page } = await launchApp();
    try {
      // commitOneFace places four corners with REAL clicks at four DISTINCT screen
      // offsets (a ~240px square, not the centre). If the screen→world mapping
      // ignored the canvas box offset (the classic HB-7 bug — every vertex appears
      // at the viewport centre instead of under the cursor), the four corner clicks
      // would collapse to one world point and the add could not produce a valid,
      // non-degenerate face. A committed face (app-active-feature non-empty) thus
      // proves click(screen)→world tracked the distinct cursor positions.
      await commitOneFace(page);
      const activeFeature = page.getByTestId('app-active-feature');
      await expect(activeFeature).toHaveText(/\S/);
      const committedId = (await activeFeature.textContent())?.trim() ?? '';
      expect(committedId.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
