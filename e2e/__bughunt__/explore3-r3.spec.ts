// BUGHUNT R3 (explore3-r3) — e2e exploration (discovery-only). Drives the REAL
// built Electron composite "like a user" through an operation plan deliberately
// UNTOUCHED by explore-r1..r4 / explore2-r1..r4 / explore3-r1 / explore3-r2.
//
// Prior rounds covered: conflict modal / settings / save-load reachability /
// undo連打 / zoom-pan / single & double & triple knife split / single
// parent-child / search / time-edges / vertex move (single) / longitude /
// context-menu / anchor-mode AND (r3-1) deep-nest count-parity + split×2→merge +
// playback monotone + grid perf AND (r3-2) reparent-by-2-clicks + nested vertex
// drag + split×3→merge+undo + ~4s playback + 6×4 grid perf + undo storm.
//
// THIS round (r3-3) goes after the MULTI-HOLE EXCLAVE dimension + the explicit
// reparent CONFIRM-BUTTON导线 + DEEPER nesting + a LONGER playback + a LARGER
// grid that r3-1/r3-2 did not touch:
//
//   A. DEEP NEST → REPARENT via the EXPLICIT 確定 BUTTON (所属変更, edit.reparent).
//      Build a deep parent→child→…→深 chain (DEPTH=6, deeper than r3-1/r3-2),
//      then arm 所属変更, click the deepest face (target) + a different ancestor
//      (new parent), and commit through the reparent-confirm BUTTON (r3-2 only
//      clicked twice and relied on auto-commit; the confirm-button path was
//      untouched). Gates: reparent-target / reparent-parent markers populate &
//      stay finite; forest count-stable across the move (地物一覧==診断, single
//      truth source); selection valid; no console.error/NaN; no stranded modal.
//
//   B. MULTI-HOLE EXCLAVE: one big parent face with TWO nested inner faces (two
//      "holes"/飛び地 regions), then (B1) VERTEX-EDIT one inner ring, and (B2)
//      KNIFE-SPLIT the big parent through BOTH inner regions. Gates: coords finite
//      after every edit; selection retained; 地物一覧==診断 never desyncs; anchor
//      rows ascending/non-overlapping/NaN-free; live geometry validators never
//      raise console.error (non-自己交差 / 包含妥当 / リング交互性).
//
//   C. CONSECUTIVE KNIFE SPLITS (3 in a row) on an isolated face → MERGE, with the
//      full metamorphic battery: undo∘op ≈ identity (count back -1) and
//      op∘逆op ≈ identity (redo restores). Gates: +1 per cut; merge -1; undo
//      reduces; redo restores; coords finite throughout.
//
//   D. LONG TIMELINE PLAYBACK (~6s) + manual STEP probing + ANCHOR ordering. Fast
//      再生速度, ▶ for ~6s sampling timeline-current, ⏸, then drive timeline-step
//      forward/back. Gates: current never NaN/Infinity & MONOTONE non-decreasing
//      while playing; pause clears aria-pressed; stepping keeps current finite;
//      anchor rows on the selection ascending/non-overlapping/NaN-free.
//
//   E. LARGE-COUNT (8×5=40) PAN/ZOOM/DRAW PERF + UNDO STORM + save→load metamorphic.
//      Commit a dense grid of small non-overlapping faces, time a hard pan/zoom
//      burst (jank proxy), fire an UNDO STORM, and confirm history + count + the
//      active-vertex hooks stay finite. save→load reachability + dirty flag at end.
//
// STRICT GATE: any console.error, React warning, unhandled rejection, or
// NaN/Infinity in the live data-* hooks / readouts is recorded as a finding (the
// test does NOT crash on them). Anomalies surface via console.log("BUGHUNT:...")
// and a final BUGHUNT_SUMMARY JSON line. Each step screenshots into
// screenshots/__bughunt__/r3-3-*.png (read back for visual anomaly判定).
//
// INVARIANTS gated after each op (recorded, not crashed):
//   - 座標に NaN/Infinity 無し (data-pan-x/y, data-zoom on map-input-layer; active-vertex)
//   - 選択が常に有効 (active-feature id: no NaN/undefined/null)
//   - 階層森: 地物一覧 count == 診断 feature-count (single truth source) per step
//   - 錨列の昇順・非重複 (anchor rows time-sorted, non-overlapping, NaN-free)
//   - knife split: +1 per cut; merge: -1; undo∘op back; op∘逆op restore (metamorphic)
//   - playback: timeline-current monotone non-decreasing & finite while playing
//   - reparent: count-stable restructure (no feature created/destroyed)
//   - save→load reachability + dirty flag (no native dialog fired)

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
  const file = resolve(shotDir, `r3-3-${n}-${label}.png`);
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

