// HB3-4 回帰ロック — 編集モードの頂点/地物ドラッグ中ライブプレビュー behavioural E2E.
//
// ROOT (診断 HB3-4 / 教訓 5.7「ロジックがあっても UI から呼ばれず機能しない」): the U24 drag
// session held the moved geometry as a transient (a drag never mutates committed state),
// but the adapter had NO `onPreview` and the render layer had no consumer — so the
// committed feature + its handles kept drawing at the PRESS position for the WHOLE drag
// and then JUMPED to the new place on release. The user dragged a vertex and saw nothing
// move until they let go. The fix adds `onPreview(session)` to the edit-session adapter,
// holds the live session in the composition root, and applies its preview to the
// edit-handle + preview-outline positions every frame.
//
// This spec drives the REAL built composite with REAL pointer events — a genuine
// mousedown → mousemove×N → mouseup vertex drag (NOT a synthetic shortcut, which could
// not detect this bug: only観察ing the per-FRAME drawn handle position proves the geometry
// follows the cursor DURING the drag and does not jump AFTER release). It observes the
// ACTUAL RENDER via window.__E2E__ (live-preview flag + vertex-handle world positions).
//
// A re-regression (onPreview unwired, or the editHandles getter ignoring the session)
// reddens here even while the adapter / handle unit tests stay green (classic 教訓 5.7).

import { test, expect, type Page } from '@playwright/test';

import { launchApp } from './helpers';

interface HandlePos {
  lon: number;
  lat: number;
}

/** Read the active feature's vertex-handle WORLD positions off the live __E2E__ hook. */
async function vertexHandlePositions(page: Page): Promise<HandlePos[]> {
  return page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E__?: { getVertexHandlePositions: () => HandlePos[] };
    }).__E2E__;
    return e2e === undefined ? [] : e2e.getVertexHandlePositions();
  });
}

/** Whether a live preview (edit drag / tool overlay) is present this frame. */
async function hasLivePreview(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E__?: { hasLivePreview: () => boolean };
    }).__E2E__;
    return e2e === undefined ? false : e2e.hasLivePreview();
  });
}

