// BUGHUNT R1 — e2e exploration (discovery-only). Drives the REAL built Electron
// composite "like a user": mode/tool switching, face add/edit/split/merge, time
// move, undo/redo, pan/zoom, save/load reachability. Each step screenshots into
// screenshots/__bughunt__/r1-*.png and records console / data-* state.
//
// STRICT GATE: any console.error, React warning, unhandled rejection, or NaN
// observed in the live data-* hooks is captured as a finding (the test does NOT
// crash on them — it records them so the human review sees every anomaly).
//
// INVARIANTS asserted after each op (recorded, not crashed):
//   - 座標に NaN/Infinity 無し (data-pan-x/y, data-zoom)
//   - 選択が常に有効 (active-feature id, when present, is a real committed id)
//   - undo/redo markers track history availability
// This spec is exploratory: it logs anomalies via console.log("BUGHUNT:...") so
// the runner can scrape them; assertions are intentionally lenient.

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { test, expect, type Page } from '@playwright/test';

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
  // eslint-disable-next-line no-console
  console.log(`BUGHUNT:${kind}: ${detail}`);
}

let shotN = 0;
async function shot(page: Page, label: string): Promise<void> {
  shotN += 1;
  const n = String(shotN).padStart(2, '0');
  const file = resolve(shotDir, `r1-${n}-${label}.png`);
  try {
    await page.screenshot({ path: file });
  } catch (e) {
    record('screenshot-fail', `${label}: ${String(e)}`);
  }
}

// Wire the console / page error / rejection listeners onto a page (strict gate).
function attachListeners(page: Page): void {
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (type === 'error') {
      // Ignore benign favicon/network 404 noise (none expected offline) — record all.
      record('console.error', text);
    } else if (type === 'warning') {
      // React dev warnings (act, keys, deprecated lifecycles, etc.).
      if (/Warning:|React|Each child|deprecated|act\(/i.test(text)) {
        record('react.warning', text);
      } else {
        record('console.warning', text);
      }
    }
  });
  page.on('pageerror', (err) => record('pageerror', `${err.name}: ${err.message}`));
  page.on('crash', () => record('page.crash', 'renderer crashed'));
  // Unhandled promise rejections surface as pageerror in Electron renderer; also
  // hook the raw window event for completeness.
  void page.addInitScript(() => {
    window.addEventListener('unhandledrejection', (ev) => {
      // eslint-disable-next-line no-console
      console.error(`UNHANDLED_REJECTION: ${String((ev as PromiseRejectionEvent).reason)}`);
    });
  });
}

// Read the live camera observation hooks and gate them for NaN/Infinity.
async function checkCamera(page: Page, where: string): Promise<void> {
  const layer = page.getByTestId('map-input-layer');
  const attrs = ['data-pan-x', 'data-pan-y', 'data-zoom'];
  for (const a of attrs) {
    const raw = await layer.getAttribute(a);
    if (raw === null) continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) {
      record('coord-nonfinite', `${where}: ${a}=${raw}`);
    }
  }
}

// Read the active-feature marker; record if it is a malformed value.
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

// Return to View mode so transient tool input overlays (add-input-layer /
// knife-input-layer, both inset:0 over the map cell) are unmounted and no longer
// intercept pointer events meant for the timeline / toolbar.
async function goView(page: Page): Promise<void> {
  const v = page.getByTestId('mode-view');
  if ((await v.getAttribute('aria-pressed')) !== 'true') {
    await v.click().catch(() => undefined);
  }
  // The add/knife overlays should be gone now.
  await page.getByTestId('add-input-layer').waitFor({ state: 'detached', timeout: 4000 }).catch(() => {
    record('overlay-stuck', 'add-input-layer still attached after returning to View');
  });
}

async function armAddArea(page: Page): Promise<void> {
  await leaveView(page);
  const add = page.getByTestId('mode-add');
  await expect(add).toBeEnabled();
  if ((await add.getAttribute('aria-pressed')) !== 'true') await add.click();
  const area = page.getByTestId('tool-add.area');
  await expect(area).toBeVisible();
  if ((await area.getAttribute('aria-pressed')) === 'true') await area.click();
  await area.click();
  await expect(area).toHaveAttribute('aria-pressed', 'true');
}

