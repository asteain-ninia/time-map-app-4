// B99 — 輪郭の道具で最後の外周を消す（面ごと消える）と、状態行は「削除」と言う。
//
// 「追加か削除か」は確定した形から決めている（環の数が増えたか減ったか）。面ごと消えた
// 写しには地物が無いので、環の数で見ると行き先が決まらず、以前は追加の束ねへ落ちて
// 「穴・飛び地の追加を行いました」と言っていた（現状.md の B99）。

import { test, expect, type Page } from '@playwright/test';

import {
  addInputLayerBox,
  armAddAreaTool,
  drawFace,
  enterEditMode,
  jumpToYear,
  launchApp,
  projectStats,
  squareCorners,
} from './helpers';

/** id → 片 → 環 → [経度, 緯度]。 */
type DrawnShapes = Record<string, number[][][][]>;

async function drawnShapes(page: Page): Promise<DrawnShapes> {
  return page.evaluate(
    () =>
      (window as unknown as { __E2E__: { getDrawnFeatureShapes: () => DrawnShapes } }).__E2E__
        .getDrawnFeatureShapes(),
  );
}

test.describe('B99 — 最後の外周を消すと面ごと消え、状態行は削除と言う', () => {
  test('外周を消す確認に［はい］と答えると面が消え、「穴・飛び地の削除を行いました」と出て、Ctrl+Z で戻る', async () => {
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1200);
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const islandId = await drawFace(page, squareCorners(cx, cy, 80), { name: '島' });
      const before = await drawnShapes(page);
      const statsBefore = await projectStats(page);
      expect(before[islandId]).toBeDefined();

      // 消す側へ切り替え、島を対象にして、外周（面の塗り）を押す。
      await enterEditMode(page);
      await page.getByTestId('tool-edit.ring').click();
      await expect(page.getByTestId('ring-edit-tool')).toBeVisible();
      await page.getByTestId('ring-edit-submode').click();
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('ring-edit-tool')).toHaveAttribute('data-flow', 'deleting');
      await page.mouse.click(cx + 20, cy + 20);
      const impact = page.getByTestId('ring-delete-impact');
      await expect(impact).toBeVisible();
      // 面ごと消えることを事前に言う（設計書 §A.3）。
      await expect(impact).toContainText('消え');
      await page.getByTestId('ring-delete-impact-confirm').click();
      await expect(impact).toHaveCount(0);

      const result = page.getByTestId('statusbar-result');
      await expect(result).toContainText('穴・飛び地の削除を行いました');
      await expect(result).not.toContainText('追加');
      await expect.poll(async () => (await drawnShapes(page))[islandId]).toBeUndefined();

      await page.keyboard.press('Control+z');
      await expect(result).toContainText('元に戻しました');
      await expect.poll(async () => drawnShapes(page)).toEqual(before);
      expect(await projectStats(page)).toEqual(statsBefore);
    } finally {
      await app.close();
    }
  });
});
