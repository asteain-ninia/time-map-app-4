// BUGHUNT R2 (explore2-r2) — e2e exploration (discovery-only). Drives the REAL
// built Electron composite "like a user" with an operation plan deliberately
// DIFFERENT from explore2-r1 (which covered conflict-modal / settings-zoom-clamp /
// save-load / undo連打 / extreme-zoom+pan). This round exercises the surfaces that
// round LEFT UNTOUCHED, to stress different invariants:
//
//   A. KNIFE / SPLIT FLOW (FR-90..94): commit one face, arm 編集→ナイフ, select it,
//      draw a piercing cut, drive the 継承先選択 modal (toggle A/B, confirm), then
//      fill the 非継承側プロパティ form and SAVE. Gates:
//        - non-self-crossing / ring validity surfaces as no add-rejected and a clean
//          split (count goes 1 -> 2);
//        - 階層森: 地物一覧 count == 診断 feature-count after the split (single truth);
//        - selection always valid; camera hooks finite throughout.
//      Also a NON-PIERCING cut to gate the Japanese rejection ("貫く") path.
//   B. PARENT/CHILD FOREST (FR-44): add a CHILD face with a parent chosen through the
//      live add-parent <select>, gating that the child commits, the forest grows by
//      exactly 1, and counts stay consistent (derived aggregation single-source).
//   C. SEARCH PANEL (FR-113): open ツール→検索, run a query, gate results are not
//      malformed (no NaN/Infinity), no-results / error paths behave, and that
//      clicking a hit yields a valid selection.
//   D. TIME EXTREMES + YMD round-trip: drag the timeline slider to both edges and
//      gate timeline-current never goes NaN/Infinity; step unit forward∘back=identity.
//   E. DELETE + UNDO metamorphic (op∘逆op=identity): select a face, 削除, then Ctrl+Z,
//      gating the feature count returns to its pre-delete value and selection is valid.
//
// STRICT GATE: any console.error, React warning, unhandled rejection, or
// NaN/Infinity in the live data-* hooks / readouts is recorded as a finding (the
// test does NOT crash on them). Anomalies surface via console.log("BUGHUNT:...")
// and a final BUGHUNT_SUMMARY JSON line. Each step screenshots into
// screenshots/__bughunt__/r2-2-*.png.
//
// INVARIANTS gated after each op (recorded, not crashed):
//   - 座標に NaN/Infinity 無し (data-pan-x/y, data-zoom on map-input-layer)
//   - 選択が常に有効 (active-feature id has no NaN/undefined/null)
//   - 階層森: 地物一覧 count == 診断情報 feature-count (single truth source)
//   - 錨列の昇順・非重複 (anchor-list rows time-sorted, non-overlapping)
//   - knife: split = 1->2, non-piercing rejected with 日本語 message, no add-rejected
//   - metamorphic: delete∘undo = identity (count) / time fwd∘back = identity

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { test, expect, type Page, type Locator } from '@playwright/test';

import {
  launchApp,
  leaveViewMode,
  returnToViewMode,
  armAddAreaTool,
  squareCorners,
  placeVertices,
  confirmDeleteIfAsked,
  listedFeatureCount,
} from '../helpers';
import { assertClickable, fitHalf, placeSquareScene } from './scene-layout';

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
  const file = resolve(shotDir, `r2-2-${n}-${label}.png`);
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
  // 増分 4: 台帳は仮想スクロールなので **行の DOM 数 != 件数**。件数の真実源は
  // `unified-list-count` の表示で、共通ヘルパ 1 本に寄せてある（helpers.listedFeatureCount）。
  return listedFeatureCount(page);
}

