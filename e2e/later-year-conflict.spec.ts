// 確定の重なりの検出は、その編集が効く後の年も見る（GPT 審査の指摘を再現して直した）。
// 押した年に居ない相手と後の年に重なる形は、重なりの年を言う板で止まり、解決すれば保存して開き直しても
// 修復を聞かれない。単体は `src/ui/consistency-binding.later-years.test.tsx`。

import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import {
  addInputLayerBox,
  armAddAreaTool,
  commitSquareFace,
  jumpToYear,
  launchApp,
  leaveViewMode,
  loadProject,
} from './helpers';
import { createScratchDirs } from './scratch-dirs';

const scratch = createScratchDirs('gimoza-later-year-');
test.afterEach(scratch.removeAll);

const STATUS = 'statusbar-result';
/** 検査が描く面の名前（画面の文言ではない）。 */
const OUTSIDE = '外';

type DrawnShapes = Record<string, number[][][][]>;

async function drawnShapesByFeature(page: Page): Promise<DrawnShapes> {
  return page.evaluate(
    () =>
      (window as unknown as { __E2E__: { getDrawnFeatureShapes: () => DrawnShapes } }).__E2E__
        .getDrawnFeatureShapes(),
  );
}

async function dragBy(page: Page, x: number, y: number, dx: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 3 });
  await page.mouse.move(x + dx, y, { steps: 3 });
  await page.mouse.up();
}

test('1000 年の移動が 1500 年から現れる面に重なると板で止まり、年を言い、解決は 1500 年から効き、開き直しても修復を聞かれない', async () => {
  test.setTimeout(120_000);
  const target = join(scratch.make(), 'a.gimoza');
  const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
  try {
    await leaveViewMode(page);
    await armAddAreaTool(page);
    const box = await addInputLayerBox(page);
    const cy = box.y + box.height / 2;
    const half = 50;
    const ax = box.x + box.width / 2 - 180;
    const xx = box.x + box.width / 2 + 60;
    await jumpToYear(page, 1500);
    const xId = await commitSquareFace(page, xx, cy, half, { name: OUTSIDE });
    await jumpToYear(page, 1000);
    const aId = await commitSquareFace(page, ax, cy, half, { name: '動く面' });

    await page.getByTestId('tool-edit.move').click();
    await page.mouse.click(ax, cy);
    await expect(page.getByTestId('app-active-feature')).toHaveText(aId);
    const before = await drawnShapesByFeature(page);
    const undo = await page.getByTestId('app-can-undo').textContent();

    // 外の面を半分覆う所まで引く。1000 年には相手が居ないが、1500 年に重なる。
    const pull = 240 - half;
    await dragBy(page, ax, cy, pull);
    const dialog = page.getByTestId('conflict-dialog');
    await expect(dialog).toBeVisible();
    if (await page.getByTestId('conflict-guide').isVisible()) {
      await page.getByTestId('conflict-guide-close').click();
    }
    const row = page.getByTestId('conflict-rows').locator('li').first();
    await expect(row).toContainText('1500年');
    await expect(row.getByTestId('conflict-row-features')).toContainText('動く面');
    await expect(row.getByTestId('conflict-row-features')).toContainText('外');

    // やめれば何も残らない。
    await page.getByTestId('conflict-cancel').click();
    await expect(dialog).toHaveCount(0);
    expect(await drawnShapesByFeature(page)).toEqual(before);
    await expect(page.getByTestId('app-can-undo')).toHaveText(undo ?? '');

    // 外の面を残す: 動く面は 1500 年から削られ、1000 年は動いた形のまま。
    await dragBy(page, ax, cy, pull);
    await expect(dialog).toBeVisible();
    await page.getByTestId('conflict-rows').locator('li').first().getByRole('radio', { name: new RegExp(OUTSIDE) }).check();
    await page.getByTestId('conflict-apply').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId(STATUS)).toContainText('重なりを解消しました（1500年）');
    const at1000 = await drawnShapesByFeature(page);
    expect(at1000[aId]).not.toEqual(before[aId]);
    await jumpToYear(page, 1500);
    const at1500 = await drawnShapesByFeature(page);
    expect(at1500[aId]).not.toEqual(at1000[aId]);
    const xShape = at1500[xId];

    await page.keyboard.press('Control+s');
    await expect(page.getByTestId(STATUS)).toContainText('保存しました');
    expect(await loadProject(page, target)).toBe('loaded');
    await expect(page.getByTestId('repair-dialog')).toHaveCount(0);
    await jumpToYear(page, 1500);
    const reopened = await drawnShapesByFeature(page);
    expect(reopened[aId]).toEqual(at1500[aId]);
    expect(reopened[xId]).toEqual(xShape);
  } finally {
    await app.close();
  }
});
