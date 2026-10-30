// 増分 8E — G-21: ズームの上下限を超えた操作を理由つきで断る（地図内のズームボタンの脇と状態行）。
//
// 上限で［＋］を押しても、これまでは地図が黙って何も変わらなかった（壊れているのか上限
// なのかが分からない）。いまは脇に「拡大の上限（50倍）です」、状態行に理由と次の一手を出す。

import { test, expect, type Page } from '@playwright/test';

import { PROJECT_FIELD_STRINGS } from '../src/ui/settings/strings';

import { launchApp, leaveViewMode } from './helpers';

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

  // 増分 8E の手直し（設計適合 S2-5・GPT 重 2）: ホイールでも上下限で理由を出す。
  test('ホイールで上限を超えて回すと、脇と状態行に理由が出る', async () => {
    const { app, page } = await launchApp();
    try {
      await hoverMapCenter(page);
      const note = page.getByTestId('map-zoom-limit-note');
      for (let i = 0; i < 80 && (await note.count()) === 0; i += 1) {
        await page.mouse.wheel(0, -100);
        await page.waitForTimeout(20);
      }
      await expect(note).toHaveText('拡大の上限（50倍）です');
      await expect(page.getByTestId('statusbar-result')).toContainText(
        'これ以上は拡大できません。拡大の上限（50倍）に達しています。',
      );
    } finally {
      await app.close();
    }
  });

  // 増分 8E の手直し（GPT 重 2）: 消えた脇の文が、元の倍率へ戻っただけで復活しない。
  // B88: 設定で狭めた上下限が地図の拡大縮小で守られるか、最小 > 最大を設定が断るかを 1 本の操作で見る。
  // 探索 explore2-r4 は「読むだけ」の鍵を閉じたまま設定を開いていたので、プロジェクト設定の欄は
  // 無効で入力が入らず、保存は何も変えずに閉じていた（それを「受け付けた」「狭めた」と記録していた）。
  test('設定で範囲を [0.5, 4] に狭めると拡大は 4 倍で止まり、最小 > 最大は理由つきで断られる', async () => {
    const { app, page } = await launchApp();
    try {
      // 鍵を開けてから設定を開く（読むだけではプロジェクト設定を変えられない＝K-6）。
      await leaveViewMode(page);
      await page.getByTestId('menu-tools').click();
      await page.getByTestId('menu-items-tools').locator('[data-command="tools.settings"]').click();
      await expect(page.getByTestId('settings-dialog')).toBeVisible();
      await page.getByTestId('settings-tab-project').click();
      const zoomMin = page.getByLabel(PROJECT_FIELD_STRINGS.zoomMin);
      const zoomMax = page.getByLabel(PROJECT_FIELD_STRINGS.zoomMax);
      await expect(zoomMin).toBeEnabled();

      // 最小 > 最大は断る: 板は閉じず、最小の欄に理由が付く。
      await zoomMin.fill('8');
      await zoomMax.fill('2');
      await page.getByTestId('settings-save').click();
      await expect(page.getByTestId('settings-error-zoomMin')).toBeVisible();
      await expect(page.getByTestId('settings-dialog')).toBeVisible();

      // 正しい範囲 [0.5, 4] は受け付けて閉じる。
      await zoomMin.fill('0.5');
      await zoomMax.fill('4');
      await page.getByTestId('settings-save').click();
      await expect(page.getByTestId('settings-dialog')).toHaveCount(0);

      // ［＋］を押し続けると 4 倍で止まり、脇の文も設定の数で言う。
      const presses = await pressUntilNote(page, 'map-zoom-in');
      expect(presses).toBeGreaterThan(1);
      await expect(page.getByTestId('map-zoom-limit-note')).toHaveText('拡大の上限（4倍）です');
      expect(await liveZoom(page)).toBeLessThanOrEqual(4 + 1e-6);

      // ホイールで回し続けても 4 倍を越えない。
      await hoverMapCenter(page);
      for (let i = 0; i < 15; i += 1) {
        await page.mouse.wheel(0, -120);
        await page.waitForTimeout(20);
      }
      expect(await liveZoom(page)).toBeLessThanOrEqual(4 + 1e-6);
    } finally {
      await app.close();
    }
  });

  test('上限で断ったあと、ホイールで縮小して元の倍率へ戻しても、脇の文は復活しない', async () => {
    const { app, page } = await launchApp();
    try {
      await pressUntilNote(page, 'map-zoom-in');
      const note = page.getByTestId('map-zoom-limit-note');
      await hoverMapCenter(page);
      await page.mouse.wheel(0, 100);
      await expect(note).toHaveCount(0);
      // 1 ノッチ戻すと倍率は上限に戻るが、このノッチは断っていない（上限の手前から動いた）。
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(300);
      await expect(note).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});

/** 地図の入力層が名乗っている、いまの倍率（カメラのクランプと同じ単位）。 */
async function liveZoom(page: Page): Promise<number> {
  const raw = await page.getByTestId('map-input-layer').getAttribute('data-zoom');
  expect(raw).not.toBeNull();
  return Number(raw);
}

/** 地図の中ほどへポインタを置く（ホイールは地図の入力層が受ける）。 */
async function hoverMapCenter(page: Page): Promise<void> {
  const b = (await page.getByTestId('map-input-layer').boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
}
