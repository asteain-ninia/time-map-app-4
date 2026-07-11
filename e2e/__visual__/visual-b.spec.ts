// VISUAL-B (discovery-only, NOT committed) — real-screen visual verification of
//   FR-20  面積表示 (property panel km² row)
//   FR-87  エッジ頂点追加 (drag an edge-midpoint handle to insert a vertex)
//   FR-87/88 頂点削除 (select a vertex handle → Delete) vs 地物削除 (no vertex → Delete)
//   FR-96  右クリックコンテキストメニュー → 削除 (vertex delete)
//
// Drives the REAL built Electron composite like a user (launch helper + testid
//導線 precisely mirrored from e2e/__bughunt__/explore*.spec.ts + e2e/helpers.ts).
// Discovery style: screenshots are the deliverable; assertions are light; a flow
// that jams is retried a few times, then a stuck screenshot is recorded (partial)
// and we move on. app/domain/src code is NEVER touched.

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { test, expect, type Page } from '@playwright/test';

import { launchApp } from '../helpers';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shotDir = resolve(projectRoot, 'screenshots', '__visual__');
mkdirSync(shotDir, { recursive: true });

interface Note {
  readonly kind: string;
  readonly detail: string;
}
const notes: Note[] = [];
function record(kind: string, detail: string): void {
  notes.push({ kind, detail });
  // eslint-disable-next-line no-console
  console.log(`VISUALB:${kind}: ${detail}`);
}

async function shot(page: Page, name: string): Promise<string> {
  const file = resolve(shotDir, `${name}.png`);
  try {
    await page.screenshot({ path: file });
  } catch (e) {
    record('screenshot-fail', `${name}: ${String(e)}`);
  }
  return file;
}

function attachListeners(page: Page): void {
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('VISUALB')) return;
    if (msg.type() === 'error') record('console.error', text);
    else if (msg.type() === 'warning' && /Warning:|React|Each child|deprecated|act\(/i.test(text)) {
      record('react.warning', text);
    }
  });
  page.on('pageerror', (err) => record('pageerror', `${err.name}: ${err.message}`));
  page.on('crash', () => record('page.crash', 'renderer crashed'));
}

// --- live observability hooks -------------------------------------------------
async function activeFeature(page: Page): Promise<string> {
  return ((await page.getByTestId('app-active-feature').textContent()) ?? '').trim();
}
async function activeVertex(page: Page): Promise<string> {
  return ((await page.getByTestId('app-active-vertex').textContent()) ?? '').trim();
}
interface PrimitiveCounts {
  handle: number;
  shape: number;
  point: number;
  line: number;
}
async function handleCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E__?: { getPrimitiveCounts: () => PrimitiveCounts };
    }).__E2E__;
    if (e2e === undefined) return -1;
    return e2e.getPrimitiveCounts().handle;
  });
}
async function featureListCount(page: Page): Promise<number> {
  if ((await page.getByTestId('feature-list-empty').count()) > 0) return 0;
  return page.locator('[data-testid^="feature-list-item-"]').count();
}

// --- mode / tool helpers (mirrors explore*/helpers) --------------------------
async function leaveView(page: Page): Promise<void> {
  const v = page.getByTestId('mode-view');
  if ((await v.getAttribute('aria-pressed')) === 'true') await v.click();
}
async function enterEditMode(page: Page): Promise<void> {
  const editMode = page.getByTestId('mode-edit');
  if ((await editMode.getAttribute('aria-pressed')) === 'true') return;
  const v = page.getByTestId('mode-view');
  if ((await v.getAttribute('aria-pressed')) === 'true') await v.click();
  if ((await editMode.getAttribute('aria-pressed')) !== 'true') await editMode.click();
  await expect(editMode).toHaveAttribute('aria-pressed', 'true');
}
async function armEditTool(page: Page, tool: string): Promise<boolean> {
  await enterEditMode(page);
  const btn = page.getByTestId(`tool-edit.${tool}`);
  if (!(await btn.isVisible().catch(() => false))) {
    record('edit-tool-missing', `tool-edit.${tool} not visible`);
    return false;
  }
  if ((await btn.getAttribute('aria-pressed')) !== 'true') await btn.click();
  return true;
}
async function showPropertiesTab(page: Page): Promise<void> {
  const tab = page.getByTestId('sidebar-tab-properties');
  if (await tab.isVisible().catch(() => false)) await tab.click().catch(() => undefined);
}

