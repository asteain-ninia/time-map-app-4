// B43: 作図中に時刻が動いたら、同じ年の中の月や日でも「年を戻すか捨てるか」の 2 択になる。
//
// 直す前は年と細かさだけを見ていたので、同じ年の中で 3 月 → 9 月と動くと板が出ず、吸着した
// 頂点 id ごと下書きが 9 月の記録になった（実機で確かめた: 新しい面が 9 月に相手の頂点 id を共有した）。

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

import {
  addInputLayerBox,
  armAddAreaTool,
  drawFace,
  jumpToYear,
  launchApp,
  squareCorners,
} from './helpers';

/** 「直接ジャンプ」の月を入れて飛ぶ。板が出る場面でも使うので、動いたことは確かめない。 */
async function requestMonth(page: Page, month: number): Promise<void> {
  const field = page.getByLabel('直接ジャンプ 月', { exact: true });
  if (!(await field.isVisible())) await page.getByTestId('rail-ymd-button').click();
  const unset = page.getByLabel('直接ジャンプ 月 未指定', { exact: true });
  if ((await unset.getAttribute('aria-pressed')) === 'true') await unset.click();
  await field.fill(String(month));
  await page.getByRole('button', { name: 'ジャンプ', exact: true }).click();
}

test.describe('B43 — 作図中に月だけが動いても、下書きを次の月へ持ち越さない', () => {
  test('吸着して打った下書きで月を動かすと板が出る。続ける＝月が戻り、捨てる＝下書きと吸着が消えて月が進む', async () => {
    test.setTimeout(120_000);
    const dir = mkdtempSync(join(tmpdir(), 'tmap-e2e-b43-'));
    const target = join(dir, 'b43.gimoza');
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
    try {
      await armAddAreaTool(page);
      await jumpToYear(page, 1500);
      await requestMonth(page, 3);
      await expect(page.getByTestId('timeline-current')).toHaveText('1500年3月');

      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const otherId = await drawFace(page, squareCorners(cx, cy, 100), { name: '相手' });

      // 相手の角へ吸着させて 1 点、外へ 2 点。確定できる点数の下書き。
      await armAddAreaTool(page);
      await page.mouse.move(cx + 101, cy + 101);
      await page.mouse.click(cx + 101, cy + 101);
      await page.mouse.click(cx + 220, cy + 100);
      await page.mouse.click(cx + 160, cy + 200);
      await expect(page.getByTestId('add-vertex-count')).toHaveText('3');

      const confirm = page.getByTestId('add-draft-discard-confirm');
      await requestMonth(page, 9);
      await expect(confirm).toBeVisible();
      await expect(page.getByTestId('timeline-current')).toHaveText('1500年3月');

      await page.getByTestId('add-draft-discard-no').click();
      await expect(confirm).toBeHidden();
      await expect(page.getByTestId('timeline-current')).toHaveText('1500年3月');
      await expect(page.getByTestId('add-vertex-count')).toHaveText('3');

      await requestMonth(page, 9);
      await expect(confirm).toBeVisible();
      await page.getByTestId('add-draft-discard-yes').click();
      await expect(page.getByTestId('timeline-current')).toHaveText('1500年9月');

      // 捨てたあとで同じ場所に打っても、記録に 9 月の別の地物の頂点は持ち込まれていない。
      await page.keyboard.press('Control+s');
      await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');
      const manifest = JSON.parse(
        strFromU8(unzipSync(new Uint8Array(readFileSync(target)))['manifest.json']!),
      ) as { histories: readonly { featureId: string }[] };
      expect(manifest.histories.map((h) => h.featureId)).toEqual([otherId]);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