// --- camera + active-vertex hooks: NaN/Infinity gate -------------------------
async function checkCamera(page: Page, where: string): Promise<void> {
  const layer = page.getByTestId('map-input-layer');
  for (const a of ['data-pan-x', 'data-pan-y', 'data-zoom']) {
    const raw = await layer.getAttribute(a).catch(() => null);
    if (raw === null) continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) record('coord-nonfinite', `${where}: ${a}=${raw}`);
  }
  // active-vertex / owner readouts must never carry NaN/Infinity garbage.
  for (const id of ['app-active-vertex', 'app-active-vertex-owner']) {
    const t = ((await page.getByTestId(id).textContent().catch(() => '')) ?? '').trim();
    if (/NaN|Infinity/.test(t)) record('vertex-hook-malformed', `${where}: ${id}="${t}"`);
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

async function diagCurrentTime(page: Page): Promise<string> {
  if (!(await clickMenuCommand(page, 'help', 'help.diagnostics'))) return '?';
  await expect(page.getByTestId('diagnostics-panel')).toBeVisible();
  const raw = ((await page.getByTestId('diagnostics-current-time').textContent().catch(() => '')) ?? '').trim();
  if (/NaN|Infinity|undefined/.test(raw)) record('diag-time-malformed', `current-time="${raw}"`);
  await page.getByTestId('diagnostics-panel-close').click().catch(() => undefined);
  await page.keyboard.press('Escape').catch(() => undefined);
  return raw;
}

// Single-truth-source parity: 地物一覧 must equal 診断 feature-count.
async function checkParity(page: Page, where: string): Promise<number> {
  await goView(page);
  await showSidebarTab(page, 'features');
  const list = await featureListCount(page);
  const diag = await diagFeatureCount(page);
  if (Number.isFinite(diag) && diag !== list) {
    record('view-count-mismatch', `${where}: feature-list=${list} diagnostics=${diag}`);
  }
  return list;
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

// Commit one square face. Optionally choose a parent (by the LAST option in the
// add-parent select → deepest nesting) and a name. Returns the outcome.
async function commitFace(
  page: Page,
  cx: number,
  cy: number,
  half: number,
  opts?: { readonly chooseLastParent?: boolean; readonly name?: string },
): Promise<'committed' | 'rejected' | 'conflict'> {
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
  const vcText = ((await page.getByTestId('add-vertex-count').textContent()) ?? '').trim();
  if (vcText !== '4') record('add-vertex-drop', `expected 4 vertices, got ${vcText}`);
  const complete = page.getByTestId('add-complete');
  if (!(await complete.isEnabled().catch(() => false))) {
    record('add-complete-disabled', `complete disabled (vertices=${vcText}) at (${Math.round(cx)},${Math.round(cy)}); aborting this add`);
    await page.getByTestId('add-cancel').click().catch(() => undefined);
    return 'rejected';
  }
  await complete.click();
  if ((await page.getByTestId('add-rejected').count()) > 0) {
    const m = ((await page.getByTestId('add-rejected').textContent()) ?? '').trim();
    record('add-rejected', `add rejected before save: ${m}`);
    await page.getByTestId('add-rejected-dismiss').click().catch(() => undefined);
    return 'rejected';
  }
  if (opts?.chooseLastParent) {
    const parent = page.getByTestId('add-parent');
    if ((await parent.count()) > 0) {
      const optionVals = await parent.locator('option').evaluateAll((els) =>
        (els as HTMLOptionElement[]).map((o) => o.value).filter((v) => v !== ''),
      );
      const last = optionVals[optionVals.length - 1];
      if (last !== undefined) {
        await parent.selectOption(last).catch(() => undefined);
      } else {
        record('add-parent-no-option', 'add-parent had no selectable (non-root) option');
      }
    } else {
      record('add-parent-missing', 'add-parent select not present for a face add');
    }
  }
  if (opts?.name !== undefined) {
    await page.getByTestId('add-name').fill(opts.name).catch(() => undefined);
  }
  await page.getByTestId('add-save').click();
  await page.waitForTimeout(180);
  if ((await page.getByTestId('conflict-modal-root').count()) > 0) return 'conflict';
  try {
    await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/, { timeout: 6000 });
  } catch {
    record('add-no-selection', 'active-feature empty after add commit (no conflict modal)');
  }
  return 'committed';
}

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

// Drive ONE knife split through a vertical piercing cut centred at (kx,ky).
async function knifeSplitVertical(
  page: Page,
  kx: number,
  ky: number,
  reach: number,
  name: string,
): Promise<'split' | 'no-confirm' | 'no-modal' | 'no-form'> {
  await page.mouse.click(kx, ky);
  await page.waitForTimeout(70);
  await page.mouse.click(kx, ky - reach); // above
  await page.mouse.click(kx, ky + reach); // below → pierces
  const cc = page.getByTestId('knife-confirm-cut');
  if (!(await cc.isVisible().catch(() => false))) return 'no-confirm';
  await cc.click();
  await page.waitForTimeout(140);
  const modal = page.getByTestId('knife-inheritor-modal-root');
  if ((await modal.count()) === 0) return 'no-modal';
  await page.getByTestId('knife-choose-a').click().catch(() => undefined);
  await page.getByTestId('knife-confirm-inheritor').click().catch(() => undefined);
  await page.waitForTimeout(120);
  const form = page.getByTestId('add-property-form');
  if (!(await form.isVisible().catch(() => false))) return 'no-form';
  await page.getByTestId('add-name').fill(name).catch(() => undefined);
  await page.getByTestId('add-save').click();
  await page.waitForTimeout(220);
  if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
    record('knife-conflict-after-split', `split "${name}" save paused on conflict modal`);
    await page.getByTestId('conflict-cancel').click().catch(() => undefined);
  }
  return 'split';
}

