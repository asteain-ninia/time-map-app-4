// BUGHUNT R3 (explore3-r4) — e2e exploration (discovery-only). Drives the REAL
// built Electron composite "like a user" through an operation plan deliberately
// UNTOUCHED by explore-r1..r4 / explore2-r1..r4 / explore3-r1..r3.
//
// Prior rounds covered: conflict modal / settings / save-load reachability /
// undo連打 / zoom-pan / single & double & triple knife split / single & deep
// parent-child (depth ≤ 6) / search / time-edges / vertex move (single + nested) /
// longitude / context-menu / anchor-mode / reparent (two-click + confirm-button) /
// multi-hole exclave (vertex + knife) / split×3→merge / playback (~4-6s) / grids
// (up to 8×5=40) / undo storm.
//
// THIS round (r3-4) pushes every dimension PAST what r3-1..r3-3 reached and adds
// genuinely new导线 they never touched:
//
//   A. VERY DEEP NEST (DEPTH=8, deeper than r3-3's 6) — strictly-nested chain via
//      the add-parent <select> (deepest option each level). Gates: every level
//      commits; 地物一覧 count == 診断 feature-count (single truth source) per
//      level; selection valid; coords finite; no console.error/NaN.
//
//   B. MULTI-HOLE EXCLAVE → REPARENT A HOLE OUT, THEN KNIFE THROUGH BOTH HOLES.
//      A NEW combination: build a big parent with TWO inner faces (holes/飛び地),
//      then 所属変更 ONE inner hole to a DIFFERENT ancestor (reparent a hole OUT of
//      its container — r3-3 only reparented a deep-nest leaf, never an exclave
//      hole), THEN knife-split the big parent that still contains the remaining
//      hole. Gates: reparent is count-stable; coords finite; 地物一覧==診断 never
//      desyncs; selection valid; live geometry validators raise no console.error
//      (リング交互性 / 非自己交差 / 包含妥当); anchor rows ascending/non-overlap/NaN-free.
//
//   C. FIVE CONSECUTIVE KNIFE SPLITS (more than r3-2/r3-3's 3) → CHAINED MERGE (two
//      merges in a row). Full metamorphic battery: +1 per cut; each merge -1;
//      undo∘op ≈ identity (count back) and op∘逆op ≈ identity (redo restores).
//
//   D. EXTRA-LONG PLAYBACK (~10s, longer than r3-3's ~6s) with SPEED CYCLING mid-run
//      + a STEP STORM driven through the REAL forward/back step BUTTONS (pointer
//      events + aria-labels — r3-3 clicked the timeline-step CONTAINER, which is
//      inert; this drives the actual buttons). Gates: timeline-current never
//      NaN/Infinity & MONOTONE non-decreasing while playing; pause clears
//      aria-pressed; stepping keeps current finite and forward>back is consistent;
//      anchor rows on the selection ascending/non-overlapping/NaN-free.
//
//   E. LARGEST GRID (10×6=60, more than r3-3's 40) with INTERLEAVED pan/zoom DURING
//      placement (a draw-while-camera-moving stress r3-1..r3-3 did not do), then a
//      hard pan/zoom PERF burst over the densest scene, an UNDO STORM, and the
//      save→load metamorphic reachability + dirty-flag probe.
//
// STRICT GATE: any console.error, React warning, unhandled rejection, or
// NaN/Infinity in the live data-* hooks / readouts is recorded as a finding (the
// test does NOT crash on them). Anomalies surface via console.log("BUGHUNT:...")
// and a final BUGHUNT_SUMMARY JSON line. Each step screenshots into
// screenshots/__bughunt__/r3-4-*.png (read back for visual anomaly判定).
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
  const file = resolve(shotDir, `r3-4-${n}-${label}.png`);
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
  // n-way chooser (commit 01ed1d6): a vertical 2-point cut yields 2 pieces →
  // knife-choose-0 / knife-choose-1 (index-based, not the old A/B testids).
  await page.getByTestId('knife-choose-0').click().catch(() => undefined);
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

