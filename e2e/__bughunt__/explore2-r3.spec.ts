// BUGHUNT R2 (explore2-r3) — e2e exploration (discovery-only). Drives the REAL
// built Electron composite "like a user" with an operation plan deliberately
// DIFFERENT from explore2-r1 (conflict modal / settings-zoom-clamp / save-load /
// undo連打 / extreme-zoom+pan) and explore2-r2 (knife split / parent-child / search
// / time-edges / delete-undo). This round exercises the surfaces those rounds left
// UNTOUCHED, to stress different invariants:
//
//   A. LINE-FEATURE ADD (tool-add.line, FR-75): draw a multi-vertex line, toggle
//      grid-snap MID-DRAW, exercise add-undo (vertex pop) and gate the vertex count
//      telescopes correctly (draw N -> undo k -> N-k), then commit. Gates: add-is-line
//      marker is present for the line tool; feature count grows by exactly 1;
//      coords stay finite throughout.
//   B. POINT-FEATURE ADD (tool-add.point): single-click confirm; gate +1 feature,
//      list==diagnostics parity (single truth source), selection valid.
//   C. VERTEX EDIT / MOVE (tool-edit.vertex, tool-edit.move): select a face, arm the
//      vertex tool, click a vertex (gate app-active-vertex + owner reflect a real
//      selection, not NaN/empty), drag it, gate camera + anchor ordering finite and
//      that the move does not corrupt the feature count. Then op∘逆op via Ctrl+Z.
//   D. LONGITUDE SHIFT (FR-12): drag the 経度シフト slider right then left, click the
//      ◀/▶ shift buttons, and toggle the 0度/180度 presets. Gate
//      center-lon-readout never NaN/Infinity and camera hooks finite. Metamorphic:
//      preset A -> preset B -> preset A returns the readout to its original value.
//   E. CONTEXT MENU (FR-96): right-click on the map in View and Edit modes; gate the
//      context-menu mounts (or cleanly no-ops) with no malformed items and dismisses.
//   F. ANCHOR-MODE toggle (list <-> timebar) on a live selection; gate no crash, no
//      malformed anchor rows, and list==diagnostics parity after the round-trip.
//      Plus a save∘load reachability / dirty-flag check (native dialogs NOT fired).
//
// STRICT GATE: any console.error, React warning, unhandled rejection, or
// NaN/Infinity in the live data-* hooks / readouts is recorded as a finding (the
// test does NOT crash on them). Anomalies surface via console.log("BUGHUNT:...")
// and a final BUGHUNT_SUMMARY JSON line. Each step screenshots into
// screenshots/__bughunt__/r2-3-*.png.
//
// INVARIANTS gated after each op (recorded, not crashed):
//   - 座標に NaN/Infinity 無し (data-pan-x/y, data-zoom on map-input-layer)
//   - 選択が常に有効 (active-feature / active-vertex ids: no NaN/undefined/null)
//   - 階層森: 地物一覧 count == 診断情報 feature-count (single truth source)
//   - 錨列の昇順・非重複 (anchor-list rows time-sorted, non-overlapping)
//   - center-lon-readout finite; preset A∘B∘A = identity (longitude metamorphic)
//   - add-undo telescopes vertex count; line tool marks add-is-line
//   - op∘逆op = identity (vertex move then undo: feature count unchanged)

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { test, expect, type Page, type Locator } from '@playwright/test';

import { launchApp } from '../helpers';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shotDir = resolve(projectRoot, 'screenshots', '__bughunt__');
mkdirSync(shotDir, { recursive: true });

interface Anomaly {
  readonly kind: string;
  readonly detail: string;
}

const anomalies: Anomaly[] = [];
function record(kind: string, detail: string): void {
  anomalies.push({ kind, detail });
  console.log(`BUGHUNT:${kind}: ${detail}`);
}

let shotN = 0;
async function shot(page: Page, label: string): Promise<void> {
  shotN += 1;
  const n = String(shotN).padStart(2, '0');
  const file = resolve(shotDir, `r2-3-${n}-${label}.png`);
  try {
    await page.screenshot({ path: file });
  } catch (e) {
    record('screenshot-fail', `${label}: ${String(e)}`);
  }
}

