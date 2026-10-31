// B103 の症状: 800×600 で測量を入れて切ると、「表示 ▾」が「≫」の中に残ったままになっていた。
//
// 原因は、「≫」の中の部品の幅を測り直していなかったこと。測量の読み取りの部品は、顔ぶれは同じまま
// 測っている間だけ幅を持つ。切ったあとも控えた広い幅で「入らない」と読まれ、先頭の読み取りが
// 帯へ戻れず、後ろの「表示 ▾」も戻れなかった。jsdom は実寸を持たないので、ここで実寸を見る（§5.49）。

import { expect, test, type Page } from '@playwright/test';

import { launchApp } from './helpers';

interface BarLayout {
  readonly inBar: readonly string[];
  readonly inPanel: readonly string[];
}

const readLayout = (page: Page): Promise<BarLayout> =>
  page.evaluate(() => {
    const settings = document.querySelector('[data-testid="option-bar-settings"]');
    const panel = document.querySelector('[data-testid="option-bar-overflow-panel"]');
    const ids = (root: Element | null): string[] =>
      [...(root?.querySelectorAll<HTMLElement>('.option-bar__slot') ?? [])].map(
        (e) => e.dataset['testid'] ?? '',
      );
    return { inBar: ids(settings), inPanel: ids(panel) };
  });

for (const [width, height] of [
  [800, 600],
  [1024, 768],
  [1280, 800],
] as const) {
  test(`${String(width)}×${String(height)} で測量を入れて切ると、部品の置き場が入れる前と同じに戻る`, async () => {
    const { app, page } = await launchApp();
    try {
      await app.evaluate(
        ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height);
        },
        { width, height },
      );
      const settings = page.getByTestId('option-bar-settings');
      await expect.poll(async () => (await settings.boundingBox())?.width ?? 0).toBeGreaterThan(0);
      await expect(page.locator('[data-testid="option-slot-display"]')).toHaveCount(1);
      // 窓幅の変更が畳みへ届くのを待ってから基準を読む。
      await page.waitForTimeout(200);
      const before = await readLayout(page);

      await page.getByTestId('survey-toggle').click();
      await expect(page.getByTestId('survey-readout')).toBeAttached();
      await page.getByTestId('survey-toggle').click();
      await expect(page.getByTestId('survey-readout')).toHaveCount(0);

      await expect.poll(() => readLayout(page)).toEqual(before);
      if (width === 800) {
        // 800×600 の前提を固定: 「表示 ▾」は帯に出ていて、中心が本物の部品に当たる。
        expect(before.inBar).toContain('option-slot-display');
        const hit = await page.getByTestId('option-slot-display').evaluate((el) => {
          const r = el.getBoundingClientRect();
          const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return at !== null && el.contains(at);
        });
        expect(hit).toBe(true);
      }
      // 閉じた板は閉じたまま（測るために外した `hidden` が残らない。地図を奪わない）。
      await expect(page.getByTestId('option-bar-overflow-panel')).toBeHidden();
    } finally {
      await app.close();
    }
  });
}

// 測り直しの回数の上限（`MEASURE_STEP_LIMIT`）は 1 回の測定の往復を止めるためのもので、入り切りを
// またいで数えてはいけない。以前は 6 往復目で上限に達し、「表示 ▾」が「≫」に残ったまま戻らなかった。
test('800×600 で測量の入り切りを 10 回繰り返しても、毎回入れる前と同じ置き場へ戻る', async () => {
  test.setTimeout(120_000);
  const { app, page } = await launchApp();
  try {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(800, 600);
    });
    const settings = page.getByTestId('option-bar-settings');
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(800);
    await expect.poll(async () => (await settings.boundingBox())?.width ?? 0).toBeGreaterThan(0);
    await expect(page.locator('[data-testid="option-slot-display"]')).toHaveCount(1);
    await page.waitForTimeout(200);
    const before = await readLayout(page);
    expect(before.inBar).toContain('option-slot-display');

    for (let round = 1; round <= 10; round += 1) {
      await page.getByTestId('survey-toggle').click();
      await expect(page.getByTestId('survey-readout')).toBeAttached();
      await page.getByTestId('survey-toggle').click();
      await expect(page.getByTestId('survey-readout')).toHaveCount(0);
      await expect
        .poll(() => readLayout(page), `${String(round)} 回目の入り切りのあと`)
        .toEqual(before);
    }
  } finally {
    await app.close();
  }
});
