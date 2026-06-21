// BUGHUNT R3 (explore3-r1) — e2e exploration (discovery-only). Drives the REAL
// built Electron composite "like a user" through an operation plan deliberately
// UNTOUCHED by explore-r1..r4 / explore2-r1..r4. Those rounds stressed conflict
// modal / settings / save-load / undo連打 / zoom-pan / knife(single split) /
// parent-child(single) / search / time-edges / line+point add / vertex move /
// longitude / context-menu / anchor-mode. THIS round goes for DEPTH and SCALE:
//
//   A. DEEP NESTING — build a chain of nested faces parent→child→grandchild→…
//      (each strictly inside the previous via the add-parent <select>), so the
//      forest reaches a deep level. Gates: every child commits (no rejection),
//      地物一覧 count == 診断 feature-count after each level (single truth source),
//      no console.error / NaN, selection always valid.
//   B. CONSECUTIVE KNIFE SPLITS → MERGE (合体) — take one face, split it twice in a
//      row (split→split), then arm the MERGE tool (tool-edit.merge) and re-combine
//      two siblings. Gates: split grows the count by 1 each time; merge SHRINKS it
//      by 1; coords finite; metamorphic split∘merge moves the count back toward the
//      pre-split value; the inheritor/merge flows never strand a stuck modal.
//   C. LONG TIMELINE PLAYBACK — press ▶ (timeline-playback toggle), let auto-advance
//      run for several seconds at a fast 再生速度, sampling timeline-current the
//      whole time, then ⏸. Gates: timeline-current never NaN/Infinity during play;
//      it is MONOTONE non-decreasing while playing (auto-advance only moves forward);
//      pressing pause actually clears aria-pressed; play∘pause leaves a finite time.
//   D. LARGE-FEATURE-COUNT PERF — commit a GRID of many small faces (≈24) at distinct
//      offsets (no overlaps → no conflict modal), then PAN and ZOOM hard while the
//      whole set is drawn. Gates: every add commits; count == diag after the batch;
//      pan/zoom legs keep data-pan-x/y/zoom finite; we time the pan/zoom burst and
//      record a perf observation if a single interaction leg is pathologically slow
//      (cartoonish-jank proxy, since headless has no FPS meter).
//
// STRICT GATE: any console.error, React warning, unhandled rejection, or
// NaN/Infinity in the live data-* hooks / readouts is recorded as a finding (the
// test does NOT crash on them). Anomalies surface via console.log("BUGHUNT:...")
// and a final BUGHUNT_SUMMARY JSON line. Each step screenshots into
// screenshots/__bughunt__/r3-1-*.png (read back for visual anomaly判定).
//
// INVARIANTS gated after each op (recorded, not crashed):
//   - 座標に NaN/Infinity 無し (data-pan-x/y, data-zoom on map-input-layer)
//   - 選択が常に有効 (active-feature id: no NaN/undefined/null)
//   - 階層森: 地物一覧 count == 診断 feature-count (single truth source) after each level
//   - 錨列の昇順・非重複 (anchor rows time-sorted, non-overlapping)
//   - knife split: +1 per cut; merge: -1; split∘merge moves count back (metamorphic)
//   - playback: timeline-current monotone non-decreasing & finite while playing
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
  const file = resolve(shotDir, `r3-1-${n}-${label}.png`);
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
  // Discovery discipline: a disabled 完了 means the draw did not register enough
  // vertices (e.g. clicks swallowed by a lingering overlay). Do NOT crash the whole
  // exploration — record it and bail this one add so later phases still run.
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
// Returns 'split' if it reached & completed the inheritor flow, else a reason tag.
async function knifeSplitVertical(
  page: Page,
  kx: number,
  ky: number,
  reach: number,
  name: string,
): Promise<'split' | 'no-confirm' | 'no-modal' | 'no-form'> {
  // Select the target under the knife, then draw a vertical cut through it.
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
  // Choose inheritor A and confirm.
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

test.describe('BUGHUNT R3 — deep nesting / split×2→merge / long playback / large-count pan-zoom perf', () => {
  test('explore3-r1: deep forest, consecutive split then merge, timeline playback monotone, mass-feature perf', async () => {
    test.setTimeout(420_000);
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
      // A. DEEP NESTING — chain of strictly-nested faces (forest depth).
      // =====================================================================
      await goView(page);
      await showSidebarTab(page, 'features');
      const countBeforeNest = await featureListCount(page);

      // Root face (large, centred), then shrinking children each inside the prior.
      const DEPTH = 6;
      let half = 220;
      let level = 0;
      for (; level < DEPTH; level += 1) {
        const res = await commitFace(page, cx, cy, half, {
          chooseLastParent: level > 0, // root has no parent; children nest in prior
          name: `nest-L${level}`,
        });
        if (res === 'conflict') {
          // A strictly-nested face should NOT conflict; record and dismiss.
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
        // Single-truth-source parity after EACH level.
        await goView(page);
        await showSidebarTab(page, 'features');
        const list = await featureListCount(page);
        const diag = await diagFeatureCount(page);
        if (Number.isFinite(diag) && diag !== list) {
          record('view-count-mismatch-nest', `level ${level}: feature-list=${list} diagnostics=${diag}`);
        }
        if (list !== countBeforeNest + level + 1) {
          record('nest-count', `after level ${level} expected ${countBeforeNest + level + 1} features, got ${list}`);
        }
        half = Math.round(half * 0.72); // each child strictly smaller → contained
      }
      await shot(page, 'deep-nest');
      const reachedDepth = level;
      record('nest-depth-reached', `committed a nesting chain of depth ${reachedDepth}`);

      // Anchor ordering on the deepest selected feature.
      await goView(page);
      await showSidebarTab(page, 'properties');
      await checkAnchorOrdering(page, 'after-deep-nest');

      const countAfterNest = await featureListCount(page);

      // =====================================================================
      // B. CONSECUTIVE KNIFE SPLITS → MERGE (合体).
      // =====================================================================
      // Fresh isolated face for the cuts/merge to operate on a clean target.
      //
      // ROOT-CAUSE FIX (R3 coverage gap): the base was previously placed at
      // (cx-360, cy-220) with half=120, which drove its left corners out to cx-480 and
      // its top to cy-340 — beyond the clear, hit-testable central map. Those corner
      // clicks were swallowed by toolbar/sidebar chrome (or fell outside the input
      // layer), so the face never committed; the subsequent knife-split-1/2 and
      // 合体(merge) checks then had NO valid target and reported 'no-confirm'. That made
      // split×2→merge LOOK exercised when it was not. We now place the base where the
      // grid faces committed: horizontally CENTRED (cx) and just BELOW the centred deep
      // nest (≈cx±220 / cy±220), with a small footprint, then CLAMP the footprint and
      // the vertical pierce inside the input layer so every click lands on hittable
      // canvas. (Per the recorded repro: "Re-place split-base at (cx, cy+offset) inside
      // the unobstructed map.") Phase D's grid already tolerates any residual overlap —
      // it cancels conflicts and only counts committed faces (gridConflicts).
      const sHalf = 80;
      // A pierce only needs to clear the face's edges; keep the reach modest so the
      // cut endpoints stay inside the layer with the base low in the viewport.
      const sReach = sHalf + 40;
      const sx = cx; // horizontally centred — guaranteed inside the layer
      const syMin = b.y + sReach + 12; // keep the upward pierce on canvas
      const syMax = b.y + b.height - (sReach + 12); // keep the downward pierce on canvas
      // Just below the nest's lower edge (≈cy+220), clamped inside the layer.
      const sy = Math.min(syMax, Math.max(syMin, cy + 240));
      const baseRes = await commitFace(page, sx, sy, sHalf, { name: 'split-base' });
      if (baseRes === 'conflict') await page.getByTestId('conflict-cancel').click().catch(() => undefined);
      // GATE: the split-base MUST commit, else B never reaches knife/merge (the very
      // gap this round was opened to close). Failing loudly here prevents a silent
      // regression back into "split×2→merge skipped, mistaken for a pass".
      if (baseRes !== 'committed') {
        record('split-base-not-committed', `split-base outcome=${baseRes} — knife/merge phase cannot run`);
      }
      expect(baseRes, 'split-base must commit so the knife-split×2→merge path is exercised').toBe('committed');
      await shot(page, 'split-base');

      await goView(page);
      await showSidebarTab(page, 'features');
      const countBeforeSplit = await featureListCount(page);

      let splitsDone = 0;
      if (await armEditTool(page, 'knife')) {
        await page.getByTestId('knife-tool').waitFor({ state: 'attached', timeout: 4000 }).catch(() => {
          record('knife-chrome-missing', 'knife-tool chrome did not mount');
        });
        const kLayer = page.getByTestId('knife-input-layer');
        const kbox = await kLayer.boundingBox();
        if (kbox) {
          // Map (sx,sy) — they are screen coords already (same coordinate space).
          // First vertical cut down the middle.
          const r1 = await knifeSplitVertical(page, sx, sy, sReach, 'split-half-1');
          await shot(page, 'split-1');
          if (r1 === 'split') splitsDone += 1;
          else record('knife-split-1', `first split outcome=${r1}`);
          await checkCamera(page, 'after-split-1');

          await goView(page);
          await showSidebarTab(page, 'features');
          const afterSplit1 = await featureListCount(page);
          if (r1 === 'split' && afterSplit1 !== countBeforeSplit + 1) {
            record('knife-split-1-count', `split#1 expected ${countBeforeSplit + 1}, got ${afterSplit1}`);
          }

          // Second consecutive split: cut one of the halves HORIZONTALLY.
          if (await armEditTool(page, 'knife')) {
            // Target the LEFT half (sx - 55) with a horizontal pierce. Clamp the
            // pierce endpoints inside the layer so the cut clicks land on canvas
            // even when the base sits near the left edge (same root-fix discipline).
            const hx = sx - 55;
            const hReach = sHalf;
            const hLeft = Math.max(b.x + 4, hx - hReach);
            const hRight = Math.min(b.x + b.width - 4, hx + hReach);
            await page.mouse.click(hx, sy);
            await page.waitForTimeout(70);
            await page.mouse.click(hLeft, sy); // left
            await page.mouse.click(hRight, sy); // right → horizontal pierce
            const cc = page.getByTestId('knife-confirm-cut');
            if (await cc.isVisible().catch(() => false)) {
              await cc.click();
              await page.waitForTimeout(140);
              if ((await page.getByTestId('knife-inheritor-modal-root').count()) > 0) {
                await page.getByTestId('knife-choose-b').click().catch(() => undefined);
                await page.getByTestId('knife-confirm-inheritor').click().catch(() => undefined);
                await page.waitForTimeout(120);
                if (await page.getByTestId('add-property-form').isVisible().catch(() => false)) {
                  await page.getByTestId('add-name').fill('split-half-2').catch(() => undefined);
                  await page.getByTestId('add-save').click();
                  await page.waitForTimeout(220);
                  if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
                    await page.getByTestId('conflict-cancel').click().catch(() => undefined);
                  }
                  splitsDone += 1;
                }
              } else {
                const msg = ((await page.getByTestId('knife-message').textContent().catch(() => '')) ?? '').trim();
                record('knife-split-2', `second split did not open inheritor modal; message="${msg}"`);
              }
            } else {
              record('knife-split-2-no-confirm', 'second cut produced no confirm-cut control');
            }
          }
          await shot(page, 'split-2');
          await checkCamera(page, 'after-split-2');
        }
      }

      await goView(page);
      await showSidebarTab(page, 'features');
      const countAfterSplits = await featureListCount(page);
      const diagAfterSplits = await diagFeatureCount(page);
      if (Number.isFinite(diagAfterSplits) && diagAfterSplits !== countAfterSplits) {
        record('view-count-mismatch-splits', `feature-list=${countAfterSplits} diagnostics=${diagAfterSplits}`);
      }
      if (splitsDone > 0 && countAfterSplits !== countBeforeSplit + splitsDone) {
        record('knife-splits-count', `expected ${countBeforeSplit}+${splitsDone}=${countBeforeSplit + splitsDone} after ${splitsDone} splits, got ${countAfterSplits}`);
      }

      // --- MERGE (合体): re-combine two split siblings. Metamorphic: split∘merge
      //     drives the count back DOWN. -------------------------------------------
      if (splitsDone > 0 && (await armEditTool(page, 'merge'))) {
        await shot(page, 'merge-armed');
        // The merge tool usually wants two clicks on adjacent siblings. Click two
        // points that lie within the two pieces of the original split-base.
        await page.mouse.click(sx - 55, sy + 30);
        await page.waitForTimeout(70);
        await page.mouse.click(sx + 55, sy + 30);
        await page.waitForTimeout(120);
        // A confirm / inheritor step may follow (re-uses knife inheritor flow).
        const mConfirm = page.getByTestId('knife-confirm-inheritor');
        if (await mConfirm.isVisible().catch(() => false)) {
          await page.getByTestId('knife-choose-a').click().catch(() => undefined);
          await mConfirm.click().catch(() => undefined);
          await page.waitForTimeout(120);
          if (await page.getByTestId('add-property-form').isVisible().catch(() => false)) {
            await page.getByTestId('add-name').fill('merged').catch(() => undefined);
            await page.getByTestId('add-save').click().catch(() => undefined);
            await page.waitForTimeout(220);
            if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
              await page.getByTestId('conflict-cancel').click().catch(() => undefined);
            }
          }
        } else {
          // Some merge implementations confirm via a dedicated control or auto-apply.
          const msg = ((await page.getByTestId('knife-message').textContent().catch(() => '')) ?? '').trim();
          if (msg) record('merge-flow-note', `merge produced message="${msg}" (no inheritor confirm shown)`);
        }
        await shot(page, 'merged');
        await checkCamera(page, 'after-merge');

        await goView(page);
        await showSidebarTab(page, 'features');
        const countAfterMerge = await featureListCount(page);
        const diagAfterMerge = await diagFeatureCount(page);
        if (Number.isFinite(diagAfterMerge) && diagAfterMerge !== countAfterMerge) {
          record('view-count-mismatch-merge', `feature-list=${countAfterMerge} diagnostics=${diagAfterMerge}`);
        }
        // Metamorphic: a successful merge of two siblings should REDUCE the count.
        if (countAfterMerge >= countAfterSplits) {
          record('merge-no-reduction', `merge did not reduce feature count: before=${countAfterSplits} after=${countAfterMerge} (merge may be a no-op / not wired)`);
        } else {
          record('merge-reduced', `merge reduced count ${countAfterSplits} -> ${countAfterMerge}`);
        }
      }

      // =====================================================================
      // C. LONG TIMELINE PLAYBACK — auto-advance several seconds, monotone gate.
      // =====================================================================
      await goView(page);
      const playback = page.getByTestId('timeline-playback');
      if (await playback.isVisible().catch(() => false)) {
        // Pick the fastest 再生速度 available so the run covers many years.
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

        // Sample timeline-current repeatedly during a multi-second auto-advance.
        const samples: number[] = [];
        const parseYear = (t: string): number => {
          const m = t.match(/-?\d+/);
          return m ? Number(m[0]) : Number.NaN;
        };
        for (let i = 0; i < 14; i += 1) {
          await page.waitForTimeout(250);
          const t = ((await cur.textContent().catch(() => '')) ?? '').trim();
          if (/NaN|Infinity|undefined/.test(t)) {
            record('timeline-current-malformed', `play sample ${i}="${t}"`);
          }
          const y = parseYear(t);
          if (Number.isFinite(y)) samples.push(y);
          if (i === 6) await shot(page, 'playback-mid');
        }
        await toggle.click().catch(() => undefined); // ⏸ pause
        await page.waitForTimeout(150);
        const pressedAfterPause = await toggle.getAttribute('aria-pressed').catch(() => null);
        if (pressedAfterPause === 'true') {
          record('playback-pause-stuck', 'pause click left play button still aria-pressed=true');
        }
        await shot(page, 'playback-paused');

        // MONOTONE gate: auto-advance only moves time forward — samples must be
        // non-decreasing (a backward jump while playing is a bug). Also require it
        // actually MOVED at all (no advance over ~3.5s = playback dead).
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
            record('playback-no-advance', `timeline-current did not advance during ~3.5s play (stayed ${first})`);
          }
        }
        const after = ((await cur.textContent().catch(() => '')) ?? '').trim();
        if (/NaN|Infinity|undefined/.test(after)) record('timeline-current-malformed', `post-pause="${after}"`);
      } else {
        record('playback-control-missing', 'timeline-playback control not visible');
      }
      await checkCamera(page, 'after-playback');

      // =====================================================================
      // D. LARGE-FEATURE-COUNT PERF — grid of small non-overlapping faces, then
      //    pan/zoom hard while all are drawn; time the interaction burst.
      // =====================================================================
      await goView(page);
      await showSidebarTab(page, 'features');
      const countBeforeGrid = await featureListCount(page);

      // A 5×5-ish grid of small squares offset so none overlap (avoids the
      // conflict modal). Step bigger than 2*half. Keep them inside the viewport.
      const HALF = 22;
      const STEP = 70;
      const COLS = 5;
      const ROWS = 5;
      const gx0 = cx - ((COLS - 1) * STEP) / 2;
      const gy0 = cy + 60; // lower half, away from the nest
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
          // Spot-check coords mid-batch.
          if ((r * COLS + c) % 8 === 0) await checkCamera(page, `grid-${r}-${c}`);
        }
      }
      await shot(page, 'grid-placed');
      record('grid-placed', `placed ${placed}/${COLS * ROWS} grid faces (${gridConflicts} conflicts)`);

      await goView(page);
      await showSidebarTab(page, 'features');
      const countAfterGrid = await featureListCount(page);
      const diagAfterGrid = await diagFeatureCount(page);
      if (Number.isFinite(diagAfterGrid) && diagAfterGrid !== countAfterGrid) {
        record('view-count-mismatch-grid', `feature-list=${countAfterGrid} diagnostics=${diagAfterGrid}`);
      }
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
        // Headless has no FPS meter; a single interaction leg taking >4s over this
        // (small) scene is a jank proxy worth flagging.
        if (dt > 4000) record('perf-slow-leg', `${label} took ${dt}ms with ${countAfterGrid} features`);
        await checkCamera(page, `perf-${label}`);
      };

      await timeLeg('zoom-in', async () => {
        for (let i = 0; i < 16; i += 1) {
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
        await pan(500, 0);
        await pan(-1000, 0);
        await pan(0, 500);
        await pan(0, -1000);
      });
      await shot(page, 'perf-panned');

      await timeLeg('zoom-out', async () => {
        for (let i = 0; i < 22; i += 1) {
          await page.mouse.move(wx, wy);
          await page.mouse.wheel(0, 120);
          await page.waitForTimeout(8);
        }
      });
      await shot(page, 'perf-zoomed-out');

      // =====================================================================
      // SAVE→LOAD reachability + dirty flag (no native dialog fired).
      // =====================================================================
      const unsavedNow = await diagUnsaved(page);
      if (unsavedNow !== 'あり') record('dirty-not-set', `after edits unsaved=${unsavedNow} (expected あり)`);
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

      void countAfterNest;
      console.log(`BUGHUNT_SUMMARY: ${JSON.stringify(anomalies)}`);
      await expect(page.getByTestId('app-shell')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
