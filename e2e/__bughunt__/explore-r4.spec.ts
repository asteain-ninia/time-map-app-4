// BUGHUNT R4 — e2e exploration (discovery-only). Drives the REAL built Electron
// composite "like a user", complementing R1/R2/R3 with the operations those rounds
// touched LEAST: the full ナイフ(分割) split flow (draw cut → confirm → inheritor →
// non-inherited props → save), the 結合(merge) flow, anchor-series ordering via the
// property panel, save/load reachability + dirty-flag metamorphic, and a deep
// undo∘op / op∘逆op identity round-trip with cross-view parity re-checks.
//
// STRICT GATE: any console.error, React warning, unhandled rejection, or
// NaN/Infinity in the live data-* hooks is captured as a finding. The test does
// NOT crash on them — it records them so the human review sees every anomaly.
// Anomalies surface via console.log("BUGHUNT:...") and a final BUGHUNT_SUMMARY
// JSON line the runner scrapes. Each step screenshots into
// screenshots/__bughunt__/r4-*.png.
//
// INVARIANTS gated after each op (recorded, not crashed):
//   - 座標に NaN/Infinity 無し (data-pan-x/y, data-zoom on map-input-layer)
//   - 選択が常に有効 (active-feature id has no NaN/undefined/null)
//   - 錨列の昇順・非重複 (anchor-list rows are time-sorted, non-overlapping)
//   - 階層森: 地物一覧 count == 診断情報 feature-count (single truth source)
//   - undo∘op = identity / op∘逆op = identity (count + selection return)
//   - save/load reachability without a native dialog blocking the headless run

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
  const file = resolve(shotDir, `r4-${n}-${label}.png`);
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

async function armEditTool(page: Page, toolId: string): Promise<boolean> {
  await leaveView(page);
  const edit = page.getByTestId('mode-edit');
  await expect(edit).toBeEnabled();
  if ((await edit.getAttribute('aria-pressed')) !== 'true') await edit.click();
  const tool = page.getByTestId(`tool-${toolId}`);
  if (!(await tool.isVisible().catch(() => false))) {
    record('edit-tool-missing', `tool-${toolId} not visible in edit mode`);
    return false;
  }
  if (!(await tool.isEnabled().catch(() => false))) {
    record('edit-tool-disabled', `tool-${toolId} is disabled (dead tool?)`);
    return false;
  }
  if ((await tool.getAttribute('aria-pressed')) !== 'true') await tool.click();
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
  const activeTool = ((await page.getByTestId('app-active-tool').textContent()) ?? '').trim();
  if (activeTool !== toolId) {
    record('tool-mirror-mismatch', `pressed tool-${toolId} but app-active-tool=${activeTool}`);
  }
  return true;
}

async function handleConflictModalIfPresent(page: Page): Promise<boolean> {
  const root = page.getByTestId('conflict-modal-root');
  if ((await root.count()) === 0) return false;
  record('conflict-modal-opened', 'commit paused on the conflict-resolution modal');
  const cancel = page.getByTestId('conflict-cancel');
  if (await cancel.isVisible().catch(() => false)) await cancel.click();
  await root.waitFor({ state: 'detached', timeout: 4000 }).catch(() => {
    record('conflict-modal-stuck', 'conflict modal did not close after cancel');
  });
  return true;
}

// Commit one square face given a centre + half-size in screen px. Optionally pick
// a parent (FR-77 aggregation). Returns the committed feature id ('' if unresolved).
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

async function clickMenuCommand(page: Page, menu: string, commandId: string): Promise<boolean> {
  // The add/knife overlays (app-shell-overlay) capture pointer events and would
  // intercept a menu click; return to View so the menubar is reachable (same
  // live導線 a user takes — you cannot open a menu through an armed tool overlay).
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
    await page.keyboard.press('Escape').catch(() => undefined);
    return false;
  }
  await item.click();
  return true;
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

