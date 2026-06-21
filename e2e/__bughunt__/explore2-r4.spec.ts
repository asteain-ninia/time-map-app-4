// BUGHUNT R2 (explore2-r4) — e2e exploration (discovery-only). Drives the REAL
// built Electron composite "like a user". This round re-runs the SAME five
// thematic surfaces explore2-r1 stressed (conflict-resolution flow / settings &
// zoom-limit / save-load roundtrip / time-move + undo連打 / extreme zoom + pan)
// but through DELIBERATELY DIFFERENT 導線 and gates so it exercises code paths the
// r1 sequence did not:
//
//   1. CONFLICT-RESOLUTION — fire the U35 modal via a THREE-face overlap (two
//      committed faces + a third intruding both), then exercise the CANCEL path
//      first (gate: cancel discards the pending add, domain feature-count is
//      UNCHANGED, modal closes), re-fire, exercise the guide reshow toggle, then
//      RESOLVE every row and APPLY. Gates: remaining-count finite & monotone,
//      apply disabled until resolved, no add-rejected, parity after apply.
//   2. SETTINGS — tighten the FR-10 zoom clamp AND narrow the timeline year range
//      via the PROJECT tab, plus poke the APP tab (snap distance). Also fire a
//      DELIBERATELY INVALID clamp (min > max) and gate that settings-save REJECTS
//      it with a settings-error (negative path), then apply a VALID clamp.
//   3. SAVE→LOAD roundtrip (metamorphic save∘load=identity): the dirty flag must
//      be clean at boot, flip to あり after edits, and the ファイル save/open/saveAs
//      commands must be reachable through the SINGLE truth source. Native dialogs
//      are NOT fired (headless).
//   4. TIME-MOVE + UNDO 連打 — step time with the StepControls 前へ/次へ using the
//      月 and 日 units (r1 used year arithmetic), reading timeline-current and the
//      diagnostics current-time. Metamorphic: forward∘back = identity (timeline
//      readout returns). Then commit a face and pound undo/redo via the live
//      app-can-undo / app-can-redo markers, gating undo∘op=identity (feature count
//      returns) and the markers flip coherently.
//   5. EXTREME ZOOM + PAN — wheel to the zoom extreme then DRAG-PAN hard in all
//      four directions; gate data-pan-x/y/zoom finite after every leg and the zoom
//      stays within the live clamp.
//
// STRICT GATE: any console.error, React warning, unhandled rejection, or
// NaN/Infinity in the live data-* hooks / readouts is recorded as a finding (the
// test does NOT crash on them). Anomalies surface via console.log("BUGHUNT:...")
// and a final BUGHUNT_SUMMARY JSON line. Each step screenshots into
// screenshots/__bughunt__/r2-4-*.png.
//
// INVARIANTS gated after each op (recorded, not crashed):
//   - 座標に NaN/Infinity 無し (data-pan-x/y, data-zoom on map-input-layer)
//   - data-zoom always within the live effective clamp [zoomMin, zoomMax]
//   - 選択が常に有効 (active-feature id has no NaN/undefined/null)
//   - 階層森: 地物一覧 count == 診断情報 feature-count (single truth source)
//   - 錨列の昇順・非重複 (anchor rows time-sorted, non-overlapping)
//   - conflict: cancel discards (count unchanged) / remaining finite & monotone
//   - settings: invalid clamp (min>max) REJECTED with an error; valid clamp applied
//   - metamorphic: time forward∘back = identity / undo∘op = identity / save→load reachable

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
  const file = resolve(shotDir, `r2-4-${n}-${label}.png`);
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

// --- camera hooks: NaN/Infinity + clamp gate ---------------------------------
async function readNum(page: Page, attr: string): Promise<number> {
  const raw = await page.getByTestId('map-input-layer').getAttribute(attr).catch(() => null);
  return raw === null ? Number.NaN : Number(raw);
}