// U30 MergeOptionsDialog (FR-52): merge-confirm no longer merges directly — it opens
// the parent/property options dialog. The seeded defaults (親なし + inherit first)
// reproduce the prior hardcoded merge, so a plain 確定 (merge-options-confirm) runs
// the merge. These probes WANT the merge to happen (they assert the count drops), so
// we CONFIRM. Returns true iff the dialog was present and confirmed. Without this the
// dialog's input-blocking backdrop stays up and later clicks are swallowed.
async function confirmMergeOptions(page: Page): Promise<boolean> {
  const dialog = page.getByTestId('merge-options-dialog');
  if (!(await dialog.isVisible().catch(() => false))) return false;
  await page.getByTestId('merge-options-confirm').click().catch(() => undefined);
  await dialog.waitFor({ state: 'detached', timeout: 6000 }).catch(() => undefined);
  return true;
}

// Try ONE merge of two faces clicked at (ax,ay) and (bx,by). Returns count delta-aware outcome.
async function tryMerge(
  page: Page,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): Promise<'merged' | 'no-confirm'> {
  await page.mouse.click(ax, ay);
  await page.waitForTimeout(70);
  await page.mouse.click(bx, by);
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
    // FR-52: merge-confirm opens the options dialog; 確定 with the seeded defaults
    // runs the merge (the caller asserts the count drops after this returns).
    await confirmMergeOptions(page);
    if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
      await page.getByTestId('conflict-cancel').click().catch(() => undefined);
    }
    return 'merged';
  }
  const msg = ((await page.getByTestId('merge-message').textContent().catch(() => '')) ?? '').trim();
  if (msg) record('merge-flow-note', `merge produced message="${msg}"`);
  else record('merge-flow-note', 'merge-confirm not enabled (fewer than 2 valid targets resolved)');
  return 'no-confirm';
}

