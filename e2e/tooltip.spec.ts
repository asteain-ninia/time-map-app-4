// ツールチップの吹き出し（設計書 §H.2 / N-01・N-02）。
//
// N-01: **吹き出しがすぐ上のボタンのクリックを飲み込む。** 「結合」にマウスを置くと吹き出しが
//       真上の「所属変更」の上に出て、`elementFromPoint` が吹き出しを返し、押しても何も
//       起きなかった（実測 shots/A-15b〜A-15d）。
// N-02: **同じ吹き出しがツールレールの `overflow` で右へ 30.8px 切れる。** レール幅 119.2px に
//       対し吹き出しは 144px あり、FR-115 の操作ガイドが「地物の所属を変更し…」で読めなかった。
//
// どちらも「見えているのに操作できない／読めない」型なので、実寸の当たり判定で固定する。

import { test, expect } from '@playwright/test';

import { enterEditMode, launchApp } from './helpers';

test.describe('ツールチップの吹き出し（設計書 §H.2）', () => {
  test('N-01: 吹き出しはクリックを飲み込まず、その下のボタンが押せる', async () => {
    const { app, page } = await launchApp();
    try {
      await enterEditMode(page);

      // 「結合」に置くと、吹き出しは真上の「所属変更」の上に出る（道具の並び順で隣接）。
      const merge = page.getByTestId('tool-edit.merge');
      const reparent = page.getByTestId('tool-edit.reparent');
      await expect(merge).toBeVisible();
      await merge.hover();

      const bubble = page.getByTestId('tooltip-bubble').filter({ hasText: '結合' });
      await expect(bubble).toBeVisible();
      const box = (await bubble.boundingBox())!;
      const target = (await reparent.boundingBox())!;

      // 吹き出しが「所属変更」に **本当に重なっている** こと（この重なりが N-01 の前提。
      // 重なっていなければ検査は空振りなので、ここで落として気づけるようにする）。
      const overlapTop = Math.max(box.y, target.y);
      const overlapBottom = Math.min(box.y + box.height, target.y + target.height);
      const overlapLeft = Math.max(box.x, target.x);
      const overlapRight = Math.min(box.x + box.width, target.x + target.width);
      expect(overlapBottom).toBeGreaterThan(overlapTop);
      expect(overlapRight).toBeGreaterThan(overlapLeft);

      const cx = (overlapLeft + overlapRight) / 2;
      const cy = (overlapTop + overlapBottom) / 2;

      // 重なっている場所で当たり判定を取ると、**吹き出し自身は返らない**
      // （pointer-events: none）。これが N-01 の直接の再現条件だった。
      const hitTestid = await page.evaluate(
        ([x, y]) => {
          const el = document.elementFromPoint(x as number, y as number);
          return el === null
            ? null
            : (el.closest('[data-testid]')?.getAttribute('data-testid') ?? null);
        },
        [cx, cy],
      );
      expect(hitTestid).not.toBe('tooltip-bubble');
      expect(hitTestid).toBe('tool-edit.reparent');

      // そして実際に押せる。
      await expect(reparent).toHaveAttribute('aria-pressed', 'false');
      await page.mouse.click(cx, cy);
      await expect(reparent).toHaveAttribute('aria-pressed', 'true');
    } finally {
      await app.close();
    }
  });

  test('N-02: 吹き出しはツールレールの overflow に切り取られず、窓の中に収まる', async () => {
    const { app, page } = await launchApp();
    try {
      await enterEditMode(page);

      // 「所属変更」の操作ガイド（FR-115）はレール幅より長い。
      await page.getByTestId('tool-edit.reparent').hover();
      const bubble = page.getByTestId('tooltip-bubble').filter({ hasText: '所属' });
      await expect(bubble).toBeVisible();

      const box = (await bubble.boundingBox())!;
      const rail = (await page.getByTestId('toolbar').boundingBox())!;
      const viewport = page.viewportSize() ?? (await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      })));

      // レールの右端を **越えて** 出ている＝枠に閉じ込められていない。
      expect(box.x + box.width).toBeGreaterThan(rail.x + rail.width);
      // それでいて窓の外へは出ない（右端で切れたら読めないのは同じこと）。
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y).toBeGreaterThanOrEqual(0);

      // 祖先の overflow に切り取られないのは position: fixed だから（CSS 側の契約）。
      const position = await bubble.evaluate((el) => getComputedStyle(el).position);
      expect(position).toBe('fixed');
    } finally {
      await app.close();
    }
  });
});
