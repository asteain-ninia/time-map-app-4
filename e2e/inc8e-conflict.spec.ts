// 増分 8E — 重なりを解消する（設計書 §E.1 の V13）を **7 手を 1 手ずつ** 固定する。
//
//   ① 重なりが起きる → 作業が止まり、重なり解決の板が出る
//   ② 初回だけ番号つきのガイドが出る
//   ③ 重なっている 2 件を見分ける（行に色見本と名前。名前が空なら「名前のない面（…年に作成）」）
//   ④ 残す側のラジオを押す
//   ⑤ 地図の下見を見る（凡例に色見本。重なっていた部分がどちらに付くかが色で出る）
//   ⑥ 適用する
//   ⑦ 状態行に「アルラーク国とバアカの重なりを解消しました（1200年）」が **消えずに残る**
//   取り消し: Ctrl+Z 1 回で解決の適用がまるごと戻る
//
// 重なりの作り方: 増分 3 から FR-29（他の末端地物の内部には頂点を置けない）が効くので、
// 2 つ目の面の頂点はどれも 1 つ目の外に置く。**横長と縦長の長方形を十字に重ねる** と、
// 頂点はどれも相手の外にあり、辺だけが交わって重なりができる。

import { test, expect, type Page } from '@playwright/test';

import {
  addInputLayerBox,
  armAddAreaTool,
  drawFace,
  jumpToYear,
  launchApp,
  type ScreenPoint,
} from './helpers';

/** 中心 (cx, cy)・半幅 hw・半高 hh の長方形の 4 隅（左上から時計回り）。 */
function rect(cx: number, cy: number, hw: number, hh: number): readonly ScreenPoint[] {
  return [
    [cx - hw, cy - hh],
    [cx + hw, cy - hh],
    [cx + hw, cy + hh],
    [cx - hw, cy + hh],
  ];
}

/**
 * 1200 年に、横長の面 → 縦長の面 の順に描く。2 つ目の保存で重なりが見つかって止まる。
 * 名前は空も渡せる（N-18 の検査）。
 */
async function drawCross(
  page: Page,
  names: readonly [string, string],
): Promise<{ cx: number; cy: number }> {
  await jumpToYear(page, 1200);
  await armAddAreaTool(page);
  const b = await addInputLayerBox(page);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  await drawFace(page, rect(cx, cy, 150, 40), { name: names[0] });
  await armAddAreaTool(page);
  await drawFace(page, rect(cx, cy, 40, 140), { name: names[1], waitForSelection: false });
  return { cx, cy };
}

/** いま地図に描かれている地物の数（観測口。描画と同じ解決を通る）。 */
async function drawnFeatureCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __E2E__: { getDrawnFeatureCount: () => number } }).__E2E__
        .getDrawnFeatureCount(),
  );
}

