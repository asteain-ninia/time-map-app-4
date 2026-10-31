// B113: 頂点のドラッグと面の移動で経度 180° の継ぎ目を越えても、保存する経度は [-180, 180) に入る。
//
// 関数の呼び出しでは「畳んだ」ことしか見えないので、実アプリで次を見る:
//   - 本物のドラッグで保存された頂点の経度（手で組んだ値と比べる）
//   - 畳んでも面の形が変わらないこと（描いた形の経度の幅）
//   - 畳んだあとも、見えている場所で同じ頂点を掴めること
//   - 継ぎ目の向こうの面に重ねると、畳んだ座標でも重なりの板で止まること
//   - Ctrl+Z 1 回で元の座標へ戻ること

import { expect, test, type Page } from '@playwright/test';

import {
  armAddAreaTool,
  committedVertices,
  drawFace,
  enterEditMode,
  launchApp,
  vertexHandlePositions,
  worldToClient,
  type ScreenPoint,
} from './helpers';

interface World {
  readonly lon: number;
  readonly lat: number;
}

/** 経度 west〜east、緯度 south〜north の四角形を描く。 */
async function faceAt(
  page: Page,
  west: number,
  east: number,
  south: number,
  north: number,
  name: string,
): Promise<string> {
  const corners: ScreenPoint[] = [];
  for (const p of [
    { lon: west, lat: north },
    { lon: east, lat: north },
    { lon: east, lat: south },
    { lon: west, lat: south },
  ]) {
    const at = await worldToClient(page, p);
    corners.push([at.x, at.y]);
  }
  await armAddAreaTool(page);
  return drawFace(page, corners, { name });
}

async function selectWithTool(
  page: Page,
  at: World,
  id: string,
  tool: 'tool-edit.vertex' | 'tool-edit.move',
): Promise<void> {
  await enterEditMode(page);
  await page.getByTestId('tool-edit.select').click();
  await page.keyboard.press('Escape');
  const p = await worldToClient(page, at);
  await page.mouse.click(p.x, p.y);
  await expect(page.getByTestId('app-active-feature')).toHaveText(id);
  await page.getByTestId(tool).click();
  await expect(page.getByTestId(tool)).toHaveAttribute('aria-pressed', 'true');
}

/** 地図上の from から to へ、本物のマウスで引く。 */
async function dragWorld(page: Page, from: World, to: World): Promise<void> {
  const a = await worldToClient(page, from);
  const b = await worldToClient(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8);
  }
  await page.mouse.up();
}

/** 描いた形（連続の経度へつないだもの）の経度の幅。継ぎ目で輪が割れると 300 度を超える。 */
async function drawnLonWidth(page: Page, id: string): Promise<number> {
  const shapes = await page.evaluate(
    () =>
      (
        window as unknown as {
          __E2E__: { getDrawnFeatureShapes: () => Record<string, number[][][][]> };
        }
      ).__E2E__.getDrawnFeatureShapes(),
  );
  const lons = (shapes[id] ?? []).flat(2).map((p) => p[0]!);
  // 代表の窓で割れても、隣り合う点を最短の向きでつないで幅を測る。
  let cur = lons[0]!;
  let min = cur;
  let max = cur;
  for (const lon of lons.slice(1)) {
    const d = ((lon - cur + 540) % 360) - 180;
    cur += d;
    min = Math.min(min, cur);
    max = Math.max(max, cur);
  }
  return max - min;
}

const inRange = (lon: number): boolean => lon >= -180 && lon < 180;

