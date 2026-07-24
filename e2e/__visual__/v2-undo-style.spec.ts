// V2 (discovery-only) — verify on the CURRENT HEAD build whether a 地物 restored by
// Ctrl+Z after a 地物削除 is painted with the SELECTED style while the property panel
// reports 未選択 (the old b-07 MEDIUM finding, 2026-07-03 build).
//
// Method: commit one square 面 through the LIVE add導線, then measure the ACTUAL
// canvas pixel at the face centre in four states (selected / deselected / after
// undo), alongside the live app-active-feature marker and the property-panel text.
// Nothing in src/ is touched; screenshots + measured RGBA are the deliverable.

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { test, expect, type Page } from '@playwright/test';

import { launchApp } from '../helpers';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shotDir = resolve(projectRoot, 'screenshots', '__visual__');
mkdirSync(shotDir, { recursive: true });

function record(kind: string, detail: string): void {
  // eslint-disable-next-line no-console
  console.log(`V2:${kind}: ${detail}`);
}

async function shot(page: Page, name: string): Promise<void> {
  try {
    await page.screenshot({ path: resolve(shotDir, `${name}.png`) });
  } catch (e) {
    record('screenshot-fail', `${name}: ${String(e)}`);
  }
}

interface Sample {
  readonly rgba: readonly number[];
  readonly canvasCount: number;
  readonly note: string;
}

/**
 * Read the composited pixel at a CLIENT point by sampling every <canvas> stacked at
 * that point, topmost-last (the map layers are absolutely stacked). Returns the
 * last canvas whose pixel is non-transparent — i.e. what the user sees drawn there.
 */
async function samplePixel(page: Page, clientX: number, clientY: number): Promise<Sample> {
  return page.evaluate(
    ({ x, y }) => {
      const canvases = Array.from(document.querySelectorAll('canvas'));
      let picked: number[] = [];
      let note = '';
      const perCanvas: string[] = [];
      canvases.forEach((c, i) => {
        const r = c.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) return;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (ctx === null) return;
        const sx = Math.round(((x - r.left) / r.width) * c.width);
        const sy = Math.round(((y - r.top) / r.height) * c.height);
        try {
          const d = ctx.getImageData(sx, sy, 1, 1).data;
          const px = [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, d[3] ?? 0];
          perCanvas.push(`#${i}(${c.width}x${c.height})=${px.join(',')}`);
          if (px[3] !== 0) picked = px;
        } catch (e) {
          note += `canvas#${i} getImageData failed: ${String(e)}; `;
        }
      });
      return { rgba: picked, canvasCount: canvases.length, note: `${note}${perCanvas.join(' | ')}` };
    },
    { x: clientX, y: clientY },
  );
}

/**
 * Sample several points INSIDE the square but away from the red meridian/equator
 * guide lines and the grid, and report each so a single unlucky pixel cannot be
 * mistaken for the fill.
 */
async function sampleFill(page: Page, cx: number, cy: number): Promise<string> {
  const offsets: ReadonlyArray<readonly [number, number]> = [
    [-70, -70],
    [-70, 60],
    [55, -70],
    [55, 60],
    [-40, 45],
  ];
  const out: string[] = [];
  for (const [dx, dy] of offsets) {
    const s = await samplePixel(page, cx + dx, cy + dy);
    out.push(`(${dx},${dy})=[${s.rgba.join(',')}]`);
  }
  return out.join(' ');
}

