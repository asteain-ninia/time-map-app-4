// B78: 錨を消す前の板が、一緒に無くなる集約地物を言う（素性欄の錨表・時刻レールの右クリック）。
// 確定後の状態行の文も固定する。

import { expect, test, type Page } from '@playwright/test';

import {
  clickClearOfStickyBars,
  enterEditMode,
  jumpToYear,
  launchApp,
  listedFeatureCount,
  loadSyntheticNested,
  openPropertySection,
  railMarkPositions,
} from './helpers';

const FED = '第一連邦';
const CHILD_ID = 'syn-nest-child-0';
const CHILD_NAME = '合成州 01';

/** 州 1 件だけの連邦を 1200 年に作り、その州を選ぶ。1200 年の錨を消すと連邦は記録ごと無くなる。 */
async function loneFederation(page: Page): Promise<void> {
  await loadSyntheticNested(page, 3, [1000]);
  await enterEditMode(page);
  await jumpToYear(page, 1200);
  await page.getByTestId('sidebar-tab-list').click();
  await page.getByTestId('unified-list-filter').fill(CHILD_NAME);
  await page.getByTestId(`ledger-mark-${CHILD_ID}`).check();
  await page.getByTestId('tool-edit.reparent').click();
  await page.getByTestId('reparent-confirm').click();
  await page.getByTestId('reparent-parent-create').check();
  await page.getByTestId('reparent-parent-create-name').fill(FED);
  await page.getByTestId('reparent-options-confirm').click();
  await expect(page.getByTestId('reparent-options-dialog')).toHaveCount(0);
  await page.getByTestId('tool-edit.select').click();
  await page.getByTestId('unified-list-filter').fill(CHILD_NAME);
  await page.getByTestId(`feature-list-item-${CHILD_ID}`).click();
  await expect(page.getByTestId('app-active-feature')).toHaveText(CHILD_ID);
}

async function countListed(page: Page, name: string): Promise<number> {
  await page.getByTestId('sidebar-tab-list').click();
  await page.getByTestId('unified-list-filter').fill(name);
  return listedFeatureCount(page);
}

test.describe('B78 — 錨を消す前の板が、記録ごと無くなる集約地物を言う', () => {
  test('素性欄の錨表: 板が言い、やめれば何も起きず、確定すると状態行も言い、取り消しで戻る', async () => {
    const { app, page } = await launchApp();
    try {
      await loneFederation(page);
      await page.getByTestId('sidebar-tab-properties').click();
      await openPropertySection(page, 'anchor-section');
      await clickClearOfStickyBars(page.locator('[data-testid^="anchor-interval-summary-"]').last());
      const del = page.locator('[data-testid^="anchor-interval-delete-"]').last();

      await clickClearOfStickyBars(del);
      const cascaded = page.getByTestId('anchor-delete-impact-cascaded');
      await expect(cascaded).toContainText(FED);
      await expect(cascaded).toContainText('記録ごと無くなります');

      await page.getByTestId('anchor-delete-impact-cancel').click();
      await expect(page.getByTestId('anchor-delete-impact')).toHaveCount(0);
      expect(await countListed(page, FED)).toBe(1);

      await page.getByTestId('sidebar-tab-properties').click();
      await clickClearOfStickyBars(del);
      await page.getByTestId('anchor-delete-impact-confirm').click();
      await expect(page.getByTestId('anchor-delete-impact')).toHaveCount(0);
      await expect(page.locator('[role="status"]')).toContainText(
        `存続期間を変えました。どの年にも下位領域が居なくなった「${FED}」は、記録ごと無くなりました。`,
      );
      expect(await countListed(page, FED)).toBe(0);

      await page.getByTestId('unified-list-filter').fill('');
      await page.getByTestId('ledger-scroller').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('app-can-redo')).toHaveText('1');
      expect(await countListed(page, FED)).toBe(1);
    } finally {
      await app.close();
    }
  });

  test('時刻レールの右クリック: 同じ板が同じことを言う', async () => {
    const { app, page } = await launchApp();
    try {
      await loneFederation(page);
      const box = await page.getByTestId('anchor-lane').boundingBox();
      if (box === null) throw new Error('レーンが見えない');
      await expect.poll(async () => (await railMarkPositions(page)).length).toBe(2);
      const marks = await railMarkPositions(page);
      await page.mouse.click(box.x + (marks[1] ?? 0), box.y + box.height / 2, { button: 'right' });
      await page.getByTestId('context-menu').locator('[data-rail-item="deleteAnchor"]').click();
      const cascaded = page.getByTestId('anchor-delete-impact-cascaded');
      await expect(cascaded).toContainText(FED);
      await expect(cascaded).toContainText('記録ごと無くなります');
      await page.getByTestId('anchor-delete-impact-cancel').click();
    } finally {
      await app.close();
    }
  });

  test('何も一緒に無くならない錨では、その群を出さない', async () => {
    const { app, page } = await launchApp();
    try {
      await loadSyntheticNested(page, 2, [1000, 1200]);
      await enterEditMode(page);
      await jumpToYear(page, 1500);
      await page.getByTestId('sidebar-tab-list').click();
      await page.getByTestId('unified-list-filter').fill('合成の連邦');
      await page.getByTestId('feature-list-item-syn-nest-parent').click();
      await page.getByTestId('sidebar-tab-properties').click();
      await openPropertySection(page, 'anchor-section');
      await clickClearOfStickyBars(page.locator('[data-testid^="anchor-interval-summary-"]').last());
      await clickClearOfStickyBars(page.locator('[data-testid^="anchor-interval-delete-"]').last());
      await expect(page.getByTestId('anchor-delete-impact')).toBeVisible();
      await expect(page.getByTestId('anchor-delete-impact-cascaded')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});