test.describe('増分 8E — 重なりを解消する（V13 の 7 手）', () => {
  test('7 手を 1 手ずつ通り、状態行の知らせが残り、Ctrl+Z 1 回で戻る', async () => {
    const { app, page } = await launchApp();
    try {
      const { cx, cy } = await drawCross(page, ['アルラーク国', 'バアカ']);

      // ① 作業が止まり、重なり解決の板が出る。
      const dialog = page.getByTestId('conflict-dialog');
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId('conflict-paused-banner')).toBeVisible();
      // 冒頭の文に言い換えが添えてある（§H.1）。
      await expect(page.getByTestId('conflict-paraphrase')).toContainText('国境を持つ面');

      // ② 初回だけ番号つきのガイドが出る。読んで閉じる（「今後表示しない」は押さない）。
      const guide = page.getByTestId('conflict-guide');
      await expect(guide).toBeVisible();
      await page.getByTestId('conflict-guide-close').click();
      await expect(guide).toHaveCount(0);

      // ③ 重なっている 2 件を見分ける: 行に 2 つの名前と、それぞれの色見本。
      const rows = page.getByTestId('conflict-rows').locator('li');
      await expect(rows).toHaveCount(1);
      const features = rows.first().getByTestId('conflict-row-features');
      await expect(features).toContainText('アルラーク国');
      await expect(features).toContainText('バアカ');
      await expect(features.getByTestId('conflict-participant-swatch')).toHaveCount(2);
      // 内部 ID（f-5-4 など）は板のどこにも出ない（N-18）。
      expect(await dialog.innerText()).not.toMatch(/\bf-[0-9a-z]+-[0-9a-z]+\b/);

      // ⑤の前提: 選ぶ前は「選ぶ前の面（灰色）」も凡例に出ていて、全部に色見本がある。
      await expect(page.getByTestId('conflict-legend-neutral')).toBeVisible();
      for (const role of ['priority', 'remaining', 'overlap']) {
        await expect(page.getByTestId(`conflict-legend-swatch-${role}`)).toBeVisible();
      }

      // ④ 残す側のラジオを押す（アルラーク国を残す）。
      const keep = rows.first().getByRole('radio', { name: /アルラーク国/ });
      await keep.check();
      await expect(keep).toBeChecked();

      // ⑤ 地図の下見: 選んだので灰色の行は消え、残す側・削られる側・重なりの 3 色になる。
      await expect(page.getByTestId('conflict-legend-neutral')).toHaveCount(0);
      await expect(page.locator('.conflict-preview__canvas')).toBeVisible();
      await expect(page.getByTestId('conflict-legend-swatch-priority')).toHaveAttribute(
        'data-color',
        '#2e7d32',
      );

      // ⑥ 適用する。
      await expect(page.getByTestId('conflict-apply')).toBeEnabled();
      await page.getByTestId('conflict-apply').click();
      await expect(dialog).toHaveCount(0);

      // ⑦ 状態行に「◯◯と◯◯の重なりを解消しました（1200年）」。
      const result = page.getByTestId('statusbar-result');
      await expect(result).toContainText(/(アルラーク国とバアカ|バアカとアルラーク国)の重なりを解消しました（1200年）/);
      // **消えずに残る**: 関係のない操作（道具の持ち替え・地図の空きを押す・Escape）をしても残る。
      await page.getByTestId('tool-edit.select').click();
      await page.mouse.click(cx + 300, cy + 170);
      await page.keyboard.press('Escape');
      await expect(result).toContainText('の重なりを解消しました（1200年）');
      expect(await drawnFeatureCount(page)).toBe(2);

      // 取り消し: Ctrl+Z 1 回で、解決の適用（＝止まっていた追加ごと）がまるごと戻る。
      await page.keyboard.press('Control+z');
      await expect(result).toContainText('元に戻しました');
      await expect.poll(async () => drawnFeatureCount(page)).toBe(1);
    } finally {
      await app.close();
    }
  });

  test('名前が空の面どうしでも内部 ID を出さず、「名前のない面（1200年に作成）」と色見本で見分ける', async () => {
    const { app, page } = await launchApp();
    try {
      await drawCross(page, ['', '']);
      const dialog = page.getByTestId('conflict-dialog');
      await expect(dialog).toBeVisible();
      const features = page.getByTestId('conflict-row-features').first();
      await expect(features).toHaveText('名前のない面（1200年に作成） ／ 名前のない面（1200年に作成）');
      expect(await dialog.innerText()).not.toMatch(/\bf-[0-9a-z]+-[0-9a-z]+\b/);
      // ラジオの名前も同じ呼び名で、内部 ID ではない。
      const radios = page.getByTestId('policy-choice-option');
      await expect(radios).toHaveCount(2);
      for (const label of await radios.allInnerTexts()) {
        expect(label).toContain('名前のない面（1200年に作成）');
      }
      // 色見本は 2 つ出ていて、どちらも色を持つ。
      const swatches = features.getByTestId('conflict-participant-swatch');
      await expect(swatches).toHaveCount(2);
      for (const color of await swatches.evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-color')),
      )) {
        expect(color).toMatch(/^#[0-9a-f]{6}$/i);
      }
      // ［キャンセル］でやめると、やめたことが状態行に出る（「描きかけの頂点を捨てました」と
      // 言わない ―― 保存を押した時点でもう描きかけではない）。
      await page.getByTestId('conflict-cancel').click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('statusbar-result')).toContainText('重なりの解決をやめました');
      await page.waitForTimeout(300);
      await expect(page.getByTestId('statusbar-result')).not.toContainText('捨てました');
    } finally {
      await app.close();
    }
  });
});