function attachListeners(page: Page): void {
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (text.startsWith('BUGHUNT')) return; // our own scraping lines
    if (type === 'error') {
      record('console.error', text);
    } else if (type === 'warning') {
      if (/Warning:|React|Each child|deprecated|act\(/i.test(text)) {
        record('react.warning', text);
      } else {
        record('console.warning', text);
      }
    }
  });
  page.on('pageerror', (err) => record('pageerror', `${err.name}: ${err.message}`));
  page.on('crash', () => record('page.crash', 'renderer crashed'));
  void page.addInitScript(() => {
    window.addEventListener('unhandledrejection', (ev) => {
      console.error(`UNHANDLED_REJECTION: ${String((ev as PromiseRejectionEvent).reason)}`);
    });
  });
}

// --- camera hooks: NaN/Infinity gate -----------------------------------------
async function checkCamera(page: Page, where: string): Promise<void> {
  const layer = page.getByTestId('map-input-layer');
  for (const a of ['data-pan-x', 'data-pan-y', 'data-zoom']) {
    const raw = await layer.getAttribute(a).catch(() => null);
    if (raw === null) continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) record('coord-nonfinite', `${where}: ${a}=${raw}`);
  }
}

async function activeFeature(page: Page): Promise<string> {
  const t = ((await page.getByTestId('app-active-feature').textContent()) ?? '').trim();
  if (/NaN|undefined|null|Infinity/.test(t)) {
    record('selection-malformed', `active-feature="${t}"`);
  }
  return t;
}

async function leaveView(page: Page): Promise<void> {
  const v = page.getByTestId('mode-view');
  if ((await v.getAttribute('aria-pressed')) === 'true') await v.click();
}

async function goView(page: Page): Promise<void> {
  const v = page.getByTestId('mode-view');
  if ((await v.getAttribute('aria-pressed')) !== 'true') {
    await v.click().catch(() => undefined);
  }
  await page
    .getByTestId('add-input-layer')
    .waitFor({ state: 'detached', timeout: 4000 })
    .catch(() => undefined);
}

async function showSidebarTab(page: Page, key: 'events' | 'features' | 'properties'): Promise<void> {
  const tab = page.getByTestId(`sidebar-tab-${key}`);
  if (await tab.isVisible().catch(() => false)) {
    await tab.click().catch(() => undefined);
  }
}

async function featureListCount(page: Page): Promise<number> {
  const empty = page.getByTestId('feature-list-empty');
  if ((await empty.count()) > 0) return 0;
  return page.locator('[data-testid^="feature-list-item-"]').count();
}

async function clickMenuCommand(page: Page, menu: string, commandId: string): Promise<boolean> {
  await goView(page);
  await page.getByTestId(`menu-${menu}`).click();
  const items = page.getByTestId(`menu-items-${menu}`);
  if (!(await items.isVisible().catch(() => false))) {
    record('menu-not-open', `menu-${menu} did not open`);
    return false;
  }
  const item = items.locator(`[data-command="${commandId}"]`);
  if (!(await item.isVisible().catch(() => false))) {
    record('menu-item-missing', `${commandId} not visible in menu-${menu}`);
    return false;
  }
  if (!(await item.isEnabled().catch(() => false))) {
    record('menu-item-disabled', `${commandId} is disabled (dead command?)`);
    await page.getByTestId(`menu-${menu}`).click().catch(() => undefined);
    return false;
  }
  await item.click();
  return true;
}

async function diagFeatureCount(page: Page): Promise<number> {
  if (!(await clickMenuCommand(page, 'help', 'help.diagnostics'))) return Number.NaN;
  await expect(page.getByTestId('diagnostics-panel')).toBeVisible();
  const raw = ((await page.getByTestId('diagnostics-feature-count').textContent()) ?? '').trim();
  if (/NaN|Infinity|undefined/.test(raw)) record('diag-count-malformed', `feature-count="${raw}"`);
  await page.getByTestId('diagnostics-panel-close').click().catch(() => undefined);
  await page.keyboard.press('Escape').catch(() => undefined);
  return Number(raw);
}

