// 増分 8E — G-21: ズームの上下限を超えた操作を理由つきで断る（地図内のズームボタンの脇と状態行）。
//
// 上限で［＋］を押しても、これまでは地図が黙って何も変わらなかった（壊れているのか上限
// なのかが分からない）。いまは脇に「拡大の上限（50倍）です」、状態行に理由と次の一手を出す。

import { test, expect, type Page } from '@playwright/test';

import { launchApp } from './helpers';

/** 脇の文が出るまで同じボタンを押し続ける（上限に着くまでの回数は倍率の刻みで決まる）。 */
async function pressUntilNote(page: Page, buttonTestId: string): Promise<number> {
  const note = page.getByTestId('map-zoom-limit-note');
  for (let i = 1; i <= 60; i += 1) {
    await page.getByTestId(buttonTestId).click();
    if ((await note.count()) > 0) return i;
  }
  throw new Error(`${buttonTestId} を 60 回押しても上下限の知らせが出なかった`);
}

test.describe('増分 8E — G-21: ズームの上下限を理由つきで断る', () => {
  test('上限で［＋］を押すと、脇と状態行に理由が出て、縮小すると脇の文は消える', async () => {
    const { app, page } = await launchApp();
    try {
      const presses = await pressUntilNote(page, 'map-zoom-in');
      // 1 回目からいきなり断ってはいない（上限に着くまでは普通に拡大している）。
      expect(presses).toBeGreaterThan(1);
      const note = page.getByTestId('map-zoom-limit-note');
      await expect(note).toHaveText('拡大の上限（50倍）です');
      await expect(page.getByTestId('statusbar-result')).toContainText(
        'これ以上は拡大できません。拡大の上限（50倍）に達しています。',
      );
      // 脇の文は押せない（地図の上に覆いを作らない＝K-2）。
      expect(await note.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');

      // 縮小すると、もう上限ではないので脇の文は消える。状態行は消えない（K-7）。
      await page.getByTestId('map-zoom-out').click();
      await expect(note).toHaveCount(0);
      await expect(page.getByTestId('statusbar-result')).toContainText('これ以上は拡大できません');
    } finally {
      await app.close();
    }
  });

  test('下限で［−］を押すと、縮小の下限だと言う', async () => {
    const { app, page } = await launchApp();
    try {
      await pressUntilNote(page, 'map-zoom-out');
      await expect(page.getByTestId('map-zoom-limit-note')).toHaveText(/^縮小の下限（.+倍）です$/);
      await expect(page.getByTestId('statusbar-result')).toContainText('これ以上は縮小できません');
    } finally {
      await app.close();
    }
  });
});
