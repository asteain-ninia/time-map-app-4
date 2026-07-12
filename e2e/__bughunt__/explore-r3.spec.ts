// BUGHUNT R3 — e2e exploration (discovery-only). Drives the REAL built Electron
// composite "like a user", complementing R1/R2 with CROSS-VIEW invariant checks
// and settings-driven camera clamp stress:
//   - 地物一覧 (feature-list) count vs 診断情報 (diagnostics feature-count): the two
//     views derive from the SAME committed domain at the SAME time and must agree.
//   - 診断情報 unsaved flag tracks the dirty source (clean at boot, あり after edit).
//   - 設定 zoom-clamp round-trip: shrink the [min,max] zoom range, then wheel-zoom
//     hard and verify the live data-zoom stays inside the clamp and finite.
//   - 検索 (search) over committed features returns plausible hits / no-results.
//   - 地物一覧 / イベント一覧 row click drives the SAME selection + time path the
//     map does (selection re-resolves, time syncs, no NaN).
//   - aggressive interleave: time-scrub + pan + zoom + undo/redo while gating every
//     numeric data-* hook for NaN/Infinity after each step.
//
// STRICT GATE: any console.error, React warning, unhandled rejection, or
// NaN/Infinity in the live data-* hooks is captured as a finding (the test does
// NOT crash on them — it records them so the human review sees every anomaly).
// Anomalies surface via console.log("BUGHUNT:...") and a final BUGHUNT_SUMMARY
// JSON line the runner scrapes. Each step screenshots into
// screenshots/__bughunt__/r3-*.png.

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
  const file = resolve(shotDir, `r3-${n}-${label}.png`);
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

// Gate the numeric camera hooks for non-finite values after every op.
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

async function handleConflictModalIfPresent(page: Page): Promise<boolean> {
  const root = page.getByTestId('conflict-modal-root');
  if ((await root.count()) === 0) return false;
  record('conflict-modal-opened', 'edit commit paused on the conflict-resolution modal');
  const cancel = page.getByTestId('conflict-cancel');
  if (await cancel.isVisible().catch(() => false)) await cancel.click();
  await root.waitFor({ state: 'detached', timeout: 4000 }).catch(() => {
    record('conflict-modal-stuck', 'conflict modal did not close after cancel');
  });
  return true;
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
  if ((await page.getByTestId('add-rejected').count()) > 0) {
    const m = ((await page.getByTestId('add-rejected').textContent()) ?? '').trim();
    record('add-rejected', `add rejected before save: ${m}`);
  }
  await page.getByTestId('add-save').click();
  await handleConflictModalIfPresent(page);
  try {
    await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/, { timeout: 8000 });
  } catch {
    record('add-no-selection', 'active-feature empty after add commit');
  }
  return activeFeature(page);
}

// Open a top menu and click a command item by its command id (the SAME live path
// the menu dispatches through). Returns false if the item never became visible.
async function clickMenuCommand(page: Page, menu: string, commandId: string): Promise<boolean> {
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
    // Close the menu so it does not intercept later input.
    await page.keyboard.press('Escape').catch(() => undefined);
    return false;
  }
  await item.click();
  return true;
}

// Activate a sidebar tab so its tabpanel (otherwise `hidden`) becomes visible.
// The sidebar defaults to the プロパティ tab, so 地物一覧 / イベント一覧 are hidden
// until their tab is selected (Sidebar.tsx tabpanel hidden={active!==key}).
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

// Count the rows in the 地物一覧 (feature-list). Empty list => 0. Assumes the
// features tab is already active (call showSidebarTab(page,'features') first).
async function featureListCount(page: Page): Promise<number> {
  const empty = page.getByTestId('unified-list-empty');
  if ((await empty.count()) > 0) return 0;
  return page.locator('[data-testid^="feature-list-item-"]').count();
}