async function diagUnsaved(page: Page): Promise<string> {
  if (!(await clickMenuCommand(page, 'help', 'help.diagnostics'))) return '?';
  await expect(page.getByTestId('diagnostics-panel')).toBeVisible();
  const raw = ((await page.getByTestId('diagnostics-unsaved').textContent()) ?? '').trim();
  await page.getByTestId('diagnostics-panel-close').click().catch(() => undefined);
  await page.keyboard.press('Escape').catch(() => undefined);
  return raw;
}

async function checkAnchorOrdering(page: Page, where: string): Promise<void> {
  const rows = page.locator('[data-testid^="anchor-row-"]');
  const n = await rows.count();
  if (n === 0) return;
  const starts: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const txt = ((await rows.nth(i).textContent()) ?? '').trim();
    if (/NaN|Infinity|undefined/.test(txt)) {
      record('anchor-row-malformed', `${where}: anchor row ${i} text="${txt}"`);
    }
    const m = txt.match(/-?\d+/);
    if (m) starts.push(Number(m[0]));
  }
  for (let i = 1; i < starts.length; i += 1) {
    const prev = starts[i - 1];
    const cur = starts[i];
    if (prev === undefined || cur === undefined) continue;
    if (cur < prev) {
      record('anchor-order-violation', `${where}: anchor starts not ascending: ${prev} then ${cur}`);
      break;
    }
  }
}

// Arm a given add-mode tool (point/line/area). Returns false if the tool button
// was missing.
async function armAddTool(page: Page, tool: 'point' | 'line' | 'area'): Promise<boolean> {
  await leaveView(page);
  const add = page.getByTestId('mode-add');
  await expect(add).toBeEnabled();
  if ((await add.getAttribute('aria-pressed')) !== 'true') await add.click();
  const btn = page.getByTestId(`tool-add.${tool}`);
  if (!(await btn.isVisible().catch(() => false))) {
    record('add-tool-missing', `tool-add.${tool} not visible in add mode`);
    return false;
  }
  if ((await btn.getAttribute('aria-pressed')) === 'true') await btn.click();
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  return true;
}

// Arm an edit-mode tool (select/vertex/move/...). Returns false if missing.
async function armEditTool(page: Page, tool: string): Promise<boolean> {
  await leaveView(page);
  const edit = page.getByTestId('mode-edit');
  await expect(edit).toBeEnabled();
  if ((await edit.getAttribute('aria-pressed')) !== 'true') await edit.click();
  const btn = page.getByTestId(`tool-edit.${tool}`);
  if (!(await btn.isVisible().catch(() => false))) {
    record('edit-tool-missing', `tool-edit.${tool} not visible in edit mode`);
    return false;
  }
  if ((await btn.getAttribute('aria-pressed')) !== 'true') await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  return true;
}

// Commit one square AREA face (used to set up edit/vertex targets).
async function commitArea(page: Page, cx: number, cy: number, half: number, name?: string): Promise<'committed' | 'rejected' | 'conflict'> {
  if (!(await armAddTool(page, 'area'))) return 'rejected';
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
  if ((await page.getByTestId('add-rejected').count()) > 0) {
    const m = ((await page.getByTestId('add-rejected').textContent()) ?? '').trim();
    record('add-rejected', `area rejected before save: ${m}`);
    return 'rejected';
  }
  if (name !== undefined) await page.getByTestId('add-name').fill(name).catch(() => undefined);
  await page.getByTestId('add-save').click();
  await page.waitForTimeout(200);
  if ((await page.getByTestId('conflict-modal-root').count()) > 0) return 'conflict';
  return 'committed';
}

