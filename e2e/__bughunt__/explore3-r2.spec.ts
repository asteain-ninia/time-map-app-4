// BUGHUNT R3 (explore3-r2) — e2e exploration (discovery-only). Drives the REAL
// built Electron composite "like a user" through an operation plan deliberately
// UNTOUCHED by explore-r1..r4 / explore2-r1..r4 / explore3-r1. Prior rounds
// covered: conflict modal / settings / save-load reachability / undo連打 /
// zoom-pan / single knife split / single parent-child / search / time-edges /
// vertex+move single drag / longitude / context-menu / anchor-mode AND (r3-1)
// deep-nest count-parity + split×2→merge + playback monotone + grid perf.
//
// THIS round (r3-2) goes after STRUCTURE MUTATION + EDIT-IN-PLACE + STRESS that
// r3-1 did not touch:
//
//   A. DEEP NEST → REPARENT RESTRUCTURE (所属変更, edit.reparent). Build a deep
//      parent→child→grandchild chain, then arm 所属変更 and try to move a deep
//      descendant under a DIFFERENT ancestor. Gates: forest stays valid (地物一覧
//      count == 診断 feature-count — single truth source — across the move),
//      selection stays valid, NO console.error/NaN, the reparent导线 never strands
//      a stuck modal. (派生集約=子の和 is checked via the diag count staying a
//      consistent single source before/after; a structural restructure must not
//      invent or drop features.)
//   B. VERTEX EDIT ON A NESTED INNER RING (edit.vertex). Select an inner nested
//      face and DRAG one of its vertices inward/outward. Gates: coords finite
//      after the drag (data-pan/zoom + readouts), selection retained, the drag
//      does not desync 地物一覧 vs 診断, no NaN in anchor rows. (non-自己交差 /
//      包含妥当 are exercised by the live geometry validators — a violation would
//      surface as add/edit-rejected or a console.error, which we gate.)
//   C. CONTINUOUS KNIFE SPLITS (3 in a row) → MERGE CHAIN, with metamorphic
//      undo∘op. Split one isolated face THREE times consecutively, screenshot
//      each, then MERGE siblings back. Gates: each split grows count by 1; merge
//      shrinks it; UNDO after the last split must flip can-redo to 1 and move the
//      count back (undo∘op ≈ identity on count); coords finite throughout.
//   D. LONG TIMELINE PLAYBACK + ANCHOR ORDERING. Fast 再生速度, ▶ for several
//      seconds sampling timeline-current, ⏸. Gates: current never NaN/Infinity &
//      MONOTONE non-decreasing while playing; pause clears aria-pressed; anchor
//      rows on the selected feature stay ascending / non-overlapping / NaN-free.
//   E. LARGE-COUNT PAN/ZOOM/DRAW PERF + UNDO STORM. Commit a grid of small
//      non-overlapping faces, time a hard pan/zoom burst over the dense scene
//      (jank proxy), then fire an UNDO STORM and confirm history + count behave
//      and stay finite. Save→load reachability + dirty flag at the end.
//
// STRICT GATE: any console.error, React warning, unhandled rejection, or
// NaN/Infinity in the live data-* hooks / readouts is recorded as a finding (the
// test does NOT crash on them). Anomalies surface via console.log("BUGHUNT:...")
// and a final BUGHUNT_SUMMARY JSON line. Each step screenshots into
// screenshots/__bughunt__/r3-2-*.png (read back for visual anomaly判定).
//
// INVARIANTS gated after each op (recorded, not crashed):
//   - 座標に NaN/Infinity 無し (data-pan-x/y, data-zoom on map-input-layer)
//   - 選択が常に有効 (active-feature id: no NaN/undefined/null)
//   - 階層森: 地物一覧 count == 診断 feature-count (single truth source) per step
//   - 錨列の昇順・非重複 (anchor rows time-sorted, non-overlapping, NaN-free)
//   - knife split: +1 per cut; merge: -1; undo∘op moves count back (metamorphic)
//   - playback: timeline-current monotone non-decreasing & finite while playing
//   - save→load reachability + dirty flag (no native dialog fired)

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { test, expect, type Page } from '@playwright/test';

