// BUGHUNT T2 (explore-t2-r1) — e2e exploration (discovery-only). Drives the REAL
// built Electron composite "like a user" through an operation plan deliberately
// UNTOUCHED by explore-r1..r4 / explore2-r1..r4 / explore3-r1..r4.
//
// Prior rounds covered: deep nest (≤8), multi-hole exclave, reparent (leaf + hole),
// knife split×5, chained merge, ~10s playback + step storm, 60-feature grid perf,
// undo storm, save/load reachability. They asserted count metamorphics on SPLIT
// (undo∘op / op∘逆op) but NOT on reparent or merge, and never:
//   - drove a TIME SCRUB across a dense scene to gate diag-count / NaN coherence,
//   - attempted a reparent CYCLE (self / descendant as parent → must be rejected:
//     forest must stay a TREE, no cycle),
//   - knifed a feature that is itself a deeply-NESTED CHILD (split inside hierarchy),
//   - exercised merge→undo→redo (op∘逆op on MERGE),
//   - exercised reparent→undo→redo (op∘逆op on REPARENT),
//   - probed save→load IDENTITY via the dirty-flag transition (save clears あり→なし).
//
// THIS round (t2-r1) pushes those NEW导线:
//
//   A. DEEP NESTED CHAIN (depth 5) then KNIFE-SPLIT A NESTED MIDDLE CHILD (not a
//      root) — a split applied to a feature that has both an ancestor AND a
//      descendant. Gate: +1 feature; coords finite; list==diag-at-time; selection
//      valid; anchor rows ascending. Then UNDO (−1) and REDO (+1) — split
//      metamorphic re-confirmed on a NESTED owner.
//
//   B. REPARENT a nested child to a different ancestor, then UNDO and REDO —
//      op∘逆op identity on REPARENT (count-stable both ways; selection valid).
//
//   C. REPARENT CYCLE PROBE: arm reparent, pick a PARENT node as target, then click
//      its OWN DESCENDANT as the new parent. A tree must reject this (confirm
//      disabled OR a message). If confirm becomes enabled AND firing it does not
//      surface a guard, that is a cycle-introduction bug → finding. Gate: count
//      unchanged; no console.error; structure still a forest (list==diag).
//
//   D. MERGE two sibling slivers, then UNDO and REDO — op∘逆op identity on MERGE.
//
//   E. TIME SCRUB across a dense scene: place a small grid, then drag the timeline
//      slider / step across many positions and gate at EACH stop: timeline-current
//      finite & non-NaN; diagnostics-feature-count finite & ≥0 & monotone-sane;
//      camera coords finite; selection valid; no console.error.
//
//   F. SAVE→LOAD IDENTITY PROBE (no native dialog): make the project dirty, read
//      diagnostics-unsaved==あり, invoke ファイル→保存 reachability, and confirm the
//      dirty flag + feature parity stay coherent (the round-trip seam fires without
//      a console.error / NaN).
//
// STRICT GATE: any console.error, React warning, unhandled rejection, or
// NaN/Infinity in the live data-* hooks / readouts is recorded as a finding (the
// test does NOT crash on them). Anomalies surface via console.log("BUGHUNT:...")
// and a final BUGHUNT_SUMMARY JSON line. Each step screenshots into
// screenshots/__bughunt__/t2-1-*.png (read back for visual anomaly判定).
//
// INVARIANTS gated after each op (recorded, not crashed):
//   - 座標に NaN/Infinity 無し (data-pan-x/y, data-zoom; active-vertex)
//   - 選択が常に有効 (active-feature id: no NaN/undefined/null)
//   - 階層森: 地物一覧(@currentTime) coherent with 診断 feature-count(@currentTime)
//   - 錨列の昇順・非重複 (anchor rows time-sorted, non-overlapping, NaN-free)
//   - knife split: +1; merge: -1; reparent: count-stable; undo∘op back; op∘逆op restore
//   - time scrub: timeline-current monotone-sane & finite; diag-count finite ≥0
//   - reparent cycle: rejected (tree stays acyclic)
//   - save: dirty flag transition coherent (no native dialog)

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
  const file = resolve(shotDir, `t2-1-${n}-${label}.png`);
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
    if (text.startsWith('BUGHUNT')) return;
    if (type === 'error') record('console.error', text);
    else if (type === 'warning') {
      if (/Warning:|React|Each child|deprecated|act\(/i.test(text)) record('react.warning', text);
      else record('console.warning', text);
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
  const t = ((await page.getByTestId('app-active-feature').textContent().catch(() => '')) ?? '').trim();
  if (/NaN|undefined|null|Infinity/.test(t)) record('selection-malformed', `active-feature="${t}"`);
  return t;
}

async function leaveView(page: Page): Promise<void> {
  const v = page.getByTestId('mode-view');
  if ((await v.getAttribute('aria-pressed')) === 'true') await v.click();
}
async function goView(page: Page): Promise<void> {
  const v = page.getByTestId('mode-view');
  if ((await v.getAttribute('aria-pressed')) !== 'true') await v.click().catch(() => undefined);
  await page.getByTestId('add-input-layer').waitFor({ state: 'detached', timeout: 4000 }).catch(() => undefined);
}
async function showSidebarTab(page: Page, key: 'events' | 'features' | 'properties'): Promise<void> {
  const tab = page.getByTestId(`sidebar-tab-${key}`);
  if (await tab.isVisible().catch(() => false)) await tab.click().catch(() => undefined);
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
    record('menu-item-disabled', `${commandId} is disabled`);
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

// list(@currentTime) vs diag(@currentTime) — both are evaluated at currentTime, so
// they should agree when the view is on the same time. A mismatch is a真実源 desync.
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
    if (/NaN|Infinity|undefined/.test(txt)) record('anchor-row-malformed', `${where}: row ${i} text="${txt}"`);
    const m = txt.match(/-?\d+/);
    if (m) starts.push(Number(m[0]));
  }
  for (let i = 1; i < starts.length; i += 1) {
    const prev = starts[i - 1];
    const cur = starts[i];
    if (prev === undefined || cur === undefined) continue;
    if (cur < prev) {
      record('anchor-order-violation', `${where}: starts not ascending: ${prev} then ${cur}`);
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
    record('add-complete-disabled', `complete disabled (vertices=${vcText}) at (${Math.round(cx)},${Math.round(cy)})`);
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
      if (last !== undefined) await parent.selectOption(last).catch(() => undefined);
      else record('add-parent-no-option', 'add-parent had no selectable (non-root) option');
    } else {
      record('add-parent-missing', 'add-parent select not present for a face add');
    }
  }
  if (opts?.name !== undefined) await page.getByTestId('add-name').fill(opts.name).catch(() => undefined);
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

// Knife-split a feature centred at (kx,ky) with a vertical pierce.
async function knifeSplitVertical(
  page: Page,
  kx: number,
  ky: number,
  reach: number,
  name: string,
): Promise<'split' | 'no-confirm' | 'no-modal' | 'no-form'> {
  await page.mouse.click(kx, ky);
  await page.waitForTimeout(70);
  await page.mouse.click(kx, ky - reach);
  await page.mouse.click(kx, ky + reach);
  const cc = page.getByTestId('knife-confirm-cut');
  if (!(await cc.isVisible().catch(() => false))) return 'no-confirm';
  await cc.click();
  await page.waitForTimeout(140);
  if ((await page.getByTestId('knife-inheritor-modal-root').count()) === 0) return 'no-modal';
  await page.getByTestId('knife-choose-a').click().catch(() => undefined);
  await page.getByTestId('knife-confirm-inheritor').click().catch(() => undefined);
  await page.waitForTimeout(120);
  const form = page.getByTestId('add-property-form');
  if (!(await form.isVisible().catch(() => false))) return 'no-form';
  await page.getByTestId('add-name').fill(name).catch(() => undefined);
  await page.getByTestId('add-save').click();
  await page.waitForTimeout(220);
  if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
    record('knife-conflict-after-split', `split "${name}" paused on conflict modal`);
    await page.getByTestId('conflict-cancel').click().catch(() => undefined);
  }
  return 'split';
}

