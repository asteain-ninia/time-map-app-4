// Realistic-outline E2E — draw NON-square country outlines through the live add
// flow so the integration layer is no longer exercised only by axis-aligned
// rectangles (cf. helpers.commitOneFace / the unit SQUARE_* fixtures).
//
// These reuse the shared catalogue in fixtures/real-shapes.ts: each shape's first
// outer ring is fitted to the add-layer's pixel box (outerRingToPixels) and
// committed corner-by-corner through the SAME live導線 a user drives (追加モード →
// 面ツール → vertices → 完了 → 保存). A committed feature re-resolves the live
// selection, so the hidden app-active-feature marker becomes non-empty — the same
// committed-feature signal commitOneFace asserts (教訓 5.11).

import { test, expect } from '@playwright/test';

import { launchApp, addInputLayerBox, armAddAreaTool, drawFace } from './helpers';
import { COUNTRY_SHAPES, outerRingToPixels } from './fixtures/real-shapes';

// One realistic, clearly-concave shape is enough to prove the live add flow
// commits a non-rectangular outline; iterating every catalogue entry would only
// re-pay the cold-launch cost without adding coverage of a distinct code path.
const ITALY = COUNTRY_SHAPES.find((s) => s.key === 'italy');

test.describe('realistic outlines commit through the live add flow', () => {
  test('committing a concave Italy outline yields a real selected feature', async () => {
    expect(ITALY).toBeDefined();
    const { app, page } = await launchApp();
    try {
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);

      // Fit Italy's outer ring into a centred ~60%-of-layer box so every vertex
      // lands comfortably inside the clickable input layer.
      const pad = { x: b.x + b.width * 0.2, y: b.y + b.height * 0.2 };
      const pixels = outerRingToPixels(ITALY!.shape, {
        x: pad.x,
        y: pad.y,
        width: b.width * 0.6,
        height: b.height * 0.6,
      });
      expect(pixels.length).toBeGreaterThanOrEqual(8); // a genuinely concave ring

      // The non-square outline committed: the live selection re-resolved to the
      // new feature (hidden observability marker non-empty) — drawFace が頂点 →
      // 完了 → 保存 → 再解決待ち まで通す。
      await drawFace(page, pixels);
    } finally {
      await app.close();
    }
  });
});