// Commit ONE square 面 (leaf) through the LIVE add導線, returning its committed id.
async function commitFace(page: Page, cx: number, cy: number, half: number): Promise<string> {
  await leaveView(page);
  const add = page.getByTestId('mode-add');
  await expect(add).toBeEnabled();
  if ((await add.getAttribute('aria-pressed')) !== 'true') await add.click();
  const area = page.getByTestId('tool-add.area');
  await expect(area).toBeVisible();
  if ((await area.getAttribute('aria-pressed')) !== 'true') await area.click();
  const layer = page.getByTestId('add-input-layer');
  await expect(layer).toBeVisible();
  const corners: ReadonlyArray<readonly [number, number]> = [
    [cx - half, cy - half],
    [cx + half, cy - half],
    [cx + half, cy + half],
    [cx - half, cy + half],
  ];
  for (const [px, py] of corners) await page.mouse.click(px, py);
  const complete = page.getByTestId('add-complete');
  await expect(complete).toBeEnabled();
  await complete.click();
  await page.getByTestId('add-save').click();
  try {
    await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/, { timeout: 8000 });
  } catch {
    record('add-no-selection', 'active-feature empty after add commit');
  }
  return activeFeature(page);
}

test.describe('VISUAL-B — FR-20 面積 / FR-87 エッジ頂点追加 / FR-87-88 頂点削除 / FR-96 右クリック削除', () => {
  test('area row, edge-vertex add, vertex delete vs feature delete, context-menu delete', async () => {
    test.setTimeout(300_000);
    const { app, page } = await launchApp();
    attachListeners(page);
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();

      const inputLayer = page.getByTestId('map-input-layer');
      const box = await inputLayer.boundingBox();
      expect(box).not.toBeNull();
      const b = box!;
      const cx = Math.round(b.x + b.width / 2);
      const cy = Math.round(b.y + b.height / 2);
      const half = 120; // 240x240 px square — vertices at corners, edge-midpoints ±120

      // =====================================================================
      // 1) FR-20 面積表示 — commit a 面, open プロパティ tab, read the km² row.
      // =====================================================================
      const faceId = await commitFace(page, cx, cy, half);
      record('face-committed', `faceId="${faceId}"`);
      await showPropertiesTab(page);
      await page.waitForTimeout(300);

      const propPanel = page.getByTestId('sidebar-panel-properties');
      const areaRow = propPanel.getByTestId('area-row');
      const areaRowVisible = await areaRow.isVisible().catch(() => false);
      if (areaRowVisible) {
        const areaText = ((await propPanel.getByTestId('area-value').textContent()) ?? '').trim();
        record('area-row', `visible; value="${areaText}"`);
        const num = Number((areaText.match(/-?\d+(\.\d+)?/) ?? [])[0]);
        if (!Number.isFinite(num) || num <= 0) {
          record('area-value-suspect', `area value not a positive finite km²: "${areaText}"`);
        }
      } else {
        record('area-row-missing', 'area-row not visible in properties panel (FR-20 row absent)');
      }
      await shot(page, 'b-01-area-row');

      // =====================================================================
      // 2) FR-87 エッジ頂点追加 — arm 頂点編集, select the face (handles draw),
      //    then drag the TOP edge-midpoint handle outward to insert a vertex.
      // =====================================================================
      const armedVertex = await armEditTool(page, 'vertex');
      if (!armedVertex) record('vertex-tool-missing', 'could not arm 頂点編集 tool');
      // Selecting the face body (a plain click) promotes it as the active feature so
      // its edit handles (4 vertex + 4 edge) are composited (HB3-9).
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/).catch(() => undefined);
      await page.waitForTimeout(200);
      const handlesBefore = await handleCount(page);
      record('handles-before-edge-add', `handle primitives=${handlesBefore} (square = 4 vtx + 4 edge = 8)`);
      await shot(page, 'b-02-edge-before');

      // Drag the top edge-midpoint (cx, cy-half) outward (upward) beyond the 3px drag
      // threshold so U24 EDIT_TOOL.EdgeAdd inserts a new vertex on that edge (FR-87).
      let edgeAdded = false;
      for (let attempt = 0; attempt < 3 && !edgeAdded; attempt += 1) {
        const midX = cx;
        const midY = cy - half;
        const dragTo = cy - half - 70 - attempt * 10;
        await page.mouse.move(midX, midY);
        await page.mouse.down();
        await page.mouse.move(midX, midY - 20, { steps: 4 });
        await page.mouse.move(midX + (attempt - 1) * 6, dragTo, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(250);
        if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
          record('edge-add-conflict', `edge-add attempt ${attempt} surfaced conflict modal`);
          await page.getByTestId('conflict-cancel').click().catch(() => undefined);
        }
        const hc = await handleCount(page);
        if (hc > handlesBefore) {
          edgeAdded = true;
          record('edge-add', `attempt ${attempt}: handle primitives ${handlesBefore} -> ${hc} (vertex inserted)`);
        } else {
          record('edge-add-retry', `attempt ${attempt}: handle count unchanged (${hc}); retrying`);
          // Re-select the face in case the gesture cleared/replaced selection.
          await page.mouse.click(cx, cy);
          await page.waitForTimeout(150);
        }
      }
      if (!edgeAdded) record('edge-add-stuck', 'edge-midpoint drag did not add a vertex after 3 attempts');
      await shot(page, 'b-03-edge-added');

      // =====================================================================
      // 3) FR-87/88 頂点削除 — click a vertex handle to SELECT it, then Delete.
      //    The chosen vertex should vanish, the face follow, the feature survive.
      // =====================================================================
      // Re-select the face body so its handles are live, then click a corner vertex
      // (bottom-left, unchanged by the edge-add) to select THAT single vertex.
      await page.mouse.click(cx, cy);
      await page.waitForTimeout(150);
      const cornerX = cx - half;
      const cornerY = cy + half;
      await page.mouse.click(cornerX, cornerY);
      await page.waitForTimeout(200);
      const selVtx = await activeVertex(page);
      const handlesBeforeVtxDelete = await handleCount(page);
      record('vertex-selected', `active-vertex="${selVtx}"; handles=${handlesBeforeVtxDelete}`);
      if (selVtx === '') record('vertex-select-fail', 'corner click did not select a vertex (app-active-vertex empty)');
      await shot(page, 'b-04-vertex-selected');

      const featBeforeVtxDelete = await activeFeature(page);
      await page.keyboard.press('Delete');
      await page.waitForTimeout(300);
      if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
        record('vertex-delete-conflict', 'vertex delete surfaced conflict modal');
        await page.getByTestId('conflict-cancel').click().catch(() => undefined);
      }
      const featAfterVtxDelete = await activeFeature(page);
      const vtxAfter = await activeVertex(page);
      const handlesAfterVtxDelete = await handleCount(page);
      record(
        'vertex-deleted',
        `feature ${featBeforeVtxDelete === featAfterVtxDelete ? 'survived' : `changed (${featBeforeVtxDelete}->${featAfterVtxDelete})`}; active-vertex now "${vtxAfter}"; handles ${handlesBeforeVtxDelete} -> ${handlesAfterVtxDelete}`,
      );
      if (featAfterVtxDelete === '') {
        record('vertex-delete-dropped-feature', 'feature disappeared after a single-vertex delete (expected survive)');
      }
      await shot(page, 'b-05-vertex-deleted');

      // =====================================================================
      // 4) 地物削除 との分岐 — NO vertex selected → Delete removes the whole 地物.
      // =====================================================================
      const listBeforeFeatDelete = await featureListCount(page);
      // Click the body to (re)select the feature; this CLEARS any vertex selection
      // (U22 body branch), so Delete now hits the whole-feature branch (FR-79/85).
      await page.mouse.click(cx, cy);
      await page.waitForTimeout(150);
      const vtxBeforeFeatDelete = await activeVertex(page);
      const featForDelete = await activeFeature(page);
      record('feature-reselected', `active-feature="${featForDelete}"; active-vertex="${vtxBeforeFeatDelete}" (should be empty)`);
      await page.keyboard.press('Delete');
      await page.waitForTimeout(300);
      if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
        record('feature-delete-conflict', 'feature delete surfaced conflict modal');
        await page.getByTestId('conflict-cancel').click().catch(() => undefined);
      }
      const listAfterFeatDelete = await featureListCount(page);
      const featAfterFeatDelete = await activeFeature(page);
      record(
        'feature-deleted',
        `feature-list ${listBeforeFeatDelete} -> ${listAfterFeatDelete}; active-feature now "${featAfterFeatDelete}"`,
      );
      if (listAfterFeatDelete >= listBeforeFeatDelete) {
        record('feature-delete-noop', `feature count did not drop (${listBeforeFeatDelete} -> ${listAfterFeatDelete})`);
      }
      await shot(page, 'b-06-feature-deleted');

      // Ctrl+Z → the deleted 地物 comes back (undo in an editing mode).
      await enterEditMode(page);
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(300);
      const listAfterUndo = await featureListCount(page);
      record('undo-restored', `feature-list ${listAfterFeatDelete} -> ${listAfterUndo} after Ctrl+Z`);
      if (listAfterUndo <= listAfterFeatDelete) {
        record('undo-noop', `undo did not restore the feature (${listAfterFeatDelete} -> ${listAfterUndo})`);
      }
      await shot(page, 'b-07-undo-restored');

      // =====================================================================
      // 5) FR-96 右クリックコンテキストメニュー → 削除 (should delete the VERTEX).
      // =====================================================================
      await armEditTool(page, 'vertex');
      // Left-click the body to make the restored face active (handles hittable).
      await page.mouse.click(cx, cy);
      await page.waitForTimeout(200);
      const handlesBeforeCtx = await handleCount(page);
      // Right-click a corner vertex: the live context-menu port promotes that vertex
      // into the selection AND opens the menu (FR-96).
      const ctxCornerX = cx + half;
      const ctxCornerY = cy - half;
      let menuShown = false;
      for (let attempt = 0; attempt < 3 && !menuShown; attempt += 1) {
        await page.mouse.click(ctxCornerX, ctxCornerY, { button: 'right' });
        await page.waitForTimeout(200);
        if ((await page.getByTestId('context-menu').count()) > 0) {
          menuShown = true;
        } else {
          record('context-menu-retry', `attempt ${attempt}: context-menu did not appear`);
          await page.mouse.click(cx, cy);
          await page.waitForTimeout(150);
        }
      }
      const ctxVtx = await activeVertex(page);
      record('context-open', `context-menu ${menuShown ? 'shown' : 'MISSING'}; active-vertex after right-click="${ctxVtx}"; handles=${handlesBeforeCtx}`);
      const ctx = page.getByTestId('context-menu');
      if (menuShown) {
        const items = ctx.locator('.context-menu__item');
        const labels: string[] = [];
        const n = await items.count();
        for (let i = 0; i < n; i += 1) labels.push(((await items.nth(i).textContent()) ?? '').trim());
        record('context-items', `items=${JSON.stringify(labels)}`);
      }
      await shot(page, 'b-08-context-menu');

      // Click 削除 (edit.delete) in the menu → vertex delete (a vertex is selected).
      const listBeforeCtxDelete = await featureListCount(page);
      const featBeforeCtxDelete = await activeFeature(page);
      if (menuShown) {
        const deleteItem = ctx.locator('[data-command="edit.delete"]');
        if ((await deleteItem.count()) > 0 && (await deleteItem.isEnabled().catch(() => false))) {
          await deleteItem.click();
          await page.waitForTimeout(300);
          if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
            record('context-delete-conflict', 'context-menu delete surfaced conflict modal');
            await page.getByTestId('conflict-cancel').click().catch(() => undefined);
          }
        } else {
          record('context-delete-missing', '削除 (edit.delete) item not present/enabled in context-menu');
        }
      }
      const listAfterCtxDelete = await featureListCount(page);
      const featAfterCtxDelete = await activeFeature(page);
      const handlesAfterCtx = await handleCount(page);
      const featureSurvived = featAfterCtxDelete === featBeforeCtxDelete && listAfterCtxDelete === listBeforeCtxDelete;
      record(
        'context-deleted',
        `feature-list ${listBeforeCtxDelete} -> ${listAfterCtxDelete}; active-feature ${featBeforeCtxDelete}->${featAfterCtxDelete}; handles ${handlesBeforeCtx} -> ${handlesAfterCtx}; ${featureSurvived ? 'VERTEX-delete (feature survived)' : 'FEATURE removed (not a vertex delete)'}`,
      );
      await shot(page, 'b-09-context-deleted');

      // eslint-disable-next-line no-console
      console.log(`VISUALB_SUMMARY: ${JSON.stringify(notes)}`);
      await expect(page.getByTestId('app-shell')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
