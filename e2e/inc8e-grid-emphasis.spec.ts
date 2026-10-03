// 増分 8E — G-12: 緯経線グリッドの強調（赤道・0 度・180 度）を表示の設定から切り替える。
//
// 強調そのもの（太い赤線）は FR-13 として前から描かれていた（`render/grid-layer.ts` が
// `latitudeEmphasis` / `longitudeEmphasis` を呼ぶ）。調査 08 が「未結線」と書いたのは
// 便利関数 `isLatitudeEmphasized` の側だけを見たためで、**画面から切り替える口** が
// 無かったのが実際の欠落である。「表示 ▾」に 1 つ足し、2 手（開く → 外す）で届く。
//
// 見え方は地図のキャンバスの画素で確かめる（強調の赤 #cc3333 の画素が消える／戻る）。

import { test, expect, type Page } from '@playwright/test';

import { launchApp } from './helpers';

/** 地図のキャンバスで、強調の赤（#cc3333 付近）に当たる画素の数。 */
async function emphasisRedPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    let total = 0;
    for (const canvas of Array.from(document.querySelectorAll('canvas'))) {
      const ctx = canvas.getContext('2d');
      if (ctx === null || canvas.width === 0 || canvas.height === 0) continue;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]!;
        const g = data[i + 1]!;
        const b = data[i + 2]!;
        if (r > 170 && g < 90 && b < 90 && Math.abs(g - b) < 30) total += 1;
      }
    }
    return total;
  });
}

test.describe('増分 8E — G-12: 緯経線グリッドの強調', () => {
  test('「表示 ▾」から赤道・0度・180度の強調を外し、戻せる（保存ファイルに入らない）', async () => {
    const { app, page } = await launchApp();
    try {
      // 起動直後はグリッドが出ていて、強調の赤い線が描かれている。
      await expect(page.getByTestId('grid-toggle')).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => emphasisRedPixels(page)).toBeGreaterThan(50);
      const identity = page.getByTestId('app-identity');
      const identityBefore = await identity.textContent();

      // 1 手目: 表示 ▾ を開く。2 手目: 強調を外す。
      await page.getByTestId('option-display-button').click();
      const toggle = page.getByTestId('display-filter-grid-emphasis');
      await expect(toggle).toBeChecked();
      await toggle.uncheck();
      await expect(toggle).not.toBeChecked();
      await expect.poll(async () => emphasisRedPixels(page)).toBeLessThan(5);

      // 戻せる。
      await toggle.check();
      await expect.poll(async () => emphasisRedPixels(page)).toBeGreaterThan(50);

      // 見え方の切り替えなので、未保存の印は立たない。
      await expect(identity).toHaveText(identityBefore ?? '');
    } finally {
      await app.close();
    }
  });
});
