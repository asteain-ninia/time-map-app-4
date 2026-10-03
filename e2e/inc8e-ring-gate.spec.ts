// 増分 8E — G-14: 穴・飛び地の頂点編集を確定前の検査に通す。
//
// 現状分析 §11-5 の申し送り「実機で『穴の頂点を親領土の外へ引きずり出す』のが最短の確認」を
// 実機（E2E）で確かめた結果を、そのまま回帰テストにする:
//   - 親の外周の外へ引き出す → ドラッグ中の拘束が外周の縁で止めるので、外へは出ない（もとから）
//   - 隣の穴の中へ入れる     → **通ってしまっていた**（穴どうしの辺が交わった形が記録された）。
//                               いまは確定の前に断り、理由を状態行に出し、形は元のまま。

import { test, expect, type Page } from '@playwright/test';

import {
  addInputLayerBox,
  armAddAreaTool,
  commitFace,
  enterEditMode,
  launchApp,
  squareCorners,
  type ScreenPoint,
} from './helpers';

interface WorldPoint {
  readonly lon: number;
  readonly lat: number;
}

async function handlePositions(page: Page): Promise<readonly WorldPoint[]> {
  return page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E__?: { getVertexHandlePositions: () => WorldPoint[] };
    }).__E2E__;
    return e2e === undefined ? [] : e2e.getVertexHandlePositions();
  });
}

const HALF = 120;

/** 面を 1 つ描き、輪郭の道具で穴を足していく。最後に「選ぶ」で面を選び直す。 */
async function faceWithHoles(
  page: Page,
  holes: readonly (readonly ScreenPoint[])[],
): Promise<{ cx: number; cy: number }> {
  await armAddAreaTool(page);
  const b = await addInputLayerBox(page);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const faceId = await commitFace(page, squareCorners(cx, cy, HALF), { name: '穴のある面' });
  await enterEditMode(page);
  for (const hole of holes) {
    await page.getByTestId('tool-edit.ring').click();
    await expect(page.getByTestId('ring-edit-tool')).toBeVisible();
    // 手順 1: 対象の面（穴の外の塗り）。手順 2: 穴の輪郭（面の内側）。
    await page.mouse.click(cx + HALF * 0.85, cy + HALF * 0.85);
    for (const [dx, dy] of hole) await page.mouse.click(cx + dx, cy + dy);
    await page.getByTestId('ring-edit-confirm').click();
    await expect(page.getByTestId('statusbar-result')).toContainText('穴・飛び地の追加を行いました');
    await page.getByTestId('tool-edit.select').click();
  }
  await page.keyboard.press('Escape');
  await page.mouse.click(cx + HALF * 0.85, cy + HALF * 0.85);
  await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
  return { cx, cy };
}

/** 画面の (sx, sy) にある頂点を (tx, ty) へ、何度かに分けて引く（本物のドラッグ）。 */
async function drag(page: Page, sx: number, sy: number, tx: number, ty: number): Promise<void> {
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(sx + ((tx - sx) * i) / 8, sy + ((ty - sy) * i) / 8);
  }
  await page.mouse.up();
}

test.describe('増分 8E — G-14: 穴の頂点の編集は確定前の検査を通る', () => {
  test('穴の頂点を隣の穴の中へ入れると、確定せず理由を出し、形は元のまま', async () => {
    const { app, page } = await launchApp();
    try {
      const { cx, cy } = await faceWithHoles(page, [
        [
          [-80, -20],
          [-40, -20],
          [-60, 20],
        ],
        [
          [20, -40],
          [80, -40],
          [80, 40],
          [20, 40],
        ],
      ]);
      await expect.poll(async () => (await handlePositions(page)).length).toBe(11);
      const before = await handlePositions(page);

      // 左の穴の右上の頂点 (-40,-20) を、右の穴の内側 (50, 0) へ。
      await drag(page, cx - 40, cy - 20, cx + 50, cy);

      // 壊れ方と、どの面のどの年の形かを言う（増分 8E の手直し。反証 2-2）。
      await expect(page.getByTestId('statusbar-result')).toContainText(
        '動かした形を確定しませんでした。穴と穴が交わる形になるためです（「穴のある面」の',
      );
      // 形は元のまま（記録されていない）。
      await expect.poll(async () => handlePositions(page)).toEqual(before);
    } finally {
      await app.close();
    }
  });

  // 増分 8E の手直し（設計適合 S2-1・反証 2-1）: 頂点の削除が関門で断られたら、理由を出す。
  // 以前は確認で［消す］を押しても何も起きず、状態行にも何も出なかった。
  test('穴の凹んだ頂点を消すと隣の穴を覆う形では、消えずに「この頂点を消すと穴と穴が交わるので消せません」と出る', async () => {
    const { app, page } = await launchApp();
    try {
      // 矢じり形の穴（(0,-10) が凹んだ頂点）と、その凹みに収まる小さな三角の穴。
      // 凹んだ頂点を消すと、矢じりは三角になって小さな穴を覆う（穴と穴が交わる）。
      const { cx, cy } = await faceWithHoles(page, [
        [
          [-90, -90],
          [0, -10],
          [90, -90],
          [0, 80],
        ],
        [
          [-15, -80],
          [15, -80],
          [0, -55],
        ],
      ]);
      await expect.poll(async () => (await handlePositions(page)).length).toBe(11);
      const before = await handlePositions(page);

      await page.mouse.click(cx, cy - 10, { button: 'right' });
      await page.locator('[data-item-kind="deleteVertex"]').click();
      await expect(page.getByTestId('vertex-delete-impact')).toBeVisible();
      await page.getByTestId('vertex-delete-impact-confirm').click();
      await expect(page.getByTestId('vertex-delete-impact')).toHaveCount(0);

      await expect(page.getByTestId('statusbar-result')).toContainText(
        'この頂点を消すと穴と穴が交わるので消せません（「穴のある面」の',
      );
      // 形は元のまま（消えていない）。
      await page.waitForTimeout(300);
      expect(await handlePositions(page)).toEqual(before);
    } finally {
      await app.close();
    }
  });

  test('穴の頂点を親の外周の外へ引き出しても、外周の外には出ない', async () => {
    const { app, page } = await launchApp();
    try {
      const { cx, cy } = await faceWithHoles(page, [
        [
          [-30, -30],
          [30, -30],
          [0, 30],
        ],
      ]);
      await expect.poll(async () => (await handlePositions(page)).length).toBe(7);
      const before = await handlePositions(page);
      const outerEast = Math.max(...before.map((p) => p.lon));

      // 穴の右上の頂点 (30,-30) を、外周の右の外（中心から 1.6 倍）へ。
      await drag(page, cx + 30, cy - 30, cx + HALF * 1.6, cy - 30);

      await page.waitForTimeout(300);
      const after = await handlePositions(page);
      // どの頂点も外周の東端より外にはない。
      for (const p of after) expect(p.lon).toBeLessThanOrEqual(outerEast + 1e-6);
    } finally {
      await app.close();
    }
  });
});