/** The handle nearest a target world position (the dragged vertex), or null. */
function nearest(handles: HandlePos[], target: HandlePos): HandlePos | null {
  let best: HandlePos | null = null;
  let bestD = Infinity;
  for (const h of handles) {
    const d = (h.lon - target.lon) ** 2 + (h.lat - target.lat) ** 2;
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}

async function enterEditMode(page: Page): Promise<void> {
  const editMode = page.getByTestId('mode-edit');
  if ((await editMode.getAttribute('aria-pressed')) === 'true') return;
  const viewToggle = page.getByTestId('mode-view');
  await expect(viewToggle).toBeVisible();
  if ((await viewToggle.getAttribute('aria-pressed')) === 'true') {
    await viewToggle.click();
  }
  if ((await editMode.getAttribute('aria-pressed')) !== 'true') {
    await expect(editMode).toBeEnabled();
    await editMode.click();
  }
  await expect(editMode).toHaveAttribute('aria-pressed', 'true');
}

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

test.describe('HB3-4 — 編集モードでドラッグ中に頂点がカーソルへ追従し release 後ジャンプしない', () => {
  test('頂点ハンドルを実ドラッグするとプレビューが追従し、解放後も移動先に留まる', async () => {
    const { app, page } = await launchApp();
    try {
      await expect
        .poll(async () => page.evaluate(() => typeof (window as unknown as {
          __E2E__?: unknown;
        }).__E2E__))
        .toBe('object');

      // 1) Commit a square 面 with four REAL corner clicks at known SCREEN positions.
      await enterAddArea(page);
      const addLayer = page.getByTestId('add-input-layer');
      await expect(addLayer).toBeVisible();
      const ab = await addLayer.boundingBox();
      expect(ab).not.toBeNull();
      const a = ab!;
      const cx = a.x + a.width / 2;
      const cy = a.y + a.height / 2;
      const topLeft: readonly [number, number] = [cx - 120, cy - 120];
      const corners: ReadonlyArray<readonly [number, number]> = [
        topLeft,
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

      // 2) Enter 編集モード and REAL-click the body to select the face → handles draw.
      await enterEditMode(page);
      await expect(activeFeature).toHaveText('');
      await page.mouse.click(cx, cy);
      await expect(activeFeature).toHaveText(faceId);
      await expect.poll(async () => (await vertexHandlePositions(page)).length, {
        message: 'edit handles must be drawn for the selected face',
      }).toBeGreaterThanOrEqual(4);

      // The committed top-left vertex world position (the one we will drag).
      const before = await vertexHandlePositions(page);
      // Resolve the top-left corner's world coord via the renderer inverse so we can
      // identify which handle is the dragged one (independent of camera).
      const tlWorld = await page.evaluate(([px, py]) => {
        const e2e = (window as unknown as {
          __E2E__?: { screenToWorld?: (x: number, y: number) => { lon: number; lat: number } };
        }).__E2E__;
        // Fall back to identity if the optional hook is absent — the nearest() match
        // below still works because handle coords are compared relatively.
        return e2e?.screenToWorld?.(px, py) ?? { lon: px, lat: py };
      }, topLeft as unknown as [number, number]);
      const draggedBefore = nearest(before, tlWorld) ?? before[0]!;

      // 3) REAL vertex drag: mousedown on the top-left handle, several mousemove samples
      //    toward the centre, then mouseup. The grab starts ON the handle so U24 begins a
      //    VertexMove session (not a body move / selection).
      const [sx, sy] = topLeft;
      const dx = sx + 70; // drag 70px right / down toward the interior
      const dy = sy + 60;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      // Multiple real move samples (NOT one synthetic jump) — this is what the bug needs.
      const steps = 6;
      let midPreviewSeen = false;
      let midFollowed = false;
      for (let i = 1; i <= steps; i += 1) {
        const mx = sx + ((dx - sx) * i) / steps;
        const my = sy + ((dy - sy) * i) / steps;
        await page.mouse.move(mx, my);
        // During the drag a LIVE preview must be present...
        if (await hasLivePreview(page)) midPreviewSeen = true;
        // ...and the dragged vertex handle must have LEFT its committed position (follows).
        const during = await vertexHandlePositions(page);
        const movedHandle = nearest(during, draggedBefore);
        if (
          movedHandle !== null &&
          (Math.abs(movedHandle.lon - draggedBefore.lon) > 1e-9 ||
            Math.abs(movedHandle.lat - draggedBefore.lat) > 1e-9)
        ) {
          // No handle remains exactly at the committed dragged position → it followed.
          const stillAtOrigin = during.some(
            (h) =>
              Math.abs(h.lon - draggedBefore.lon) < 1e-9 &&
              Math.abs(h.lat - draggedBefore.lat) < 1e-9,
          );
          if (!stillAtOrigin) midFollowed = true;
        }
      }
      expect(midPreviewSeen, 'a live preview must be present during the drag (HB3-4)').toBe(
        true,
      );
      expect(
        midFollowed,
        'the dragged vertex must FOLLOW the cursor during the drag, not stay at the press position',
      ).toBe(true);

      // Capture the preview position at the final move sample (just before release).
      const lastDuring = await vertexHandlePositions(page);
      const previewFinal =
        lastDuring.find(
          (h) =>
            Math.abs(h.lon - draggedBefore.lon) > 1e-9 ||
            Math.abs(h.lat - draggedBefore.lat) > 1e-9,
        ) ?? null;

      await page.mouse.up();

      // 4) After release the geometry must NOT jump: the committed result equals the
      //    preview position (no snap back to the press position, no leap elsewhere).
      await expect.poll(async () => (await vertexHandlePositions(page)).length, {
        message: 'handles must persist after release (still the active feature)',
      }).toBeGreaterThanOrEqual(4);
      const after = await vertexHandlePositions(page);

      // The dragged vertex is NO LONGER at its committed press position.
      const backAtOrigin = after.some(
        (h) =>
          Math.abs(h.lon - draggedBefore.lon) < 1e-9 &&
          Math.abs(h.lat - draggedBefore.lat) < 1e-9,
      );
      expect(backAtOrigin, 'release must NOT jump the vertex back to the press position').toBe(
        false,
      );

      // And the released vertex matches the last live preview (continuity — no jump).
      if (previewFinal !== null) {
        const releasedMatch = after.some(
          (h) =>
            Math.abs(h.lon - previewFinal.lon) < 1e-6 &&
            Math.abs(h.lat - previewFinal.lat) < 1e-6,
        );
        expect(
          releasedMatch,
          'the released vertex must equal the final preview position (no post-release jump)',
        ).toBe(true);
      }
    } finally {
      await app.close();
    }
  });
});
