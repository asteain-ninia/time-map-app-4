// HB-14 回帰ロック — behavioural E2E: ズームインしても画面内の地物が消えない
// (人間テスト発見バグ「拡大すると地物が消える」, v1/2/3 でも再発した古典).
//
// The classic failure mode is a culling / viewport-clip / period-aware-wrap
// boundary bug: as the user zooms IN on a committed feature, a wrong clip decision
// drops the feature from the candidate set and the map suddenly goes blank even
// though the feature is dead-centre on screen. Earlier passes fixed the pure clip
// math but never locked it from REAL input, so a re-regression could ship green.
//
// This spec drives the genuine 導線: commit ONE 面 through the live add flow, then
// scroll the wheel UP repeatedly (real `mouse.wheel`) anchored at the feature
// centre, and assert at EVERY zoom step that:
//   1. the live camera actually zoomed IN (data-zoom strictly increases), and
//   2. the committed feature still SURVIVES the clip — the
//      `data-visible-feature-count` observation hook never falls to 0 while the
//      feature is centred on screen (拡大すると地物が消える の不在をアサート).
// The hook reflects EXACTLY the set the frame composed (selectVisibleFeatures, the
// same selector buildFeaturePrimitives uses), so it cannot drift from the draw.

import { test, expect } from '@playwright/test';

import { launchApp, commitOneFace } from './helpers';

test.describe('HB-14: 拡大しても画面内の地物が消えない', () => {
  test('zooming in step by step keeps the committed feature in the clip set', async () => {
    const { app, page } = await launchApp();
    try {
      // Commit one real face through the live add flow (it renders on the canvas).
      await commitOneFace(page);

      // Return to View mode so the map input layer receives the wheel (the same
      // proven path as the HB-1 pan/zoom spec); wheel zoom works in every mode but
      // View keeps the add overlay out of the way.
      const viewToggle = page.getByTestId('mode-view');
      if ((await viewToggle.getAttribute('aria-pressed')) !== 'true') {
        await viewToggle.click();
      }
      await expect(viewToggle).toHaveAttribute('aria-pressed', 'true');

      const inputLayer = page.getByTestId('map-input-layer');
      await expect(inputLayer).toBeAttached();
      // The HB-14 observation hook is published on every composite; wait for it.
      await expect(inputLayer).toHaveAttribute('data-visible-feature-count', /.+/);
      await expect(inputLayer).toHaveAttribute('data-zoom', /.+/);

      const box = await inputLayer.boundingBox();
      expect(box).not.toBeNull();
      const b = box!;
      // The committed face is centred in the layer (commitOneFace draws it there);
      // anchor the wheel zoom at the centre so the feature stays on screen as we
      // zoom IN (cursor-anchored zoom keeps the centred world point under the cursor).
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      await page.mouse.move(cx, cy);

      // Baseline: the feature is on screen, so at least one feature survives the clip.
      const baselineCount = Number(
        await inputLayer.getAttribute('data-visible-feature-count'),
      );
      expect(baselineCount).toBeGreaterThanOrEqual(1);

      let prevZoom = Number(await inputLayer.getAttribute('data-zoom'));

      // Zoom IN in several discrete steps; at EACH step assert the camera magnified
      // AND the feature is still in the clip set (count never wrongly drops to 0).
      for (let step = 0; step < 8; step += 1) {
        await page.mouse.wheel(0, -240); // negative deltaY = zoom IN
        // The live magnification strictly increased this step (real zoom, not a no-op).
        await expect
          .poll(async () => Number(await inputLayer.getAttribute('data-zoom')))
          .toBeGreaterThan(prevZoom);
        const zoomNow = Number(await inputLayer.getAttribute('data-zoom'));

        // The committed feature, still dead-centre under the cursor, MUST remain in
        // the candidate/clip set: the count never falls to 0 (HB-14 の核心アサート).
        const countNow = Number(
          await inputLayer.getAttribute('data-visible-feature-count'),
        );
        expect(
          countNow,
          `visible feature count must not drop to 0 at zoom ${zoomNow} (step ${step})`,
        ).toBeGreaterThanOrEqual(1);

        prevZoom = zoomNow;
      }

      // After all the zoom-in steps the feature is still visible — the classic
      // "拡大すると地物が消える" did NOT happen — and the camera ended deeply zoomed in.
      const finalCount = Number(
        await inputLayer.getAttribute('data-visible-feature-count'),
      );
      expect(finalCount).toBeGreaterThanOrEqual(1);
      const finalZoom = Number(await inputLayer.getAttribute('data-zoom'));
      expect(finalZoom).toBeGreaterThan(prevZoom * 0.5); // finite, positive, deeply zoomed
    } finally {
      await app.close();
    }
  });
});
