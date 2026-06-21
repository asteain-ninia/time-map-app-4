// BUGHUNT R2 — e2e exploration (discovery-only). Drives the REAL built Electron
// composite "like a user", complementing R1 with deeper / different operation
// orderings: aggressive mode/tool cycling, nested face aggregation, edit-tool
// interaction (vertex/move/reparent/merge clicks), time scrubbing to range edges,
// repeated undo/redo metamorphic round-trips, pan+zoom interleaving, and file
// command reachability. Each step screenshots into screenshots/__bughunt__/r2-*.png
// and records console / data-* state.
//
// STRICT GATE: any console.error, React warning, unhandled rejection, or NaN /
// Infinity observed in the live data-* hooks is captured as a finding (the test
// does NOT crash on them — it records them so the human review sees every anomaly).
//
// INVARIANTS asserted after each op (recorded, not crashed):
//   - 座標に NaN/Infinity 無し (data-pan-x/y, data-zoom on map-input-layer)
//   - 選択が常に有効 (active-feature id, when present, has no NaN/undefined/null)
//   - undo/redo markers track history availability; undo∘op / op∘逆op round-trips
//   - 時間移動 forward∘back = identity (FR-68 step round-trip)
// Assertions are intentionally lenient; anomalies surface via console.log
// ("BUGHUNT:...") and a final BUGHUNT_SUMMARY JSON line the runner scrapes.

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

  console.log(`BUGHUNT:${kind}: ${detail}`);
}