test.describe('BUGHUNT R3 — cross-view invariants + settings clamp + search', () => {
  test('explore: diagnostics/list parity, zoom clamp, search, list-select sync', async () => {
    // Exploratory spec: it drives MANY user-like ops (adds, modals, settings,
    // search, interleaved time/pan/zoom, undo/redo) in ONE live session, which
    // exceeds the 60s default per-test cap. Raise the budget for THIS spec only so
    // the exploration runs to its BUGHUNT_SUMMARY rather than tripping the cap.
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

      // --- Boot diagnostics: clean dirty flag + no error log --------------------
      if (await clickMenuCommand(page, 'help', 'help.diagnostics')) {
        await expect(page.getByTestId('diagnostics-panel')).toBeVisible();
        const unsaved0 = ((await page.getByTestId('diagnostics-unsaved').textContent()) ?? '').trim();
        if (unsaved0 !== 'なし') {
          record('boot-dirty', `diagnostics shows unsaved=${unsaved0} at a fresh boot (expected なし)`);
        }
        const diagCount0 = ((await page.getByTestId('diagnostics-feature-count').textContent()) ?? '').trim();
        if (/NaN|Infinity|undefined/.test(diagCount0)) {
          record('diag-count-malformed', `boot feature-count="${diagCount0}"`);
        }
        const curTime0 = ((await page.getByTestId('diagnostics-current-time').textContent()) ?? '').trim();
        if (/NaN|Infinity|undefined/.test(curTime0)) {
          record('diag-time-malformed', `boot current-time="${curTime0}"`);
        }
        await shot(page, 'diagnostics-boot');
        await page.getByTestId('diagnostics-panel-close').click().catch(() => undefined);
        await page.keyboard.press('Escape').catch(() => undefined);
      }

      // --- Build a small aggregation: PARENT > CHILD + one disjoint face --------
      const parentId = await commitFace(page, cx - 150, cy + 10, 90);
      await shot(page, 'parent-added');
      if (parentId === '') record('add-empty', 'parent face id empty after commit');

      const childId = await commitFace(page, cx - 150, cy + 10, 40, 1);
      await shot(page, 'child-added');
      if (childId === parentId) record('id-collide', `child id == parent id (${childId})`);

      const otherId = await commitFace(page, cx + 150, cy - 10, 70);
      await shot(page, 'other-added');
      if (otherId === '') record('add-empty', 'other face id empty after commit');

      await goView(page);
      await checkCamera(page, 'after-adds');

      // --- Cross-view parity: 地物一覧 count == 診断情報 feature-count ----------
      await showSidebarTab(page, 'features');
      const listCount = await featureListCount(page);
      if (await clickMenuCommand(page, 'help', 'help.diagnostics')) {
        await expect(page.getByTestId('diagnostics-panel')).toBeVisible();
        const diagRaw = ((await page.getByTestId('diagnostics-feature-count').textContent()) ?? '').trim();
        const diagCount = Number(diagRaw);
        const unsaved1 = ((await page.getByTestId('diagnostics-unsaved').textContent()) ?? '').trim();
        // Metamorphic: a domain edit must flip the single dirty source to あり.
        if (unsaved1 !== 'あり') {
          record('dirty-not-set', `after 3 adds diagnostics unsaved=${unsaved1} (expected あり)`);
        }
        // Cross-view invariant: the two derivations of "features effective now"
        // (sidebar 地物一覧 vs 診断情報) read the SAME committed domain at the SAME
        // time and MUST agree (技術方針 2.5 single truth source).
        if (Number.isFinite(diagCount) && diagCount !== listCount) {
          record(
            'view-count-mismatch',
            `feature-list count=${listCount} but diagnostics feature-count=${diagRaw}`,
          );
        }
        await shot(page, 'diagnostics-after-adds');
        await page.getByTestId('diagnostics-panel-close').click().catch(() => undefined);
        await page.keyboard.press('Escape').catch(() => undefined);
      }

      // --- Search reachability + result plausibility (FR-113) ------------------
      if (await clickMenuCommand(page, 'tools', 'tools.search')) {
        await expect(page.getByTestId('search-panel')).toBeVisible();
        // A query that should match nothing in the committed features.
        await page.getByTestId('search-panel-input').fill('ZZZ_NOMATCH_QUERY_QQ');
        await page.getByTestId('search-panel-run').click();
        await expect(page.getByTestId('search-panel-results')).toBeVisible();
        const noRes = await page.getByTestId('search-panel-no-results').count();
        const hitsForNonsense = await page.getByTestId('search-panel-hit').count();
        if (noRes === 0 && hitsForNonsense > 0) {
          record('search-false-hit', `nonsense query returned ${hitsForNonsense} hits`);
        }
        await shot(page, 'search-no-results');
        // An empty query is a degenerate input — should not crash / show NaN.
        await page.getByTestId('search-panel-input').fill('');
        await page.getByTestId('search-panel-run').click();
        const errTxt = await page.getByTestId('search-panel-error').textContent().catch(() => null);
        if (errTxt !== null && /NaN|undefined|Infinity/.test(errTxt)) {
          record('search-error-malformed', `search error text="${errTxt}"`);
        }
        await shot(page, 'search-empty');
        await page.getByTestId('search-panel-close').click().catch(() => undefined);
        await page.keyboard.press('Escape').catch(() => undefined);
      }

      // --- Settings zoom-clamp round-trip (FR-10 / FR-109) ---------------------
      // Shrink [min,max] to a narrow window, save, then wheel-zoom hard and assert
      // the live data-zoom stays inside the clamp and finite.
      if (await clickMenuCommand(page, 'tools', 'tools.settings')) {
        await expect(page.getByTestId('settings-dialog')).toBeVisible();
        await page.getByTestId('settings-tab-project').click().catch(() => undefined);
        const minField = page.getByLabel('最小ズーム倍率');
        const maxField = page.getByLabel('最大ズーム倍率');
        if ((await minField.count()) > 0 && (await maxField.count()) > 0) {
          await minField.fill('0.5');
          await maxField.fill('2');
          await page.getByTestId('settings-save').click();
          // If validation rejected, the dialog stays open with errors — record it.
          if ((await page.getByTestId('settings-dialog').count()) > 0) {
            const errs = await page.getByTestId('settings-errors').textContent().catch(() => null);
            record('settings-save-blocked', `zoom range [0.5,2] did not save; errors=${errs ?? '(none shown)'}`);
            await page.getByTestId('settings-cancel').click().catch(() => undefined);
          }
        } else {
          record('settings-zoom-fields-missing', 'zoom min/max fields not found in project tab');
          await page.getByTestId('settings-cancel').click().catch(() => undefined);
        }
        await page.getByTestId('settings-dialog').waitFor({ state: 'detached', timeout: 4000 }).catch(() => undefined);
        await shot(page, 'settings-zoom-clamped');
      }

      // Now wheel-zoom hard in both directions against the [0.5,2] clamp.
      await goView(page);
      await page.mouse.move(cx, cy);
      for (let i = 0; i < 10; i += 1) await page.mouse.wheel(0, -240);
      const zMax = Number(await inputLayer.getAttribute('data-zoom'));
      await checkCamera(page, 'after-zoom-in-clamp');
      if (Number.isFinite(zMax) && zMax > 2 + 1e-6) {
        record('zoom-clamp-exceeded-max', `data-zoom=${zMax} exceeds clamped max 2 after hard zoom-in`);
      }
      for (let i = 0; i < 20; i += 1) await page.mouse.wheel(0, 240);
      const zMin = Number(await inputLayer.getAttribute('data-zoom'));
      await checkCamera(page, 'after-zoom-out-clamp');
      if (Number.isFinite(zMin) && zMin < 0.5 - 1e-6) {
        record('zoom-clamp-exceeded-min', `data-zoom=${zMin} below clamped min 0.5 after hard zoom-out`);
      }
      await shot(page, 'zoom-clamp');

      // --- 地物一覧 row click drives the live selection path --------------------
      await goView(page);
      await showSidebarTab(page, 'features');
      const rows = page.locator('[data-testid^="feature-list-item-"]');
      const rowCount = await rows.count();
      if (rowCount === 0) {
        record('unified-list-empty-unexpected', 'feature list empty after committing 3 faces');
      }
      for (let i = 0; i < rowCount; i += 1) {
        const row = rows.nth(i);
        const testid = (await row.getAttribute('data-testid')) ?? '';
        const expectedId = testid.replace('feature-list-item-', '');
        await row.click();
        const sel = await activeFeature(page);
        // Selecting a list row should promote EXACTLY that feature (single
        // selection source). A mismatch means a second selection truth exists.
        if (sel !== '' && expectedId !== '' && sel !== expectedId) {
          record('list-select-mismatch', `clicked row ${expectedId} but active-feature=${sel}`);
        }
        if (sel === '') {
          record('list-select-empty', `clicking list row ${expectedId} yielded empty selection`);
        }
        await checkCamera(page, `list-select-${i}`);
      }
      await shot(page, 'list-select');

      // --- イベント一覧 row click syncs time + selection ------------------------
      await showSidebarTab(page, 'events');
      const eventRows = page.locator('[data-testid^="event-list-item-"]');
      const evCount = await eventRows.count();
      if (evCount > 0) {
        const current = page.getByTestId('timeline-current');
        const beforeTime = ((await current.textContent()) ?? '').trim();
        await eventRows.first().click();
        const afterTime = ((await current.textContent()) ?? '').trim();
        if (/NaN|Infinity|undefined/.test(afterTime)) {
          record('event-sync-time-malformed', `time after event-jump="${afterTime}"`);
        }
        const selAfterEvent = await activeFeature(page);
        if (selAfterEvent === '') {
          record('event-sync-no-selection', 'event-list jump did not promote a feature');
        }
        void beforeTime;
        await checkCamera(page, 'after-event-jump');
        await shot(page, 'event-jump');
      }

      // --- Aggressive interleave: time + pan + zoom + undo/redo -----------------
      await goView(page);
      const fwd = page.getByRole('button', { name: '1年次へ進む' });
      const back = page.getByRole('button', { name: '1年前へ戻る' });
      for (let i = 0; i < 6; i += 1) {
        await fwd.click();
        await page.mouse.move(cx, cy);
        await page.mouse.wheel(0, i % 2 === 0 ? -180 : 180);
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + (i % 2 === 0 ? 60 : -60), cy + 40, { steps: 5 });
        await page.mouse.up();
        await checkCamera(page, `interleave-${i}`);
      }
      for (let i = 0; i < 6; i += 1) {
        await back.click();
        await checkCamera(page, `interleave-back-${i}`);
      }
      await shot(page, 'interleave');

      // --- Undo/redo metamorphic (edit mode) -----------------------------------
      await leaveView(page);
      const em = page.getByTestId('mode-edit');
      if ((await em.getAttribute('aria-pressed')) !== 'true') await em.click();
      const canUndo = page.getByTestId('app-can-undo');
      const canRedo = page.getByTestId('app-can-redo');
      const featBefore = await activeFeature(page);
      let undos = 0;
      for (let i = 0; i < 3; i += 1) {
        if ((await canUndo.textContent())?.trim() !== '1') break;
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(150);
        undos += 1;
        await checkCamera(page, `undo-${i}`);
        await activeFeature(page);
      }
      for (let i = 0; i < undos; i += 1) {
        if ((await canRedo.textContent())?.trim() !== '1') break;
        await page.keyboard.press('Control+y');
        await page.waitForTimeout(150);
        await checkCamera(page, `redo-${i}`);
        await activeFeature(page);
      }
      const featAfter = await activeFeature(page);
      if (featBefore !== '' && featAfter === '') {
        record('redo-lost-selection', `undo*${undos} -> redo*${undos} lost selection (was ${featBefore})`);
      }
      await handleConflictModalIfPresent(page);
      await shot(page, 'after-undo-redo');

      // --- Post-undo/redo cross-view parity re-check ---------------------------
      await goView(page);
      await showSidebarTab(page, 'features');
      const listCount2 = await featureListCount(page);
      if (await clickMenuCommand(page, 'help', 'help.diagnostics')) {
        await expect(page.getByTestId('diagnostics-panel')).toBeVisible();
        const diagRaw2 = ((await page.getByTestId('diagnostics-feature-count').textContent()) ?? '').trim();
        const diagCount2 = Number(diagRaw2);
        if (Number.isFinite(diagCount2) && diagCount2 !== listCount2) {
          record(
            'view-count-mismatch-post-undo',
            `after undo/redo: feature-list=${listCount2} diagnostics=${diagRaw2}`,
          );
        }
        await shot(page, 'diagnostics-post-undo');
        await page.getByTestId('diagnostics-panel-close').click().catch(() => undefined);
        await page.keyboard.press('Escape').catch(() => undefined);
      }

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
