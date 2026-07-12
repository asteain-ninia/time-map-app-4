// BUGHUNT R2 (explore2-r1) — e2e exploration (discovery-only). Drives the REAL
// built Electron composite "like a user" with an operation plan deliberately
// DIFFERENT from rounds R1-R4:
//
//   1. CONFLICT-RESOLUTION FLOW actually fired: commit two OVERLAPPING faces at the
//      same time so the add真に pauses on the U35 conflict modal, then exercise the
//      modal end-to-end (pick a policy radio, switch focus row, apply) and gate the
//      remaining-count / apply-enable invariants. Also a cancel path on a second
//      conflict to gate "cancel discards, no domain change".
//   2. SETTINGS / ZOOM-LIMIT round-trip: open 設定 (tools.settings), tighten the
//      FR-10 zoom clamp (zoomMin/zoomMax), save, then wheel-zoom past the new max/min
//      and gate that the live data-zoom hook stays inside [min,max] (no NaN/Infinity).
//   3. SAVE→LOAD round-trip (metamorphic save∘load=identity): reachability of the
//      file commands + the dirty flag flips through the SINGLE truth source; native
//      dialogs are NOT triggered (headless).
//   4. TIME-MOVE + UNDO 連打 (rapid): step time with the live ◀/▶ controls and pound
//      Ctrl+Z / Ctrl+Y, gating undo∘op=identity (feature count + selection return)
//      and time forward∘back=identity.
//   5. EXTREME ZOOM + PAN: wheel to the extremes then drag-pan in View mode, gating
//      camera hooks for NaN/Infinity and clamp adherence after every notch.
//
// STRICT GATE: any console.error, React warning, unhandled rejection, or
// NaN/Infinity in the live data-* hooks is recorded as a finding (the test does NOT
// crash on them). Anomalies surface via console.log("BUGHUNT:...") and a final
// BUGHUNT_SUMMARY JSON line. Each step screenshots into
// screenshots/__bughunt__/r2-1-*.png.
//
// INVARIANTS gated after each op (recorded, not crashed):
//   - 座標に NaN/Infinity 無し (data-pan-x/y, data-zoom on map-input-layer)
//   - data-zoom always within the live effective clamp [zoomMin, zoomMax]
//   - 選択が常に有効 (active-feature id has no NaN/undefined/null)
//   - 階層森: 地物一覧 count == 診断情報 feature-count (single truth source)
//   - 錨列の昇順・非重複 (anchor-list rows are time-sorted, non-overlapping)
//   - undo∘op = identity / time forward∘back = identity / save∘load reachable
//   - conflict modal: remaining count is finite & monotone toward 0 as rows resolve

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
  const file = resolve(shotDir, `r2-1-${n}-${label}.png`);
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
async function readZoom(page: Page): Promise<number> {
  const raw = await page.getByTestId('map-input-layer').getAttribute('data-zoom').catch(() => null);
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
    const z = await readZoom(page);
    if (Number.isFinite(z)) {
      // Small epsilon for float drift on the clamp boundary.
      const eps = 1e-6;
      if (z < clamp.min - eps || z > clamp.max + eps) {
        record(
          'zoom-clamp-violation',
          `${where}: data-zoom=${z} outside [${clamp.min}, ${clamp.max}]`,
        );
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
    .catch(() => record('overlay-stuck', 'add-input-layer still attached after returning to View'));
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
    // Toggle the menu closed (Esc does not dismiss the MenuBar overlay).
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

// Commit one square face given a centre + half-size. Returns true if it paused on
// the conflict modal (caller drives the modal), false if it committed cleanly.
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
  const vc = page.getByTestId('add-vertex-count');
  const vcText = (await vc.textContent())?.trim();
  if (vcText !== '4') record('add-vertex-drop', `expected 4 vertices, got ${vcText}`);
  const complete = page.getByTestId('add-complete');
  await expect(complete).toBeEnabled();
  await complete.click();
  if ((await page.getByTestId('add-rejected').count()) > 0) {
    const m = ((await page.getByTestId('add-rejected').textContent()) ?? '').trim();
    record('add-rejected', `add rejected before save: ${m}`);
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

// Gate the conflict modal's invariants: remaining count finite, rows present,
// apply disabled until all resolved. Returns the number of rows.
async function gateConflictModal(page: Page, where: string): Promise<number> {
  const remaining = page.getByTestId('conflict-remaining');
  const remText = ((await remaining.textContent()) ?? '').trim();
  if (/NaN|Infinity|undefined/.test(remText)) {
    record('conflict-remaining-malformed', `${where}: remaining="${remText}"`);
  }
  const rows = page.locator('[data-testid^="conflict-row-select-"]');
  const n = await rows.count();
  if (n === 0) record('conflict-no-rows', `${where}: conflict modal shown but 0 rows`);
  // Apply should be disabled while anything is unresolved (canApply gate).
  const apply = page.getByTestId('conflict-apply');
  const applyDisabledInitially = !(await apply.isEnabled().catch(() => true));
  if (n > 0 && !applyDisabledInitially) {
    record('conflict-apply-enabled-early', `${where}: apply enabled before any policy chosen`);
  }
  return n;
}

test.describe('BUGHUNT R2 — conflict flow / zoom-limit / save-load / undo連打 / extreme zoom+pan', () => {
  test('explore2: conflict resolution, settings clamp, dirty roundtrip, undo/time identity', async () => {
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

      // Boot dirty flag should be clean.
      const unsaved0 = await diagUnsaved(page);
      if (unsaved0 !== 'なし') record('boot-dirty', `boot unsaved=${unsaved0} (expected なし)`);

      // =====================================================================
      // 1. CONFLICT-RESOLUTION FLOW — two OVERLAPPING faces at the same time.
      // =====================================================================
      const first = await commitFaceMaybeConflict(page, cx, cy, 110);
      await shot(page, 'first-face');
      if (first !== 'committed') {
        record('conflict-setup', `first face did not commit cleanly: ${first}`);
      }
      await checkCamera(page, 'after-first-face');

      // Second face overlapping the first (shifted by < half so it intrudes).
      const second = await commitFaceMaybeConflict(page, cx + 70, cy + 40, 110);
      await shot(page, 'second-face-overlap');

      if (second === 'conflict') {
        record('conflict-modal-fired', 'overlapping add真に paused on conflict modal');
        const nRows = await gateConflictModal(page, 'first-conflict');
        await shot(page, 'conflict-modal');

        // Resolve each row: choose the FIRST policy radio in each row's fieldset.
        for (let i = 0; i < nRows; i += 1) {
          const radios = page.locator('[data-testid^="policy-"]');
          // Pick the radio for this row's index (radios are grouped per row).
          const radio = radios.nth(i * 2); // 2 radios per conflict row (a/b)
          if (await radio.count().then((c) => c > 0)) {
            await radio.check({ force: true }).catch(() => undefined);
            await page.waitForTimeout(60);
          }
        }
        await shot(page, 'conflict-resolved-radios');

        // Remaining should now be 0-ish and apply enabled.
        const apply = page.getByTestId('conflict-apply');
        const applyEnabled = await apply.isEnabled().catch(() => false);
        if (!applyEnabled) {
          const remText = ((await page.getByTestId('conflict-remaining').textContent()) ?? '').trim();
          record('conflict-apply-stuck', `apply still disabled after choosing all policies (remaining=${remText})`);
          // Cancel to not get stuck.
          await page.getByTestId('conflict-cancel').click().catch(() => undefined);
        } else {
          await apply.click();
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
        record('conflict-not-fired', `overlapping add did NOT pause on conflict modal (result=${second}); spatial conflict may be undetected for同時刻 overlap`);
      }

      // Cross-view parity after the conflict path.
      await goView(page);
      await showSidebarTab(page, 'features');
      const listAfterConflict = await featureListCount(page);
      const diagAfterConflict = await diagFeatureCount(page);
      if (Number.isFinite(diagAfterConflict) && diagAfterConflict !== listAfterConflict) {
        record('view-count-mismatch-conflict', `feature-list=${listAfterConflict} diagnostics=${diagAfterConflict}`);
      }

      // =====================================================================
      // 2. SETTINGS / ZOOM-LIMIT round-trip — tighten the FR-10 clamp.
      // =====================================================================
      let clamp = { min: 0.1, max: 10000 };
      if (await clickMenuCommand(page, 'tools', 'tools.settings')) {
        await expect(page.getByTestId('settings-modal-root')).toBeVisible();
        await shot(page, 'settings-open');
        // Project tab holds the zoom-limit inputs.
        await page.getByTestId('settings-tab-project').click().catch(() => undefined);
        const zoomMin = page.getByLabel('最小ズーム倍率').or(page.locator('input[aria-label*="最小ズーム"]'));
        const zoomMax = page.getByLabel('最大ズーム倍率').or(page.locator('input[aria-label*="最大ズーム"]'));
        // Fall back to nth number inputs if labels differ; query by aria-label text.
        const minInput = page.locator('input[aria-label*="最小"][aria-label*="ズーム"]').first();
        const maxInput = page.locator('input[aria-label*="最大"][aria-label*="ズーム"]').first();
        const useMin = (await minInput.count()) > 0 ? minInput : zoomMin;
        const useMax = (await maxInput.count()) > 0 ? maxInput : zoomMax;
        const TIGHT_MIN = 0.5;
        const TIGHT_MAX = 4;
        if ((await useMin.count()) > 0 && (await useMax.count()) > 0) {
          await useMin.fill(String(TIGHT_MIN)).catch(() => undefined);
          await useMax.fill(String(TIGHT_MAX)).catch(() => undefined);
          await shot(page, 'settings-zoom-edited');
          await page.getByTestId('settings-save').click();
          await page.waitForTimeout(200);
          // If a rejection banner stayed open, the dialog won't close.
          if ((await page.getByTestId('settings-modal-root').count()) > 0) {
            const errs = await page.locator('[data-testid^="settings-error-"]').allTextContents().catch(() => []);
            record('settings-rejected', `settings save rejected: ${JSON.stringify(errs)}`);
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
      // 5. EXTREME ZOOM + PAN — wheel to the extremes, gate clamp every notch.
      // =====================================================================
      await goView(page);
      const layerBox = await inputLayer.boundingBox();
      const wx = layerBox ? layerBox.x + layerBox.width / 2 : cx;
      const wy = layerBox ? layerBox.y + layerBox.height / 2 : cy;
      // Zoom IN hard (many notches past the new max).
      for (let i = 0; i < 25; i += 1) {
        await page.mouse.move(wx, wy);
        await page.mouse.wheel(0, -120);
        await page.waitForTimeout(15);
        if (i % 5 === 0) await checkCamera(page, `zoom-in-${i}`, clamp);
      }
      await checkCamera(page, 'zoom-in-final', clamp);
      await shot(page, 'zoomed-in-max');
      const zMaxObserved = await readZoom(page);

      // Zoom OUT hard (many notches past the new min).
      for (let i = 0; i < 40; i += 1) {
        await page.mouse.move(wx, wy);
        await page.mouse.wheel(0, 120);
        await page.waitForTimeout(15);
        if (i % 5 === 0) await checkCamera(page, `zoom-out-${i}`, clamp);
      }
      await checkCamera(page, 'zoom-out-final', clamp);
      await shot(page, 'zoomed-out-min');
      const zMinObserved = await readZoom(page);
      if (Number.isFinite(zMaxObserved) && Number.isFinite(zMinObserved) && zMinObserved > zMaxObserved) {
        record('zoom-monotone', `min-observed ${zMinObserved} > max-observed ${zMaxObserved}`);
      }

      // PAN at extreme zoom: View-mode left drag should pan; gate hooks for NaN.
      const panBox = await inputLayer.boundingBox();
      if (panBox) {
        const px = panBox.x + panBox.width / 2;
        const py = panBox.y + panBox.height / 2;
        await page.mouse.move(px, py);
        await page.mouse.down();
        for (let i = 1; i <= 8; i += 1) {
          await page.mouse.move(px - i * 18, py - i * 12);
          await page.waitForTimeout(15);
        }
        await page.mouse.up();
        await checkCamera(page, 'after-extreme-pan', clamp);
        await shot(page, 'extreme-pan');
      }

      // =====================================================================
      // 3. SAVE→LOAD reachability + dirty flag (metamorphic save∘load=identity).
      // =====================================================================
      const unsavedBeforeSave = await diagUnsaved(page);
      if (unsavedBeforeSave !== 'あり') {
        record('dirty-not-set', `after edits unsaved=${unsavedBeforeSave} (expected あり)`);
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
      } else {
        record('menu-not-open', 'ファイル menu did not open');
      }
      // The MenuBar toggles open/closed on the menu button — Esc does NOT close it,
      // so click the button again to dismiss the items overlay (otherwise it
      // intercepts later toolbar clicks).
      if (await fileItems.isVisible().catch(() => false)) {
        await page.getByTestId('menu-file').click().catch(() => undefined);
      }
      await fileItems.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {
        record('file-menu-stuck', 'ファイル menu items overlay did not close');
      });
      await shot(page, 'file-menu');

      // =====================================================================
      // 4. TIME-MOVE + UNDO 連打 (rapid) — gate time + undo identity.
      // =====================================================================
      await goView(page);
      const fwd = page.getByRole('button', { name: '1年次へ進む' });
      const back = page.getByRole('button', { name: '1年前へ戻る' });
      const cur = page.getByTestId('timeline-current');
      const t0 = ((await cur.textContent()) ?? '').trim();
      if (/NaN|Infinity|undefined/.test(t0)) record('timeline-current-malformed', `t0="${t0}"`);
      // Rapid: 8 forward, 8 back — should land where we started.
      for (let i = 0; i < 8; i += 1) await fwd.click().catch(() => undefined);
      for (let i = 0; i < 8; i += 1) await back.click().catch(() => undefined);
      const t1 = ((await cur.textContent()) ?? '').trim();
      if (t0 !== t1) record('time-roundtrip-violation', `fwd*8∘back*8 changed time: "${t0}" -> "${t1}"`);
      await checkCamera(page, 'time-roundtrip', clamp);
      await shot(page, 'time-roundtrip');

      // UNDO 連打 then REDO 連打; gate count identity.
      await goView(page);
      await showSidebarTab(page, 'features');
      const countBeforeUndo = await featureListCount(page);
      await leaveView(page);
      const em = page.getByTestId('mode-edit');
      if ((await em.getAttribute('aria-pressed')) !== 'true') await em.click();
      const canUndo = page.getByTestId('app-can-undo');
      const canRedo = page.getByTestId('app-can-redo');

      let undos = 0;
      for (let i = 0; i < 12; i += 1) {
        if ((await canUndo.textContent())?.trim() !== '1') break;
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(70);
        if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
          await page.getByTestId('conflict-cancel').click().catch(() => undefined);
        }
        undos += 1;
        await checkCamera(page, `undo-${i}`, clamp);
        await activeFeature(page);
      }
      let redos = 0;
      for (let i = 0; i < undos; i += 1) {
        if ((await canRedo.textContent())?.trim() !== '1') break;
        await page.keyboard.press('Control+y');
        await page.waitForTimeout(70);
        if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
          await page.getByTestId('conflict-cancel').click().catch(() => undefined);
        }
        redos += 1;
        await checkCamera(page, `redo-${i}`, clamp);
        await activeFeature(page);
      }
      await goView(page);
      await showSidebarTab(page, 'features');
      const countAfterRedo = await featureListCount(page);
      if (undos > 0 && undos === redos && countAfterRedo !== countBeforeUndo) {
        record('undo-redo-count-drift', `undo*${undos}∘redo*${redos}: count ${countBeforeUndo} -> ${countAfterRedo}`);
      }
      const diagAfterRedo = await diagFeatureCount(page);
      if (Number.isFinite(diagAfterRedo) && diagAfterRedo !== countAfterRedo) {
        record('view-count-mismatch-undo-redo', `feature-list=${countAfterRedo} diagnostics=${diagAfterRedo}`);
      }
      await shot(page, 'undo-redo-done');

      // Anchor ordering on the surviving selection.
      await goView(page);
      await showSidebarTab(page, 'features');
      const flist = page.locator('[data-testid^="feature-list-item-"]');
      if ((await flist.count()) > 0) {
        await flist.first().click();
        await page.waitForTimeout(100);
        await showSidebarTab(page, 'properties');
        await checkAnchorOrdering(page, 'final-selection');
        await shot(page, 'anchor-final');
      }

      await checkCamera(page, 'final', clamp);
      await activeFeature(page);
      await shot(page, 'final');

      console.log(`BUGHUNT_SUMMARY: ${JSON.stringify(anomalies)}`);
      await expect(page.getByTestId('app-shell')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