test.describe('BUGHUNT T2-R1 — nested-child knife + undo/redo / reparent op∘逆op / reparent cycle probe / merge op∘逆op / time-scrub coherence / save dirty-flag', () => {
  test('explore-t2-r1: split a nested middle child (undo/redo), reparent undo/redo, reparent-cycle rejection, merge undo/redo, dense time-scrub NaN gate, save dirty-flag round-trip', async () => {
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

      // =====================================================================
      // A. DEEP NESTED CHAIN (depth 5), then KNIFE A NESTED MIDDLE CHILD.
      // =====================================================================
      const c0 = await checkParity(page, 'before-nest');
      const DEPTH = 5;
      let half = 230;
      let level = 0;
      const halves: number[] = [];
      for (; level < DEPTH; level += 1) {
        halves.push(half);
        const res = await commitFace(page, cx, cy, half, { chooseLastParent: level > 0, name: `t2-L${level}` });
        if (res !== 'committed') {
          record('nest-stop', `level ${level} (half=${half}) outcome=${res}`);
          break;
        }
        await activeFeature(page);
        await checkCamera(page, `nest-L${level}`);
        const list = await checkParity(page, `nest-L${level}`);
        if (list !== c0 + level + 1) record('nest-count', `level ${level}: expected ${c0 + level + 1}, got ${list}`);
        half = Math.round(half * 0.74);
      }
      const reached = level;
      record('nest-depth-reached', `nested chain depth ${reached}`);
      await shot(page, 'deep-nest');
      await goView(page);
      await showSidebarTab(page, 'properties');
      await checkAnchorOrdering(page, 'after-nest');

      // Knife a MIDDLE child: pick a mid-level half so the cut owner has both an
      // ancestor and descendants. Use level index 2 (3rd ring) if reached >= 4.
      if (reached >= 4) {
        const midHalf = halves[2] ?? 120;
        const reach = midHalf + 40;
        const beforeSplit = await checkParity(page, 'before-nested-split');
        if (await armEditTool(page, 'knife')) {
          await page.getByTestId('knife-tool').waitFor({ state: 'attached', timeout: 4000 }).catch(() => {
            record('knife-chrome-missing', 'knife-tool chrome did not mount (nested split)');
          });
          // Click a point inside the mid ring but OUTSIDE the deeper child so the
          // owner under the pointer is the middle child, then pierce it.
          const px = cx + Math.round((midHalf + (halves[3] ?? midHalf * 0.74)) / 2 / 2);
          const r = await knifeSplitVertical(page, px, cy, reach, 'nested-split');
          await shot(page, 'nested-split');
          record('nested-knife', `nested middle-child split outcome=${r}`);
          await checkCamera(page, 'after-nested-split');
          await clearStuckModals(page, 'after-nested-split');
          const afterSplit = await checkParity(page, 'after-nested-split');
          if (r === 'split' && afterSplit !== beforeSplit + 1) {
            record('nested-split-count', `expected ${beforeSplit + 1}, got ${afterSplit}`);
          }
          // undo∘op then op∘逆op on a NESTED owner.
          if (r === 'split') {
            await armEditTool(page, 'select');
            await page.keyboard.press('Control+z');
            await page.waitForTimeout(180);
            const afterUndo = await checkParity(page, 'after-nested-split-undo');
            if (afterUndo !== beforeSplit) {
              record('nested-split-undo', `undo did not restore: expected ${beforeSplit}, got ${afterUndo}`);
            }
            await page.keyboard.press('Control+y').catch(() => undefined);
            await page.waitForTimeout(180);
            const afterRedo = await checkParity(page, 'after-nested-split-redo');
            if (afterRedo !== afterSplit) {
              record('nested-split-redo', `redo did not restore: expected ${afterSplit}, got ${afterRedo}`);
            }
          }
        }
      } else {
        record('nest-too-shallow', `reached depth ${reached} (<4); skipping nested-child knife`);
      }

      // =====================================================================
      // B. REPARENT a nested child elsewhere, then UNDO + REDO (op∘逆op).
      //    Build a separate small parent + child far from the nest cluster.
      // =====================================================================
      const rpHalf = 150;
      const rpReach = rpHalf + 30;
      const rpCx = Math.max(b.x + rpReach + 12, Math.min(b.x + b.width - rpReach - 12, cx - 300));
      const rpCy = Math.min(b.y + b.height - rpReach - 12, Math.max(b.y + rpReach + 12, cy + 250));
      const rpParent = await commitFace(page, rpCx, rpCy, rpHalf, { name: 't2-rp-parent' });
      if (rpParent === 'conflict') await page.getByTestId('conflict-cancel').click().catch(() => undefined);
      const rpChildPt: readonly [number, number] = [rpCx, rpCy];
      let rpChild: 'committed' | 'rejected' | 'conflict' = 'rejected';
      if (rpParent === 'committed') {
        rpChild = await commitFace(page, rpChildPt[0], rpChildPt[1], 36, { chooseLastParent: true, name: 't2-rp-child' });
        if (rpChild === 'conflict') await page.getByTestId('conflict-cancel').click().catch(() => undefined);
      }
      await shot(page, 'reparent-built');
      const beforeReparent = await checkParity(page, 'before-reparent');

      if (rpChild === 'committed' && (await armEditTool(page, 'reparent'))) {
        await page.mouse.click(rpChildPt[0], rpChildPt[1]); // target = child
        await page.waitForTimeout(90);
        const tgt = ((await page.getByTestId('reparent-target').textContent().catch(() => '')) ?? '').trim();
        if (tgt === '') record('reparent-no-target', 'reparent-target empty after clicking child');
        else if (/NaN|Infinity|undefined|null/.test(tgt)) record('reparent-target-malformed', `target="${tgt}"`);
        // New parent = nest cluster centre (different subtree).
        await page.mouse.click(cx, cy);
        await page.waitForTimeout(120);
        const par = ((await page.getByTestId('reparent-parent').textContent().catch(() => '')) ?? '').trim();
        if (/NaN|Infinity/.test(par)) record('reparent-parent-malformed', `parent="${par}"`);
        const confirm = page.getByTestId('reparent-confirm');
        const enabled = (await confirm.isVisible().catch(() => false)) && (await confirm.isEnabled().catch(() => false));
        record('reparent-confirm-state', `enabled=${enabled} target="${tgt}" parent="${par}"`);
        if (enabled) {
          await confirm.click().catch(() => undefined);
          await page.waitForTimeout(160);
          await clearStuckModals(page, 'after-reparent');
          const afterReparent = await checkParity(page, 'after-reparent');
          if (afterReparent !== beforeReparent) {
            record('reparent-count-change', `reparent changed count ${beforeReparent} -> ${afterReparent}`);
          }
          await shot(page, 'reparented');
          // op∘逆op on REPARENT: undo then redo, count-stable both ways, selection valid.
          await armEditTool(page, 'select');
          await page.keyboard.press('Control+z');
          await page.waitForTimeout(180);
          await activeFeature(page);
          const afterRpUndo = await checkParity(page, 'after-reparent-undo');
          if (afterRpUndo !== beforeReparent) {
            record('reparent-undo-count', `reparent undo changed count to ${afterRpUndo} (expected ${beforeReparent})`);
          }
          await page.keyboard.press('Control+y').catch(() => undefined);
          await page.waitForTimeout(180);
          await activeFeature(page);
          const afterRpRedo = await checkParity(page, 'after-reparent-redo');
          if (afterRpRedo !== beforeReparent) {
            record('reparent-redo-count', `reparent redo changed count to ${afterRpRedo}`);
          }
        }
      }

      // =====================================================================
      // C. REPARENT CYCLE PROBE — target a parent, then click its OWN descendant
      //    as the new parent. A tree MUST reject (confirm disabled or message).
      // =====================================================================
      const beforeCycle = await checkParity(page, 'before-cycle');
      if (reached >= 3 && (await armEditTool(page, 'reparent'))) {
        // Target = an OUTER nest ring (click near its edge, away from inner rings).
        const outerHalf = halves[0] ?? 230;
        const outerEdgeX = cx + Math.round((outerHalf + (halves[1] ?? outerHalf * 0.74)) / 2);
        await page.mouse.click(outerEdgeX, cy); // target = outer-ish ancestor
        await page.waitForTimeout(90);
        const tgt = ((await page.getByTestId('reparent-target').textContent().catch(() => '')) ?? '').trim();
        // New parent = the DEEPEST ring centre (a descendant of the target).
        await page.mouse.click(cx, cy);
        await page.waitForTimeout(120);
        const par = ((await page.getByTestId('reparent-parent').textContent().catch(() => '')) ?? '').trim();
        const msg = ((await page.getByTestId('reparent-message').textContent().catch(() => '')) ?? '').trim();
        const confirm = page.getByTestId('reparent-confirm');
        const enabled = (await confirm.isVisible().catch(() => false)) && (await confirm.isEnabled().catch(() => false));
        record('cycle-probe-state', `target="${tgt}" descendant-as-parent="${par}" confirm-enabled=${enabled} message="${msg}"`);
        // If target and parent resolved to an ancestor/descendant pair and confirm
        // is ENABLED, firing it must NOT silently create a cycle. We fire and then
        // gate parity (a cycle would typically desync list vs diag or throw).
        if (enabled && tgt !== '' && par !== '' && tgt !== par) {
          await confirm.click().catch(() => undefined);
          await page.waitForTimeout(160);
          const after = await checkParity(page, 'after-cycle-attempt');
          if (after !== beforeCycle) {
            record('cycle-count-change', `cycle attempt changed count ${beforeCycle} -> ${after}`);
          }
          record('cycle-attempt-fired', 'confirm was enabled for descendant-as-parent; fired and gated parity (potential cycle bug if no guard)');
          await clearStuckModals(page, 'after-cycle');
        } else {
          record('cycle-rejected', `descendant-as-parent correctly not confirmable (enabled=${enabled})`);
          await page.getByTestId('reparent-cancel').click().catch(() => undefined);
        }
        await shot(page, 'cycle-probe');
      }

      // =====================================================================
      // D. MERGE two sibling slivers, then UNDO + REDO (op∘逆op on MERGE).
      //    Build a base face, knife it once, then merge the two halves back.
      // =====================================================================
      const mHalf = 95;
      const mReach = mHalf + 45;
      const mx = Math.max(b.x + mReach + 12, Math.min(b.x + b.width - mReach - 12, cx + 320));
      const my = Math.min(b.y + b.height - mReach - 12, Math.max(b.y + mReach + 12, cy + 250));
      const mBase = await commitFace(page, mx, my, mHalf, { name: 't2-merge-base' });
      if (mBase === 'conflict') await page.getByTestId('conflict-cancel').click().catch(() => undefined);
      await shot(page, 'merge-base');
      if (mBase === 'committed') {
        // One split → two halves.
        let splitOk = false;
        if (await armEditTool(page, 'knife')) {
          const r = await knifeSplitVertical(page, mx, my, mReach, 't2-merge-half');
          splitOk = r === 'split';
          if (!splitOk) record('merge-prep-split', `split-for-merge outcome=${r}`);
          await clearStuckModals(page, 'after-merge-prep-split');
        }
        const beforeMerge = await checkParity(page, 'before-merge');
        if (splitOk && (await armEditTool(page, 'merge'))) {
          await shot(page, 'merge-armed');
          await page.mouse.click(mx - 40, my);
          await page.waitForTimeout(70);
          await page.mouse.click(mx + 40, my);
          await page.waitForTimeout(120);
          const tc = ((await page.getByTestId('merge-target-count').textContent().catch(() => '')) ?? '').trim();
          record('merge-target-count', `merge target-count="${tc}"`);
          const mc = page.getByTestId('merge-confirm');
          if ((await mc.isVisible().catch(() => false)) && (await mc.isEnabled().catch(() => false))) {
            await mc.click().catch(() => undefined);
            await page.waitForTimeout(220);
            await clearStuckModals(page, 'after-merge');
            const afterMerge = await checkParity(page, 'after-merge');
            await shot(page, 'merged');
            if (afterMerge >= beforeMerge) {
              record('merge-no-reduction', `merge did not reduce: before=${beforeMerge} after=${afterMerge}`);
            } else {
              record('merge-reduced', `merge ${beforeMerge} -> ${afterMerge}`);
              // op∘逆op on MERGE: undo restores split count, redo re-merges.
              await armEditTool(page, 'select');
              await page.keyboard.press('Control+z');
              await page.waitForTimeout(180);
              const afterMergeUndo = await checkParity(page, 'after-merge-undo');
              if (afterMergeUndo !== beforeMerge) {
                record('merge-undo-count', `merge undo did not restore: expected ${beforeMerge}, got ${afterMergeUndo}`);
              }
              await page.keyboard.press('Control+y').catch(() => undefined);
              await page.waitForTimeout(180);
              const afterMergeRedo = await checkParity(page, 'after-merge-redo');
              if (afterMergeRedo !== afterMerge) {
                record('merge-redo-count', `merge redo did not restore: expected ${afterMerge}, got ${afterMergeRedo}`);
              }
            }
          } else {
            const msg = ((await page.getByTestId('merge-message').textContent().catch(() => '')) ?? '').trim();
            record('merge-not-confirmable', `merge-confirm not enabled; message="${msg}"`);
          }
        }
      }
      await checkCamera(page, 'after-merge-phase');

      // =====================================================================
      // E. DENSE TIME SCRUB — small grid, then step time across many stops and
      //    gate finiteness + diag-count sanity at each.
      // =====================================================================
      const HALF = 14;
      const STEP = 46;
      const COLS = 6;
      const ROWS = 3;
      const gx0 = cx - ((COLS - 1) * STEP) / 2;
      const gy0 = b.y + 60;
      let placed = 0;
      for (let r = 0; r < ROWS; r += 1) {
        for (let c = 0; c < COLS; c += 1) {
          const res = await commitFace(page, gx0 + c * STEP, gy0 + r * STEP, HALF, { name: `t2-grid-${r}-${c}` });
          if (res === 'committed') placed += 1;
          else if (res === 'conflict') await page.getByTestId('conflict-cancel').click().catch(() => undefined);
        }
      }
      record('grid-placed', `placed ${placed}/${COLS * ROWS} grid faces`);
      await shot(page, 'grid-placed');

      await goView(page);
      const stepFwd = page.getByRole('button', { name: /次へ進む/ }).first();
      const stepBack = page.getByRole('button', { name: /前へ戻る/ }).first();
      const cur = page.getByTestId('timeline-current');
      const fwdVisible = await stepFwd.isVisible().catch(() => false);
      if (fwdVisible) {
        const diagSeen: number[] = [];
        const timeSeen: number[] = [];
        const parseYear = (t: string): number => {
          const m = t.match(/-?\d+/);
          return m ? Number(m[0]) : Number.NaN;
        };
        for (let i = 0; i < 14; i += 1) {
          await stepFwd.click().catch(() => undefined);
          await page.waitForTimeout(80);
          const t = ((await cur.textContent().catch(() => '')) ?? '').trim();
          if (/NaN|Infinity|undefined/.test(t)) record('timeline-step-malformed', `fwd ${i} current="${t}"`);
          const y = parseYear(t);
          if (Number.isFinite(y)) timeSeen.push(y);
          await checkCamera(page, `scrub-fwd-${i}`);
          // Sample diag count at a few stops (each opens/closes the panel → costly,
          // so only every 4th stop).
          if (i % 4 === 0) {
            const dc = await diagFeatureCount(page);
            if (!Number.isFinite(dc) || dc < 0) record('scrub-diag-bad', `fwd ${i}: diag-count=${dc}`);
            else diagSeen.push(dc);
            await activeFeature(page);
          }
        }
        for (let i = 0; i < 14; i += 1) {
          await stepBack.click().catch(() => undefined);
          await page.waitForTimeout(80);
          const t = ((await cur.textContent().catch(() => '')) ?? '').trim();
          if (/NaN|Infinity|undefined/.test(t)) record('timeline-step-malformed', `back ${i} current="${t}"`);
          if (i % 6 === 0) await checkCamera(page, `scrub-back-${i}`);
        }
        // Forward stepping should be non-decreasing in time (clamps allowed).
        let regressions = 0;
        for (let i = 1; i < timeSeen.length; i += 1) {
          const prev = timeSeen[i - 1];
          const c2 = timeSeen[i];
          if (prev !== undefined && c2 !== undefined && c2 < prev) regressions += 1;
        }
        if (regressions > 0) record('scrub-non-monotone', `fwd time regressed ${regressions}×: ${JSON.stringify(timeSeen)}`);
        record('scrub-diag-samples', `diag counts during scrub: ${JSON.stringify(diagSeen)}`);
        await shot(page, 'time-scrubbed');
      } else {
        record('timeline-step-missing', 'step-forward button not visible');
      }
      await goView(page);
      await showSidebarTab(page, 'properties');
      await checkAnchorOrdering(page, 'after-scrub');

      // =====================================================================
      // F. SAVE DIRTY-FLAG ROUND-TRIP (no native dialog).
      // =====================================================================
      const unsavedNow = await diagUnsaved(page);
      if (unsavedNow !== 'あり') record('expected-dirty', `after edits unsaved="${unsavedNow}" (expected あり)`);
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
      record('final', `final list=${finalList} current-time="${finalTime}"`);
      await shot(page, 'final');

      console.log(`BUGHUNT_SUMMARY: ${JSON.stringify(anomalies)}`);
      await expect(page.getByTestId('app-shell')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  // ISOLATION PROBE: confirm/refute the merge-redo & reparent metamorphic signals
  // WITHOUT any menu navigation between ops (the diagnostics panel + menu toggles
  // in the main run could confound history focus). Uses ONLY the live history hooks
  // (app-can-undo / app-can-redo) and the sidebar feature-list count.
  test('explore-t2-r1-iso: merge op∘逆op and reparent op∘逆op using only live history hooks (no menu nav between ops)', async () => {
    test.setTimeout(600_000);
    const { app, page } = await launchApp();
    attachListeners(page);
    const isoAnoms: Anomaly[] = [];
    const rec = (k: string, d: string): void => {
      isoAnoms.push({ kind: k, detail: d });
      console.log(`BUGHUNT:${k}: ${d}`);
    };
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      const inputLayer = page.getByTestId('map-input-layer');
      const box = await inputLayer.boundingBox();
      expect(box).not.toBeNull();
      const b = box!;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;

      const listCount = async (): Promise<number> => {
        await goView(page);
        await showSidebarTab(page, 'features');
        return featureListCount(page);
      };
      const canUndo = page.getByTestId('app-can-undo');
      const canRedo = page.getByTestId('app-can-redo');
      const u = async (): Promise<string> => ((await canUndo.textContent()) ?? '').trim();
      const r = async (): Promise<string> => ((await canRedo.textContent()) ?? '').trim();

      // --- MERGE op∘逆op, hook-only -----------------------------------------
      const mHalf = 100;
      const mReach = mHalf + 45;
      const mx = cx;
      const my = cy;
      const base = await commitFace(page, mx, my, mHalf, { name: 'iso-merge-base' });
      expect(base).toBe('committed');
      let splitOk = false;
      if (await armEditTool(page, 'knife')) {
        const sr = await knifeSplitVertical(page, mx, my, mReach, 'iso-half');
        splitOk = sr === 'split';
        await clearStuckModals(page, 'iso-after-split');
      }
      if (!splitOk) {
        rec('iso-merge-prep-failed', 'could not split base for merge probe');
      } else {
        const afterSplit = await listCount();
        rec('iso-after-split-count', `count after split = ${afterSplit}`);
        if (await armEditTool(page, 'merge')) {
          await page.mouse.click(mx - 45, my);
          await page.waitForTimeout(70);
          await page.mouse.click(mx + 45, my);
          await page.waitForTimeout(120);
          const mc = page.getByTestId('merge-confirm');
          if ((await mc.isVisible().catch(() => false)) && (await mc.isEnabled().catch(() => false))) {
            await mc.click().catch(() => undefined);
            await page.waitForTimeout(220);
            await clearStuckModals(page, 'iso-after-merge');
            const afterMerge = await listCount();
            rec('iso-after-merge-count', `count after merge = ${afterMerge}`);
            // Switch to select, then undo/redo via hooks ONLY (no menu in between).
            await armEditTool(page, 'select');
            const uBeforeUndo = await u();
            await page.keyboard.press('Control+z');
            await page.waitForTimeout(200);
            const afterUndo = await featureListCount(page); // sidebar already on features
            const redoAvail = await r();
            rec('iso-merge-undo', `canUndo(before)=${uBeforeUndo} afterUndo count=${afterUndo} canRedo=${redoAvail}`);
            if (afterUndo !== afterSplit) {
              rec('iso-merge-undo-count', `merge undo expected ${afterSplit}, got ${afterUndo}`);
            }
            if (redoAvail !== '1') {
              rec('iso-merge-redo-unavailable', `after undo of merge, canRedo=${redoAvail} (expected 1)`);
            }
            await page.keyboard.press('Control+y');
            await page.waitForTimeout(200);
            const afterRedo = await featureListCount(page);
            rec('iso-merge-redo', `afterRedo count=${afterRedo} (merge result was ${afterMerge})`);
            if (afterRedo !== afterMerge) {
              rec('iso-merge-redo-count', `merge REDO did not reapply: expected ${afterMerge}, got ${afterRedo}`);
            }
          } else {
            rec('iso-merge-not-confirmable', 'merge-confirm not enabled in iso probe');
          }
        }
      }

      // --- REPARENT op∘逆op, hook-only --------------------------------------
      // Build a fresh parent + child away from the merge cluster.
      const pHalf = 130;
      const pReach = pHalf + 30;
      const pcx = Math.max(b.x + pReach + 12, Math.min(b.x + b.width - pReach - 12, cx - 330));
      const pcy = Math.min(b.y + b.height - pReach - 12, Math.max(b.y + pReach + 12, cy - 240));
      const par = await commitFace(page, pcx, pcy, pHalf, { name: 'iso-rp-parent' });
      // A SECOND independent parent to receive the child (sibling subtree, not a
      // descendant — a clean legal reparent that must be count-stable).
      const qcx = Math.max(b.x + pReach + 12, Math.min(b.x + b.width - pReach - 12, cx + 330));
      const qcy = pcy;
      const par2 = await commitFace(page, qcx, qcy, pHalf, { name: 'iso-rp-parent2' });
      let child: 'committed' | 'rejected' | 'conflict' = 'rejected';
      if (par === 'committed') {
        child = await commitFace(page, pcx, pcy, 34, { chooseLastParent: true, name: 'iso-rp-child' });
        if (child === 'conflict') await page.getByTestId('conflict-cancel').click().catch(() => undefined);
      }
      if (child !== 'committed' || par2 !== 'committed') {
        rec('iso-reparent-prep', `prep incomplete: parent=${par} parent2=${par2} child=${child}`);
      } else {
        const beforeRp = await listCount();
        if (await armEditTool(page, 'reparent')) {
          await page.mouse.click(pcx, pcy); // target = child (sits at parent centre)
          await page.waitForTimeout(90);
          const tgt = ((await page.getByTestId('reparent-target').textContent().catch(() => '')) ?? '').trim();
          await page.mouse.click(qcx, qcy); // new parent = the SECOND parent (sibling subtree)
          await page.waitForTimeout(120);
          const np = ((await page.getByTestId('reparent-parent').textContent().catch(() => '')) ?? '').trim();
          const confirm = page.getByTestId('reparent-confirm');
          const enabled = (await confirm.isVisible().catch(() => false)) && (await confirm.isEnabled().catch(() => false));
          rec('iso-reparent-state', `target="${tgt}" newParent="${np}" enabled=${enabled}`);
          if (enabled) {
            await confirm.click().catch(() => undefined);
            await page.waitForTimeout(200);
            const sawConflict = (await page.getByTestId('conflict-modal-root').count()) > 0;
            if (sawConflict) {
              rec('iso-reparent-conflict', 'legal sibling-subtree reparent surfaced a conflict modal');
              await page.getByTestId('conflict-cancel').click().catch(() => undefined);
            }
            const afterRp = await listCount();
            rec('iso-reparent-count', `before=${beforeRp} after=${afterRp} conflict=${sawConflict}`);
            if (!sawConflict && afterRp !== beforeRp) {
              rec('iso-reparent-count-change', `reparent changed count ${beforeRp} -> ${afterRp}`);
            }
            await armEditTool(page, 'select');
            await page.keyboard.press('Control+z');
            await page.waitForTimeout(200);
            const afterRpUndo = await featureListCount(page);
            const redoAvail = await r();
            rec('iso-reparent-undo', `afterUndo=${afterRpUndo} canRedo=${redoAvail}`);
            await page.keyboard.press('Control+y');
            await page.waitForTimeout(200);
            const afterRpRedo = await featureListCount(page);
            rec('iso-reparent-redo', `afterRedo=${afterRpRedo}`);
          } else {
            rec('iso-reparent-not-enabled', `confirm not enabled target="${tgt}" newParent="${np}"`);
            await page.getByTestId('reparent-cancel').click().catch(() => undefined);
          }
        }
      }

      console.log(`BUGHUNT_ISO_SUMMARY: ${JSON.stringify(isoAnoms)}`);
      await expect(page.getByTestId('app-shell')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  // FOCUSED PROBE: does opening/closing a read-only help modal (diagnostics) or a
  // menu BETWEEN an undo and a redo destroy the redo stack? In the main run, a
  // checkParity (which opens diagnostics) sat between undo and redo and the redo
  // failed to reapply; the iso probe (no menu between) redid fine. This pins the
  // cause: commit→undo→[open+close diagnostics]→redo, asserting redo still works.
  test('explore-t2-r1-modal-redo: a read-only diagnostics modal between undo and redo must NOT clear the redo stack', async () => {
    test.setTimeout(300_000);
    const { app, page } = await launchApp();
    attachListeners(page);
    const out: Anomaly[] = [];
    const rec = (k: string, d: string): void => {
      out.push({ kind: k, detail: d });
      console.log(`BUGHUNT:${k}: ${d}`);
    };
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      const inputLayer = page.getByTestId('map-input-layer');
      const box = await inputLayer.boundingBox();
      expect(box).not.toBeNull();
      const b = box!;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const canRedo = page.getByTestId('app-can-redo');
      const r = async (): Promise<string> => ((await canRedo.textContent()) ?? '').trim();
      const count = async (): Promise<number> => {
        await goView(page);
        await showSidebarTab(page, 'features');
        return featureListCount(page);
      };

      // Commit two faces so we have undoable history.
      await commitFace(page, cx - 120, cy, 60, { name: 'mr-a' });
      await commitFace(page, cx + 120, cy, 60, { name: 'mr-b' });
      const afterCommits = await count();
      rec('mr-after-commits', `count=${afterCommits}`);

      await armEditTool(page, 'select');
      await page.keyboard.press('Control+z'); // undo the 2nd commit
      await page.waitForTimeout(200);
      const afterUndo = await featureListCount(page);
      const redoBeforeModal = await r();
      rec('mr-after-undo', `count=${afterUndo} canRedo=${redoBeforeModal}`);
      expect(redoBeforeModal).toBe('1');

      // Open + close the read-only diagnostics modal (a pure viewer — must not touch history).
      if (await clickMenuCommand(page, 'help', 'help.diagnostics')) {
        await expect(page.getByTestId('diagnostics-panel')).toBeVisible();
        await page.getByTestId('diagnostics-panel-close').click().catch(() => undefined);
        await page.keyboard.press('Escape').catch(() => undefined);
      }
      const redoAfterModal = await r();
      rec('mr-after-modal', `canRedo after open/close diagnostics=${redoAfterModal}`);
      if (redoAfterModal !== '1') {
        rec('mr-modal-cleared-redo', `read-only diagnostics modal CLEARED the redo stack (canRedo ${redoBeforeModal} -> ${redoAfterModal})`);
      }

      // Now attempt redo via Ctrl+Y (re-arm select first, mirroring the main run).
      await armEditTool(page, 'select');
      await page.keyboard.press('Control+y');
      await page.waitForTimeout(200);
      const afterRedo = await featureListCount(page);
      rec('mr-after-redo', `count=${afterRedo} (expected ${afterCommits})`);
      if (afterRedo !== afterCommits) {
        rec('mr-redo-failed-after-modal', `redo after diagnostics modal did NOT reapply: expected ${afterCommits}, got ${afterRedo}`);
      }

      console.log(`BUGHUNT_MODAL_REDO_SUMMARY: ${JSON.stringify(out)}`);
      await expect(page.getByTestId('app-shell')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  // FOCUSED PROBE: nested-child add. The exclave/reparent paths hit a conflict modal
  // when adding a child face. Determine deterministically: does adding a child that
  // is STRICTLY INSET inside its chosen parent (clearly contained, non-coincident)
  // commit cleanly, or does it surface a conflict modal? A clean containment add is a
  // core authoring导线; a spurious conflict would be a usability bug.
  test('explore-t2-r1-nested-add: a strictly-inset child face inside its chosen parent should commit without a conflict modal', async () => {
    test.setTimeout(300_000);
    const { app, page } = await launchApp();
    attachListeners(page);
    const out: Anomaly[] = [];
    const rec = (k: string, d: string): void => {
      out.push({ kind: k, detail: d });
      console.log(`BUGHUNT:${k}: ${d}`);
    };
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      const inputLayer = page.getByTestId('map-input-layer');
      const box = await inputLayer.boundingBox();
      expect(box).not.toBeNull();
      const b = box!;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;

      // Big parent.
      const parent = await commitFace(page, cx, cy, 180, { name: 'na-parent' });
      rec('na-parent', `parent outcome=${parent}`);

      // Child strictly INSET (half=50, well inside the 180 parent), choosing the
      // parent via the add-parent select.
      await armAddArea(page);
      const layer = page.getByTestId('add-input-layer');
      await expect(layer).toBeVisible();
      const half = 50;
      const corners: ReadonlyArray<readonly [number, number]> = [
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx + half, cy + half],
        [cx - half, cy + half],
      ];
      for (const [px, py] of corners) await page.mouse.click(px, py);
      const complete = page.getByTestId('add-complete');
      await complete.click();
      if ((await page.getByTestId('add-rejected').count()) > 0) {
        const m = ((await page.getByTestId('add-rejected').textContent()) ?? '').trim();
        rec('na-child-rejected', `inset child rejected before save: ${m}`);
        await page.getByTestId('add-rejected-dismiss').click().catch(() => undefined);
      } else {
        // Choose the parent (last non-root option).
        const sel = page.getByTestId('add-parent');
        if ((await sel.count()) > 0) {
          const vals = await sel.locator('option').evaluateAll((els) =>
            (els as HTMLOptionElement[]).map((o) => o.value).filter((v) => v !== ''),
          );
          const last = vals[vals.length - 1];
          rec('na-parent-options', `parent options=${JSON.stringify(vals)}`);
          if (last !== undefined) await sel.selectOption(last).catch(() => undefined);
        } else {
          rec('na-parent-select-missing', 'add-parent select not present');
        }
        await page.getByTestId('add-name').fill('na-child').catch(() => undefined);
        await page.getByTestId('add-save').click();
        await page.waitForTimeout(220);
        const conflict = (await page.getByTestId('conflict-modal-root').count()) > 0;
        if (conflict) {
          // Capture the conflict modal's text for diagnosis.
          const txt = ((await page.getByTestId('conflict-modal-root').textContent().catch(() => '')) ?? '').trim();
          rec('na-child-conflict', `strictly-inset child add surfaced conflict modal: "${txt.slice(0, 240)}"`);
          await page.getByTestId('conflict-cancel').click().catch(() => undefined);
        } else {
          const active = ((await page.getByTestId('app-active-feature').textContent().catch(() => '')) ?? '').trim();
          rec('na-child-committed', `inset child committed cleanly; active="${active}"`);
        }
      }
      await page.screenshot({ path: resolve(shotDir, 't2-1-14-nested-add-probe.png') }).catch(() => undefined);

      console.log(`BUGHUNT_NESTED_ADD_SUMMARY: ${JSON.stringify(out)}`);
      await expect(page.getByTestId('app-shell')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
