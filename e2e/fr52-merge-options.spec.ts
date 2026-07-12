// FR-52 回帰ロック — behavioural + screenshot E2E: 結合結果の上位領域・属性継承元を選ぶ
// ダイアログが実機で表示され、選んだプロパティで結合できる。
//
// THE POINT (FR-52 wiring-gap): the domain to choose a merge result's 上位領域 + プロパティ
// inheritance source existed and was unit-tested, but the UI hardcoded parentNone +
// inherit-first and NEVER opened a dialog — the user could not choose. This spec proves
// the WHOLE flow end-to-end in the REAL built Electron app:
//   - commit TWO non-overlapping top-level faces through the live add導線,
//   - arm the merge (結合) tool, click both face bodies as merge targets,
//   - press 結合を確定 → the FR-52 options dialog OPENS (merge-options-dialog),
//   - choose 新規プロパティ入力 with a typed name (the propertyNew variant — formerly
//     unreachable from the UI),
//   - press 結合を実行 → the merge commits and the feature count DROPS (2 → 1),
//   - screenshot the open dialog (the whole point of FR-52) to fr52-merge-options.png.

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

/** Commit one square face centred at (cx,cy) with half-extent `half` (4 real clicks). */
async function commitFaceAt(page: Page, cx: number, cy: number, half: number): Promise<void> {
  await enterAddMode(page);
  const area = page.getByTestId('tool-add.area');
  await expect(area).toBeVisible();
  if ((await area.getAttribute('aria-pressed')) === 'true') await area.click(); // re-arm fresh
  await area.click();
  await expect(area).toHaveAttribute('aria-pressed', 'true');
  const addLayer = page.getByTestId('add-input-layer');
  await expect(addLayer).toBeVisible();
  for (const [dx, dy] of [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ] as const) {
    await page.mouse.click(cx + dx, cy + dy);
  }
  await page.getByTestId('add-complete').click();
  await page.getByTestId('add-save').click();
}

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

test.describe('FR-52 — 結合の上位領域・属性継承元を選ぶダイアログが実機で機能する', () => {
  test('2面を結合対象に取り、確定でオプションダイアログ→新規プロパティ選択→実行で 2→1 地物', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();

      // --- 1. Commit TWO non-overlapping top-level faces left & right of centre. ---
      const mapInput = page.getByTestId('map-input-layer');
      const m0 = (await mapInput.boundingBox())!;
      const cx = m0.x + m0.width / 2;
      const cy = m0.y + m0.height / 2;
      await commitFaceAt(page, cx - 150, cy, 70);
      await commitFaceAt(page, cx + 150, cy, 70);

      await goView(page);
      const countBefore = await featureListCount(page);
      expect(countBefore).toBe(2);

      // --- 2. Arm the merge (結合) tool. ---
      await enterEditMode(page);
      const mergeTool = page.getByTestId('tool-edit.merge');
      await expect(mergeTool).toBeEnabled();
      await mergeTool.click();
      await expect(mergeTool).toHaveAttribute('aria-pressed', 'true');

      // --- 3. Click each face body → both picked as merge targets (count 0→1→2). ---
      const targetCount = page.getByTestId('merge-target-count');
      await page.mouse.click(cx - 150, cy);
      await expect(targetCount).toHaveText('1');
      await page.mouse.click(cx + 150, cy);
      await expect(targetCount).toHaveText('2');
      await expect(page.getByTestId('merge-confirm')).toBeEnabled();

      // --- 4. 結合を確定 → the FR-52 options dialog OPENS (the wiring under test). ---
      await page.getByTestId('merge-confirm').click();
      const dialog = page.getByTestId('merge-options-dialog');
      await expect(dialog).toBeVisible();
      // The parent 3-択 + property 2-択 are present.
      await expect(page.getByTestId('merge-parent-none')).toBeVisible();
      await expect(page.getByTestId('merge-parent-existing')).toBeVisible();
      await expect(page.getByTestId('merge-parent-create')).toBeVisible();
      await expect(page.getByTestId('merge-property-inherit')).toBeVisible();
      await expect(page.getByTestId('merge-property-new')).toBeVisible();

      // Screenshot the open dialog (the whole point of FR-52).
      await page.screenshot({ path: resolve(shotDir, 'fr52-merge-options.png') });

      // --- 5. Choose 新規プロパティ入力 + type a name (the propertyNew variant). ---
      await page.getByTestId('merge-property-new').click();
      await page.getByTestId('merge-property-new-name').fill('統合領域');

      // --- 6. 結合を実行 → commit. ---
      await page.getByTestId('merge-options-confirm').click();

      // --- 7. ASSERT the feature count dropped (2 → 1: the two faces folded into one). ---
      await goView(page);
      await expect
        .poll(async () => featureListCount(page), { timeout: 15_000 })
        .toBe(1);
    } finally {
      await app.close();
    }
  });
});