// Commit one square face given a centre + half-size in screen px. Returns the
// committed feature id (or '' if it never resolved). Records anomalies on the way.
async function commitFace(
  page: Page,
  cx: number,
  cy: number,
  half: number,
  parentIndex?: number,
): Promise<string> {
  await armAddArea(page);
  const layer = page.getByTestId('add-input-layer');
  await expect(layer).toBeVisible();
  const corners: ReadonlyArray<readonly [number, number]> = [
    [cx - half, cy - half],
    [cx + half, cy - half],
    [cx + half, cy + half],
    [cx - half, cy + half],
  ];
  for (const [px, py] of corners) await page.mouse.click(px, py);
  const vc = page.getByTestId('add-vertex-count');
  const vcText = (await vc.textContent())?.trim();
  if (vcText !== '4') record('add-vertex-drop', `expected 4 vertices, got ${vcText}`);
  const complete = page.getByTestId('add-complete');
  await expect(complete).toBeEnabled();
  await complete.click();
  if (parentIndex !== undefined) {
    const parentSel = page.getByTestId('add-parent');
    if ((await parentSel.count()) > 0) {
      try {
        await parentSel.selectOption({ index: parentIndex });
      } catch (e) {
        record('parent-select-fail', String(e));
      }
    }
  }
  await page.getByTestId('add-save').click();
  // The selection should re-resolve to a non-empty committed feature (教訓 5.11).
  try {
    await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/, { timeout: 8000 });
  } catch {
    record('add-no-selection', 'active-feature empty after add commit');
  }
  return activeFeature(page);
}