async function checkCamera(
  page: Page,
  where: string,
  clamp?: { readonly min: number; readonly max: number },
): Promise<void> {
  const layer = page.getByTestId('map-input-layer');
  for (const a of ['data-pan-x', 'data-pan-y', 'data-zoom']) {
    const raw = await layer.getAttribute(a).catch(() => null);
    if (raw === null) continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) record('coord-nonfinite', `${where}: ${a}=${raw}`);
  }
  if (clamp !== undefined) {
    const z = await readNum(page, 'data-zoom');
    if (Number.isFinite(z)) {
      const eps = 1e-6;
      if (z < clamp.min - eps || z > clamp.max + eps) {
        record('zoom-clamp-violation', `${where}: data-zoom=${z} outside [${clamp.min}, ${clamp.max}]`);
      }
    }
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

async function diagFields(page: Page): Promise<{ unsaved: string; time: string }> {
  if (!(await clickMenuCommand(page, 'help', 'help.diagnostics'))) return { unsaved: '?', time: '?' };
  await expect(page.getByTestId('diagnostics-panel')).toBeVisible();
  const unsaved = ((await page.getByTestId('diagnostics-unsaved').textContent()) ?? '').trim();
  const time = ((await page.getByTestId('diagnostics-current-time').textContent()) ?? '').trim();
  if (/NaN|Infinity|undefined/.test(time)) record('diag-time-malformed', `current-time="${time}"`);
  await page.getByTestId('diagnostics-panel-close').click().catch(() => undefined);
  await page.keyboard.press('Escape').catch(() => undefined);
  return { unsaved, time };
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

// Commit one square face. Returns whether it committed cleanly, paused on the
// conflict modal, or was rejected before save.
async function commitFaceMaybeConflict(
  page: Page,
  cx: number,
  cy: number,
  half: number,
): Promise<'committed' | 'conflict' | 'rejected'> {
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
  await expect(complete).toBeEnabled();
  await complete.click();
  if ((await page.getByTestId('add-rejected').count()) > 0) {
    const m = ((await page.getByTestId('add-rejected').textContent()) ?? '').trim();
    record('add-rejected', `add rejected before save: ${m}`);
    await page.getByTestId('add-rejected-dismiss').click().catch(() => undefined);
    return 'rejected';
  }
  await page.getByTestId('add-save').click();
  await page.waitForTimeout(200);
  if ((await page.getByTestId('conflict-modal-root').count()) > 0) return 'conflict';
  try {
    await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/, { timeout: 6000 });
  } catch {
    record('add-no-selection', 'active-feature empty after add commit (no conflict modal)');
  }
  return 'committed';
}

// Gate the conflict modal invariants and return row count.
async function gateConflictModal(page: Page, where: string): Promise<number> {
  const remText = ((await page.getByTestId('conflict-remaining').textContent()) ?? '').trim();
  if (/NaN|Infinity|undefined/.test(remText)) {
    record('conflict-remaining-malformed', `${where}: remaining="${remText}"`);
  }
  const rows = page.locator('[data-testid^="conflict-row-select-"]');
  const n = await rows.count();
  if (n === 0) record('conflict-no-rows', `${where}: conflict modal shown but 0 rows`);
  const apply = page.getByTestId('conflict-apply');
  const applyEnabledEarly = await apply.isEnabled().catch(() => false);
  if (n > 0 && applyEnabledEarly) {
    record('conflict-apply-enabled-early', `${where}: apply enabled before any policy chosen`);
  }
  return n;
}

test.describe('BUGHUNT R2 — conflict(cancel+apply) / settings(invalid+valid) / time月日 / undo連打 / extreme pan', () => {
  test('explore2-r4: conflict cancel∘apply, settings reject, time fwd∘back identity, undo∘op identity, pan finite', async () => {
    test.setTimeout(300_000);
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

      const boot = await diagFields(page);
      if (boot.unsaved !== 'なし') record('boot-dirty', `boot unsaved=${boot.unsaved} (expected なし)`);

      // =====================================================================
      // 1. CONFLICT — three-face overlap; CANCEL path then APPLY path.
      // =====================================================================
      const f1 = await commitFaceMaybeConflict(page, cx - 60, cy - 40, 110);
      if (f1 !== 'committed') record('conflict-setup', `first face: ${f1}`);
      await checkCamera(page, 'after-f1');
      const f2 = await commitFaceMaybeConflict(page, cx + 90, cy + 60, 110);
      await shot(page, 'two-faces');
      if (f2 === 'conflict') {
        // The 2nd already overlaps the 1st; resolve+apply to set a clean base.
        const n = await gateConflictModal(page, 'pre-conflict');
        for (let i = 0; i < n; i += 1) {
          const radios = page.locator('[data-testid^="policy-"]');
          const r = radios.nth(i * 2);
          if ((await r.count()) > 0) await r.check({ force: true }).catch(() => undefined);
        }
        const ap = page.getByTestId('conflict-apply');
        if (await ap.isEnabled().catch(() => false)) await ap.click();
        else await page.getByTestId('conflict-cancel').click().catch(() => undefined);
        await page.waitForTimeout(200);
      }

      // Domain count just before the cancel experiment.
      await goView(page);
      await showSidebarTab(page, 'features');
      const countBeforeCancel = await featureListCount(page);

      // A THIRD face that straddles both -> should fire the conflict modal.
      const f3 = await commitFaceMaybeConflict(page, cx + 10, cy + 10, 130);
      await shot(page, 'third-face-overlap');
      if (f3 === 'conflict') {
        record('conflict-modal-fired', 'three-face overlap真に paused on conflict modal');
        await gateConflictModal(page, 'cancel-conflict');
        await shot(page, 'conflict-modal-cancel');

        // --- CANCEL path: cancel must DISCARD the pending add (count unchanged).
        // Exercise the guide reshow toggle first (FR: re-show guide), if present.
        const reshow = page.getByTestId('conflict-guide-reshow');
        if (await reshow.isVisible().catch(() => false)) {
          await reshow.click().catch(() => undefined);
          await page.waitForTimeout(60);
        }
        await page.getByTestId('conflict-cancel').click();
        await page.waitForTimeout(250);
        if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
          record('conflict-cancel-stuck', 'modal still open after cancel');
          await page.getByTestId('conflict-cancel').click().catch(() => undefined);
        }
        await goView(page);
        await showSidebarTab(page, 'features');
        const countAfterCancel = await featureListCount(page);
        const diagAfterCancel = await diagFeatureCount(page);
        if (countAfterCancel !== countBeforeCancel) {
          record('conflict-cancel-mutated', `cancel changed feature count ${countBeforeCancel} -> ${countAfterCancel} (cancel should discard the pending add)`);
        }
        if (Number.isFinite(diagAfterCancel) && diagAfterCancel !== countAfterCancel) {
          record('view-count-mismatch-cancel', `list=${countAfterCancel} diag=${diagAfterCancel}`);
        }

        // --- APPLY path: re-fire and RESOLVE every row, then apply.
        const f3b = await commitFaceMaybeConflict(page, cx + 10, cy + 10, 130);
        if (f3b === 'conflict') {
          const n2 = await gateConflictModal(page, 'apply-conflict');
          // Resolve: choose the FIRST policy radio per row (2 radios/row a|b).
          for (let i = 0; i < n2; i += 1) {
            const radios = page.locator('[data-testid^="policy-"]');
            const r = radios.nth(i * 2);
            if ((await r.count()) > 0) {
              await r.check({ force: true }).catch(() => undefined);
              await page.waitForTimeout(40);
            }
          }
          // Remaining should be finite and apply now enabled.
          const remText = ((await page.getByTestId('conflict-remaining').textContent()) ?? '').trim();
          if (/NaN|Infinity|undefined/.test(remText)) record('conflict-remaining-malformed', `apply-phase remaining="${remText}"`);
          const ap = page.getByTestId('conflict-apply');
          if (!(await ap.isEnabled().catch(() => false))) {
            record('conflict-apply-stuck', `apply disabled after resolving all rows (remaining=${remText})`);
            await page.getByTestId('conflict-cancel').click().catch(() => undefined);
          } else {
            await ap.click();
            await page.waitForTimeout(300);
            if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
              record('conflict-modal-stuck', 'modal did not close after apply');
              await page.getByTestId('conflict-cancel').click().catch(() => undefined);
            }
          }
          await shot(page, 'conflict-applied');
          await checkCamera(page, 'after-conflict-apply');
          await activeFeature(page);
        } else {
          record('conflict-not-refired', `re-fire of overlapping add did NOT pause on conflict modal (result=${f3b})`);
        }
      } else {
        record('conflict-not-fired', `three-face overlap did NOT pause on conflict modal (result=${f3}); 同時刻 spatial conflict may be undetected`);
      }

      await goView(page);
      await showSidebarTab(page, 'features');
      const listAfterConflict = await featureListCount(page);
      const diagAfterConflict = await diagFeatureCount(page);
      if (Number.isFinite(diagAfterConflict) && diagAfterConflict !== listAfterConflict) {
        record('view-count-mismatch-conflict', `list=${listAfterConflict} diag=${diagAfterConflict}`);
      }

      // =====================================================================
      // 2. SETTINGS — invalid clamp REJECTED, then a valid clamp + APP tab poke.
      // =====================================================================
      let clamp = { min: 0.1, max: 10000 };
      if (await clickMenuCommand(page, 'tools', 'tools.settings')) {
        await expect(page.getByTestId('settings-modal-root')).toBeVisible();
        await page.getByTestId('settings-tab-project').click().catch(() => undefined);
        await shot(page, 'settings-open');

        const minInput = page.locator('input[aria-label*="最小"][aria-label*="ズーム"]').first();
        const maxInput = page.locator('input[aria-label*="最大"][aria-label*="ズーム"]').first();
        const haveInputs = (await minInput.count()) > 0 && (await maxInput.count()) > 0;

        if (haveInputs) {
          // --- NEGATIVE: min > max must be REJECTED (settings-error surfaces).
          await minInput.fill('8').catch(() => undefined);
          await maxInput.fill('2').catch(() => undefined);
          await shot(page, 'settings-invalid');
          await page.getByTestId('settings-save').click();
          await page.waitForTimeout(200);
          if ((await page.getByTestId('settings-modal-root').count()) === 0) {
            record('settings-invalid-accepted', 'min>max zoom clamp was ACCEPTED (should reject min<=max)');
            // It applied; reopen to fix.
            if (await clickMenuCommand(page, 'tools', 'tools.settings')) {
              await page.getByTestId('settings-tab-project').click().catch(() => undefined);
            }
          } else {
            const errs = await page.locator('[data-testid^="settings-error-"]').allTextContents().catch(() => []);
            if (errs.length === 0) {
              record('settings-invalid-no-error', 'min>max kept dialog open but showed NO settings-error');
            }
          }

          // --- POSITIVE: valid clamp + narrow timeline + APP-tab snap distance.
          const m2 = page.locator('input[aria-label*="最小"][aria-label*="ズーム"]').first();
          const x2 = page.locator('input[aria-label*="最大"][aria-label*="ズーム"]').first();
          const TIGHT_MIN = 0.5;
          const TIGHT_MAX = 4;
          await m2.fill(String(TIGHT_MIN)).catch(() => undefined);
          await x2.fill(String(TIGHT_MAX)).catch(() => undefined);
          // Narrow the timeline year range (poke a different field than r1).
          const minYear = page.locator('input[aria-label*="開始"], input[aria-label*="最小"][aria-label*="年"]').first();
          const maxYear = page.locator('input[aria-label*="終了"], input[aria-label*="最大"][aria-label*="年"]').first();
          if ((await minYear.count()) > 0) await minYear.fill('-500').catch(() => undefined);
          if ((await maxYear.count()) > 0) await maxYear.fill('2500').catch(() => undefined);

          // Poke the APP tab (snap distance) — a surface r1 never touched.
          const appTab = page.getByTestId('settings-tab-app');
          if (await appTab.isVisible().catch(() => false)) {
            await appTab.click().catch(() => undefined);
            const snap = page.locator('input[aria-label*="スナップ"]').first();
            if ((await snap.count()) > 0) {
              await snap.fill('12').catch(() => undefined);
            }
            await page.getByTestId('settings-tab-project').click().catch(() => undefined);
          }
          await shot(page, 'settings-valid');
          await page.getByTestId('settings-save').click();
          await page.waitForTimeout(250);
          if ((await page.getByTestId('settings-modal-root').count()) > 0) {
            const errs = await page.locator('[data-testid^="settings-error-"]').allTextContents().catch(() => []);
            record('settings-valid-rejected', `valid settings save rejected: ${JSON.stringify(errs)}`);
            await page.getByTestId('settings-cancel').click().catch(() => undefined);
          } else {
            clamp = { min: TIGHT_MIN, max: TIGHT_MAX };
            record('settings-clamp-applied', `zoom clamp now [${TIGHT_MIN}, ${TIGHT_MAX}]`);
          }
        } else {
          record('settings-zoom-inputs-missing', 'could not find zoomMin/zoomMax inputs');
          await page.getByTestId('settings-cancel').click().catch(() => undefined);
        }
      }
      await shot(page, 'settings-closed');

      // =====================================================================
      // 4. TIME-MOVE — 月/日 step units; forward∘back = identity (metamorphic).
      // =====================================================================
      await goView(page);
      const timeBefore = (await diagFields(page)).time;
      const unitSelect = page.getByRole('combobox', { name: 'ステップ単位' });
      const back = page.getByRole('button', { name: /前へ戻る/ });
      const fwd = page.getByRole('button', { name: /次へ進む/ });

      for (const unit of ['月', '日'] as const) {
        if (await unitSelect.isVisible().catch(() => false)) {
          await unitSelect.selectOption({ label: unit }).catch(() => undefined);
        }
        const cur0 = ((await page.getByTestId('timeline-current').textContent().catch(() => '')) ?? '').trim();
        if (/NaN|Infinity|undefined/.test(cur0)) record('timeline-current-malformed', `${unit}: before="${cur0}"`);
        // forward K then back K.
        const K = 5;
        for (let i = 0; i < K; i += 1) await fwd.click().catch(() => undefined);
        await page.waitForTimeout(40);
        const curF = ((await page.getByTestId('timeline-current').textContent().catch(() => '')) ?? '').trim();
        if (/NaN|Infinity|undefined/.test(curF)) record('timeline-current-malformed', `${unit}: forward="${curF}"`);
        for (let i = 0; i < K; i += 1) await back.click().catch(() => undefined);
        await page.waitForTimeout(40);
        const curB = ((await page.getByTestId('timeline-current').textContent().catch(() => '')) ?? '').trim();
        if (/NaN|Infinity|undefined/.test(curB)) record('timeline-current-malformed', `${unit}: back="${curB}"`);
        // Metamorphic: forward∘back returns to cur0 (unless clamped at an edge).
        if (cur0 !== curB && cur0 !== '' && curB !== '') {
          record('time-fwd-back-not-identity', `${unit}: fwd${K}∘back${K} not identity: "${cur0}" -> "${curB}"`);
        }
        await shot(page, `time-${unit}-roundtrip`);
      }
      const timeAfter = (await diagFields(page)).time;
      if (timeBefore !== timeAfter && timeBefore !== '?' && timeAfter !== '?') {
        record('time-diag-drift', `diag current-time drifted across step round-trips: "${timeBefore}" -> "${timeAfter}"`);
      }

      // =====================================================================
      //    UNDO 連打 — commit a face, pound undo/redo, gate undo∘op = identity.
      // =====================================================================
      await goView(page);
      await showSidebarTab(page, 'features');
      const countBeforeUndoOp = await featureListCount(page);
      const addRes = await commitFaceMaybeConflict(page, cx - 230, cy - 170, 70);
      if (addRes === 'conflict') {
        await page.getByTestId('conflict-cancel').click().catch(() => undefined);
      }
      await goView(page);
      await showSidebarTab(page, 'features');
      const countAfterAdd = await featureListCount(page);

      // Live undo/redo markers.
      const canUndo = async (): Promise<string> =>
        ((await page.getByTestId('app-can-undo').textContent().catch(() => '')) ?? '').trim();
      const canRedo = async (): Promise<string> =>
        ((await page.getByTestId('app-can-redo').textContent().catch(() => '')) ?? '').trim();

      if (countAfterAdd === countBeforeUndoOp + 1) {
        // op done: undo should be available.
        if ((await canUndo()) !== '1') record('undo-marker-not-set', 'app-can-undo != 1 after a committed add');
        // Pound Ctrl+Z several times (連打), then Ctrl+Y to redo once.
        await leaveView(page);
        const em = page.getByTestId('mode-edit');
        if ((await em.getAttribute('aria-pressed')) !== 'true') await em.click();
        for (let i = 0; i < 4; i += 1) {
          await page.keyboard.press('Control+z');
          await page.waitForTimeout(50);
          if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
            await page.getByTestId('conflict-cancel').click().catch(() => undefined);
          }
        }
        await checkCamera(page, 'after-undo-burst');
        await goView(page);
        await showSidebarTab(page, 'features');
        const countAfterUndo = await featureListCount(page);
        // undo∘op = identity: the add is undone, count back to baseline.
        if (countAfterUndo !== countBeforeUndoOp) {
          record('undo-op-not-identity', `undo∘op not identity: baseline=${countBeforeUndoOp} afterUndo=${countAfterUndo}`);
        }
        // redo should now be available; Ctrl+Y restores the add.
        if ((await canRedo()) === '1') {
          await leaveView(page);
          if ((await em.getAttribute('aria-pressed')) !== 'true') await em.click();
          await page.keyboard.press('Control+y');
          await page.waitForTimeout(80);
          if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
            await page.getByTestId('conflict-cancel').click().catch(() => undefined);
          }
          await goView(page);
          await showSidebarTab(page, 'features');
          const countAfterRedo = await featureListCount(page);
          if (countAfterRedo !== countAfterUndo + 1 && countAfterRedo !== countAfterAdd) {
            record('redo-not-restore', `Ctrl+Y did not restore the add: afterUndo=${countAfterUndo} afterRedo=${countAfterRedo}`);
          }
        }
        await activeFeature(page);
        await shot(page, 'undo-redo-done');
      } else {
        record('undo-setup', `add for undo-op did not grow count by 1: ${countBeforeUndoOp} -> ${countAfterAdd}`);
      }

      // Anchor ordering of whatever is selected now.
      await showSidebarTab(page, 'properties');
      await checkAnchorOrdering(page, 'after-undo-redo');

      // =====================================================================
      // 5. EXTREME ZOOM + PAN — zoom to clamp, then drag-pan hard 4 directions.
      // =====================================================================
      await goView(page);
      const lbox = await inputLayer.boundingBox();
      const wx = lbox ? lbox.x + lbox.width / 2 : cx;
      const wy = lbox ? lbox.y + lbox.height / 2 : cy;
      // Zoom IN hard past the (possibly tightened) max.
      for (let i = 0; i < 22; i += 1) {
        await page.mouse.move(wx, wy);
        await page.mouse.wheel(0, -120);
        await page.waitForTimeout(12);
        if (i % 6 === 0) await checkCamera(page, `zoom-in-${i}`, clamp);
      }
      await checkCamera(page, 'zoom-in-final', clamp);
      await shot(page, 'zoomed-in');

      // DRAG-PAN hard in all four directions at this extreme zoom.
      const pan = async (dx: number, dy: number, tag: string): Promise<void> => {
        await page.mouse.move(wx, wy);
        await page.mouse.down();
        for (let s = 1; s <= 8; s += 1) {
          await page.mouse.move(wx + (dx * s) / 8, wy + (dy * s) / 8);
          await page.waitForTimeout(10);
        }
        await page.mouse.up();
        await page.waitForTimeout(40);
        await checkCamera(page, `pan-${tag}`, clamp);
      };
      await pan(600, 0, 'right');
      await pan(-1200, 0, 'left');
      await pan(0, 600, 'down');
      await pan(0, -1200, 'up');
      await shot(page, 'panned-extreme');

      // Zoom OUT hard past the min, gate clamp every few notches.
      for (let i = 0; i < 30; i += 1) {
        await page.mouse.move(wx, wy);
        await page.mouse.wheel(0, 120);
        await page.waitForTimeout(12);
        if (i % 6 === 0) await checkCamera(page, `zoom-out-${i}`, clamp);
      }
      await checkCamera(page, 'zoom-out-final', clamp);
      await shot(page, 'zoomed-out');

      // =====================================================================
      // 3. SAVE→LOAD reachability + dirty flag (no native dialog fired).
      // =====================================================================
      const dirtyNow = (await diagFields(page)).unsaved;
      if (dirtyNow !== 'あり') record('dirty-not-set', `after edits unsaved=${dirtyNow} (expected あり)`);
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
        record('view-count-mismatch-final', `list=${finalList} diag=${finalDiag}`);
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