test.describe('BUGHUNT R3-4 — depth-8 nest / exclave-hole reparent-out then knife / split×5→chained-merge / extra-long playback + step-storm / 60-feature interleaved perf + undo-storm', () => {
  test('explore3-r4: very-deep nest, reparent an exclave hole out then knife the parent, five consecutive splits then two merges with undo/redo, ~10s playback + speed-cycle + step-storm, 60-feature interleaved grid perf + undo storm + save/load', async () => {
    test.setTimeout(600_000);
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
      // A. VERY DEEP NEST (DEPTH=8).
      // =====================================================================
      const countBeforeNest = await checkParity(page, 'before-nest');

      const DEPTH = 8;
      let half = 250;
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
        half = Math.round(half * 0.74);
      }
      await shot(page, 'deep-nest');
      const reachedDepth = level;
      record('nest-depth-reached', `committed a nesting chain of depth ${reachedDepth}`);
      const countAfterNest = await checkParity(page, 'after-nest');

      await goView(page);
      await showSidebarTab(page, 'properties');
      await checkAnchorOrdering(page, 'after-nest');

      // =====================================================================
      // B. MULTI-HOLE EXCLAVE → REPARENT ONE HOLE OUT, THEN KNIFE THE PARENT.
      // =====================================================================
      const exHalf = 170;
      const exReach = exHalf + 50;
      const exYmin = b.y + exReach + 12;
      const exYmax = b.y + b.height - (exReach + 12);
      const exCy = Math.min(exYmax, Math.max(exYmin, cy + 230));
      const exCx = Math.max(b.x + exReach + 12, Math.min(b.x + b.width - exReach - 12, cx - 230));

      const bigRes = await commitFace(page, exCx, exCy, exHalf, { name: 'exclave-parent' });
      if (bigRes === 'conflict') await page.getByTestId('conflict-cancel').click().catch(() => undefined);
      const multiHoleOk = bigRes === 'committed';
      if (!multiHoleOk) record('exclave-parent-not-committed', `exclave-parent outcome=${bigRes}`);
      await shot(page, 'exclave-parent');

      // Two inner faces (holes) nested INSIDE the big parent.
      const innerHalf = 40;
      const innerL: readonly [number, number] = [exCx - 72, exCy];
      const innerR: readonly [number, number] = [exCx + 72, exCy];
      let innerCommitted = 0;
      if (multiHoleOk) {
        for (let i = 0; i < 2; i += 1) {
          const off = i === 0 ? innerL : innerR;
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
      const countAfterExBuild = await checkParity(page, 'after-exclave-build');

      // --- B1: REPARENT ONE HOLE OUT — select inner-1 (left hole) as target, then
      //     click a DIFFERENT ancestor (the deep-nest cluster centre) as new parent,
      //     and commit through the reparent-confirm BUTTON. This moves a飛び地 hole
      //     OUT of its container — a structure mutation r3-3 never did with an exclave.
      if (innerCommitted > 0 && (await armEditTool(page, 'reparent'))) {
        await shot(page, 'reparent-armed');
        await page.mouse.click(innerL[0], innerL[1]); // target = left hole
        await page.waitForTimeout(90);
        const tgtMarker = ((await page.getByTestId('reparent-target').textContent().catch(() => '')) ?? '').trim();
        if (tgtMarker === '') {
          record('reparent-no-target', 'reparent-target empty after clicking the left exclave hole');
        } else if (/NaN|Infinity|undefined|null/.test(tgtMarker)) {
          record('reparent-target-malformed', `reparent-target="${tgtMarker}"`);
        }
        // New parent = the deep-nest cluster centre (a different subtree entirely).
        await page.mouse.click(cx, cy);
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
          record('reparent-no-parent', 'new-parent click resolved no feature; confirm not enabled (hole reparent-out)');
        }
        if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
          record('reparent-conflict', 'exclave-hole reparent surfaced conflict modal');
          await page.getByTestId('conflict-cancel').click().catch(() => undefined);
        }
        await clearStuckModals(page, 'after-hole-reparent');
        await checkCamera(page, 'after-hole-reparent');
        await shot(page, 'reparented-hole');
        const countAfterReparent = await checkParity(page, 'after-hole-reparent');
        if (countAfterReparent !== countAfterExBuild) {
          record('reparent-count-change', `exclave-hole reparent changed count ${countAfterExBuild} -> ${countAfterReparent} (restructure should be count-stable)`);
        }
      }

      // --- B2: KNIFE-SPLIT the big parent (still containing the remaining hole).
      const countBeforeExSplit = await checkParity(page, 'before-exclave-split');
      if (multiHoleOk && (await armEditTool(page, 'knife'))) {
        await page.getByTestId('knife-tool').waitFor({ state: 'attached', timeout: 4000 }).catch(() => {
          record('knife-chrome-missing', 'knife-tool chrome did not mount (exclave split)');
        });
        // Cut horizontally through the parent centre, ABOVE the inner row, so the
        // pierce separates parent halves while a hole is still contained.
        await page.mouse.click(exCx, exCy);
        await page.waitForTimeout(70);
        await page.mouse.click(exCx - exReach, exCy - 8);
        await page.mouse.click(exCx + exReach, exCy - 8);
        const cc = page.getByTestId('knife-confirm-cut');
        let exSplitOutcome = 'no-confirm';
        if (await cc.isVisible().catch(() => false)) {
          await cc.click();
          await page.waitForTimeout(140);
          if ((await page.getByTestId('knife-inheritor-modal-root').count()) > 0) {
            // n-way chooser (commit 01ed1d6): a horizontal 2-point cut yields 2
            // pieces → knife-choose-0 / knife-choose-1 (index-based, not A/B).
            await page.getByTestId('knife-choose-0').click().catch(() => undefined);
            await page.getByTestId('knife-confirm-inheritor').click().catch(() => undefined);
            await page.waitForTimeout(120);
            const form = page.getByTestId('add-property-form');
            if (await form.isVisible().catch(() => false)) {
              await page.getByTestId('add-name').fill('exclave-split').catch(() => undefined);
              await page.getByTestId('add-save').click();
              await page.waitForTimeout(220);
              exSplitOutcome = 'split';
            } else exSplitOutcome = 'no-form';
          } else exSplitOutcome = 'no-modal';
        }
        await shot(page, 'exclave-split');
        record('exclave-knife', `exclave parent split outcome=${exSplitOutcome}`);
        await checkCamera(page, 'after-exclave-split');
        await clearStuckModals(page, 'after-exclave-split');
        const afterExSplit = await checkParity(page, 'after-exclave-split');
        record('exclave-split-count', `exclave count ${countBeforeExSplit} -> ${afterExSplit}`);
      }
      await goView(page);
      await showSidebarTab(page, 'properties');
      await checkAnchorOrdering(page, 'after-exclave');

      // =====================================================================
      // C. FIVE CONSECUTIVE KNIFE SPLITS → CHAINED MERGE (two merges).
      // =====================================================================
      const sHalf = 95;
      const sReach = sHalf + 45;
      const sx = Math.max(b.x + sReach + 12, Math.min(b.x + b.width - sReach - 12, cx + 250));
      const syMin = b.y + sReach + 12;
      const syMax = b.y + b.height - (sReach + 12);
      const sy = Math.min(syMax, Math.max(syMin, cy + 250));
      const baseRes = await commitFace(page, sx, sy, sHalf, { name: 'split-base' });
      if (baseRes === 'conflict') await page.getByTestId('conflict-cancel').click().catch(() => undefined);
      if (baseRes !== 'committed') {
        record('split-base-not-committed', `split-base outcome=${baseRes} — knife/merge phase cannot run`);
      }
      expect(baseRes, 'split-base must commit so the knife-split×5→merge path is exercised').toBe('committed');
      await shot(page, 'split-base');

      const countBeforeSplit = await checkParity(page, 'before-splits');

      let splitsDone = 0;
      // Five distinct vertical cut offsets inside the (wider) base face.
      const cutXs = [sx, sx - 44, sx + 36, sx - 22, sx + 18];
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

      // --- CHAINED MERGE: two merges in a row, each must shrink the count. -------
      if (splitsDone >= 2) {
        let mergeRound = 0;
        let countBeforeMerge = await checkParity(page, 'before-merge');
        for (let m = 0; m < 2; m += 1) {
          if (!(await armEditTool(page, 'merge'))) break;
          await shot(page, `merge-armed-${m + 1}`);
          // Click two adjacent sibling slivers near the bottom edge of the base.
          const ay = sy + sHalf - 18;
          const r = await tryMerge(page, sx - 52 + m * 10, ay, sx + 52 - m * 10, ay);
          await clearStuckModals(page, `after-merge-${m + 1}`);
          await shot(page, `merged-${m + 1}`);
          await checkCamera(page, `after-merge-${m + 1}`);
          const countAfterMerge = await checkParity(page, `after-merge-${m + 1}`);
          if (r === 'merged' && countAfterMerge < countBeforeMerge) {
            mergeRound += 1;
            record('merge-reduced', `merge ${m + 1} reduced count ${countBeforeMerge} -> ${countAfterMerge}`);
          } else {
            record('merge-no-reduction', `merge ${m + 1}: before=${countBeforeMerge} after=${countAfterMerge} outcome=${r}`);
          }
          countBeforeMerge = countAfterMerge;
        }
        record('merges-done', `${mergeRound} merges reduced the count`);
      }

      // =====================================================================
      // D. EXTRA-LONG PLAYBACK (~10s) + SPEED CYCLING + STEP STORM (real buttons).
      // =====================================================================
      await goView(page);
      const playback = page.getByTestId('timeline-playback');
      if (await playback.isVisible().catch(() => false)) {
        const speed = page.getByRole('combobox', { name: '再生速度' });
        const optLabels = (await speed.locator('option').allTextContents().catch(() => [])) ?? [];
        if (optLabels.length > 0) {
          await speed.selectOption({ index: optLabels.length - 1 }).catch(() => undefined);
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
        // ~10s of playback (40 × 250ms), with a SPEED CYCLE at the midpoint.
        for (let i = 0; i < 40; i += 1) {
          await page.waitForTimeout(250);
          const t = ((await cur.textContent().catch(() => '')) ?? '').trim();
          if (/NaN|Infinity|undefined/.test(t)) record('timeline-current-malformed', `play sample ${i}="${t}"`);
          const y = parseYear(t);
          if (Number.isFinite(y)) samples.push(y);
          if (i === 19) {
            // Cycle the speed mid-playback (down then back up) — a live setting
            // change while the timer is running, which r3-* never did.
            if (optLabels.length > 1) {
              await speed.selectOption({ index: 0 }).catch(() => undefined);
              await page.waitForTimeout(120);
              await speed.selectOption({ index: optLabels.length - 1 }).catch(() => undefined);
            }
            await shot(page, 'playback-mid');
          }
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
            record('playback-no-advance', `timeline-current did not advance during ~10s play (stayed ${first})`);
          }
        }
        const after = ((await cur.textContent().catch(() => '')) ?? '').trim();
        if (/NaN|Infinity|undefined/.test(after)) record('timeline-current-malformed', `post-pause="${after}"`);

        // --- STEP STORM through the REAL forward/back BUTTONS (pointer events).
        const stepFwd = page.getByRole('button', { name: /次へ進む/ }).first();
        const stepBack = page.getByRole('button', { name: /前へ戻る/ }).first();
        const fwdVisible = await stepFwd.isVisible().catch(() => false);
        const backVisible = await stepBack.isVisible().catch(() => false);
        if (fwdVisible && backVisible) {
          const stepSamples: string[] = [];
          const before2 = parseYear(((await cur.textContent().catch(() => '')) ?? '').trim());
          for (let i = 0; i < 8; i += 1) {
            await stepFwd.click().catch(() => undefined);
            await page.waitForTimeout(60);
            const t = ((await cur.textContent().catch(() => '')) ?? '').trim();
            stepSamples.push(t);
            if (/NaN|Infinity|undefined/.test(t)) record('timeline-step-malformed', `fwd step ${i} current="${t}"`);
          }
          const afterFwd = parseYear(((await cur.textContent().catch(() => '')) ?? '').trim());
          // 8 back steps should undo the 8 forward steps (op∘逆op identity proxy on time).
          for (let i = 0; i < 8; i += 1) {
            await stepBack.click().catch(() => undefined);
            await page.waitForTimeout(60);
            const t = ((await cur.textContent().catch(() => '')) ?? '').trim();
            if (/NaN|Infinity|undefined/.test(t)) record('timeline-step-malformed', `back step ${i} current="${t}"`);
          }
          const afterBack = parseYear(((await cur.textContent().catch(() => '')) ?? '').trim());
          record('timeline-step', `before=${before2} afterFwd=${afterFwd} afterBack=${afterBack}; fwd samples=${JSON.stringify(stepSamples)}`);
          if (Number.isFinite(before2) && Number.isFinite(afterFwd) && afterFwd < before2) {
            record('timeline-step-direction', `forward step DECREASED time: ${before2} -> ${afterFwd}`);
          }
          if (Number.isFinite(before2) && Number.isFinite(afterBack) && afterBack !== before2) {
            // Only a soft note: clamping at range edges can legitimately break exact symmetry.
            record('timeline-step-asymmetry', `8 fwd + 8 back did not return to start: ${before2} -> ${afterBack}`);
          }
          await shot(page, 'playback-stepped');
        } else {
          record('timeline-step-missing', `step buttons not both visible (fwd=${fwdVisible} back=${backVisible})`);
        }
      } else {
        record('playback-control-missing', 'timeline-playback control not visible');
      }
      await checkCamera(page, 'after-playback');
      await goView(page);
      await showSidebarTab(page, 'properties');
      await checkAnchorOrdering(page, 'after-playback');

      // =====================================================================
      // E. LARGEST GRID (10×6=60) with INTERLEAVED pan/zoom DURING placement.
      // =====================================================================
      const countBeforeGrid = await checkParity(page, 'before-grid');

      const HALF = 14;
      const STEP = 48;
      const COLS = 10;
      const ROWS = 6;
      const gx0 = cx - ((COLS - 1) * STEP) / 2;
      const gy0 = b.y + 64;
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
          // INTERLEAVE: every full row, do a small pan + zoom while the grid grows.
          if (c === COLS - 1) {
            await goView(page);
            const lb = await inputLayer.boundingBox();
            const wx = lb ? lb.x + lb.width / 2 : cx;
            const wy = lb ? lb.y + lb.height / 2 : cy;
            await page.mouse.move(wx, wy);
            await page.mouse.wheel(0, r % 2 === 0 ? -120 : 120);
            await page.mouse.down();
            await page.mouse.move(wx + 40, wy + 18, { steps: 3 });
            await page.mouse.up();
            await checkCamera(page, `grid-interleave-row-${r}`);
          }
        }
      }
      await shot(page, 'grid-placed');
      record('grid-placed', `placed ${placed}/${COLS * ROWS} grid faces (${gridConflicts} conflicts)`);
      const countAfterGrid = await checkParity(page, 'after-grid');
      if (countAfterGrid !== countBeforeGrid + placed) {
        record('grid-count', `expected ${countBeforeGrid}+${placed}=${countBeforeGrid + placed}, got ${countAfterGrid}`);
      }
      record('total-feature-count', `total features now ${countAfterGrid}`);

      // --- PERF: hard pan + zoom burst over the densest scene; time each leg. ----
      await goView(page);
      const lbox = await inputLayer.boundingBox();
      const wx = lbox ? lbox.x + lbox.width / 2 : cx;
      const wy = lbox ? lbox.y + lbox.height / 2 : cy;
      const timeLeg = async (label: string, fn: () => Promise<void>): Promise<void> => {
        const t0 = Date.now();
        await fn();
        const dt = Date.now() - t0;
        if (dt > 5000) record('perf-slow-leg', `${label} took ${dt}ms with ${countAfterGrid} features`);
        await checkCamera(page, `perf-${label}`);
      };
      await timeLeg('zoom-in', async () => {
        for (let i = 0; i < 24; i += 1) {
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
        await pan(800, 0);
        await pan(-1600, 0);
        await pan(0, 800);
        await pan(0, -1600);
      });
      await shot(page, 'perf-panned');
      await timeLeg('zoom-out', async () => {
        for (let i = 0; i < 30; i += 1) {
          await page.mouse.move(wx, wy);
          await page.mouse.wheel(0, 120);
          await page.waitForTimeout(8);
        }
      });
      await shot(page, 'perf-zoomed-out');

      // --- UNDO STORM. ----------------------------------------------------------
      await armEditTool(page, 'select');
      const canUndo = page.getByTestId('app-can-undo');
      const stormCountBefore = await featureListCount(page);
      let storm = 0;
      for (let i = 0; i < 24; i += 1) {
        if (((await canUndo.textContent()) ?? '').trim() !== '1') break;
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(80);
        storm += 1;
        if (i % 4 === 0) await checkCamera(page, `undo-storm-${i}`);
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
          if ((await it.count()) === 0) record('file-command-missing', `${cmd} not present in ファイル menu`);
        }
        await page.getByTestId('menu-file').click().catch(() => undefined);
      } else {
        record('menu-not-open', 'ファイル menu did not open');
      }
      await fileItems.waitFor({ state: 'detached', timeout: 3000 }).catch(() => undefined);
      await shot(page, 'file-menu');

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