test.describe('BUGHUNT R1 — user-like exploration of the live composite', () => {
  test('explore: mode/tool, add/edit/split/merge, time, undo/redo, pan/zoom, save', async () => {
    const { app, page } = await launchApp();
    attachListeners(page);
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await shot(page, 'boot');
      await checkCamera(page, 'boot');

      // --- Map geometry baseline -------------------------------------------------
      const inputLayer = page.getByTestId('map-input-layer');
      const box = await inputLayer.boundingBox();
      expect(box).not.toBeNull();
      const b = box!;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;

      // --- Mode / tool switching round-trip --------------------------------------
      await leaveView(page);
      await page.getByTestId('mode-add').click();
      await shot(page, 'mode-add');
      for (const t of ['tool-add.point', 'tool-add.line', 'tool-add.area']) {
        const btn = page.getByTestId(t);
        if (await btn.isVisible()) {
          await btn.click();
          await expect(page.getByTestId('app-active-tool')).toHaveText(/\S/);
        }
      }
      await page.getByTestId('mode-edit').click();
      await shot(page, 'mode-edit');
      for (const t of [
        'tool-edit.select',
        'tool-edit.vertex',
        'tool-edit.move',
        'tool-edit.knife',
        'tool-edit.reparent',
        'tool-edit.merge',
      ]) {
        const btn = page.getByTestId(t);
        if (await btn.isVisible()) await btn.click();
      }
      await checkCamera(page, 'after-tool-switch');

      // --- Add a PARENT face -----------------------------------------------------
      const parentId = await commitFace(page, cx - 160, cy, 70);
      await shot(page, 'parent-added');
      await checkCamera(page, 'parent-added');
      if (parentId === '') record('add-parent-empty', 'parent face id empty after commit');

      // --- Add a CHILD face parented to the parent (aggregation) ------------------
      const childId = await commitFace(page, cx + 120, cy, 60, 1);
      await shot(page, 'child-added');
      if (childId === parentId) {
        record('child-id-collide', `child id == parent id (${childId})`);
      }

      // --- Diagnostics panel: feature count invariant ----------------------------
      // Open via menu command would need the menubar; read the hook if present.
      // (Best-effort; not all builds expose the menu in offscreen mode.)

      // --- Time move forward / backward (FR-68) ----------------------------------
      // Leave any armed tool first so the transient input overlay does not eat the
      // timeline button click (observed: add-input-layer stays mounted after a save
      // commit because the area tool remains armed for repeated adds).
      await goView(page);
      const current = page.getByTestId('timeline-current');
      await expect(current).toBeVisible();
      const t0 = (await current.textContent())?.trim() ?? '';
      const fwd = page.getByRole('button', { name: '1年次へ進む' });
      await fwd.click();
      const t1 = (await current.textContent())?.trim() ?? '';
      if (t1 === t0) record('time-step-noop', `forward step did not change time (${t0})`);
      await shot(page, 'time-forward');
      const back = page.getByRole('button', { name: '1年前へ戻る' });
      await back.click();
      const t2 = (await current.textContent())?.trim() ?? '';
      if (t2 !== t0) {
        record('time-roundtrip', `forward then back != identity: ${t0} -> ${t1} -> ${t2}`);
      }
      await checkCamera(page, 'after-time');
      await shot(page, 'time-back');

      // --- Pan the camera (data-pan-x/y change) ----------------------------------
      await goView(page); // View mode: left-drag over the map pans the live camera
      const panBeforeX = Number(await inputLayer.getAttribute('data-pan-x'));
      const panBeforeY = Number(await inputLayer.getAttribute('data-pan-y'));
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 140, cy + 90, { steps: 8 });
      await page.mouse.up();
      const panAfterX = Number(await inputLayer.getAttribute('data-pan-x'));
      const panAfterY = Number(await inputLayer.getAttribute('data-pan-y'));
      if (panAfterX === panBeforeX && panAfterY === panBeforeY) {
        record('pan-noop', 'drag did not move camera pan hooks');
      }
      await checkCamera(page, 'after-pan');
      await shot(page, 'pan');

      // --- Wheel zoom in/out -----------------------------------------------------
      const zBefore = Number(await inputLayer.getAttribute('data-zoom'));
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, -240);
      const zIn = Number(await inputLayer.getAttribute('data-zoom'));
      if (!(zIn > zBefore)) record('zoom-in-fail', `zoom did not increase: ${zBefore}->${zIn}`);
      await page.mouse.wheel(0, 240);
      const zOut = Number(await inputLayer.getAttribute('data-zoom'));
      if (!(zOut < zIn)) record('zoom-out-fail', `zoom did not decrease: ${zIn}->${zOut}`);
      await checkCamera(page, 'after-zoom');
      await shot(page, 'zoom');

      // --- Undo / redo via keyboard ----------------------------------------------
      // 教訓 5.13: EditUndo/EditRedo are EDITING commands, disabled in View mode.
      // We must be in an editing mode for the keyboard shortcut to actually run.
      await leaveView(page);
      const em0 = page.getByTestId('mode-edit');
      if ((await em0.getAttribute('aria-pressed')) !== 'true') await em0.click();
      const canUndo = page.getByTestId('app-can-undo');
      const canRedo = page.getByTestId('app-can-redo');
      const undoBefore = (await canUndo.textContent())?.trim();
      if (undoBefore !== '1') {
        record('undo-unavailable', `expected can-undo=1 after edits, got ${undoBefore}`);
      }
      const featBeforeUndo = await activeFeature(page);
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(200);
      const redoAfter = (await canRedo.textContent())?.trim();
      if (undoBefore === '1' && redoAfter !== '1') {
        record(
          'redo-unavailable',
          `Ctrl+Z in edit mode did not enable redo (can-undo was ${undoBefore}, can-redo now ${redoAfter}) — undo may not have run`,
        );
      }
      await shot(page, 'after-undo');
      await checkCamera(page, 'after-undo');
      await activeFeature(page);
      await page.keyboard.press('Control+y');
      await page.waitForTimeout(150);
      const featAfterRedo = await activeFeature(page);
      await shot(page, 'after-redo');
      // op∘逆op metamorphic: undo then redo should restore the committed feature.
      if (featBeforeUndo !== '' && featAfterRedo === '') {
        record('redo-lost-selection', `undo->redo lost selection (was ${featBeforeUndo})`);
      }
      await checkCamera(page, 'after-redo');

      // --- Split (knife) a face: full live flow ----------------------------------
      // Re-add a fresh face to split (state may have been mutated by undo/redo).
      const splitTarget = await commitFace(page, cx, cy - 30, 90);
      await shot(page, 'split-target-added');
      const editMode = page.getByTestId('mode-edit');
      await leaveView(page);
      if ((await editMode.getAttribute('aria-pressed')) !== 'true') await editMode.click();
      const knifeBtn = page.getByTestId('tool-edit.knife');
      if (await knifeBtn.isVisible()) {
        await knifeBtn.click();
        const knifeLayer = page.getByTestId('knife-input-layer');
        if (await knifeLayer.isVisible().catch(() => false)) {
          await page.mouse.click(cx, cy - 30); // select the face
          await page.mouse.click(cx + 2, cy - 30 - 130); // cut start (outside, above)
          await page.mouse.click(cx - 3, cy - 30 + 130); // cut end (outside, below)
          const cutCount = page.getByTestId('knife-cut-count');
          if ((await cutCount.textContent())?.trim() !== '2') {
            record('knife-cut-count', `expected 2 cut points, got ${(await cutCount.textContent())?.trim()}`);
          }
          await shot(page, 'knife-cut-drawn');
          const confirm = page.getByTestId('knife-confirm-cut');
          if (await confirm.isVisible().catch(() => false)) {
            await confirm.click();
            const chooseA = page.getByTestId('knife-choose-a');
            if (await chooseA.isVisible().catch(() => false)) {
              await chooseA.click();
              await page.getByTestId('knife-confirm-inheritor').click();
              const saveBtn = page.getByTestId('add-save');
              if (await saveBtn.isVisible().catch(() => false)) {
                await saveBtn.click();
              }
            }
            await shot(page, 'knife-after-confirm');
            // Record if the split paused on a conflict/sliver (a real anomaly class).
            if ((await page.getByTestId('knife-conflict-paused').count()) > 0) {
              record('knife-conflict-paused', 'split paused on conflict (seam sliver?)');
            }
            if ((await page.getByTestId('knife-rejected').count()) > 0) {
              const m = ((await page.getByTestId('knife-rejected').textContent()) ?? '').trim();
              record('knife-rejected', `split rejected: ${m}`);
            }
          }
        } else {
          record('knife-layer-missing', 'knife input layer never appeared');
        }
      }
      await checkCamera(page, 'after-split');
      await activeFeature(page);

      // --- Merge tool reachability ----------------------------------------------
      // Idempotent edit-mode entry (toggling would flip us back to View and hide
      // all tools — the merge tool then "disappears" as a spec artifact, not a bug).
      await leaveView(page);
      if ((await editMode.getAttribute('aria-pressed')) !== 'true') await editMode.click();
      const mergeBtn = page.getByTestId('tool-edit.merge');
      if (await mergeBtn.isVisible()) {
        await mergeBtn.click();
        await shot(page, 'merge-tool');
        await expect(page.getByTestId('app-active-tool')).toHaveText(/\S/);
      } else {
        record('merge-tool-missing', 'merge tool button not visible');
      }

      // --- Vertex edit + move tool reachability ----------------------------------
      for (const t of ['tool-edit.vertex', 'tool-edit.move', 'tool-edit.reparent']) {
        const btn = page.getByTestId(t);
        if (await btn.isVisible()) {
          await btn.click();
          // A select click somewhere on the map should not crash.
          await page.mouse.click(cx, cy - 30);
        }
      }
      await shot(page, 'edit-tools');
      await checkCamera(page, 'after-edit-tools');

      // --- Final state snapshot --------------------------------------------------
      await shot(page, 'final');
      await activeFeature(page);

      // Emit a machine-scrapeable summary of all anomalies.
      // eslint-disable-next-line no-console
      console.log(`BUGHUNT_SUMMARY: ${JSON.stringify(anomalies)}`);

      // The exploration itself must have reached the end with the shell intact.
      await expect(page.getByTestId('app-shell')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
