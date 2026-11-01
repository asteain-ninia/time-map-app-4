// 確定の重なりの検出は、その編集が効く後の年も見る（GPT 審査の指摘を再現して直した）。
// 押した年に居ない相手と後の年に重なる形は、重なりの年を言う板で止まり、解決すれば保存して開き直しても
// 修復を聞かれない。単体は `src/ui/consistency-binding.later-years.test.tsx`。

import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import {
  addInputLayerBox,
  armAddAreaTool,
  armVertexTool,
  commitFace,
  commitSquareFace,
  drawFace,
  jumpToYear,
  launchApp,
  leaveViewMode,
  loadProject,
  worldToClient,
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

/** 板の最初の行で `keep` の名前の面を残して適用し、保存して開き直し、修復を聞かれないことを見る。 */
async function resolveSaveReopen(page: Page, keep: string, target: string): Promise<void> {
  const dialog = page.getByTestId('conflict-dialog');
  await expect(dialog).toBeVisible();
  if (await page.getByTestId('conflict-guide').isVisible()) {
    await page.getByTestId('conflict-guide-close').click();
  }
  await page.getByTestId('conflict-rows').locator('li').first().getByRole('radio', { name: new RegExp(keep) }).check();
  await page.getByTestId('conflict-apply').click();
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId(STATUS)).toContainText('保存しました');
  expect(await loadProject(page, target)).toBe('loaded');
  await expect(page.getByTestId('repair-dialog')).toHaveCount(0);
}

test('頂点を消して凹みを埋めると 1500 年の面を覆う形は板で止まり、解決すれば開き直しても修復を聞かれない', async () => {
  test.setTimeout(120_000);
  const target = join(scratch.make(), 'a.gimoza');
  const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
  try {
    await leaveViewMode(page);
    await armAddAreaTool(page);
    const box = await addInputLayerBox(page);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    // 凹みの中に、1500 年から現れる面。
    await jumpToYear(page, 1500);
    await commitSquareFace(page, cx, cy - 70, 12, { name: OUTSIDE });
    await jumpToYear(page, 1000);
    const dent: [number, number] = [cx, cy];
    await commitFace(
      page,
      [
        [cx - 100, cy + 100],
        [cx + 100, cy + 100],
        [cx + 100, cy - 100],
        dent,
        [cx - 100, cy - 100],
      ],
      { name: '凹んだ面' },
    );
    await armVertexTool(page);
    await page.mouse.click(dent[0], dent[1]);
    await expect(page.getByTestId('app-active-vertex')).not.toHaveText('');
    await page.keyboard.press('Delete');
    await page.getByTestId('vertex-delete-impact-confirm').click();
    const row = page.getByTestId('conflict-rows').locator('li').first();
    await expect(row).toContainText('1500年');
    await expect(row.getByTestId('conflict-row-features')).toContainText('凹んだ面');
    await resolveSaveReopen(page, OUTSIDE, target);
  } finally {
    await app.close();
  }
});

test('1500 年の相手が 2000 年に動く形で、相手を残して削っても、開き直しで頂点の座標の食い違いを言われない', async () => {
  test.setTimeout(120_000);
  const target = join(scratch.make(), 'a.gimoza');
  const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
  try {
    await leaveViewMode(page);
    await armAddAreaTool(page);
    const box = await addInputLayerBox(page);
    const cy = box.y + box.height / 2;
    const half = 40;
    const ax = box.x + box.width / 2 - 150;
    const xx = box.x + box.width / 2 + 30;
    await jumpToYear(page, 1500);
    await commitSquareFace(page, xx, cy, half, { name: OUTSIDE });
    // 相手を 2000 年に別の場所へ動かす（同じ頂点の id のまま、その年の錨ができる）。
    await jumpToYear(page, 2000);
    await page.getByTestId('tool-edit.move').click();
    await page.mouse.click(xx, cy);
    await dragBy(page, xx, cy, 200);
    await jumpToYear(page, 1000);
    await armAddAreaTool(page);
    await commitSquareFace(page, ax, cy, half, { name: '動く面' });
    await page.getByTestId('tool-edit.move').click();
    await page.mouse.click(ax, cy);
    await dragBy(page, ax, cy, 130);
    await expect(page.getByTestId('conflict-rows').locator('li').first()).toContainText('1500年');
    await resolveSaveReopen(page, OUTSIDE, target);
  } finally {
    await app.close();
  }
});

test('継ぎ目をまたぐ 1500 年の面に重なる 1000 年の移動は板で止まり、解決すれば開き直しても修復を聞かれない', async () => {
  test.setTimeout(120_000);
  const target = join(scratch.make(), 'a.gimoza');
  const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
  try {
    await leaveViewMode(page);
    // 継ぎ目の両側が窓に入るまで縮小する。
    const box = (await page.getByTestId('map-input-layer').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect
      .poll(async () => {
        const east = await worldToClient(page, { lon: 200, lat: 0 });
        const west = await worldToClient(page, { lon: -200, lat: 0 });
        if (east.x < box.x + box.width - 5 && west.x > box.x + 5) return true;
        await page.mouse.wheel(0, 100);
        return false;
      }, '継ぎ目が窓に入らない')
      .toBe(true);
    const at = async (lon: number, lat: number): Promise<[number, number]> => {
      const p = await worldToClient(page, { lon, lat });
      return [p.x, p.y];
    };
    const face = async (west: number, east: number, south: number, north: number, name: string): Promise<void> => {
      const corners = [
        await at(west, north),
        await at(east, north),
        await at(east, south),
        await at(west, south),
      ];
      await armAddAreaTool(page);
      await drawFace(page, corners, { name });
    };
    await jumpToYear(page, 1500);
    await face(170, 190, -10, 10, OUTSIDE);
    await jumpToYear(page, 1000);
    await face(122, 128, -8, 8, '動く面');
    const [fromX, fromY] = await at(125, 0);
    const [toX] = await at(175, 0);
    await page.getByTestId('tool-edit.move').click();
    await page.mouse.click(fromX, fromY);
    await dragBy(page, fromX, fromY, toX - fromX);
    await expect(page.getByTestId('conflict-rows').locator('li').first()).toContainText('1500年');
    // 動く面は相手の中に収まるので、動く面を残す（相手を残すと全部覆われて削れない）。
    await resolveSaveReopen(page, '動く面', target);
  } finally {
    await app.close();
  }
});
