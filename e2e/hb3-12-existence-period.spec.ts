// HB3-12 回帰ロック — behavioural + screenshot E2E: 地物の存続期間編集.
//
// THE POINT (HB3-12, 教訓 5.7 配線漏れ): the U09 ops that move WHEN a feature appears /
// disappears on the time axis (changeStart / setEnd) existed + were unit-tested, but
// NOTHING called them — users could SEE existence bars but could NOT change when a
// feature appears or disappears. This spec proves the WHOLE flow end-to-end in the REAL
// built Electron app:
//   - commit ONE face through the live add導線 (anchored at the default time, year 0, so
//     it is present from year 0 onward),
//   - confirm the 地物一覧 shows it at year 0 (present),
//   - enter 編集モード, reselect the feature (a mode switch clears selection), open the
//     property panel's per-anchor存続期間 editor, move the 開始年 to 5000 and 反映,
//   - jump the time cursor to year 1000 (BEFORE the new start) → the feature is HIDDEN
//     (the 地物一覧 — the SAME live-truth set the map draws — is now empty),
//   - jump to year 6000 (AFTER the new start) → the feature is SHOWN again.
// A screenshot of the hidden state lands at screenshots/hb3-12-existence-period.png.
//
// This drives the REAL property-dispatch → createAnchorIntervalCommandForRoot → U09
// changeStart → store swap path (NOT a unit fake): the existence interval genuinely
// moved, recorded as one undo unit.

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { test, expect, type Page } from '@playwright/test';

import { commitOneFace, launchApp } from './helpers';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = resolve(projectRoot, 'screenshots');
mkdirSync(shotDir, { recursive: true });

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

async function showPropertiesTab(page: Page): Promise<void> {
  const tab = page.getByTestId('sidebar-tab-properties');
  if (await tab.isVisible().catch(() => false)) {
    await tab.click().catch(() => undefined);
  }
}

async function featureListCount(page: Page): Promise<number> {
  await showFeaturesTab(page);
  if ((await page.getByTestId('unified-list-empty').count()) > 0) return 0;
  return page.locator('[data-testid^="feature-list-item-"]').count();
}

/** Jump the time cursor to a precise year via the 直接ジャンプ (YearMonthDayInput). */
async function jumpToYear(page: Page, year: number): Promise<void> {
  const yearInput = page.getByLabel('直接ジャンプ 年', { exact: true });
  await yearInput.fill(String(year));
  // `exact` so the 未指定 toggle buttons (accessible name「直接ジャンプ 月 未指定」…)
  // are not matched — only the literal「ジャンプ」confirm button.
  await page.getByRole('button', { name: 'ジャンプ', exact: true }).click();
  await expect(page.getByTestId('timeline-current')).toHaveText(`${year}年`);
}

test.describe('HB3-12 — 地物の存続期間編集: 開始年を未来へ動かすと、その前では地物が消える', () => {
  test('面を1枚作り、開始年を5000へ→1000年で非表示・6000年で再表示', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();

      // --- 1. Commit ONE face (anchored at the default time = year 0). ---
      await commitOneFace(page);

      // The default current time is year 0; the face is present, so the 地物一覧 shows 1.
      await jumpToYear(page, 0);
      expect(await featureListCount(page)).toBe(1);

      // --- 2. Enter 編集モード, then RESELECT the feature (a mode switch clears selection). ---
      await enterEditMode(page);
      await showFeaturesTab(page);
      const featureItem = page.locator('[data-testid^="feature-list-item-"]').first();
      await expect(featureItem).toBeVisible();
      await featureItem.click();
      await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);

      // --- 3. Open the per-anchor存続期間 editor in the property panel + move 開始年→5000. ---
      await showPropertiesTab(page);
      const propertiesPanel = page.getByTestId('sidebar-panel-properties');
      // The editor only renders in editable mode with a wired dispatch (HB3-12). The
      // anchor id is derived from the feature id + time, so match by the testid prefix.
      // It lives in a collapsed <details> disclosure — open it (click the summary, the
      // only one in the anchor list after a single commit) so its inputs become visible.
      const summary = propertiesPanel.locator('details.anchor-interval > summary').first();
      await expect(summary).toBeVisible();
      await summary.click();
      const startInput = propertiesPanel
        .locator('[data-testid^="anchor-interval-start-"]')
        .first();
      await expect(startInput).toBeVisible();
      await startInput.fill('5000');
      await propertiesPanel
        .locator('[data-testid^="anchor-interval-apply-start-"]')
        .first()
        .click();

      // --- 4. THE PROOF: at year 1000 (before the new start) the feature is HIDDEN. ---
      await jumpToYear(page, 1000);
      await expect.poll(async () => featureListCount(page), { timeout: 15_000 }).toBe(0);
      await page.screenshot({ path: resolve(shotDir, 'hb3-12-existence-period.png') });

      // --- 5. At year 6000 (after the new start) the feature is SHOWN again. ---
      await jumpToYear(page, 6000);
      await expect.poll(async () => featureListCount(page), { timeout: 15_000 }).toBe(1);
    } finally {
      await app.close();
    }
  });
});