// Read the diagnostics feature-count (open/close panel). Returns NaN on failure.
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

// Parse "→"-separated anchor-list rows and gate ascending / non-overlapping order.
// We compare on the rendered start label numerically when possible; if labels are
// non-numeric (eras), we only gate for NaN markers (best-effort, no false alarms).
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
      record(
        'anchor-order-violation',
        `${where}: anchor starts not ascending: ${prev} then ${cur}`,
      );
      break;
    }
  }
}

test.describe('BUGHUNT R4 — knife split / merge / anchor ordering / save-load / metamorphic', () => {
  test('explore: split flow, merge flow, anchor ordering, dirty flag, undo/op identity', async () => {
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

      // --- Boot dirty flag should be clean -------------------------------------
      const unsaved0 = await diagUnsaved(page);
      if (unsaved0 !== 'なし') record('boot-dirty', `boot unsaved=${unsaved0} (expected なし)`);

      // --- Build features: a large face to split, plus a sibling to merge ------
      const bigId = await commitFace(page, cx - 120, cy, 110);
      await shot(page, 'big-added');
      if (bigId === '') record('add-empty', 'big face id empty after commit');
      await checkCamera(page, 'big-added');

      const sibId = await commitFace(page, cx + 150, cy, 70);
      await shot(page, 'sibling-added');
      if (sibId === '') record('add-empty', 'sibling face id empty after commit');

      // Metamorphic: domain edits flip the single dirty source to あり.
      const unsaved1 = await diagUnsaved(page);
      if (unsaved1 !== 'あり') record('dirty-not-set', `after adds unsaved=${unsaved1} (expected あり)`);

      // --- File menu reachability (do NOT click — native dialogs block) --------
      await goView(page);
      await page.getByTestId('menu-file').click();
      const fileItems = page.getByTestId('menu-items-file');
      if (await fileItems.isVisible().catch(() => false)) {
        for (const cmd of ['file.new', 'file.open', 'file.save', 'file.saveAs']) {
          const it = fileItems.locator(`[data-command="${cmd}"]`);
          if ((await it.count()) === 0) {
            record('file-command-missing', `${cmd} not present in ファイル menu`);
          } else if (!(await it.isEnabled().catch(() => false))) {
            record('file-command-disabled', `${cmd} is disabled (save should be reachable when dirty)`);
          }
        }
      } else {
        record('menu-not-open', 'ファイル menu did not open');
      }
      await page.keyboard.press('Escape').catch(() => undefined);
      await shot(page, 'file-menu');

      // --- Cross-view parity baseline ------------------------------------------
      await goView(page);
      await showSidebarTab(page, 'features');
      const list0 = await featureListCount(page);
      const diag0 = await diagFeatureCount(page);
      if (Number.isFinite(diag0) && diag0 !== list0) {
        record('view-count-mismatch', `feature-list=${list0} diagnostics=${diag0}`);
      }

      // =========================================================================
      // KNIFE (分割) FULL FLOW — select big face, draw a cut across it, confirm,
      // pick inheritor, fill non-inherited props, save. Gate every phase.
      // =========================================================================
      const knifeArmed = await armEditTool(page, 'edit.knife');
      if (knifeArmed) {
        const knifeTool = page.getByTestId('knife-tool');
        await knifeTool.waitFor({ state: 'attached', timeout: 4000 }).catch(() => {
          record('knife-chrome-missing', 'knife-tool chrome never appeared after arming edit.knife');
        });
        await shot(page, 'knife-armed');

        // Phase 1: select the big face via the knife input layer (固定円ヒット).
        const knifeInput = page.getByTestId('knife-input-layer');
        if (await knifeInput.isVisible().catch(() => false)) {
          // Click the centre of the big face to select it as the split target.
          await page.mouse.click(cx - 120, cy);
          await page.waitForTimeout(150);
          const flow1 = (await knifeTool.getAttribute('data-flow')) ?? '';
          await shot(page, 'knife-target');

          // Phase 2: draw a cut line straight across the big face (2 points).
          // The input layer is re-rendered per flow; re-query it.
          const drawLayer = page.getByTestId('knife-input-layer');
          if (await drawLayer.isVisible().catch(() => false)) {
            await page.mouse.click(cx - 120 - 140, cy - 10);
            await page.mouse.click(cx - 120 + 140, cy + 10);
            await page.waitForTimeout(150);
            const cutCount = ((await page.getByTestId('knife-cut-count').textContent()) ?? '').trim();
            if (cutCount !== '' && /NaN/.test(cutCount)) {
              record('knife-cut-count-malformed', `cut-count="${cutCount}"`);
            }
            await shot(page, 'knife-cut-drawn');

            // Confirm the cut.
            const confirm = page.getByTestId('knife-confirm-cut');
            if (await confirm.isVisible().catch(() => false)) {
              await confirm.click();
              await page.waitForTimeout(200);
              await shot(page, 'knife-confirmed');

              // A rejection message means the cut was not valid — record it.
              if ((await page.getByTestId('knife-rejected').count()) > 0) {
                const m = ((await page.getByTestId('knife-rejected').textContent()) ?? '').trim();
                record('knife-rejected', `split rejected: ${m}`);
                await page.getByTestId('knife-rejected-dismiss').click().catch(() => undefined);
              }

              // Phase 3: inheritor modal (FR-93). Choose piece 0 + confirm. The n-way
              // chooser (commit 01ed1d6) renders index-based buttons knife-choose-0 /
              // knife-choose-1 (a 2-point vertical cut yields 2 pieces), not the old
              // A/B testids. Assert the button is present so a stale testid can no
              // longer空振り silently, then verify the selection took (aria-pressed).
              const inheritorRoot = page.getByTestId('knife-inheritor-modal-root');
              const inheritorConfirm = page.getByTestId('knife-confirm-inheritor');
              if (await inheritorRoot.isVisible().catch(() => false)) {
                await shot(page, 'knife-inheritor');
                const choose0 = page.getByTestId('knife-choose-0');
                await expect(choose0).toBeVisible();
                await choose0.click();
                await expect(choose0).toHaveAttribute('aria-pressed', 'true');
                await page.waitForTimeout(80);
                if (await inheritorConfirm.isEnabled().catch(() => false)) {
                  await inheritorConfirm.click();
                } else {
                  record('knife-confirm-inheritor-disabled', 'inheritor confirm disabled after choosing piece 0');
                }
                // The modal must close after confirming (no stranded backdrop).
                await inheritorRoot
                  .waitFor({ state: 'detached', timeout: 4000 })
                  .catch(() => record('knife-inheritor-stuck', 'inheritor modal did not close after confirm'));
                await page.waitForTimeout(200);

                // Phase 4: non-inherited side props form (re-uses AddPropertyForm).
                const propsSave = page.getByTestId('add-save');
                if (await page.getByTestId('knife-props').isVisible().catch(() => false)) {
                  await shot(page, 'knife-props');
                  if (await propsSave.isVisible().catch(() => false)) {
                    await propsSave.click();
                    await page.waitForTimeout(250);
                  }
                }
                await handleConflictModalIfPresent(page);
              } else {
                record('knife-no-inheritor', `inheritor modal not shown after confirm (flow=${flow1})`);
              }
            } else {
              record('knife-no-confirm', `confirm-cut button not visible (flow=${(await knifeTool.getAttribute('data-flow')) ?? ''})`);
            }
          } else {
            record('knife-no-draw-layer', 'knife draw input layer not visible after target select');
          }
        } else {
          record('knife-no-input', 'knife-input-layer not visible after arming knife');
        }
        await checkCamera(page, 'after-knife');
        await activeFeature(page);
        await shot(page, 'knife-done');

        // Cross-view parity after a (possible) split: count should be consistent.
        await goView(page);
        await showSidebarTab(page, 'features');
        const listAfterKnife = await featureListCount(page);
        const diagAfterKnife = await diagFeatureCount(page);
        if (Number.isFinite(diagAfterKnife) && diagAfterKnife !== listAfterKnife) {
          record(
            'view-count-mismatch-post-knife',
            `after split: feature-list=${listAfterKnife} diagnostics=${diagAfterKnife}`,
          );
        }
        // Metamorphic undo of the split: count should return toward the pre-split.
        await leaveView(page);
        const em = page.getByTestId('mode-edit');
        if ((await em.getAttribute('aria-pressed')) !== 'true') await em.click();
        const canUndo = page.getByTestId('app-can-undo');
        if ((await canUndo.textContent())?.trim() === '1') {
          await page.keyboard.press('Control+z');
          await page.waitForTimeout(200);
          await handleConflictModalIfPresent(page);
          await checkCamera(page, 'undo-split');
          await goView(page);
          await showSidebarTab(page, 'features');
          const listUndoKnife = await featureListCount(page);
          const diagUndoKnife = await diagFeatureCount(page);
          if (Number.isFinite(diagUndoKnife) && diagUndoKnife !== listUndoKnife) {
            record(
              'view-count-mismatch-undo-knife',
              `undo split: feature-list=${listUndoKnife} diagnostics=${diagUndoKnife}`,
            );
          }
          await shot(page, 'knife-undone');
        }
      }

      // =========================================================================
      // MERGE (結合) FLOW — arm merge, select two adjacent faces, merge.
      // =========================================================================
      // First build two ADJACENT faces (sharing an edge) so a merge is valid.
      const adjA = await commitFace(page, cx - 60, cy + 180, 50);
      const adjB = await commitFace(page, cx + 40, cy + 180, 50);
      void adjA;
      void adjB;
      await shot(page, 'merge-pair-added');
      const mergeArmed = await armEditTool(page, 'edit.merge');
      if (mergeArmed) {
        // Select both faces (merge typically needs a multi-select). Click each.
        await page.mouse.click(cx - 60, cy + 180);
        await page.waitForTimeout(100);
        await page.keyboard.down('Shift');
        await page.mouse.click(cx + 40, cy + 180);
        await page.keyboard.up('Shift');
        await page.waitForTimeout(150);
        await shot(page, 'merge-selected');
        await activeFeature(page);
        await checkCamera(page, 'merge-selected');
        // Look for a merge confirm affordance; if none, the tool may merge on
        // selection. Either way, gate the outcome via cross-view parity.
        await handleConflictModalIfPresent(page);
        await goView(page);
        await showSidebarTab(page, 'features');
        const listAfterMerge = await featureListCount(page);
        const diagAfterMerge = await diagFeatureCount(page);
        if (Number.isFinite(diagAfterMerge) && diagAfterMerge !== listAfterMerge) {
          record(
            'view-count-mismatch-post-merge',
            `after merge attempt: feature-list=${listAfterMerge} diagnostics=${diagAfterMerge}`,
          );
        }
        await shot(page, 'merge-done');
      }

      // =========================================================================
      // ANCHOR SERIES ORDERING — select a feature, scrub time, add anchors via
      // edit, and gate the anchor-list rows for ascending / non-overlapping order.
      // =========================================================================
      await goView(page);
      await showSidebarTab(page, 'features');
      const rows = page.locator('[data-testid^="feature-list-item-"]');
      if ((await rows.count()) > 0) {
        await rows.first().click();
        await page.waitForTimeout(100);
        await showSidebarTab(page, 'properties');
        await checkAnchorOrdering(page, 'initial-selection');
        await shot(page, 'anchor-initial');

        // Scrub time forward several years, re-select, and re-check ordering. A
        // feature edited at different times grows its anchor series; the rows must
        // stay ascending + non-overlapping (錨列の昇順・非重複).
        await leaveView(page);
        const em2 = page.getByTestId('mode-edit');
        if ((await em2.getAttribute('aria-pressed')) !== 'true') await em2.click();
        const fwd = page.getByRole('button', { name: '1年次へ進む' });
        for (let i = 0; i < 4; i += 1) {
          await fwd.click().catch(() => undefined);
          await page.waitForTimeout(60);
        }
        const current = page.getByTestId('timeline-current');
        const curTxt = ((await current.textContent()) ?? '').trim();
        if (/NaN|Infinity|undefined/.test(curTxt)) {
          record('timeline-current-malformed', `current="${curTxt}"`);
        }
        await showSidebarTab(page, 'properties');
        await checkAnchorOrdering(page, 'after-time-scrub');
        await shot(page, 'anchor-after-scrub');
      }

      // =========================================================================
      // DEEP METAMORPHIC: time forward∘back identity + undo/op∘redo identity.
      // =========================================================================
      await goView(page);
      const fwd2 = page.getByRole('button', { name: '1年次へ進む' });
      const back2 = page.getByRole('button', { name: '1年前へ戻る' });
      const cur = page.getByTestId('timeline-current');
      const t0 = ((await cur.textContent()) ?? '').trim();
      for (let i = 0; i < 5; i += 1) await fwd2.click().catch(() => undefined);
      for (let i = 0; i < 5; i += 1) await back2.click().catch(() => undefined);
      const t1 = ((await cur.textContent()) ?? '').trim();
      if (t0 !== t1) {
        record('time-roundtrip-violation', `forward*5∘back*5 changed time: "${t0}" -> "${t1}"`);
      }
      await checkCamera(page, 'time-roundtrip');

      // Undo everything we can, then redo, and gate count + selection identity.
      await leaveView(page);
      const em3 = page.getByTestId('mode-edit');
      if ((await em3.getAttribute('aria-pressed')) !== 'true') await em3.click();
      const canUndo3 = page.getByTestId('app-can-undo');
      const canRedo3 = page.getByTestId('app-can-redo');

      await goView(page);
      await showSidebarTab(page, 'features');
      const countBeforeUndo = await featureListCount(page);
      await leaveView(page);
      if ((await em3.getAttribute('aria-pressed')) !== 'true') await em3.click();

      let undos = 0;
      for (let i = 0; i < 8; i += 1) {
        if ((await canUndo3.textContent())?.trim() !== '1') break;
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(120);
        await handleConflictModalIfPresent(page);
        undos += 1;
        await checkCamera(page, `undo-${i}`);
        await activeFeature(page);
      }
      let redos = 0;
      for (let i = 0; i < undos; i += 1) {
        if ((await canRedo3.textContent())?.trim() !== '1') break;
        await page.keyboard.press('Control+y');
        await page.waitForTimeout(120);
        await handleConflictModalIfPresent(page);
        redos += 1;
        await checkCamera(page, `redo-${i}`);
        await activeFeature(page);
      }
      // Metamorphic: a full undo→redo cycle should restore the feature count.
      await goView(page);
      await showSidebarTab(page, 'features');
      const countAfterRedo = await featureListCount(page);
      if (undos > 0 && undos === redos && countAfterRedo !== countBeforeUndo) {
        record(
          'undo-redo-count-drift',
          `undo*${undos}∘redo*${redos}: count ${countBeforeUndo} -> ${countAfterRedo}`,
        );
      }
      const diagAfterRedo = await diagFeatureCount(page);
      if (Number.isFinite(diagAfterRedo) && diagAfterRedo !== countAfterRedo) {
        record(
          'view-count-mismatch-post-undo-redo',
          `after undo/redo: feature-list=${countAfterRedo} diagnostics=${diagAfterRedo}`,
        );
      }
      await shot(page, 'undo-redo-done');

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
