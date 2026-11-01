// ツールチップの吹き出し（設計書 §H.2 / N-01・N-02）。
//
// N-01: **吹き出しがすぐ上のボタンのクリックを飲み込む。** 「結合」にマウスを置くと吹き出しが
//       真上の「所属変更」の上に出て、`elementFromPoint` が吹き出しを返し、押しても何も
//       起きなかった（実測 shots/A-15b〜A-15d）。いまはレールの外の横に出すので、どの道具にも
//       重ならない（B103。吹き出しが道具の文字を隠していた）。重ならないことと、それでも
//       `pointer-events: none` で飲み込まないことの両方を見る。
// N-02: **同じ吹き出しがツールレールの `overflow` で右へ 30.8px 切れる。** レール幅 119.2px に
//       対し吹き出しは 144px あり、FR-115 の操作ガイドが「地物の所属を変更し…」で読めなかった。
//
// どちらも「見えているのに操作できない／読めない」型なので、実寸の当たり判定で固定する。

import { test, expect } from '@playwright/test';

import { TOOLTIPS } from '../src/ui/shell/strings';
import { TOOL_ID } from '../src/ui/shell/tools';

import { enterEditMode, launchApp } from './helpers';

test.describe('ツールチップの吹き出し（設計書 §H.2）', () => {
  for (const size of [
    { width: 1280, height: 800 },
    { width: 800, height: 600 },
  ]) {
    test(`N-01 ${String(size.width)}x${String(size.height)}: どの道具の吹き出しも道具の文字を隠さず、窓の中に出て、上の道具が押せる`, async () => {
      const { app, page } = await launchApp();
      try {
        await page.setViewportSize(size);
        await enterEditMode(page);
        const tools = page.getByTestId('toolbar').locator('button[data-testid^="tool-"]');
        const count = await tools.count();
        expect(count, '道具の数').toBeGreaterThan(5);
        for (let i = 0; i < count; i += 1) {
          const tool = tools.nth(i);
          await tool.hover();
          const seen = await page.getByTestId('toolbar').evaluate((rail) => {
            const bubble = rail.querySelector('[data-testid="tooltip-bubble"]:not([hidden])');
            if (bubble === null) return null;
            const b = bubble.getBoundingClientRect();
            const covers = Array.from(rail.querySelectorAll('button')).filter((button) => {
              const r = button.getBoundingClientRect();
              return b.left < r.right && r.left < b.right && b.top < r.bottom && r.top < b.bottom;
            }).length;
            return {
              covers,
              inWindow: b.left >= 0 && b.top >= 0 && b.right <= window.innerWidth && b.bottom <= window.innerHeight,
              events: getComputedStyle(bubble).pointerEvents,
            };
          });
          const name = (await tool.getAttribute('data-testid')) ?? '';
          // 吹き出しを持たない道具（測るの入れ物）は外す。持つものは全部見る。
          if (seen === null) continue;
          expect(seen.covers, `${name}: 吹き出しが道具を隠さない`).toBe(0);
          expect(seen.inWindow, `${name}: 吹き出しが窓の中`).toBe(true);
          expect(seen.events, `${name}: クリックを飲み込まない`).toBe('none');
        }

        // 「結合」に置いたまま、真上の「所属変更」を押せる（N-01 の元の害）。
        const merge = page.getByTestId('tool-edit.merge');
        const reparent = page.getByTestId('tool-edit.reparent');
        await merge.hover();
        // **画面の言葉を直書きしない**（教訓 5.64）。
        const mergeTip = TOOLTIPS[TOOL_ID.EditMerge];
        expect(mergeTip, '結ぶ道具の吹き出しの文が写像表に無い').toBeTruthy();
        await expect(page.getByTestId('tooltip-bubble').filter({ hasText: mergeTip ?? '' })).toBeVisible();
        const target = (await reparent.boundingBox())!;
        const cx = target.x + target.width / 2;
        const cy = target.y + target.height / 2;
        const hitTestid = await page.evaluate(
          ([x, y]) => document.elementFromPoint(x as number, y as number)?.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
          [cx, cy],
        );
        expect(hitTestid).toBe('tool-edit.reparent');
        await expect(reparent).toHaveAttribute('aria-pressed', 'false');
        await page.mouse.click(cx, cy);
        await expect(reparent).toHaveAttribute('aria-pressed', 'true');
      } finally {
        await app.close();
      }
    });
  }

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