function parseReadoutDeg(text: string): number | null {
  // e.g. "中心経度: 170°E" -> +170, "170°W" -> -170
  const m = text.match(/(-?\d+(?:\.\d+)?)\s*°\s*([EW])?/);
  if (!m || m[1] === undefined) return null;
  let v = Number(m[1]);
  if (m[2] === 'W') v = -v;
  return Number.isFinite(v) ? v : null;
}

test.describe('BUGHUNT R2 — line/point add / vertex edit-move / longitude shift / context menu / anchor-mode', () => {
  test('explore2-r3: line+grid+undo, point, vertex move∘undo, lon-shift identity, context menu, anchor-mode parity', async () => {
    test.setTimeout(240_000);
    const { app, page } = await launchApp();
    attachListeners(page);
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await shot(page, 'boot');
      await checkCamera(page, 'boot');

      const inputLayer = page.getByTestId('map-input-layer');
      const box = await inputLayer.boundingBox();
      expect(box).not.toBeNull();
      const b = box!;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;

      const unsaved0 = await diagUnsaved(page);
      if (unsaved0 !== 'なし') record('boot-dirty', `boot unsaved=${unsaved0} (expected なし)`);

      // =====================================================================
      // A. LINE-FEATURE ADD — grid-snap mid-draw + add-undo telescoping.
      // =====================================================================
      await goView(page);
      await showSidebarTab(page, 'features');
      const countBeforeLine = await featureListCount(page);

      if (await armAddTool(page, 'line')) {
        const layer = page.getByTestId('add-input-layer');
        await expect(layer).toBeVisible();
        // Line tool should mark add-is-line.
        if ((await page.getByTestId('add-is-line').count()) === 0) {
          record('add-line-marker-missing', 'tool-add.line armed but add-is-line marker absent');
        }
        // Draw 5 vertices along a zig-zag.
        const pts: ReadonlyArray<readonly [number, number]> = [
          [cx - 220, cy - 60],
          [cx - 110, cy + 40],
          [cx, cy - 40],
          [cx + 110, cy + 40],
          [cx + 220, cy - 60],
        ];
        for (const [px, py] of pts) await page.mouse.click(px, py);
        let vc = ((await page.getByTestId('add-vertex-count').textContent()) ?? '').trim();
        if (vc !== '5') record('add-vertex-drop', `line: expected 5 vertices, got ${vc}`);
        await shot(page, 'line-drawn');

        // Toggle grid-snap MID-DRAW (must not drop or duplicate vertices).
        const snap = page.getByTestId('add-grid-snap');
        const before = ((await page.getByTestId('add-vertex-count').textContent()) ?? '').trim();
        await snap.click().catch(() => undefined);
        await page.waitForTimeout(60);
        const after = ((await page.getByTestId('add-vertex-count').textContent()) ?? '').trim();
        if (before !== after) {
          record('grid-snap-vertex-change', `toggling grid-snap changed vertex count ${before} -> ${after}`);
        }
        // Add one more vertex under grid-snap.
        await page.mouse.click(cx + 260, cy + 20);
        vc = ((await page.getByTestId('add-vertex-count').textContent()) ?? '').trim();
        if (vc !== '6') record('add-vertex-drop', `line+snap: expected 6 vertices, got ${vc}`);

        // add-undo: pop two vertices, gate telescoping 6 -> 4.
        const undo = page.getByTestId('add-undo');
        await undo.click().catch(() => undefined);
        await undo.click().catch(() => undefined);
        await page.waitForTimeout(60);
        vc = ((await page.getByTestId('add-vertex-count').textContent()) ?? '').trim();
        if (vc !== '4') record('add-undo-telescope', `expected 6-2=4 vertices after add-undo*2, got ${vc}`);
        await shot(page, 'line-after-undo');

        const complete = page.getByTestId('add-complete');
        if (!(await complete.isEnabled().catch(() => false))) {
          record('line-complete-disabled', 'add-complete disabled with 4 line vertices');
        } else {
          await complete.click();
          if ((await page.getByTestId('add-rejected').count()) > 0) {
            const m = ((await page.getByTestId('add-rejected').textContent()) ?? '').trim();
            record('line-rejected', `line rejected: ${m}`);
            await page.getByTestId('add-rejected-dismiss').click().catch(() => undefined);
          } else {
            await page.getByTestId('add-name').fill('zigzag-line').catch(() => undefined);
            await page.getByTestId('add-save').click();
            await page.waitForTimeout(200);
            if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
              record('line-conflict', 'line add paused on conflict modal (unexpected for a line)');
              await page.getByTestId('conflict-cancel').click().catch(() => undefined);
            }
          }
        }
        await checkCamera(page, 'after-line');
        await activeFeature(page);
        await shot(page, 'line-saved');
      }

      await goView(page);
      await showSidebarTab(page, 'features');
      const countAfterLine = await featureListCount(page);
      const diagAfterLine = await diagFeatureCount(page);
      if (Number.isFinite(diagAfterLine) && diagAfterLine !== countAfterLine) {
        record('view-count-mismatch-line', `feature-list=${countAfterLine} diagnostics=${diagAfterLine}`);
      }
      if (countAfterLine !== countBeforeLine + 1) {
        record('line-count', `expected line count ${countBeforeLine}->${countBeforeLine + 1}, got ${countAfterLine}`);
      }

      // =====================================================================
      // B. POINT-FEATURE ADD — single-click confirm.
      // =====================================================================
      await goView(page);
      await showSidebarTab(page, 'features');
      const countBeforePoint = await featureListCount(page);
      if (await armAddTool(page, 'point')) {
        const layer = page.getByTestId('add-input-layer');
        await expect(layer).toBeVisible();
        // Single click places the point; complete/save may follow.
        await page.mouse.click(cx + 300, cy - 200);
        await page.waitForTimeout(100);
        // A point may auto-advance to the property form, or expose complete.
        const complete = page.getByTestId('add-complete');
        if (await complete.isVisible().catch(() => false)) {
          if (await complete.isEnabled().catch(() => false)) await complete.click();
        }
        if ((await page.getByTestId('add-rejected').count()) > 0) {
          const m = ((await page.getByTestId('add-rejected').textContent()) ?? '').trim();
          record('point-rejected', `point rejected: ${m}`);
          await page.getByTestId('add-rejected-dismiss').click().catch(() => undefined);
        } else {
          const nameField = page.getByTestId('add-name');
          if (await nameField.isVisible().catch(() => false)) {
            await nameField.fill('lone-point').catch(() => undefined);
            await page.getByTestId('add-save').click().catch(() => undefined);
            await page.waitForTimeout(200);
            if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
              await page.getByTestId('conflict-cancel').click().catch(() => undefined);
            }
          } else {
            record('point-no-form', 'point add produced neither rejection nor property form');
          }
        }
        await checkCamera(page, 'after-point');
        await shot(page, 'point-saved');
      }
      await goView(page);
      await showSidebarTab(page, 'features');
      const countAfterPoint = await featureListCount(page);
      const diagAfterPoint = await diagFeatureCount(page);
      if (Number.isFinite(diagAfterPoint) && diagAfterPoint !== countAfterPoint) {
        record('view-count-mismatch-point', `feature-list=${countAfterPoint} diagnostics=${diagAfterPoint}`);
      }
      if (countAfterPoint !== countBeforePoint + 1) {
        record('point-count', `expected point count ${countBeforePoint}->${countBeforePoint + 1}, got ${countAfterPoint}`);
      }

      // =====================================================================
      // C. VERTEX EDIT / MOVE — make an area target, select a vertex, drag it.
      // =====================================================================
      const areaRes = await commitArea(page, cx, cy, 150, 'edit-target');
      if (areaRes === 'conflict') {
        await page.getByTestId('conflict-cancel').click().catch(() => undefined);
      }
      await shot(page, 'edit-target-area');
      await checkCamera(page, 'after-edit-target');

      await goView(page);
      await showSidebarTab(page, 'features');
      const countBeforeMove = await featureListCount(page);

      // Select the target via the feature list (the most recently added area).
      await goView(page);
      await showSidebarTab(page, 'features');
      const flist = page.locator('[data-testid^="feature-list-item-"]');
      const nFeat = await flist.count();
      if (nFeat > 0) {
        await flist.last().click();
        await page.waitForTimeout(120);
        await activeFeature(page);
      }

      if (await armEditTool(page, 'vertex')) {
        await shot(page, 'vertex-tool-armed');
        // Click on a corner of the centred square (top-left corner area).
        const vx = cx - 150;
        const vy = cy - 150;
        await page.mouse.click(vx, vy);
        await page.waitForTimeout(120);
        const av = ((await page.getByTestId('app-active-vertex').textContent()) ?? '').trim();
        const avo = ((await page.getByTestId('app-active-vertex-owner').textContent()) ?? '').trim();
        if (/NaN|undefined|null|Infinity/.test(av) || /NaN|undefined|null|Infinity/.test(avo)) {
          record('vertex-selection-malformed', `active-vertex="${av}" owner="${avo}"`);
        }
        if (av === '' && avo === '') {
          // Not necessarily a bug (the hit may have missed); record as observation.
          record('vertex-hit-miss', 'vertex click did not select any vertex (hit test miss?)');
        }
        // Drag the corner inward.
        await page.mouse.move(vx, vy);
        await page.mouse.down();
        for (let i = 1; i <= 6; i += 1) {
          await page.mouse.move(vx + i * 8, vy + i * 8);
          await page.waitForTimeout(15);
        }
        await page.mouse.up();
        await page.waitForTimeout(120);
        await checkCamera(page, 'after-vertex-drag');
        await shot(page, 'vertex-dragged');
      }

      // op∘逆op: undo the move, gate feature count unchanged & coords finite.
      await leaveView(page);
      const em = page.getByTestId('mode-edit');
      if ((await em.getAttribute('aria-pressed')) !== 'true') await em.click();
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(150);
      if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
        await page.getByTestId('conflict-cancel').click().catch(() => undefined);
      }
      await checkCamera(page, 'after-vertex-undo');
      await goView(page);
      await showSidebarTab(page, 'features');
      const countAfterMoveUndo = await featureListCount(page);
      if (countAfterMoveUndo !== countBeforeMove) {
        record('vertex-move-undo-count', `vertex move∘undo changed feature count ${countBeforeMove} -> ${countAfterMoveUndo}`);
      }

      // Anchor ordering of the (still) selected feature.
      await showSidebarTab(page, 'properties');
      await checkAnchorOrdering(page, 'after-vertex-move');
      await shot(page, 'vertex-undo-done');

      // =====================================================================
      // D. LONGITUDE SHIFT — slider + buttons + preset round-trip (A∘B∘A).
      // =====================================================================
      await goView(page);
      const lon = page.getByTestId('longitude-shift');
      if (await lon.isVisible().catch(() => false)) {
        const readout = page.getByTestId('center-lon-readout');
        const r0text = ((await readout.textContent()) ?? '').trim();
        const r0 = parseReadoutDeg(r0text);
        if (r0 === null) record('lon-readout-malformed', `initial readout="${r0text}"`);

        // Drag the 経度シフト slider right then left.
        const slider: Locator = page.getByRole('slider', { name: '経度シフト' });
        if (await slider.isVisible().catch(() => false)) {
          const sbox = await slider.boundingBox();
          if (sbox) {
            await page.mouse.move(sbox.x + sbox.width / 2, sbox.y + sbox.height / 2);
            await page.mouse.down();
            await page.mouse.move(sbox.x + sbox.width, sbox.y + sbox.height / 2, { steps: 6 });
            await page.mouse.up();
            await page.waitForTimeout(80);
            const rRight = ((await readout.textContent()) ?? '').trim();
            if (/NaN|Infinity|undefined/.test(rRight)) record('lon-readout-malformed', `after right drag="${rRight}"`);
            await page.mouse.move(sbox.x + sbox.width / 2, sbox.y + sbox.height / 2);
            await page.mouse.down();
            await page.mouse.move(sbox.x, sbox.y + sbox.height / 2, { steps: 6 });
            await page.mouse.up();
            await page.waitForTimeout(80);
          }
        }
        await checkCamera(page, 'after-lon-slider');
        await shot(page, 'lon-slider');

        // ◀/▶ shift buttons.
        const shiftRight = page.getByRole('button', { name: '右へシフト' });
        const shiftLeft = page.getByRole('button', { name: '左へシフト' });
        for (let i = 0; i < 3; i += 1) await shiftRight.click().catch(() => undefined);
        for (let i = 0; i < 3; i += 1) await shiftLeft.click().catch(() => undefined);
        await page.waitForTimeout(60);
        const rButtons = ((await readout.textContent()) ?? '').trim();
        if (/NaN|Infinity|undefined/.test(rButtons)) record('lon-readout-malformed', `after buttons="${rButtons}"`);
        await checkCamera(page, 'after-lon-buttons');

        // Preset round-trip A -> B -> A should restore the readout (metamorphic).
        const presetA = page.getByRole('button', { name: '0度中心', exact: true });
        const presetB = page.getByRole('button', { name: '180度中心', exact: true });
        if ((await presetA.count()) > 0 && (await presetB.count()) > 0) {
          await presetA.click().catch(() => undefined);
          await page.waitForTimeout(60);
          const ra1 = ((await readout.textContent()) ?? '').trim();
          await presetB.click().catch(() => undefined);
          await page.waitForTimeout(60);
          await presetA.click().catch(() => undefined);
          await page.waitForTimeout(60);
          const ra2 = ((await readout.textContent()) ?? '').trim();
          if (parseReadoutDeg(ra1) === null || parseReadoutDeg(ra2) === null) {
            record('lon-readout-malformed', `preset readout malformed a1="${ra1}" a2="${ra2}"`);
          } else if (ra1 !== ra2) {
            record('lon-preset-roundtrip', `preset A∘B∘A not identity: "${ra1}" then "${ra2}"`);
          }
        }
        await checkCamera(page, 'after-lon-presets');
        await shot(page, 'lon-presets');
      } else {
        record('lon-control-missing', 'longitude-shift control not visible');
      }

      // =====================================================================
      // E. CONTEXT MENU — right-click in View and Edit modes.
      // =====================================================================
      await goView(page);
      await page.mouse.click(cx + 40, cy + 40, { button: 'right' });
      await page.waitForTimeout(120);
      const ctx = page.getByTestId('context-menu');
      if ((await ctx.count()) > 0) {
        const items = ctx.locator('.context-menu__item');
        const nItems = await items.count();
        for (let i = 0; i < nItems; i += 1) {
          const t = ((await items.nth(i).textContent()) ?? '').trim();
          if (/NaN|Infinity|undefined|null/.test(t)) record('context-item-malformed', `view ctx item ${i}="${t}"`);
        }
        await shot(page, 'context-menu-view');
        // Dismiss by clicking elsewhere / Escape.
        await page.keyboard.press('Escape').catch(() => undefined);
        await page.mouse.click(cx, cy - 250).catch(() => undefined);
        await ctx.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {
          record('context-menu-stuck', 'view context-menu did not dismiss');
        });
      }
      await checkCamera(page, 'after-context-view');

      // Edit-mode right-click on a feature.
      await leaveView(page);
      const em2 = page.getByTestId('mode-edit');
      if ((await em2.getAttribute('aria-pressed')) !== 'true') await em2.click();
      await armEditTool(page, 'select');
      await page.mouse.click(cx, cy, { button: 'right' });
      await page.waitForTimeout(120);
      const ctx2 = page.getByTestId('context-menu');
      if ((await ctx2.count()) > 0) {
        const items = ctx2.locator('.context-menu__item');
        const nItems = await items.count();
        for (let i = 0; i < nItems; i += 1) {
          const t = ((await items.nth(i).textContent()) ?? '').trim();
          if (/NaN|Infinity|undefined|null/.test(t)) record('context-item-malformed', `edit ctx item ${i}="${t}"`);
        }
        await shot(page, 'context-menu-edit');
        await page.keyboard.press('Escape').catch(() => undefined);
        await page.mouse.click(cx, cy - 250).catch(() => undefined);
        await ctx2.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {
          record('context-menu-stuck', 'edit context-menu did not dismiss');
        });
      }
      await checkCamera(page, 'after-context-edit');

      // =====================================================================
      // F. ANCHOR-MODE toggle (list <-> timebar) + save∘load reachability.
      // =====================================================================
      await goView(page);
      await showSidebarTab(page, 'features');
      const fl3 = page.locator('[data-testid^="feature-list-item-"]');
      if ((await fl3.count()) > 0) {
        // Pick a FACE (areas have anchors); the last added area is the edit target.
        await fl3.last().click();
        await page.waitForTimeout(120);
        await showSidebarTab(page, 'properties');
        const sec = page.getByTestId('anchor-section');
        if (await sec.isVisible().catch(() => false)) {
          const toTimebar = page.getByTestId('anchor-mode-timebar');
          const toList = page.getByTestId('anchor-mode-list');
          await checkAnchorOrdering(page, 'anchor-list-before');
          if (await toTimebar.isVisible().catch(() => false)) {
            await toTimebar.click().catch(() => undefined);
            await page.waitForTimeout(80);
            await shot(page, 'anchor-timebar');
            // Timebar should mount its axis without malformed edges.
            const edgeMin = ((await page.getByTestId('timebar-edge-min').textContent().catch(() => '')) ?? '').trim();
            const edgeMax = ((await page.getByTestId('timebar-edge-max').textContent().catch(() => '')) ?? '').trim();
            if (/NaN|Infinity|undefined/.test(edgeMin) || /NaN|Infinity|undefined/.test(edgeMax)) {
              record('timebar-edge-malformed', `min="${edgeMin}" max="${edgeMax}"`);
            }
          }
          if (await toList.isVisible().catch(() => false)) {
            await toList.click().catch(() => undefined);
            await page.waitForTimeout(80);
            await checkAnchorOrdering(page, 'anchor-list-after');
          }
          await shot(page, 'anchor-list-back');
        }
      }

      // save∘load reachability + dirty flag (no native dialog fired).
      const unsavedNow = await diagUnsaved(page);
      if (unsavedNow !== 'あり') {
        record('dirty-not-set', `after edits unsaved=${unsavedNow} (expected あり)`);
      }
      await goView(page);
      await page.getByTestId('menu-file').click();
      const fileItems = page.getByTestId('menu-items-file');
      if (await fileItems.isVisible().catch(() => false)) {
        for (const cmd of ['file.new', 'file.open', 'file.save', 'file.saveAs']) {
          const it = fileItems.locator(`[data-command="${cmd}"]`);
          if ((await it.count()) === 0) {
            record('file-command-missing', `${cmd} not present in ファイル menu`);
          } else if (!(await it.isEnabled().catch(() => false))) {
            record('file-command-disabled', `${cmd} disabled (save should be reachable when dirty)`);
          }
        }
        await page.getByTestId('menu-file').click().catch(() => undefined);
      } else {
        record('menu-not-open', 'ファイル menu did not open');
      }
      await fileItems.waitFor({ state: 'detached', timeout: 3000 }).catch(() => undefined);
      await shot(page, 'file-menu');

      // Final parity + camera.
      await goView(page);
      await showSidebarTab(page, 'features');
      const finalList = await featureListCount(page);
      const finalDiag = await diagFeatureCount(page);
      if (Number.isFinite(finalDiag) && finalDiag !== finalList) {
        record('view-count-mismatch-final', `feature-list=${finalList} diagnostics=${finalDiag}`);
      }
      await checkCamera(page, 'final');
      await activeFeature(page);
      await shot(page, 'final');

      console.log(`BUGHUNT_SUMMARY: ${JSON.stringify(anomalies)}`);
      await expect(page.getByTestId('app-shell')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