import { launchApp } from '../helpers';
import { SCENE_MARGIN, placeSquareScene } from './scene-layout';

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
  const file = resolve(shotDir, `r3-2-${n}-${label}.png`);
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
  // HB6: 地物一覧 / 錨一覧 are unified into the「一覧」tab (現在時刻 = 旧地物一覧 /
  // 通史 = 旧錨一覧 のモードトグル). 'features' → 現在時刻, 'events' → 通史.
  const tabKey = key === 'properties' ? 'properties' : 'list';
  const tab = page.getByTestId(`sidebar-tab-${tabKey}`);
  if (await tab.isVisible().catch(() => false)) {
    await tab.click().catch(() => undefined);
  }
  if (key !== 'properties') {
    const mode = page.getByTestId(key === 'features' ? 'list-mode-current' : 'list-mode-history');
    if (await mode.isVisible().catch(() => false)) {
      await mode.click().catch(() => undefined);
    }
  }
}

async function featureListCount(page: Page): Promise<number> {
  const empty = page.getByTestId('unified-list-empty');
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
// add-parent select, i.e. the most-recently-added feature → deep nesting) and a
// name. Returns the outcome.
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

// U30 MergeOptionsDialog (FR-52): merge-confirm no longer merges directly — it opens
// the parent/property options dialog. The seeded defaults (親なし + inherit first)
// reproduce the prior hardcoded merge, so a plain 確定 (merge-options-confirm) runs
// the merge. This probe WANTS the merge to happen (it asserts the count drops), so we
// CONFIRM. Returns true iff the dialog was present and confirmed. Without this the
// dialog's input-blocking backdrop stays up and later clicks are swallowed.
async function confirmMergeOptions(page: Page): Promise<boolean> {
  const dialog = page.getByTestId('merge-options-dialog');
  if (!(await dialog.isVisible().catch(() => false))) return false;
  await page.getByTestId('merge-options-confirm').click().catch(() => undefined);
  await dialog.waitFor({ state: 'detached', timeout: 6000 }).catch(() => undefined);
  return true;
}

// Dismiss any stray modal so a stuck dialog from one phase never poisons later
// phases (discovery discipline: record + recover, never crash the whole run).
async function clearStuckModals(page: Page, where: string): Promise<void> {
  const modals: ReadonlyArray<readonly [string, string]> = [
    ['conflict-modal-root', 'conflict-cancel'],
    ['knife-inheritor-modal-root', 'knife-modal-cancel'],
    ['add-property-form', 'add-form-cancel'],
  ];
  for (const [root, cancel] of modals) {
    if ((await page.getByTestId(root).count()) > 0) {
      record('stuck-modal', `${where}: ${root} still present; dismissing`);
      await page.getByTestId(cancel).click().catch(() => undefined);
      await page.keyboard.press('Escape').catch(() => undefined);
    }
  }
}

test.describe('BUGHUNT R3-2 — deep-nest reparent / nested vertex-edit / split×3→merge+undo / playback+anchors / mass perf+undo-storm', () => {
  test('explore3-r2: reparent restructure, nested vertex drag, consecutive splits then merge with undo, long playback monotone, mass-feature perf + undo storm', async () => {
    test.setTimeout(480_000);
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
      // A. DEEP NEST → REPARENT RESTRUCTURE (所属変更, edit.reparent).
      // =====================================================================
      const countBeforeNest = await checkParity(page, 'before-nest');

      // 第7工程: the nest is placed from the LIVE box via the shared scene solver —
      // the old centre anchor with half=210 dropped its bottom corners onto the
      // map-anchored bottom-centre tool-controls strip. half=150 keeps the FULL
      // depth-5 chain (L4 half ≈ 36px); depth semantics unchanged. The reparent /
      // vertex phases below are nest-relative and follow automatically.
      const DEPTH = 5;
      const nest = placeSquareScene(b, {
        fx: 0.5,
        fy: 0.42,
        half: 150,
        avoidTopChrome: false, // pure-add phase — no tool guide mounts
        name: 'r2-nest',
      });
      const ncx = nest.cx;
      const ncy = nest.cy;
      let half = 150;
      let level = 0;
      for (; level < DEPTH; level += 1) {
        const res = await commitFace(page, ncx, ncy, half, {
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
        half = Math.round(half * 0.7);
      }
      await shot(page, 'deep-nest');
      const reachedDepth = level;
      record('nest-depth-reached', `committed a nesting chain of depth ${reachedDepth}`);

      const countAfterNest = await checkParity(page, 'after-nest');

      // --- REPARENT: arm 所属変更, select the deepest face, then click a different
      //     ancestor as the new parent. The forest must stay valid & count-stable.
      if (await armEditTool(page, 'reparent')) {
        await shot(page, 'reparent-armed');
        // The deepest faces are concentric around (cx,cy). Click near the centre to
        // pick up the smallest (deepest) face, then click further out (a shallower
        // ancestor ring) to retarget its parent. Re-using the live导线 (no bypass).
        await page.mouse.click(ncx, ncy); // pick deepest (centre)
        const selBefore = await activeFeature(page);
        await page.waitForTimeout(90);
        // Click an outer ring offset to nominate a different ancestor.
        await page.mouse.click(ncx + Math.round(half * 1.4), ncy);
        await page.waitForTimeout(120);
        // A reparent may surface a confirm/conflict; recover without crashing.
        if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
          record('reparent-conflict', 'reparent surfaced conflict modal');
          await page.getByTestId('conflict-cancel').click().catch(() => undefined);
        }
        await clearStuckModals(page, 'after-reparent');
        const selAfter = await activeFeature(page);
        if (selBefore !== '' && selAfter === '') {
          record('reparent-lost-selection', `selection lost after reparent (was ${selBefore})`);
        }
        await checkCamera(page, 'after-reparent');
        await shot(page, 'reparented');
        const countAfterReparent = await checkParity(page, 'after-reparent');
        // A reparent is a STRUCTURE move: it must NOT change the feature count
        // (no feature created/destroyed). Single-truth-source must stay consistent.
        if (countAfterReparent !== countAfterNest) {
          record('reparent-count-change', `reparent changed feature count ${countAfterNest} -> ${countAfterReparent} (restructure should be count-stable)`);
        }
      }

      // Anchor ordering on the currently-selected feature.
      await goView(page);
      await showSidebarTab(page, 'properties');
      await checkAnchorOrdering(page, 'after-reparent');

      // =====================================================================
      // B. VERTEX EDIT ON A NESTED INNER RING (edit.vertex).
      // =====================================================================
      if (await armEditTool(page, 'vertex')) {
        await shot(page, 'vertex-armed');
        // Select an inner nested face (centre), then drag a corner of it. The inner
        // faces are concentric; the deepest face corner sits near (cx±halfInner).
        // half currently holds the NEXT (un-committed) shrink; recompute the last
        // committed inner half from the depth reached.
        let innerHalf = 150; // 第7工程: tracks the nest's new L0 half
        for (let i = 1; i < reachedDepth; i += 1) innerHalf = Math.round(innerHalf * 0.7);
        await page.mouse.click(ncx, ncy); // select the deepest face
        const vSelBefore = await activeFeature(page);
        // Grab its top-left corner and drag it inward (smaller) — must stay a valid
        // simple polygon contained by its parent (live validators gate self-cross).
        const vx = ncx - innerHalf;
        const vy = ncy - innerHalf;
        await page.mouse.move(vx, vy);
        await page.mouse.down();
        await page.mouse.move(vx + 18, vy + 18, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(140);
        if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
          record('vertex-conflict', 'vertex drag surfaced conflict modal');
          await page.getByTestId('conflict-cancel').click().catch(() => undefined);
        }
        await clearStuckModals(page, 'after-vertex-drag');
        const vSelAfter = await activeFeature(page);
        if (vSelBefore !== '' && vSelAfter === '') {
          record('vertex-lost-selection', `selection lost after vertex drag (was ${vSelBefore})`);
        }
        await checkCamera(page, 'after-vertex-drag');
        await shot(page, 'vertex-dragged');
        await checkParity(page, 'after-vertex-drag');
        // Try an OUTWARD drag on the same vertex toward the parent edge — a stress
        // that could push it to (or past) containment / self-crossing limits.
        await page.mouse.move(vx + 18, vy + 18);
        await page.mouse.down();
        await page.mouse.move(vx - 40, vy - 40, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(140);
        if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
          record('vertex-conflict-out', 'outward vertex drag surfaced conflict modal');
          await page.getByTestId('conflict-cancel').click().catch(() => undefined);
        }
        await clearStuckModals(page, 'after-vertex-out');
        await checkCamera(page, 'after-vertex-out');
        await shot(page, 'vertex-out');
        await checkParity(page, 'after-vertex-out');
      }

      // =====================================================================
      // C. CONTINUOUS KNIFE SPLITS (3 in a row) → MERGE + UNDO metamorphic.
      // =====================================================================
      const sHalf = 78;
      const sReach = sHalf + 40;
      // 第7工程: RIGHT lane via the shared scene solver — clear of the centred nest
      // AND fully outside the bottom-centre tool-controls strip, so the base's
      // corners and every vertical pierce endpoint land on canvas.
      const splitScene = placeSquareScene(b, {
        fx: 0.9,
        fy: 0.5,
        half: sHalf,
        pierce: sReach,
        avoidTopChrome: true, // knife guide mounts over this scene
        name: 'r2-split-base',
      });
      const sx = splitScene.cx;
      const sy = splitScene.cy;
      const baseRes = await commitFace(page, sx, sy, sHalf, { name: 'split-base' });
      if (baseRes === 'conflict') await page.getByTestId('conflict-cancel').click().catch(() => undefined);
      if (baseRes !== 'committed') {
        record('split-base-not-committed', `split-base outcome=${baseRes} — knife/merge phase cannot run`);
      }
      expect(baseRes, 'split-base must commit so the knife-split×3→merge path is exercised').toBe('committed');
      await shot(page, 'split-base');

      const countBeforeSplit = await checkParity(page, 'before-splits');

      let splitsDone = 0;
      // Three consecutive splits, each on the latest left-most piece. We re-arm the
      // knife each time (a fresh selection per cut) and pierce vertically at a
      // shifting x so each cut lands on a real piece.
      const cutXs = [sx, sx - 36, sx - 18];
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

      // --- UNDO after the last split: undo∘op ≈ identity (count moves back). -----
      if (splitsDone > 0) {
        await armEditTool(page, 'select'); // undo/redo are editing commands (教訓 5.13)
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
        // Metamorphic: undoing the last split should reduce the count by 1 from the
        // post-split total (back toward the pre-cut value).
        if (countAfterUndo >= countAfterSplits) {
          record('undo-no-reduction', `undo did not reduce count: after-splits=${countAfterSplits} after-undo=${countAfterUndo}`);
        } else {
          record('undo-reduced', `undo moved count ${countAfterSplits} -> ${countAfterUndo}`);
        }
        // Redo it back: op∘逆op ≈ identity.
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
        // bughunt3 fix: the 結合 tool now collects targets by click then commits via
        // its OWN 結合を確定 button (data-testid merge-confirm), mirroring the knife's
        // 分断線を確定 (the domain runs validateMergePreconditions at confirm, 教訓 5.26).
        // Click two adjacent split-sibling faces to toggle them into the target set.
        await page.mouse.click(sx - 50, sy + 28);
        await page.waitForTimeout(70);
        await page.mouse.click(sx + 50, sy + 28);
        await page.waitForTimeout(120);
        const mergeConfirm = page.getByTestId('merge-confirm');
        if (
          (await mergeConfirm.isVisible().catch(() => false)) &&
          (await mergeConfirm.isEnabled().catch(() => false))
        ) {
          await mergeConfirm.click().catch(() => undefined);
          await page.waitForTimeout(220);
          // FR-52: merge-confirm opens the options dialog; 確定 with the seeded
          // defaults runs the merge (this probe asserts the count drops below).
          await confirmMergeOptions(page);
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
      // D. LONG TIMELINE PLAYBACK + ANCHOR ORDERING.
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
        for (let i = 0; i < 16; i += 1) {
          await page.waitForTimeout(250);
          const t = ((await cur.textContent().catch(() => '')) ?? '').trim();
          if (/NaN|Infinity|undefined/.test(t)) {
            record('timeline-current-malformed', `play sample ${i}="${t}"`);
          }
          const y = parseYear(t);
          if (Number.isFinite(y)) samples.push(y);
          if (i === 7) await shot(page, 'playback-mid');
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
            record('playback-no-advance', `timeline-current did not advance during ~4s play (stayed ${first})`);
          }
        }
        const after = ((await cur.textContent().catch(() => '')) ?? '').trim();
        if (/NaN|Infinity|undefined/.test(after)) record('timeline-current-malformed', `post-pause="${after}"`);
      } else {
        record('playback-control-missing', 'timeline-playback control not visible');
      }
      await checkCamera(page, 'after-playback');

      // Anchor ordering on the selected feature after the playback scrub.
      await goView(page);
      await showSidebarTab(page, 'properties');
      await checkAnchorOrdering(page, 'after-playback');

      // =====================================================================
      // E. LARGE-COUNT PAN/ZOOM/DRAW PERF + UNDO STORM.
      // =====================================================================
      const countBeforeGrid = await checkParity(page, 'before-grid');

      // 第7工程: the grid lives in the TOP-LEFT band — clear of the centred nest, the
      // right-lane split scene, and the bottom-centre controls strip — so every cell's
      // corner clicks land on canvas. 24 cells preserved (perf 規模は不変); STEP/HALF
      // shrink only the geometry (still non-overlapping: STEP > 2×HALF).
      const HALF = 18;
      const STEP = 50;
      const COLS = 6;
      const ROWS = 4;
      const gx0 = b.x + SCENE_MARGIN + HALF + 2;
      const gy0 = b.y + SCENE_MARGIN + HALF + 6;
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
          if ((r * COLS + c) % 8 === 0) await checkCamera(page, `grid-${r}-${c}`);
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
        if (dt > 4000) record('perf-slow-leg', `${label} took ${dt}ms with ${countAfterGrid} features`);
        await checkCamera(page, `perf-${label}`);
      };

      await timeLeg('zoom-in', async () => {
        for (let i = 0; i < 18; i += 1) {
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
        await pan(600, 0);
        await pan(-1200, 0);
        await pan(0, 600);
        await pan(0, -1200);
      });
      await shot(page, 'perf-panned');

      await timeLeg('zoom-out', async () => {
        for (let i = 0; i < 24; i += 1) {
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
      for (let i = 0; i < 12; i += 1) {
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
      // After an undo storm the dirty flag may be either state; only flag if the
      // diagnostics value is malformed (the real invariant is single-source sanity).
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

      // Final parity + camera + selection.
      const finalList = await checkParity(page, 'final');
      await checkCamera(page, 'final');
      await activeFeature(page);
      await shot(page, 'final');

      void countAfterNest;
      void finalList;
      console.log(`BUGHUNT_SUMMARY: ${JSON.stringify(anomalies)}`);
      await expect(page.getByTestId('app-shell')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