async function clickMenuCommand(page: Page, menu: string, commandId: string): Promise<boolean> {
  await returnToViewMode(page);
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

// Commit one square face given a centre + half-size; choose an optional parent via
// the live add-parent <select>. Returns 'committed' | 'rejected' | 'conflict'.
async function commitFace(
  page: Page,
  cx: number,
  cy: number,
  half: number,
  opts?: { readonly chooseParentIndex?: number; readonly name?: string },
): Promise<'committed' | 'rejected' | 'conflict'> {
  await armAddAreaTool(page);
  await placeVertices(page, squareCorners(cx, cy, half));
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
  // Optional parent selection through the live <select> (FR-44 forest).
  if (opts?.chooseParentIndex !== undefined) {
    const parent = page.getByTestId('add-parent');
    if ((await parent.count()) > 0) {
      const optionVals = await parent.locator('option').evaluateAll((els) =>
        (els as HTMLOptionElement[]).map((o) => o.value),
      );
      const idx = opts.chooseParentIndex;
      if (idx >= 0 && idx < optionVals.length && optionVals[idx] !== undefined) {
        await parent.selectOption(optionVals[idx]).catch(() => undefined);
      } else {
        record('add-parent-no-option', `requested parent index ${idx} but only ${optionVals.length} options`);
      }
    } else {
      record('add-parent-missing', 'add-parent select not present for a face add');
    }
  }
  if (opts?.name !== undefined) {
    await page.getByTestId('add-name').fill(opts.name).catch(() => undefined);
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

async function armKnife(page: Page): Promise<boolean> {
  await leaveViewMode(page);
  const edit = page.getByTestId('mode-edit');
  await expect(edit).toBeEnabled();
  if ((await edit.getAttribute('aria-pressed')) !== 'true') await edit.click();
  const knife = page.getByTestId('tool-edit.knife');
  if (!(await knife.isVisible().catch(() => false))) {
    record('knife-tool-missing', 'tool-edit.knife not visible in edit mode');
    return false;
  }
  if ((await knife.getAttribute('aria-pressed')) !== 'true') await knife.click();
  // The knife chrome (guide layer) should appear.
  await page.getByTestId('knife-tool').waitFor({ state: 'attached', timeout: 4000 }).catch(() => {
    record('knife-chrome-missing', 'knife-tool chrome did not mount after arming');
  });
  return true;
}

test.describe('BUGHUNT R2 — knife split / forest parent / search / time extremes / delete-undo', () => {
  test('explore2-r2: split, parent-child, search, time-edges, delete∘undo identity', async () => {
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

      // =====================================================================
      // A. KNIFE / SPLIT FLOW — commit a face, split it cleanly, gate forest.
      // =====================================================================
      // UI 再設計 増分 1: シェルに行が増えて地図セルが縦に約 74px 縮んだ（オプションバー
      // 40px ＋ 状態行 22→28px ＋ アプリバーの折り返し）。中心から固定 px（half=150、
      // 切り線 ±220/±230）で決めると、下の 2 隅と切り線の下端が地図に浮くツールの帯に
      // 乗ってクリックが飲まれる。**要求した大きさをその箱で成り立つ最大値まで落とし、
      // 中心も placeSquareScene に解かせる**（下限を割ったら fitHalf が落ちる）。
      //
      // 位相は不変: 「貫かない切り線」は面の下辺より下、「貫く切り線」は上下の辺の外、
      // 子の面は base と離れている（重ならない）。どれも half から導く。
      const baseHalf = fitHalf(b, 150, {
        avoidTopChrome: true, // ナイフを構えると上部にガイドが出る
        pierceExtra: 40,
        min: 60,
        name: 'r2-knife-base',
      });
      const baseReach = baseHalf + 40; // 切り線の端点は面の辺より外
      const baseScene = placeSquareScene(b, {
        fx: 0.5,
        fy: 0.5,
        half: baseHalf,
        pierce: baseReach,
        avoidTopChrome: true,
        name: 'r2-knife-base',
      });
      const bcx = baseScene.cx;
      const bcy = baseScene.cy;
      // 子の面は base の左上へ、重ならない距離だけ離す（元の -260/-160 と half=60 の
      // 「離れている」関係を、縮んだ base に合わせて相似に保つ）。
      const childScale = baseHalf / 150;
      const childHalf = Math.round(60 * childScale);
      const childCx = bcx - Math.round(260 * childScale);
      const childCy = bcy - Math.round(160 * childScale);
      assertClickable(b, squareCorners(bcx, bcy, baseHalf), {
        avoidTopChrome: false,
        name: 'r2-knife-base-corners',
      });
      assertClickable(b, squareCorners(childCx, childCy, childHalf), {
        avoidTopChrome: false,
        name: 'r2-child-corners',
      });
      assertClickable(
        b,
        [
          [bcx, bcy],
          [bcx - baseReach, bcy + baseReach],
          [bcx + baseReach, bcy + baseReach],
          [bcx, baseScene.cutTopY],
          [bcx, baseScene.cutBottomY],
        ],
        { avoidTopChrome: true, name: 'r2-knife-cuts' },
      );

      const c0 = await commitFace(page, bcx, bcy, baseHalf);
      if (c0 !== 'committed') record('knife-setup', `base face did not commit: ${c0}`);
      await shot(page, 'base-face');
      await checkCamera(page, 'after-base-face');

      await returnToViewMode(page);
      await showSidebarTab(page, 'features');
      const countBeforeSplit = await featureListCount(page);

      if (await armKnife(page)) {
        await shot(page, 'knife-armed');
        const kLayer = page.getByTestId('knife-input-layer');
        const kbox = await kLayer.boundingBox();
        if (kbox) {
          // 入力層の中心ではなく **置いた面の中心** を使う（面の中心は箱から解いた
          // 位置にあり、地図セルの中心とは一致しない）。
          const kx = bcx;
          const ky = bcy;

          // --- Non-piercing cut first: gate the 日本語 rejection ("貫く"). -----
          // Select the target.
          await page.mouse.click(kx, ky);
          await page.waitForTimeout(80);
          // Two points both BELOW the face — does not pierce it.
          await page.mouse.click(kx - baseReach, ky + baseReach);
          await page.mouse.click(kx + baseReach, ky + baseReach);
          const confirmCut = page.getByTestId('knife-confirm-cut');
          if (await confirmCut.isVisible().catch(() => false)) {
            await confirmCut.click();
            await page.waitForTimeout(120);
            const noModal = (await page.getByTestId('knife-inheritor-dialog').count()) === 0;
            const msg = ((await page.getByTestId('knife-message').textContent().catch(() => '')) ?? '').trim();
            if (!noModal) {
              record('knife-nonpiercing-advanced', 'non-piercing cut advanced to inheritor modal');
            } else if (!/貫く|貫通|分割/.test(msg)) {
              record('knife-nonpiercing-msg', `non-piercing cut: unexpected message "${msg}"`);
            }
            await shot(page, 'knife-nonpiercing-reject');
          } else {
            record('knife-no-confirm', 'confirm-cut control not shown after drawing a cut');
          }
          await checkCamera(page, 'after-nonpiercing-cut');

          // --- Piercing cut: select again, draw a vertical cut through the face.
          await page.mouse.click(kx, ky);
          await page.waitForTimeout(80);
          await page.mouse.click(kx, baseScene.cutTopY); // above the face
          await page.mouse.click(kx, baseScene.cutBottomY); // below the face -> pierces
          const cc = page.getByTestId('knife-confirm-cut');
          if (await cc.isVisible().catch(() => false)) {
            await cc.click();
            await page.waitForTimeout(150);
            const modal = page.getByTestId('knife-inheritor-modal-root');
            if ((await modal.count()) > 0) {
              await shot(page, 'knife-inheritor-modal');
              // Toggle piece 0 then 1 then 0 — gate aria-pressed exclusivity. The
              // n-way chooser (commit 01ed1d6) renders index-based buttons
              // knife-choose-0 / knife-choose-1 (a vertical 2-point cut → 2 pieces),
              // not the old A/B testids. Assert both are present so a stale testid can
              // no longer空振り silently past this exclusivity check.
              const a = page.getByTestId('knife-choose-0');
              const bSel = page.getByTestId('knife-choose-1');
              await expect(a).toBeVisible();
              await expect(bSel).toBeVisible();
              await a.click();
              const aPressed1 = await a.getAttribute('aria-pressed');
              const bPressed1 = await bSel.getAttribute('aria-pressed');
              if (aPressed1 === 'true' && bPressed1 === 'true') {
                record('knife-choice-both-pressed', 'both inheritor choices aria-pressed=true');
              }
              await bSel.click();
              const aPressed2 = await a.getAttribute('aria-pressed');
              const bPressed2 = await bSel.getAttribute('aria-pressed');
              if (aPressed2 === 'true' && bPressed2 === 'true') {
                record('knife-choice-both-pressed', 'both inheritor choices aria-pressed=true after toggle');
              }
              await a.click();
              await shot(page, 'knife-choice-toggled');

              await page.getByTestId('knife-confirm-inheritor').click();
              await page.waitForTimeout(120);
              // Non-inherited property form (re-uses U23 add form).
              const form = page.getByTestId('add-property-form');
              if (await form.isVisible().catch(() => false)) {
                await page.getByTestId('add-name').fill('split-half').catch(() => undefined);
                await shot(page, 'knife-noninherit-form');
                await page.getByTestId('add-save').click();
                await page.waitForTimeout(250);
                // A conflict modal could appear if the new face overlaps同時刻.
                if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
                  record('knife-conflict-after-split', 'split save paused on conflict modal');
                  await page.getByTestId('conflict-cancel').click().catch(() => undefined);
                }
              } else {
                record('knife-no-form', 'non-inherited property form not shown after confirm inheritor');
              }
              await shot(page, 'knife-split-saved');
            } else {
              const msg = ((await page.getByTestId('knife-message').textContent().catch(() => '')) ?? '').trim();
              record('knife-piercing-rejected', `piercing cut did NOT open inheritor modal; message="${msg}"`);
            }
          } else {
            record('knife-no-confirm-2', 'confirm-cut not shown for piercing cut');
          }
          await checkCamera(page, 'after-knife-split');
          await activeFeature(page);
        }

        // The split should leave the count at countBeforeSplit + 1 (1 -> 2).
        await returnToViewMode(page);
        await showSidebarTab(page, 'features');
        const countAfterSplit = await featureListCount(page);
        const diagAfterSplit = await diagFeatureCount(page);
        if (Number.isFinite(diagAfterSplit) && diagAfterSplit !== countAfterSplit) {
          record('view-count-mismatch-split', `feature-list=${countAfterSplit} diagnostics=${diagAfterSplit}`);
        }
        if (countBeforeSplit > 0 && countAfterSplit !== countBeforeSplit + 1) {
          record(
            'knife-split-count',
            `expected split count ${countBeforeSplit}->${countBeforeSplit + 1}, got ${countAfterSplit}`,
          );
        }
      }

      // =====================================================================
      // B. PARENT/CHILD FOREST — add a child face with a parent from the select.
      // =====================================================================
      await returnToViewMode(page);
      await showSidebarTab(page, 'features');
      const countBeforeChild = await featureListCount(page);
      // Add a small face offset away (avoid same-time overlap conflicts), choosing
      // the first real parent option (index 1 — index 0 is usually the なし/none row).
      const child = await commitFace(page, childCx, childCy, childHalf, { chooseParentIndex: 1, name: 'child-face' });
      await shot(page, 'child-face');
      if (child === 'conflict') {
        record('child-conflict', 'child face add paused on conflict modal (unexpected, offset placement)');
        await page.getByTestId('conflict-cancel').click().catch(() => undefined);
      }
      await checkCamera(page, 'after-child-face');
      await returnToViewMode(page);
      await showSidebarTab(page, 'features');
      const countAfterChild = await featureListCount(page);
      const diagAfterChild = await diagFeatureCount(page);
      if (Number.isFinite(diagAfterChild) && diagAfterChild !== countAfterChild) {
        record('view-count-mismatch-child', `feature-list=${countAfterChild} diagnostics=${diagAfterChild}`);
      }
      if (child === 'committed' && countAfterChild !== countBeforeChild + 1) {
        record('child-count', `expected child count ${countBeforeChild}->${countBeforeChild + 1}, got ${countAfterChild}`);
      }

      // =====================================================================
      // C. SEARCH PANEL — open ツール→検索, run queries, gate hits/no-results.
      // =====================================================================
      if (await clickMenuCommand(page, 'tools', 'tools.search')) {
        const input = page.getByTestId('search-panel-input');
        await expect(input).toBeVisible();
        await shot(page, 'search-open');
        // Run a query likely to match one of the named faces.
        await input.fill('face');
        await page.getByTestId('search-panel-run').click();
        await page.waitForTimeout(150);
        const results = page.getByTestId('search-panel-results');
        const noResults = page.getByTestId('search-panel-no-results');
        if ((await results.count()) > 0) {
          const hits = page.getByTestId('search-panel-hit');
          const nHits = await hits.count();
          for (let i = 0; i < nHits; i += 1) {
            const t = ((await hits.nth(i).textContent()) ?? '').trim();
            if (/NaN|Infinity|undefined|null/.test(t)) {
              record('search-hit-malformed', `hit ${i} text="${t}"`);
            }
          }
          if (nHits > 0) {
            await hits.first().click().catch(() => undefined);
            await page.waitForTimeout(120);
            await activeFeature(page);
          }
        } else if ((await noResults.count()) === 0) {
          record('search-no-result-state', 'search ran but neither results nor no-results shown');
        }
        await shot(page, 'search-results');
        // Whitespace-only query: gate the error path.
        await input.fill('   ');
        await page.getByTestId('search-panel-run').click();
        await page.waitForTimeout(120);
        if ((await page.getByTestId('search-panel-error').count()) === 0 &&
            (await page.getByTestId('search-panel-results').count()) > 0) {
          record('search-blank-no-error', 'blank query produced results instead of an error');
        }
        await shot(page, 'search-blank');
        // Close the search panel.
        await page.getByTestId('search-panel-close').click().catch(() => undefined);
        await page.keyboard.press('Escape').catch(() => undefined);
      }

      // =====================================================================
      // D. TIME EXTREMES + step round-trip (metamorphic fwd∘back=identity).
      // =====================================================================
      await returnToViewMode(page);
      const cur = page.getByTestId('timeline-current');
      const t0 = ((await cur.textContent()) ?? '').trim();
      if (/NaN|Infinity|undefined/.test(t0)) record('timeline-current-malformed', `t0="${t0}"`);

      // Drag the timeline slider to both edges; gate current never goes non-finite.
      const slider: Locator = page.getByRole('slider', { name: '時間軸スライダー' });
      if (await slider.isVisible().catch(() => false)) {
        const sbox = await slider.boundingBox();
        if (sbox) {
          // To the far right edge.
          await page.mouse.move(sbox.x + sbox.width / 2, sbox.y + sbox.height / 2);
          await page.mouse.down();
          await page.mouse.move(sbox.x + sbox.width + 200, sbox.y + sbox.height / 2, { steps: 6 });
          await page.mouse.up();
          await page.waitForTimeout(80);
          const tRight = ((await cur.textContent()) ?? '').trim();
          if (/NaN|Infinity|undefined/.test(tRight)) record('timeline-edge-malformed', `right edge="${tRight}"`);
          await shot(page, 'time-right-edge');
          // To the far left edge.
          await page.mouse.move(sbox.x + sbox.width / 2, sbox.y + sbox.height / 2);
          await page.mouse.down();
          await page.mouse.move(sbox.x - 200, sbox.y + sbox.height / 2, { steps: 6 });
          await page.mouse.up();
          await page.waitForTimeout(80);
          const tLeft = ((await cur.textContent()) ?? '').trim();
          if (/NaN|Infinity|undefined/.test(tLeft)) record('timeline-edge-malformed', `left edge="${tLeft}"`);
          await shot(page, 'time-left-edge');
        }
      }
      await checkCamera(page, 'after-time-edges');

      // Step unit forward∘back = identity using the live ◀/▶ controls.
      const fwd = page.getByRole('button', { name: /次へ進む$/ });
      const back = page.getByRole('button', { name: /前へ戻る$/ });
      if (await fwd.isVisible().catch(() => false)) {
        const tA = ((await cur.textContent()) ?? '').trim();
        for (let i = 0; i < 5; i += 1) await fwd.click().catch(() => undefined);
        for (let i = 0; i < 5; i += 1) await back.click().catch(() => undefined);
        const tB = ((await cur.textContent()) ?? '').trim();
        if (tA !== tB) record('time-step-roundtrip', `fwd*5∘back*5 changed time: "${tA}" -> "${tB}"`);
      }
      await shot(page, 'time-step-roundtrip');

      // =====================================================================
      // E. DELETE ∘ UNDO = identity (op∘逆op): delete a face then undo.
      // =====================================================================
      await returnToViewMode(page);
      await showSidebarTab(page, 'features');
      const countBeforeDel = await featureListCount(page);
      const flist = page.locator('[data-testid^="feature-list-item-"]');
      if ((await flist.count()) > 0) {
        await flist.first().click();
        await page.waitForTimeout(100);
        const selBefore = await activeFeature(page);
        await leaveViewMode(page);
        const em = page.getByTestId('mode-edit');
        if ((await em.getAttribute('aria-pressed')) !== 'true') await em.click();
        // Delete via keyboard (the live Delete accelerator).
        await page.keyboard.press('Delete');
        // A8: 地物の削除は確認を通る（3 経路で 1 つの確認）。
        await confirmDeleteIfAsked(page);
        await page.waitForTimeout(150);
        await returnToViewMode(page);
        await showSidebarTab(page, 'features');
        const countAfterDel = await featureListCount(page);
        if (countBeforeDel > 0 && countAfterDel !== countBeforeDel - 1) {
          record('delete-count', `expected delete ${countBeforeDel}->${countBeforeDel - 1}, got ${countAfterDel}`);
        }
        await shot(page, 'after-delete');
        // Undo the delete.
        await leaveViewMode(page);
        if ((await em.getAttribute('aria-pressed')) !== 'true') await em.click();
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(180);
        if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
          await page.getByTestId('conflict-cancel').click().catch(() => undefined);
        }
        await returnToViewMode(page);
        await showSidebarTab(page, 'features');
        const countAfterUndo = await featureListCount(page);
        if (countBeforeDel > 0 && countAfterUndo !== countBeforeDel) {
          record('delete-undo-identity', `delete∘undo not identity: ${countBeforeDel} -> ${countAfterDel} -> ${countAfterUndo}`);
        }
        const diagAfterUndo = await diagFeatureCount(page);
        if (Number.isFinite(diagAfterUndo) && diagAfterUndo !== countAfterUndo) {
          record('view-count-mismatch-undo', `feature-list=${countAfterUndo} diagnostics=${diagAfterUndo}`);
        }
        await shot(page, 'after-undo-delete');
        void selBefore;
      }

      // Anchor ordering on the surviving selection.
      await returnToViewMode(page);
      await showSidebarTab(page, 'features');
      const fl2 = page.locator('[data-testid^="feature-list-item-"]');
      if ((await fl2.count()) > 0) {
        await fl2.first().click();
        await page.waitForTimeout(100);
        await showSidebarTab(page, 'properties');
        await checkAnchorOrdering(page, 'final-selection');
        await shot(page, 'anchor-final');
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