/** 継ぎ目の両側が窓に入るまで、地図の中央を軸に縮小する（経度 ±190° が地図の中に収まる）。 */
async function bringSeamIntoView(page: Page): Promise<void> {
  const box = (await page.getByTestId('map-input-layer').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect
    .poll(async () => {
      const east = await worldToClient(page, { lon: 190, lat: 0 });
      const west = await worldToClient(page, { lon: -190, lat: 0 });
      if (east.x < box.x + box.width - 5 && west.x > box.x + 5) return true;
      await page.mouse.wheel(0, 100);
      return false;
    }, '継ぎ目が窓に入らない')
    .toBe(true);
}

test.describe('B113 — 継ぎ目を越えた頂点と面の経度', () => {
  test('頂点を 176° から 181° へ引くと -179° で保存され、形は変わらず、見えている場所で掴み直せる', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await bringSeamIntoView(page);
      const id = await faceAt(page, 170, 176, 0, 10, '面');
      await selectWithTool(page, { lon: 173, lat: 5 }, id, 'tool-edit.vertex');
      await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(4);

      const before = await committedVertices(page, id);
      const grabbed = [...before.entries()].sort(
        ([, a], [, b]) => b.lon + b.lat - (a.lon + a.lat),
      )[0]!; // 北東の角
      const beforeOthers = [...before.entries()].filter(([vid]) => vid !== grabbed[0]);

      await dragWorld(page, grabbed[1], { lon: 181, lat: grabbed[1].lat + 2 });
      await expect
        .poll(async () => (await committedVertices(page, id)).get(grabbed[0])?.lat)
        .toBeCloseTo(grabbed[1].lat + 2, 0);

      const after = await committedVertices(page, id);
      const moved = after.get(grabbed[0])!;
      expect(inRange(moved.lon), `保存された経度 ${String(moved.lon)}`).toBe(true);
      expect(moved.lon).toBeCloseTo(-179, 0);
      // ほかの 3 頂点は 1 ビットも動かない。
      for (const [vid, p] of beforeOthers) expect(after.get(vid)).toEqual(p);
      // 面の幅は西端 170° から 181° の 11 度。-179° を 349 度西と読むと 349 度になる。
      expect(await drawnLonWidth(page, id)).toBeCloseTo(11, 0);

      // 見えている場所（181° の位置）でそのまま掴み直して、178° へ戻す。
      await dragWorld(page, { lon: 181, lat: moved.lat }, { lon: 178, lat: moved.lat });
      await expect
        .poll(async () => (await committedVertices(page, id)).get(grabbed[0])?.lon)
        .toBeCloseTo(178, 0);
    } finally {
      await app.close();
    }
  });

  test('面を東へ 8 度動かすと東側の頂点が -176° で保存され、形は同じ。Ctrl+Z で元の座標へ戻る', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await bringSeamIntoView(page);
      // 全体図で押した点が頂点や辺の中点の掴める距離に入らないよう、大きめの面にする。
      const id = await faceAt(page, 150, 176, -15, 15, '面');
      const before = await committedVertices(page, id);
      await selectWithTool(page, { lon: 163, lat: 0 }, id, 'tool-edit.move');

      await dragWorld(page, { lon: 163, lat: 0 }, { lon: 171, lat: 0 });
      await expect
        .poll(async () => (await committedVertices(page, id)).values().next().value?.lon)
        .not.toBe(before.values().next().value?.lon);

      const after = await committedVertices(page, id);
      const lons = [...after.values()].map((p) => p.lon);
      for (const lon of lons) expect(inRange(lon), `保存された経度 ${String(lon)}`).toBe(true);
      // 西側は 158°、東側は 184° ＝ -176°。ドラッグの量は画面の px を通るので 1 度の桁で見る。
      expect(lons.filter((lon) => Math.abs(lon - 158) < 1)).toHaveLength(2);
      expect(lons.filter((lon) => Math.abs(lon + 176) < 1)).toHaveLength(2);
      expect(await drawnLonWidth(page, id)).toBeCloseTo(26, 0);

      await page.keyboard.press('Control+z');
      await expect.poll(async () => committedVertices(page, id)).toEqual(before);
    } finally {
      await app.close();
    }
  });

  test('継ぎ目の向こうの面へ重ねると、畳んだ座標でも重なりの板で止まり、形は元のまま', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await bringSeamIntoView(page);
      await faceAt(page, -178, -170, 0, 10, '向こう');
      const id = await faceAt(page, 165, 174, 0, 10, '動かす');
      const before = await committedVertices(page, id);
      await selectWithTool(page, { lon: 170, lat: 5 }, id, 'tool-edit.move');

      // 東端は 174° + 10° = 184° ＝ -176° で「向こう」の中へ入る。
      await dragWorld(page, { lon: 170, lat: 5 }, { lon: 180, lat: 5 });
      await expect(page.getByTestId('conflict-dialog')).toBeVisible();
      expect(await committedVertices(page, id)).toEqual(before);
    } finally {
      await app.close();
    }
  });
});
