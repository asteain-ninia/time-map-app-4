// HB3-5/19 回帰ロック — behavioural + screenshot E2E: the ナイフ(分割) n-way 片チューザ.
//
// THE POINT (HB3-5/19): an OPEN knife cut that crosses the target face boundary 2k
// times yields k+1 pieces (the domain migration, commit 8cc828c). This spec proves
// the WHOLE flow end-to-end in the REAL built Electron app — NOT a unit fake:
//   - commit ONE face through the live add導線,
//   - arm the knife, draw a COMB / W cut that crosses the face's bottom edge FOUR
//     times (down-up-down-up) so checkSplittable yields THREE pieces,
//   - confirm the cut → the inheritor modal now shows ≥3 piece choices
//     (knife-choose-0 / -1 / -2 — the n-way chooser, not the old 2-way A/B),
//   - pick an inheritor + save,
//   - ASSERT the feature count grew by 2 (1 → 3 features: k+1 = 3) via the sidebar
//     feature-list, and screenshot the map showing the 3 pieces.
//
// The comb is the SAME topology the domain probe locks (split-geometry / __nway-probe
// world coords [-1,5],[5,5],[5,-1],[8,-1],[8,5],[11,5] on a [0,10]² square) mapped
// onto the committed face's on-screen box — the screen→world transform is affine, so
// the crossing topology (and hence the 3-piece outcome) is preserved.

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { test, expect, type Page } from '@playwright/test';

import { launchApp } from './helpers';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = resolve(projectRoot, 'screenshots');
mkdirSync(shotDir, { recursive: true });

/** Land in 追加モード idempotently from any starting mode. */
async function enterAddMode(page: Page): Promise<void> {
  const addMode = page.getByTestId('mode-add');
  if ((await addMode.getAttribute('aria-pressed')) === 'true') return;
  const viewToggle = page.getByTestId('mode-view');
  await expect(viewToggle).toBeVisible();
  if ((await viewToggle.getAttribute('aria-pressed')) === 'true') {
    await viewToggle.click();
  }
  if ((await addMode.getAttribute('aria-pressed')) !== 'true') {
    await expect(addMode).toBeEnabled();
    await addMode.click();
  }
  await expect(addMode).toHaveAttribute('aria-pressed', 'true');
}

/** Land in 編集モード idempotently from any starting mode. */
async function enterEditMode(page: Page): Promise<void> {
  const editMode = page.getByTestId('mode-edit');
  if ((await editMode.getAttribute('aria-pressed')) === 'true') return;
  const viewToggle = page.getByTestId('mode-view');
  await expect(viewToggle).toBeVisible();
  if ((await viewToggle.getAttribute('aria-pressed')) === 'true') {
    await viewToggle.click();
  }
  if ((await editMode.getAttribute('aria-pressed')) !== 'true') {
    await expect(editMode).toBeEnabled();
    await editMode.click();
  }
  await expect(editMode).toHaveAttribute('aria-pressed', 'true');
}

/** Return to View so the sidebar feature-list reflects the committed forest. */
async function goView(page: Page): Promise<void> {
  const v = page.getByTestId('mode-view');
  if ((await v.getAttribute('aria-pressed')) !== 'true') {
    await v.click().catch(() => undefined);
  }
}

async function showFeaturesTab(page: Page): Promise<void> {
  // HB6: 地物一覧 / 錨一覧 are unified into the「一覧」tab; 現在時刻 mode = 旧地物一覧.
  const tab = page.getByTestId('sidebar-tab-list');
  if (await tab.isVisible().catch(() => false)) {
    await tab.click().catch(() => undefined);
  }
  const currentMode = page.getByTestId('list-mode-current');
  if (await currentMode.isVisible().catch(() => false)) {
    await currentMode.click().catch(() => undefined);
  }
}

async function featureListCount(page: Page): Promise<number> {
  await showFeaturesTab(page);
  if ((await page.getByTestId('unified-list-empty').count()) > 0) return 0;
  return page.locator('[data-testid^="feature-list-item-"]').count();
}