// Dismiss any stray modal so a stuck dialog from one phase never poisons later
// phases (discovery discipline: record + recover, never crash the whole run).
async function clearStuckModals(page: Page, where: string): Promise<void> {
  const modals: ReadonlyArray<readonly [string, string]> = [
    ['conflict-modal-root', 'conflict-cancel'],
    ['knife-inheritor-modal-root', 'knife-modal-cancel'],
    ['add-property-form', 'add-form-cancel'],
    ['repair-modal-root', 'repair-abort'],
    ['unsaved-modal-root', 'unsaved-cancel'],
  ];
  for (const [root, cancel] of modals) {
    if ((await page.getByTestId(root).count()) > 0) {
      record('stuck-modal', `${where}: ${root} still present; dismissing`);
      await page.getByTestId(cancel).click().catch(() => undefined);
      await page.keyboard.press('Escape').catch(() => undefined);
    }
  }
}

test.describe('BUGHUNT R3-3 — deep-nest reparent-confirm / multi-hole exclave edit / split×3→merge metamorphic / long playback+step / 40-feature perf+undo-storm', () => {
  test('explore3-r3: reparent via confirm-button, multi-hole vertex+knife edit, consecutive splits then merge with undo/redo, long playback monotone + step, mass-feature perf + undo storm + save/load', async () => {
    test.setTimeout(540_000);
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
      const time0 = await diagCurrentTime(page);
      record('boot-current-time', `boot current-time="${time0}"`);

      // =====================================================================
      // A. DEEP NEST (DEPTH=6) → REPARENT via the EXPLICIT 確定 BUTTON.
      // =====================================================================
      const countBeforeNest = await checkParity(page, 'before-nest');

      const DEPTH = 6;
      let half = 230;
      let level = 0;
      for (; level < DEPTH; level += 1) {
        const res = await commitFace(page, cx, cy, half, {
          chooseLastParent: level > 0,
          name: `nest-L${level}`,
        });
        if (res === 'conflict') {
          record('nest-conflict', `level ${level} paused on conflict modal (nested face should not conflict)`);
          await page.getByTestId('conflict-cancel').click().catch(() => undefined);
          break;
        }
        if (res === 'rejected') {
          record('nest-rejected', `level ${level} (half=${half}) rejected — nesting chain stopped`);
          break;
        }
        await activeFeature(page);
        await checkCamera(page, `nest-L${level}`);
        const list = await checkParity(page, `nest-L${level}`);
        if (list !== countBeforeNest + level + 1) {
          record('nest-count', `after level ${level} expected ${countBeforeNest + level + 1} features, got ${list}`);
        }
        half = Math.round(half * 0.72);
      }
      await shot(page, 'deep-nest');
      const reachedDepth = level;
      record('nest-depth-reached', `committed a nesting chain of depth ${reachedDepth}`);

      const countAfterNest = await checkParity(page, 'after-nest');

      // --- REPARENT through the CONFIRM BUTTON (r3-2 only auto-committed via two
      //     clicks; here we drive the explicit reparent-confirm导线 + assert the
      //     hidden reparent-target / reparent-parent markers populate & are finite).
      if (await armEditTool(page, 'reparent')) {
        await shot(page, 'reparent-armed');
        // First click: target = the deepest face (centre). Second click: a shallower
        // ancestor ring offset → the new parent.
        await page.mouse.click(cx, cy);
        await page.waitForTimeout(90);
        const tgtMarker = ((await page.getByTestId('reparent-target').textContent().catch(() => '')) ?? '').trim();
        if (tgtMarker === '') {
          record('reparent-no-target', 'reparent-target empty after clicking the deepest face');
        } else if (/NaN|Infinity|undefined|null/.test(tgtMarker)) {
          record('reparent-target-malformed', `reparent-target="${tgtMarker}"`);
        }
        await page.mouse.click(cx + Math.round(half * 1.8), cy);
        await page.waitForTimeout(120);
        const parMarker = ((await page.getByTestId('reparent-parent').textContent().catch(() => '')) ?? '').trim();
        if (/NaN|Infinity/.test(parMarker)) record('reparent-parent-malformed', `reparent-parent="${parMarker}"`);

        const confirm = page.getByTestId('reparent-confirm');
        const confirmVisible = await confirm.isVisible().catch(() => false);
        const confirmEnabled = confirmVisible && (await confirm.isEnabled().catch(() => false));
        record('reparent-confirm-state', `confirm visible=${confirmVisible} enabled=${confirmEnabled} target="${tgtMarker}" parent="${parMarker}"`);
        if (confirmEnabled) {
          await confirm.click().catch(() => undefined);
          await page.waitForTimeout(160);
        } else if (parMarker === '') {
          // The second click resolved no new-parent feature; record so a dead
          // reparent (selecting then unable to confirm) surfaces.
          record('reparent-no-parent', 'second reparent click resolved no new-parent; confirm not enabled');
        }
        if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
          record('reparent-conflict', 'reparent surfaced conflict modal');
          await page.getByTestId('conflict-cancel').click().catch(() => undefined);
        }
        await clearStuckModals(page, 'after-reparent');
        await checkCamera(page, 'after-reparent');
        await shot(page, 'reparented');
        const countAfterReparent = await checkParity(page, 'after-reparent');
        // A reparent is a STRUCTURE move: feature count must NOT change.
        if (countAfterReparent !== countAfterNest) {
          record('reparent-count-change', `reparent changed feature count ${countAfterNest} -> ${countAfterReparent} (restructure should be count-stable)`);
        }
      }

      await goView(page);
      await showSidebarTab(page, 'properties');
      await checkAnchorOrdering(page, 'after-reparent');

      // =====================================================================
      // B. MULTI-HOLE EXCLAVE: a big parent with TWO nested inner regions, then
      //    (B1) vertex-edit an inner ring and (B2) knife-split through the holes.
      // =====================================================================
      // Place this scene in the LOWER band so it never overlaps the deep-nest
      // cluster (no spurious conflict modal). Big parent + two inner faces.
      const exHalf = 170;
      const exReach = exHalf + 50;
      const exYmin = b.y + exReach + 12;
      const exYmax = b.y + b.height - (exReach + 12);
      const exCy = Math.min(exYmax, Math.max(exYmin, cy + 230));
      const exCx = Math.max(b.x + exReach + 12, Math.min(b.x + b.width - exReach - 12, cx - 220));

      const bigRes = await commitFace(page, exCx, exCy, exHalf, { name: 'exclave-parent' });
      if (bigRes === 'conflict') await page.getByTestId('conflict-cancel').click().catch(() => undefined);
      const multiHoleOk = bigRes === 'committed';
      if (!multiHoleOk) record('exclave-parent-not-committed', `exclave-parent outcome=${bigRes}`);
      await shot(page, 'exclave-parent');

      // Two inner faces nested INSIDE the big parent (left & right "holes"/飛び地).
      let innerCommitted = 0;
      if (multiHoleOk) {
        const innerHalf = 42;
        const innerOffsets: ReadonlyArray<readonly [number, number]> = [
          [exCx - 70, exCy],
          [exCx + 70, exCy],
        ];
        for (let i = 0; i < innerOffsets.length; i += 1) {
          const off = innerOffsets[i]!;
          const r = await commitFace(page, off[0], off[1], innerHalf, {
            chooseLastParent: true,
            name: `exclave-inner-${i + 1}`,
          });
          if (r === 'committed') innerCommitted += 1;
          else if (r === 'conflict') {
            record('exclave-inner-conflict', `inner ${i + 1} paused on conflict modal`);
            await page.getByTestId('conflict-cancel').click().catch(() => undefined);
          } else {
            record('exclave-inner-rejected', `inner ${i + 1} outcome=${r}`);
          }
          await checkCamera(page, `exclave-inner-${i + 1}`);
        }
      }
      record('exclave-inners', `committed ${innerCommitted}/2 inner exclave faces`);
      await shot(page, 'exclave-built');
      await checkParity(page, 'after-exclave-build');

      // --- B1: VERTEX-EDIT an inner ring. Select inner-1 (left) and drag a corner.
      if (innerCommitted > 0 && (await armEditTool(page, 'vertex'))) {
        await shot(page, 'exclave-vertex-armed');
        const inX = exCx - 70;
        const inY = exCy;
        await page.mouse.click(inX, inY); // select inner-1
        const vSelBefore = await activeFeature(page);
        const innerHalf = 42;
        const vx = inX - innerHalf;
        const vy = inY - innerHalf;
        await page.mouse.move(vx, vy);
        await page.mouse.down();
        await page.mouse.move(vx + 14, vy + 14, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(140);
        if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
          record('exclave-vertex-conflict', 'inner vertex drag surfaced conflict modal');
          await page.getByTestId('conflict-cancel').click().catch(() => undefined);
        }
        await clearStuckModals(page, 'after-exclave-vertex');
        const vSelAfter = await activeFeature(page);
        if (vSelBefore !== '' && vSelAfter === '') {
          record('exclave-vertex-lost-selection', `selection lost after inner vertex drag (was ${vSelBefore})`);
        }
        await checkCamera(page, 'after-exclave-vertex');
        await shot(page, 'exclave-vertex-dragged');
        await checkParity(page, 'after-exclave-vertex');
      }

      // --- B2: KNIFE-SPLIT the big parent through BOTH inner regions (a vertical cut
      //     down the centre that pierces between the two holes). Re-select the parent.
      const countBeforeExSplit = await checkParity(page, 'before-exclave-split');
      if (multiHoleOk && (await armEditTool(page, 'knife'))) {
        await page.getByTestId('knife-tool').waitFor({ state: 'attached', timeout: 4000 }).catch(() => {
          record('knife-chrome-missing', 'knife-tool chrome did not mount (exclave split)');
        });
        // Pierce vertically through the centre of the big parent (between the two
        // inner holes), top-to-bottom, so the parent is cut while it contains holes.
        const kx = exCx;
        const r = await knifeSplitVertical(page, kx, exCy, exReach, 'exclave-split');
        await shot(page, 'exclave-split');
        if (r !== 'split') record('exclave-knife', `exclave parent split outcome=${r}`);
        await checkCamera(page, 'after-exclave-split');
        await clearStuckModals(page, 'after-exclave-split');
        const afterExSplit = await checkParity(page, 'after-exclave-split');
        record('exclave-split-count', `exclave count ${countBeforeExSplit} -> ${afterExSplit} (split outcome=${r})`);
      }
      await goView(page);
      await showSidebarTab(page, 'properties');
      await checkAnchorOrdering(page, 'after-exclave');

      // =====================================================================
      // C. CONSECUTIVE KNIFE SPLITS (3 in a row) → MERGE + UNDO/REDO metamorphic.
      // =====================================================================
      const sHalf = 70;
      const sReach = sHalf + 40;
      const sx = Math.max(b.x + sReach + 12, Math.min(b.x + b.width - sReach - 12, cx + 240));
      const syMin = b.y + sReach + 12;
      const syMax = b.y + b.height - (sReach + 12);
      const sy = Math.min(syMax, Math.max(syMin, cy + 250));
      const baseRes = await commitFace(page, sx, sy, sHalf, { name: 'split-base' });
      if (baseRes === 'conflict') await page.getByTestId('conflict-cancel').click().catch(() => undefined);
      if (baseRes !== 'committed') {
        record('split-base-not-committed', `split-base outcome=${baseRes} — knife/merge phase cannot run`);
      }
      expect(baseRes, 'split-base must commit so the knife-split×3→merge path is exercised').toBe('committed');
      await shot(page, 'split-base');

      const countBeforeSplit = await checkParity(page, 'before-splits');

      let splitsDone = 0;
      const cutXs = [sx, sx - 32, sx - 16];
      for (let s = 0; s < cutXs.length; s += 1) {
        if (!(await armEditTool(page, 'knife'))) break;
        await page.getByTestId('knife-tool').waitFor({ state: 'attached', timeout: 4000 }).catch(() => {
          record('knife-chrome-missing', `knife-tool chrome did not mount (cut ${s})`);
        });
        const kx = Math.max(b.x + sReach + 6, Math.min(b.x + b.width - sReach - 6, cutXs[s] ?? sx));
        const r = await knifeSplitVertical(page, kx, sy, sReach, `split-${s + 1}`);
        await shot(page, `split-${s + 1}`);
        if (r === 'split') splitsDone += 1;
        else record('knife-split', `cut ${s + 1} outcome=${r}`);
        await checkCamera(page, `after-split-${s + 1}`);
        const afterCut = await checkParity(page, `after-split-${s + 1}`);
        if (r === 'split' && afterCut !== countBeforeSplit + splitsDone) {
          record('knife-split-count', `after ${splitsDone} splits expected ${countBeforeSplit + splitsDone}, got ${afterCut}`);
        }
        await clearStuckModals(page, `after-split-${s + 1}`);
      }
      record('splits-done', `completed ${splitsDone}/${cutXs.length} consecutive splits`);

      const countAfterSplits = await checkParity(page, 'after-splits');

      // --- UNDO∘op ≈ identity, then op∘逆op ≈ identity. -------------------------
      if (splitsDone > 0) {
        await armEditTool(page, 'select');
        const canUndo = page.getByTestId('app-can-undo');
        const canRedo = page.getByTestId('app-can-redo');
        const u0 = ((await canUndo.textContent()) ?? '').trim();
        if (u0 !== '1') record('undo-unavailable', `expected can-undo=1 after splits, got ${u0}`);
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(180);
        const redoAfter = ((await canRedo.textContent()) ?? '').trim();
        if (redoAfter !== '1') {
          record('undo-no-redo', `Ctrl+Z after split did not enable redo (can-redo=${redoAfter})`);
        }
        await checkCamera(page, 'after-undo-split');
        const countAfterUndo = await checkParity(page, 'after-undo-split');
        if (countAfterUndo >= countAfterSplits) {
          record('undo-no-reduction', `undo did not reduce count: after-splits=${countAfterSplits} after-undo=${countAfterUndo}`);
        } else {
          record('undo-reduced', `undo moved count ${countAfterSplits} -> ${countAfterUndo}`);
        }
        await armEditTool(page, 'select');
        await page.keyboard.press('Control+y').catch(() => undefined);
        await page.waitForTimeout(180);
        const countAfterRedo = await checkParity(page, 'after-redo-split');
        if (countAfterRedo !== countAfterSplits) {
          record('redo-not-identity', `redo did not restore count: expected ${countAfterSplits}, got ${countAfterRedo}`);
        }
        await shot(page, 'undo-redo-split');
      }

      // --- MERGE (合体): re-combine two split siblings → count shrinks. ----------
      const countBeforeMerge = await checkParity(page, 'before-merge');
      if (splitsDone > 0 && (await armEditTool(page, 'merge'))) {
        await shot(page, 'merge-armed');
        await page.mouse.click(sx - 46, sy + 26);
        await page.waitForTimeout(70);
        await page.mouse.click(sx + 46, sy + 26);
        await page.waitForTimeout(120);
        const tc = ((await page.getByTestId('merge-target-count').textContent().catch(() => '')) ?? '').trim();
        record('merge-target-count', `merge target-count="${tc}"`);
        const mergeConfirm = page.getByTestId('merge-confirm');
        if (
          (await mergeConfirm.isVisible().catch(() => false)) &&
          (await mergeConfirm.isEnabled().catch(() => false))
        ) {
          await mergeConfirm.click().catch(() => undefined);
          await page.waitForTimeout(220);
          if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
            await page.getByTestId('conflict-cancel').click().catch(() => undefined);
          }
        } else {
          const msg = ((await page.getByTestId('merge-message').textContent().catch(() => '')) ?? '').trim();
          if (msg) record('merge-flow-note', `merge produced message="${msg}"`);
          else record('merge-flow-note', 'merge-confirm not enabled (fewer than 2 valid targets resolved)');
        }
        await clearStuckModals(page, 'after-merge');
        await shot(page, 'merged');
        await checkCamera(page, 'after-merge');
        const countAfterMerge = await checkParity(page, 'after-merge');
        if (countAfterMerge >= countBeforeMerge) {
          record('merge-no-reduction', `merge did not reduce count: before=${countBeforeMerge} after=${countAfterMerge} (merge may be a no-op / not wired)`);
        } else {
          record('merge-reduced', `merge reduced count ${countBeforeMerge} -> ${countAfterMerge}`);
        }
      }

      // =====================================================================
      // D. LONG TIMELINE PLAYBACK (~6s) + manual STEP + ANCHOR ordering.
      // =====================================================================
      await goView(page);
      const playback = page.getByTestId('timeline-playback');
      if (await playback.isVisible().catch(() => false)) {
        const speed = page.getByRole('combobox', { name: '再生速度' });
        if (await speed.isVisible().catch(() => false)) {
          const optLabels = await speed.locator('option').allTextContents().catch(() => []);
          if (optLabels.length > 0) {
            await speed.selectOption({ index: optLabels.length - 1 }).catch(() => undefined);
          }
        }
        const toggle = page.getByRole('button', { name: /再生|一時停止/ }).first();
        const cur = page.getByTestId('timeline-current');
        const before = ((await cur.textContent().catch(() => '')) ?? '').trim();
        if (/NaN|Infinity|undefined/.test(before)) record('timeline-current-malformed', `pre-play="${before}"`);

        await toggle.click().catch(() => undefined); // ▶ play
        await page.waitForTimeout(120);
        const pressedDuringPlay = await toggle.getAttribute('aria-pressed').catch(() => null);
        if (pressedDuringPlay !== 'true') {
          record('playback-not-pressed', `play button aria-pressed=${pressedDuringPlay} after clicking 再生`);
        }

        const samples: number[] = [];
        const parseYear = (t: string): number => {
          const m = t.match(/-?\d+/);
          return m ? Number(m[0]) : Number.NaN;
        };
        // ~6s of playback (24 × 250ms): a LONGER run than r3-1/r3-2 (~4s).
        for (let i = 0; i < 24; i += 1) {
          await page.waitForTimeout(250);
          const t = ((await cur.textContent().catch(() => '')) ?? '').trim();
          if (/NaN|Infinity|undefined/.test(t)) {
            record('timeline-current-malformed', `play sample ${i}="${t}"`);
          }
          const y = parseYear(t);
          if (Number.isFinite(y)) samples.push(y);
          if (i === 11) await shot(page, 'playback-mid');
        }
        await toggle.click().catch(() => undefined); // ⏸ pause
        await page.waitForTimeout(150);
        const pressedAfterPause = await toggle.getAttribute('aria-pressed').catch(() => null);
        if (pressedAfterPause === 'true') {
          record('playback-pause-stuck', 'pause click left play button still aria-pressed=true');
        }
        await shot(page, 'playback-paused');

        let regressions = 0;
        for (let i = 1; i < samples.length; i += 1) {
          const prev = samples[i - 1];
          const curY = samples[i];
          if (prev !== undefined && curY !== undefined && curY < prev) regressions += 1;
        }
        if (regressions > 0) {
          record('playback-non-monotone', `timeline-current regressed ${regressions}× during play: ${JSON.stringify(samples)}`);
        }
        if (samples.length >= 2) {
          const first = samples[0];
          const last = samples[samples.length - 1];
          if (first !== undefined && last !== undefined && last === first) {
            record('playback-no-advance', `timeline-current did not advance during ~6s play (stayed ${first})`);
          }
        }
        const after = ((await cur.textContent().catch(() => '')) ?? '').trim();
        if (/NaN|Infinity|undefined/.test(after)) record('timeline-current-malformed', `post-pause="${after}"`);

        // --- manual STEP probing: drive timeline-step forward/back; current finite.
        const step = page.getByTestId('timeline-step');
        if (await step.isVisible().catch(() => false)) {
          const stepSamples: string[] = [];
          for (let i = 0; i < 4; i += 1) {
            await step.click().catch(() => undefined);
            await page.waitForTimeout(80);
            const t = ((await cur.textContent().catch(() => '')) ?? '').trim();
            stepSamples.push(t);
            if (/NaN|Infinity|undefined/.test(t)) record('timeline-step-malformed', `step ${i} current="${t}"`);
          }
          record('timeline-step', `step samples=${JSON.stringify(stepSamples)}`);
          await shot(page, 'playback-stepped');
        } else {
          record('timeline-step-missing', 'timeline-step control not visible');
        }
      } else {
        record('playback-control-missing', 'timeline-playback control not visible');
      }
      await checkCamera(page, 'after-playback');

      await goView(page);
      await showSidebarTab(page, 'properties');
      await checkAnchorOrdering(page, 'after-playback');

      // =====================================================================
      // E. LARGE-COUNT (8×5=40) PAN/ZOOM/DRAW PERF + UNDO STORM + save/load.
      // =====================================================================
      const countBeforeGrid = await checkParity(page, 'before-grid');

      const HALF = 16;
      const STEP = 54;
      const COLS = 8;
      const ROWS = 5;
      const gx0 = cx - ((COLS - 1) * STEP) / 2;
      const gy0 = b.y + 70;
      let placed = 0;
      let gridConflicts = 0;
      for (let r = 0; r < ROWS; r += 1) {
        for (let c = 0; c < COLS; c += 1) {
          const gxc = gx0 + c * STEP;
          const gyc = gy0 + r * STEP;
          const res = await commitFace(page, gxc, gyc, HALF, { name: `grid-${r}-${c}` });
          if (res === 'committed') placed += 1;
          else if (res === 'conflict') {
            gridConflicts += 1;
            await page.getByTestId('conflict-cancel').click().catch(() => undefined);
          }
          if ((r * COLS + c) % 10 === 0) await checkCamera(page, `grid-${r}-${c}`);
        }
      }
      await shot(page, 'grid-placed');
      record('grid-placed', `placed ${placed}/${COLS * ROWS} grid faces (${gridConflicts} conflicts)`);

      const countAfterGrid = await checkParity(page, 'after-grid');
      if (countAfterGrid !== countBeforeGrid + placed) {
        record('grid-count', `expected ${countBeforeGrid}+${placed}=${countBeforeGrid + placed}, got ${countAfterGrid}`);
      }
      record('total-feature-count', `total features now ${countAfterGrid}`);

      // --- PERF: pan + zoom burst over the dense scene; time each leg. ----------
      await goView(page);
      const lbox = await inputLayer.boundingBox();
      const wx = lbox ? lbox.x + lbox.width / 2 : cx;
      const wy = lbox ? lbox.y + lbox.height / 2 : cy;

      const timeLeg = async (label: string, fn: () => Promise<void>): Promise<void> => {
        const t0 = Date.now();
        await fn();
        const dt = Date.now() - t0;
        if (dt > 4500) record('perf-slow-leg', `${label} took ${dt}ms with ${countAfterGrid} features`);
        await checkCamera(page, `perf-${label}`);
      };

      await timeLeg('zoom-in', async () => {
        for (let i = 0; i < 20; i += 1) {
          await page.mouse.move(wx, wy);
          await page.mouse.wheel(0, -120);
          await page.waitForTimeout(8);
        }
      });
      await shot(page, 'perf-zoomed-in');

      await timeLeg('pan-burst', async () => {
        const pan = async (dx: number, dy: number): Promise<void> => {
          await page.mouse.move(wx, wy);
          await page.mouse.down();
          for (let s = 1; s <= 6; s += 1) {
            await page.mouse.move(wx + (dx * s) / 6, wy + (dy * s) / 6);
            await page.waitForTimeout(6);
          }
          await page.mouse.up();
          await page.waitForTimeout(20);
        };
        await pan(700, 0);
        await pan(-1400, 0);
        await pan(0, 700);
        await pan(0, -1400);
      });
      await shot(page, 'perf-panned');

      await timeLeg('zoom-out', async () => {
        for (let i = 0; i < 26; i += 1) {
          await page.mouse.move(wx, wy);
          await page.mouse.wheel(0, 120);
          await page.waitForTimeout(8);
        }
      });
      await shot(page, 'perf-zoomed-out');

      // --- UNDO STORM: fire many undos, then verify history + finiteness. -------
      await armEditTool(page, 'select');
      const canUndo = page.getByTestId('app-can-undo');
      const stormCountBefore = await featureListCount(page);
      let storm = 0;
      for (let i = 0; i < 16; i += 1) {
        if (((await canUndo.textContent()) ?? '').trim() !== '1') break;
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(90);
        storm += 1;
        await checkCamera(page, `undo-storm-${i}`);
        await activeFeature(page);
      }
      record('undo-storm', `executed ${storm} undos; feature count ${stormCountBefore} -> ${await featureListCount(page)}`);
      await clearStuckModals(page, 'after-undo-storm');
      await checkParity(page, 'after-undo-storm');
      await shot(page, 'undo-storm');

      // =====================================================================
      // SAVE→LOAD reachability + dirty flag (no native dialog fired).
      // =====================================================================
      const unsavedNow = await diagUnsaved(page);
      if (!/^(あり|なし)$/.test(unsavedNow)) record('dirty-malformed', `unsaved="${unsavedNow}"`);
      await goView(page);
      await page.getByTestId('menu-file').click();
      const fileItems = page.getByTestId('menu-items-file');
      if (await fileItems.isVisible().catch(() => false)) {
        for (const cmd of ['file.new', 'file.open', 'file.save', 'file.saveAs']) {
          const it = fileItems.locator(`[data-command="${cmd}"]`);
          if ((await it.count()) === 0) {
            record('file-command-missing', `${cmd} not present in ファイル menu`);
          }
        }
        await page.getByTestId('menu-file').click().catch(() => undefined);
      } else {
        record('menu-not-open', 'ファイル menu did not open');
      }
      await fileItems.waitFor({ state: 'detached', timeout: 3000 }).catch(() => undefined);
      await shot(page, 'file-menu');

      // Final parity + camera + selection + current-time finiteness.
      const finalList = await checkParity(page, 'final');
      await checkCamera(page, 'final');
      await activeFeature(page);
      const finalTime = await diagCurrentTime(page);
      record('final-current-time', `final current-time="${finalTime}"`);
      await shot(page, 'final');

      void countAfterNest;
      void finalList;
      void reachedDepth;
      console.log(`BUGHUNT_SUMMARY: ${JSON.stringify(anomalies)}`);
      await expect(page.getByTestId('app-shell')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