let shotN = 0;
async function shot(page: Page, label: string): Promise<void> {
  shotN += 1;
  const n = String(shotN).padStart(2, '0');
  const file = resolve(shotDir, `r2-${n}-${label}.png`);
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

// Gate ALL numeric data-* hooks on the map input layer for non-finite values.
async function checkCamera(page: Page, where: string): Promise<void> {
  const layer = page.getByTestId('map-input-layer');
  for (const a of ['data-pan-x', 'data-pan-y', 'data-zoom']) {
    const raw = await layer.getAttribute(a);
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

async function modeOf(page: Page): Promise<string> {
  return ((await page.getByTestId('app-mode').textContent()) ?? '').trim();
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
    .catch(() => record('overlay-stuck', 'add-input-layer still attached after returning to View'));
}

async function enterEdit(page: Page): Promise<void> {
  await leaveView(page);
  const e = page.getByTestId('mode-edit');
  await expect(e).toBeEnabled();
  if ((await e.getAttribute('aria-pressed')) !== 'true') await e.click();
  await expect(e).toHaveAttribute('aria-pressed', 'true');
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

// Commit one square face given a centre + half-size in screen px. Optionally pick
// a parent (FR-77 aggregation). Returns the committed feature id ('' if it never
// resolved). Records anomalies on the way.
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
  // A rejected add (self-intersection / containment violation) shows add-rejected.
  if ((await page.getByTestId('add-rejected').count()) > 0) {
    const m = ((await page.getByTestId('add-rejected').textContent()) ?? '').trim();
    record('add-rejected', `add rejected before save: ${m}`);
  }
  await page.getByTestId('add-save').click();

  // A commit that produces a terminal-vs-terminal overlap pauses on the U35
  // conflict-resolution modal (FR-62). If it appeared, inspect its labels for the
  // empty-name defect, then cancel so the exploration can continue (the backdrop
  // otherwise intercepts ALL further pointer input).
  await handleConflictModalIfPresent(page);

  try {
    await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/, { timeout: 8000 });
  } catch {
    record('add-no-selection', 'active-feature empty after add commit');
  }
  return activeFeature(page);
}

// If the conflict-resolution modal is open, audit its row + policy labels for the
// blank-display-name defect, then cancel it so the backdrop stops intercepting.
async function handleConflictModalIfPresent(page: Page): Promise<boolean> {
  const root = page.getByTestId('conflict-modal-root');
  if ((await root.count()) === 0) return false;
  record('conflict-modal-opened', 'edit commit paused on the conflict-resolution modal');
  // Audit the policy radio labels (優先: <name>) for an empty feature name.
  const labels = page.locator('.policy-choice__option');
  const n = await labels.count();
  for (let i = 0; i < n; i += 1) {
    const txt = ((await labels.nth(i).textContent()) ?? '').trim();
    // Expected form "優先: <name>". An empty name leaves a trailing ":" / blank.
    if (/[:：]\s*$/.test(txt) || txt === '' || /優先[:：]\s*$/.test(txt)) {
      record('conflict-empty-policy-label', `policy radio label has no feature name: "${txt}"`);
    }
  }
  // Audit the row feature-name spans.
  const featSpans = page.locator('.conflict-row__features');
  const m = await featSpans.count();
  for (let i = 0; i < m; i += 1) {
    const txt = ((await featSpans.nth(i).textContent()) ?? '').trim();
    // Form "<a> ／ <b>"; either side blank => "／" with nothing around it.
    if (/^\s*／\s*$/.test(txt) || txt.replace(/／/g, '').trim() === '') {
      record('conflict-empty-row-label', `conflict row feature names blank: "${txt}"`);
    }
  }
  const cancel = page.getByTestId('conflict-cancel');
  if (await cancel.isVisible().catch(() => false)) await cancel.click();
  await root.waitFor({ state: 'detached', timeout: 4000 }).catch(() => {
    record('conflict-modal-stuck', 'conflict modal did not close after cancel');
  });
  return true;
}

test.describe('BUGHUNT R2 — deeper user-like exploration of the live composite', () => {
  test('explore: nested aggregation, edit tools, time edges, undo/redo, pan/zoom, save', async () => {
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

      // --- Aggressive mode/tool cycling (no crashes, mode marker tracks) ---------
      for (let i = 0; i < 2; i += 1) {
        await leaveView(page);
        await page.getByTestId('mode-add').click();
        if ((await modeOf(page)) !== 'add') record('mode-marker-mismatch', `expected add, got ${await modeOf(page)}`);
        for (const t of ['tool-add.point', 'tool-add.line', 'tool-add.area']) {
          const btn = page.getByTestId(t);
          if (await btn.isVisible()) await btn.click();
        }
        await page.getByTestId('mode-edit').click();
        if ((await modeOf(page)) !== 'edit') record('mode-marker-mismatch', `expected edit, got ${await modeOf(page)}`);
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
      }
      await goView(page);
      await shot(page, 'mode-cycle');
      await checkCamera(page, 'mode-cycle');

      // --- Build a 3-level aggregation: GRAND > PARENT > CHILD -------------------
      const grandId = await commitFace(page, cx - 150, cy + 10, 100);
      await shot(page, 'grand-added');
      if (grandId === '') record('add-empty', 'grand face id empty after commit');

      const parentId = await commitFace(page, cx - 150, cy + 10, 60, 1);
      await shot(page, 'parent-added');
      if (parentId === grandId) record('id-collide', `parent id == grand id (${parentId})`);

      const childId = await commitFace(page, cx - 150, cy + 10, 30, 1);
      await shot(page, 'child-added');
      if (childId === parentId || childId === grandId) {
        record('id-collide', `child id collides (${childId})`);
      }
      await checkCamera(page, 'aggregation-built');

      // A second disjoint face elsewhere (for merge / multi-select interaction).
      const otherId = await commitFace(page, cx + 160, cy - 10, 70);
      await shot(page, 'other-added');
      if (otherId === '') record('add-empty', 'other face id empty after commit');

      // --- Edit-tool interaction: select / vertex / move / reparent / merge ------
      await enterEdit(page);
      for (const t of [
        'tool-edit.select',
        'tool-edit.vertex',
        'tool-edit.move',
        'tool-edit.reparent',
        'tool-edit.merge',
      ]) {
        const btn = page.getByTestId(t);
        if (!(await btn.isVisible())) {
          record('edit-tool-missing', `${t} not visible in edit mode`);
          continue;
        }
        await btn.click();
        await expect(page.getByTestId('app-active-tool')).toHaveText(/\S/);
        // A click on a known face should not crash; selection should stay valid.
        await page.mouse.click(cx - 150, cy + 10);
        await activeFeature(page);
        await checkCamera(page, `edit-${t}`);
      }
      await shot(page, 'edit-tools');

      // --- Vertex drag on the 'other' face (move tool) --------------------------
      await page.getByTestId('tool-edit.move').click();
      await page.mouse.click(cx + 160, cy - 10); // select other face
      const beforeSel = await activeFeature(page);
      await page.mouse.move(cx + 160, cy - 10);
      await page.mouse.down();
      await page.mouse.move(cx + 190, cy + 20, { steps: 6 });
      await page.mouse.up();
      await handleConflictModalIfPresent(page);
      const afterSel = await activeFeature(page);
      if (beforeSel !== '' && afterSel === '') {
        record('move-lost-selection', `selection lost after move drag (was ${beforeSel})`);
      }
      await checkCamera(page, 'after-move-drag');
      await shot(page, 'move-drag');

      // --- Time scrubbing to range edges + round-trip (FR-68) -------------------
      await goView(page);
      const current = page.getByTestId('timeline-current');
      await expect(current).toBeVisible();
      const t0 = (await current.textContent())?.trim() ?? '';
      const fwd = page.getByRole('button', { name: '1年次へ進む' });
      const back = page.getByRole('button', { name: '1年前へ戻る' });
      // Step far forward, then far back; record any NaN / non-finite camera.
      for (let i = 0; i < 12; i += 1) {
        await fwd.click();
        await checkCamera(page, `time-fwd-${i}`);
      }
      const tFar = (await current.textContent())?.trim() ?? '';
      if (tFar === t0) record('time-step-noop', `12 forward steps did not change time (${t0})`);
      await shot(page, 'time-far-forward');
      for (let i = 0; i < 12; i += 1) {
        await back.click();
        await checkCamera(page, `time-back-${i}`);
      }
      const tHome = (await current.textContent())?.trim() ?? '';
      if (tHome !== t0) {
        record('time-roundtrip', `12 fwd + 12 back != identity: ${t0} -> ${tFar} -> ${tHome}`);
      }
      await shot(page, 'time-roundtrip');

      // --- Pan + zoom interleaving ---------------------------------------------
      await goView(page);
      const px0 = Number(await inputLayer.getAttribute('data-pan-x'));
      const py0 = Number(await inputLayer.getAttribute('data-pan-y'));
      const z0 = Number(await inputLayer.getAttribute('data-zoom'));
      // Pan
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx - 120, cy + 70, { steps: 8 });
      await page.mouse.up();
      const px1 = Number(await inputLayer.getAttribute('data-pan-x'));
      const py1 = Number(await inputLayer.getAttribute('data-pan-y'));
      if (px1 === px0 && py1 === py0) record('pan-noop', 'drag did not move camera pan hooks');
      // Zoom in then out (interleave a pan between)
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, -300);
      const zIn = Number(await inputLayer.getAttribute('data-zoom'));
      if (!(zIn > z0)) record('zoom-in-fail', `zoom did not increase: ${z0}->${zIn}`);
      await page.mouse.move(cx + 40, cy + 40);
      await page.mouse.down();
      await page.mouse.move(cx + 120, cy - 60, { steps: 6 });
      await page.mouse.up();
      await page.mouse.wheel(0, 600);
      const zOut = Number(await inputLayer.getAttribute('data-zoom'));
      if (!(zOut < zIn)) record('zoom-out-fail', `zoom did not decrease: ${zIn}->${zOut}`);
      await checkCamera(page, 'after-pan-zoom');
      await shot(page, 'pan-zoom');

      // --- Repeated undo/redo metamorphic round-trips ---------------------------
      // 教訓 5.13: undo/redo are EDITING commands; must be in an editing mode.
      await enterEdit(page);
      const canUndo = page.getByTestId('app-can-undo');
      const canRedo = page.getByTestId('app-can-redo');
      const u0 = (await canUndo.textContent())?.trim();
      if (u0 !== '1') record('undo-unavailable', `expected can-undo=1 after many edits, got ${u0}`);
      const featBefore = await activeFeature(page);

      // Undo several times, recording history flips + NaN gating each step.
      let undos = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((await canUndo.textContent())?.trim() !== '1') break;
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(150);
        undos += 1;
        await checkCamera(page, `undo-${i}`);
        await activeFeature(page);
      }
      if (undos === 0) record('undo-noop', 'no undo steps executed despite can-undo=1');
      const redoAfterUndo = (await canRedo.textContent())?.trim();
      if (undos > 0 && redoAfterUndo !== '1') {
        record('redo-unavailable', `after ${undos} undos can-redo=${redoAfterUndo} (undo may not have run)`);
      }
      await shot(page, 'after-undos');

      // Redo the same number of times; selection / camera must stay finite.
      for (let i = 0; i < undos; i += 1) {
        if ((await canRedo.textContent())?.trim() !== '1') break;
        await page.keyboard.press('Control+y');
        await page.waitForTimeout(150);
        await checkCamera(page, `redo-${i}`);
        await activeFeature(page);
      }
      const featAfter = await activeFeature(page);
      // op∘逆op metamorphic: undo*n then redo*n should restore a valid selection.
      if (featBefore !== '' && featAfter === '') {
        record('redo-lost-selection', `undo*${undos} -> redo*${undos} lost selection (was ${featBefore})`);
      }
      await shot(page, 'after-redos');
      await checkCamera(page, 'after-undo-redo');
      await handleConflictModalIfPresent(page);

      // --- Knife split full live flow (fresh target) ----------------------------
      const splitTarget = await commitFace(page, cx, cy + 120, 85);
      await shot(page, 'split-target-added');
      if (splitTarget === '') record('add-empty', 'split target empty after commit');
      await enterEdit(page);
      const knifeBtn = page.getByTestId('tool-edit.knife');
      if (await knifeBtn.isVisible()) {
        await knifeBtn.click();
        const knifeLayer = page.getByTestId('knife-input-layer');
        if (await knifeLayer.isVisible().catch(() => false)) {
          await page.mouse.click(cx, cy + 120); // select target
          await page.mouse.click(cx + 2, cy + 120 - 130); // cut start above
          await page.mouse.click(cx - 3, cy + 120 + 130); // cut end below
          const cutCount = page.getByTestId('knife-cut-count');
          const cc = (await cutCount.textContent())?.trim();
          if (cc !== '2') record('knife-cut-count', `expected 2 cut points, got ${cc}`);
          await shot(page, 'knife-cut');
          const confirm = page.getByTestId('knife-confirm-cut');
          if (await confirm.isVisible().catch(() => false)) {
            await confirm.click();
            const chooseA = page.getByTestId('knife-choose-a');
            if (await chooseA.isVisible().catch(() => false)) {
              await chooseA.click();
              await page.getByTestId('knife-confirm-inheritor').click();
              const saveBtn = page.getByTestId('add-save');
              if (await saveBtn.isVisible().catch(() => false)) await saveBtn.click();
            }
            await handleConflictModalIfPresent(page);
            await shot(page, 'knife-after-confirm');
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
      await shot(page, 'after-split');

      // --- Property / anchor panel observability (selection valid) --------------
      await enterEdit(page);
      await page.getByTestId('tool-edit.select').click();
      await page.mouse.click(cx - 150, cy + 10);
      const selForPanel = await activeFeature(page);
      // The anchor section, if rendered, should not show NaN/undefined times.
      const anchorText = await page
        .getByTestId('anchor-list')
        .textContent()
        .catch(() => null);
      if (anchorText !== null && /NaN|Infinity|undefined/.test(anchorText)) {
        record('anchor-malformed', `anchor list text contains bad token: ${anchorText.slice(0, 120)}`);
      }
      await shot(page, 'property-panel');
      if (selForPanel === '') record('select-empty', 'selecting a known face yielded empty selection');

      // --- File command reachability (no native dialog; assert hook presence) ---
      // The menu bar may not be present offscreen; just confirm the FileOps marker
      // path did not error and the shell is intact.
      await goView(page);
      await shot(page, 'final');
      await activeFeature(page);
      await checkCamera(page, 'final');


      console.log(`BUGHUNT_SUMMARY: ${JSON.stringify(anomalies)}`);
      await expect(page.getByTestId('app-shell')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