async function activeFeature(page: Page): Promise<string> {
  return ((await page.getByTestId('app-active-feature').textContent()) ?? '').trim();
}
async function drawnCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const e2e = (window as unknown as { __E2E__?: { getDrawnFeatureCount: () => number } }).__E2E__;
    return e2e === undefined ? -1 : e2e.getDrawnFeatureCount();
  });
}
async function panelText(page: Page): Promise<string> {
  const p = page.getByTestId('sidebar-panel-properties');
  if ((await p.count()) === 0) return '(panel absent)';
  return ((await p.textContent()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

async function leaveView(page: Page): Promise<void> {
  const v = page.getByTestId('mode-view');
  if ((await v.getAttribute('aria-pressed')) === 'true') await v.click();
}
async function enterEditMode(page: Page): Promise<void> {
  await leaveView(page);
  const editMode = page.getByTestId('mode-edit');
  if ((await editMode.getAttribute('aria-pressed')) !== 'true') await editMode.click();
  await expect(editMode).toHaveAttribute('aria-pressed', 'true');
}

test.describe('V2 — 削除→Ctrl+Z 復活後の塗り色 (現HEAD)', () => {
  test('undo-restored face: measured fill vs selection state', async () => {
    test.setTimeout(300_000);
    const { app, page } = await launchApp();
    page.on('pageerror', (err) => record('pageerror', `${err.name}: ${err.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') record('console.error', m.text());
    });
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      const box = await page.getByTestId('map-input-layer').boundingBox();
      expect(box).not.toBeNull();
      const b = box!;
      const cx = Math.round(b.x + b.width / 2);
      const cy = Math.round(b.y + b.height / 2);
      const half = 120;

      // ---- 1) commit ONE square 面 through the live add導線 -------------------
      await leaveView(page);
      const add = page.getByTestId('mode-add');
      await expect(add).toBeEnabled();
      if ((await add.getAttribute('aria-pressed')) !== 'true') await add.click();
      const area = page.getByTestId('tool-add.area');
      if ((await area.getAttribute('aria-pressed')) !== 'true') await area.click();
      await expect(page.getByTestId('add-input-layer')).toBeVisible();
      for (const [px, py] of [
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx + half, cy + half],
        [cx - half, cy + half],
      ] as ReadonlyArray<readonly [number, number]>) {
        await page.mouse.click(px, py);
      }
      const complete = page.getByTestId('add-complete');
      await expect(complete).toBeEnabled();
      await complete.click();
      await page.getByTestId('add-save').click();
      await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/, { timeout: 10_000 });
      const faceId = await activeFeature(page);
      record('committed', `faceId="${faceId}" drawn=${await drawnCount(page)}`);

      // ---- 2) CALIBRATION A: just committed => SELECTED (active) -------------
      const tab = page.getByTestId('sidebar-tab-properties');
      if (await tab.isVisible().catch(() => false)) await tab.click().catch(() => undefined);
      await page.waitForTimeout(400);
      const sSel = await samplePixel(page, cx, cy);
      record('A-selected', `active="${await activeFeature(page)}" rgba=[${sSel.rgba.join(',')}] canvases=${sSel.canvasCount}`);
      record('A-fill', await sampleFill(page, cx, cy));
      record('A-panel', await panelText(page));
      await shot(page, 'v2-01-selected');

      // ---- 3) CALIBRATION B: deselect (Escape / click empty map) => NORMAL ----
      await enterEditMode(page);
      const sel = page.getByTestId('tool-edit.select');
      if (await sel.isVisible().catch(() => false)) {
        if ((await sel.getAttribute('aria-pressed')) !== 'true') await sel.click();
      }
      // Click far from the square (empty ocean) to clear the selection.
      await page.mouse.click(Math.round(b.x + 40), Math.round(b.y + 40));
      await page.waitForTimeout(400);
      const afterDeselect = await activeFeature(page);
      if (afterDeselect !== '') {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
      const sNorm = await samplePixel(page, cx, cy);
      record('B-deselected', `active="${await activeFeature(page)}" rgba=[${sNorm.rgba.join(',')}]`);
      record('B-fill', await sampleFill(page, cx, cy));
      record('B-panel', await panelText(page));
      await shot(page, 'v2-02-deselected');

      // ---- 4) select the face, then 地物削除 (no vertex selected) -------------
      await page.mouse.click(cx, cy);
      await page.waitForTimeout(300);
      record('C-reselected', `active="${await activeFeature(page)}" drawn=${await drawnCount(page)}`);
      const sReSel = await samplePixel(page, cx, cy);
      record('C-selected-again', `rgba=[${sReSel.rgba.join(',')}]`);
      record('C-fill', await sampleFill(page, cx, cy));
      await shot(page, 'v2-025-selected-edit');
      await page.keyboard.press('Delete');
      await page.waitForTimeout(500);
      if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
        record('delete-conflict', 'conflict modal surfaced on delete');
        await page.getByTestId('conflict-cancel').click().catch(() => undefined);
      }
      const sDeleted = await samplePixel(page, cx, cy);
      record('D-deleted', `active="${await activeFeature(page)}" drawn=${await drawnCount(page)} rgba=[${sDeleted.rgba.join(',')}]`);
      record('D-panel', await panelText(page));
      await shot(page, 'v2-03-deleted');

      // ---- 5) Ctrl+Z → restored; measure the fill IMMEDIATELY ---------------
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(600);
      const sUndo = await samplePixel(page, cx, cy);
      const undoActive = await activeFeature(page);
      record('E-undo', `active="${undoActive}" drawn=${await drawnCount(page)} rgba=[${sUndo.rgba.join(',')}]`);
      record('E-fill', await sampleFill(page, cx, cy));
      record('E-panel', await panelText(page));
      await shot(page, 'v2-04-undo-restored');

      // ---- 6) settle: re-measure after a further idle frame ------------------
      await page.waitForTimeout(1500);
      const sUndo2 = await samplePixel(page, cx, cy);
      record('F-undo-settled', `active="${await activeFeature(page)}" rgba=[${sUndo2.rgba.join(',')}]`);
      record('F-fill', await sampleFill(page, cx, cy));
      // Re-select the restored feature: proves the SELECTED style still resolves.
      await page.mouse.click(cx, cy);
      await page.waitForTimeout(400);
      record('H-reselect-after-undo', `active="${await activeFeature(page)}"`);
      record('H-fill', await sampleFill(page, cx, cy));
      await shot(page, 'v2-06-reselected-after-undo');
      await shot(page, 'v2-05-undo-settled');

      // ---- 7) also try the undo BUTTON path (menu 編集→元に戻す) -------------
      record('G-note', 'redo/undo button path not driven (keyboard path measured above)');

      await expect(page.getByTestId('app-shell')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  // Variant that mirrors the OLD b-06/b-07 導線 exactly: 頂点編集 armed when the
  // feature is deleted, then Ctrl+Z in 編集モード.
  test('variant: 頂点編集 armed at delete time (mirrors old b-07 導線)', async () => {
    test.setTimeout(300_000);
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      const box = await page.getByTestId('map-input-layer').boundingBox();
      const b = box!;
      const cx = Math.round(b.x + b.width / 2);
      const cy = Math.round(b.y + b.height / 2);
      const half = 120;

      await leaveView(page);
      const add = page.getByTestId('mode-add');
      if ((await add.getAttribute('aria-pressed')) !== 'true') await add.click();
      const area = page.getByTestId('tool-add.area');
      if ((await area.getAttribute('aria-pressed')) !== 'true') await area.click();
      await expect(page.getByTestId('add-input-layer')).toBeVisible();
      for (const [px, py] of [
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx + half, cy + half],
        [cx - half, cy + half],
      ] as ReadonlyArray<readonly [number, number]>) {
        await page.mouse.click(px, py);
      }
      await page.getByTestId('add-complete').click();
      await page.getByTestId('add-save').click();
      await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/, { timeout: 10_000 });

      await enterEditMode(page);
      const vtx = page.getByTestId('tool-edit.vertex');
      if ((await vtx.getAttribute('aria-pressed')) !== 'true') await vtx.click();
      await page.mouse.click(cx, cy); // body click: selects feature, clears vertex sel
      await page.waitForTimeout(300);
      record('V-selected', `active="${await activeFeature(page)}"`);
      record('V-fill-selected', await sampleFill(page, cx, cy));
      await page.keyboard.press('Delete');
      await page.waitForTimeout(500);
      record('V-deleted', `active="${await activeFeature(page)}" drawn=${await drawnCount(page)}`);
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(800);
      const handles = await page.evaluate(() => {
        const e2e = (window as unknown as {
          __E2E__?: { getPrimitiveCounts: () => { handle: number } };
        }).__E2E__;
        return e2e === undefined ? -1 : e2e.getPrimitiveCounts().handle;
      });
      record('V-undo', `active="${await activeFeature(page)}" drawn=${await drawnCount(page)} handles=${handles}`);
      record('V-fill-undo', await sampleFill(page, cx, cy));
      record('V-panel', await panelText(page));
      await shot(page, 'v2-07-variant-undo-restored');
    } finally {
      await app.close();
    }
  });
});