test.describe('HB3-5/19 — ナイフの n-way 片チューザ: コーム切断で k+1 片が実機で生成される', () => {
  test('面を1枚作り、4回境界を跨ぐコーム切断 → 継承先モーダルに3片 → 保存で 1→3 地物', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();

      // --- 1. Commit ONE face through the live add導線, capturing its on-screen box. ---
      // Inline add (not commitOneFace) so we capture the EXACT screen box the face was
      // drawn in (the add-input-layer rect) and reuse it for BOTH the knife target
      // click and the comb cut — the face's screen position is left-of-map-centre on a
      // wide window, so deriving the cut box from map-input-layer's centre misses it.
      await enterAddMode(page);
      await page.getByTestId('tool-add.area').click();
      const addLayer = page.getByTestId('add-input-layer');
      await expect(addLayer).toBeVisible();
      const fb = (await addLayer.boundingBox())!;
      const cx = fb.x + fb.width / 2;
      const cy = fb.y + fb.height / 2;
      const HALF = 120; // the face spans [cx±120, cy±120] = world [0,10]² (24px / world unit).
      const U = (HALF * 2) / 10; // px per world unit.
      for (const [dx, dy] of [
        [-HALF, -HALF],
        [HALF, -HALF],
        [HALF, HALF],
        [-HALF, HALF],
      ] as const) {
        await page.mouse.click(cx + dx, cy + dy);
      }
      await page.getByTestId('add-complete').click();
      await page.getByTestId('add-save').click();
      await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);

      // The pre-split forest count (should be 1 top-level face).
      await goView(page);
      const countBefore = await featureListCount(page);
      expect(countBefore).toBe(1);

      // Map a probe world coord (square [0,10]²; centre = (5,5)) to a screen pixel.
      // Screen Y grows downward, world lat grows upward → flip lat. The comb's teeth
      // dip BELOW the bottom edge (world y < 0 → screen y > cy + HALF).
      const W = (wx: number, wy: number): { x: number; y: number } => ({
        x: cx + (wx - 5) * U,
        y: cy - (wy - 5) * U,
      });

      // The COMB / W cut: enter the LEFT edge mid-height, run in to x=5, dip down
      // THROUGH the bottom edge (tooth 1), run right under the face to x=8, come back
      // UP through the bottom edge (tooth 2), exit the RIGHT edge. FOUR boundary
      // crossings of the bottom edge ⇒ 2 interior chords ⇒ THREE pieces (the same
      // topology the domain __nway-probe locks). Endpoints sit clearly OUTSIDE the
      // face (world x = -1 / 11) so it is an honest outside→through→outside cut.
      const combWorld: ReadonlyArray<readonly [number, number]> = [
        [-1, 5],
        [5, 5],
        [5, -1],
        [8, -1],
        [8, 5],
        [11, 5],
      ];

      // --- 2. Arm the knife (edit mode → knife tool). Entering edit clears selection. ---
      await enterEditMode(page);
      const knifeTool = page.getByTestId('tool-edit.knife');
      await expect(knifeTool).toBeEnabled();
      await knifeTool.click();
      await expect(knifeTool).toHaveAttribute('aria-pressed', 'true');

      // --- 3. Select the face as the split target (click its body). ---
      const knifeInput = page.getByTestId('knife-input-layer');
      await expect(knifeInput).toBeVisible();
      await page.mouse.click(cx, cy);
      // HB3-6/18: selecting a knife target promotes it into the active selection.
      await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);

      // Diagnostic: the knife input layer rect (should overlap the face box). Logged so
      // a miss (face drawn off the cut box) is visible in the runner output.
      const kb = (await knifeInput.boundingBox())!;
      console.log(
        `KNIFE-NWAY: faceBox=(${fb.x},${fb.y},${fb.width},${fb.height}) ` +
          `knifeBox=(${kb.x},${kb.y},${kb.width},${kb.height}) cx=${cx} cy=${cy}`,
      );

      // --- 4. Draw the comb cut on the knife input layer (screen px). ---
      for (const [wx, wy] of combWorld) {
        const p = W(wx, wy);
        await page.mouse.click(p.x, p.y);
      }
      // Six points placed (no fixed-circle close — all teeth land outside the circle).
      await expect(page.getByTestId('knife-cut-count')).toHaveText(String(combWorld.length));
      await page.screenshot({ path: resolve(shotDir, 'knife-nway-cut.png') });

      // --- 5. Confirm the cut → the n-way inheritor modal. ---
      await page.getByTestId('knife-confirm-cut').click();

      // If the cut was rejected, surface why (fails the test loudly).
      const rejected = page.getByTestId('knife-rejected');
      if ((await rejected.count()) > 0) {
        const msg = ((await rejected.textContent()) ?? '').trim();
        throw new Error(`knife cut was rejected (expected a 3-piece split): ${msg}`);
      }

      const modal = page.getByTestId('knife-inheritor-modal-root');
      await expect(modal).toBeVisible();
      // THE n-way ASSERTION: a THIRD piece choice exists (knife-choose-2). The old
      // 2-way modal only ever rendered knife-choose-a / -b.
      await expect(page.getByTestId('knife-choose-0')).toBeVisible();
      await expect(page.getByTestId('knife-choose-1')).toBeVisible();
      await expect(page.getByTestId('knife-choose-2')).toBeVisible();
      await page.screenshot({ path: resolve(shotDir, 'knife-nway-modal.png') });

      // --- 6. Pick an inheritor (piece 0) + confirm + author the shared U23 default. ---
      await page.getByTestId('knife-choose-0').click();
      await expect(page.getByTestId('knife-choose-0')).toHaveAttribute('aria-pressed', 'true');
      await page.getByTestId('knife-confirm-inheritor').click();

      // The non-inherited pieces share ONE U23 property default (re-uses AddPropertyForm).
      await expect(page.getByTestId('knife-props')).toBeVisible();
      await page.getByTestId('add-save').click();

      // --- 7. ASSERT the feature count grew by 2 (k+1 = 3 features from 1). ---
      await goView(page);
      await expect
        .poll(async () => featureListCount(page), { timeout: 15_000 })
        .toBe(countBefore + 2);

      // Screenshot the map showing the 3 pieces (the whole point of HB3-5/19).
      await page.screenshot({ path: resolve(shotDir, 'knife-nway-3pieces.png') });
    } finally {
      await app.close();
    }
  });
});
