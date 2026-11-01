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
  projectStats,
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
): Promise<{ cx: number; cy: number; before: DrawnShapes; statsBefore: unknown }> {
  await jumpToYear(page, 1200);
  await armAddAreaTool(page);
  const b = await addInputLayerBox(page);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  await drawFace(page, rect(cx, cy, 150, 40), { name: names[0] });
  // 2 つ目を描く前（＝重なる前）の形と企画の数（Ctrl+Z で戻る先）。
  const before = await drawnShapes(page);
  const statsBefore = await projectStats(page);
  await armAddAreaTool(page);
  await drawFace(page, rect(cx, cy, 40, 140), { name: names[1], waitForSelection: false });
  return { cx, cy, before, statsBefore };
}

/** id → 片 → 環 → [経度, 緯度]。 */
type DrawnShapes = Record<string, number[][][][]>;

/** いま地図に描いている面の形（観測口。描画と同じ解決を通る）。 */
async function drawnShapes(page: Page): Promise<DrawnShapes> {
  return page.evaluate(
    () =>
      (window as unknown as { __E2E__: { getDrawnFeatureShapes: () => DrawnShapes } }).__E2E__
        .getDrawnFeatureShapes(),
  );
}

/** 形の全頂点の緯度の範囲。 */
function latRange(pieces: number[][][][]): { min: number; max: number } {
  const lats = pieces.flatMap((rings) => rings.flatMap((ring) => ring.map((c) => c[1]!)));
  return { min: Math.min(...lats), max: Math.max(...lats) };
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
      const { cx, cy, before, statsBefore } = await drawCross(page, ['アルラーク国', 'バアカ']);
      const [keptId] = Object.keys(before);
      expect(Object.keys(before)).toHaveLength(1);

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

      // 形そのもので確かめる（増分 8E の手直し。GPT 重 2）:
      //   - 残す側（アルラーク国＝横長）の形は、重なる前とまったく同じ
      //   - 削られた側（バアカ＝縦長）は、横長の帯の上と下の 2 片（飛び地）に分かれ、
      //     どの片も横長の帯の緯度の内側に入っていない（重なりが消えた）
      const after = await drawnShapes(page);
      expect(after[keptId!]).toEqual(before[keptId!]);
      const adjustedId = Object.keys(after).find((id) => id !== keptId)!;
      const adjusted = after[adjustedId]!;
      expect(adjusted).toHaveLength(2);
      const band = latRange(before[keptId!]!);
      const eps = 1e-6;
      for (const piece of adjusted) {
        const r = latRange([piece]);
        expect(r.min >= band.max - eps || r.max <= band.min + eps, `片 ${JSON.stringify(r)} が帯 ${JSON.stringify(band)} に重なる`).toBe(true);
      }

      // 戻せることが、状態行の元に戻す枠で分かる（設計書 §E.1 の V13 の取り消し。B10）。
      await expect(page.getByTestId('statusbar-undo')).toHaveText('元に戻せます: 重なりの解消（Ctrl+Z）');

      // 取り消し: Ctrl+Z 1 回で、解決の適用（＝止まっていた追加ごと）がまるごと戻る。
      await page.keyboard.press('Control+z');
      await expect(result).toContainText('元に戻しました: 重なりの解消');
      await expect.poll(async () => drawnFeatureCount(page)).toBe(1);
      // 形・頂点・企画の数が、2 つ目を描く前とまったく同じ。
      expect(await drawnShapes(page)).toEqual(before);
      expect(await projectStats(page)).toEqual(statsBefore);
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
      // 番号札が付くときは名前の前に「①」「②」が入る。
      await expect(features).toHaveText(
        /^①?名前のない面（1200年に作成） ／ ②?名前のない面（1200年に作成）$/,
      );
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
      const colors = await swatches.evaluateAll((els) => els.map((el) => el.getAttribute('data-color')));
      for (const color of colors) expect(color).toMatch(/^#[0-9a-f]{6}$/i);
      // 増分 8E の手直し（設計適合 S2-4）: 2 つの色見本が同じなら番号札（①②）が行・ラジオ・
      // 地図の下見に付き、違えば付かない。どちらの場合でも 2 件を見分けられる。
      const tags = dialog.getByTestId('conflict-participant-tag');
      const preview = dialog.locator('.conflict-preview__canvas');
      if (colors[0]!.toLowerCase() === colors[1]!.toLowerCase()) {
        await expect(features.getByTestId('conflict-participant-tag')).toHaveText(['①', '②']);
        await expect(tags).toHaveCount(4);
        await expect(preview).toHaveAttribute('data-tags', '①②');
      } else {
        await expect(tags).toHaveCount(0);
        await expect(preview).toHaveAttribute('data-tags', '');
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
