// B80: ±360° の複製の上で辺の中点を押して足した頂点は、保存する座標が経度 [-180, 180) に入る。
//
// 複製が見えるまで地図を引き（ズームの下限なら 1 周が窓の幅に収まる）、複製の上の辺の中点を
// 実際に押す。経路ごとの正しさを実アプリで見る: 押した辺に頂点が増え、元の頂点は動かず、
// 足した頂点の経度は本来の巻きの辺の中点と同じ。

import { expect, test } from '@playwright/test';

import {
  armVertexTool,
  addInputLayerBox,
  armAddAreaTool,
  committedVertices,
  drawFace,
  launchApp,
  liveCamera,
  squareCorners,
  vertexHandlePositions,
  worldToClient,
} from './helpers';

test.describe('B80 — 複製の上で足した頂点の経度', () => {
  test('複製の上の辺の中点を押すと、足した頂点は本来の巻きの中点に保存され、面の形は変わらない', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await armAddAreaTool(page);
      const face = await addInputLayerBox(page);
      await drawFace(
        page,
        squareCorners(face.x + face.width / 2, face.y + face.height / 2, 200),
        { name: '面' },
      );
      await armVertexTool(page);
      const featureId = await page.getByTestId('app-active-feature').textContent();
      expect(featureId).toBeTruthy();
      await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(4);

      const before = await committedVertices(page, featureId!);
      const corners = [...before.values()];

      // 倍率を下げて、1 周が窓の幅に収まるようにする（複製が窓の中に入る）。
      const layer = page.getByTestId('map-input-layer');
      const box = (await layer.boundingBox())!;
      await page.mouse.move(box.x + 5, box.y + box.height / 2); // 左端を中心に引く（面は左へ寄り、東の複製が窓に入る）。
      // 面の南の辺（緯度の小さい 2 頂点）の中点と、その東の複製。
      const south = [...corners].sort((a, b) => a.lat - b.lat).slice(0, 2);
      const mid = { lon: (south[0]!.lon + south[1]!.lon) / 2, lat: south[0]!.lat };
      const replicaLon = mid.lon + 360;
      await expect
        .poll(async () => {
          const cam = await liveCamera(page);
          const x = box.x + box.width / 2 + (replicaLon - cam.centerLon) * cam.zoom;
          if (x > box.x + 5 && x < box.x + box.width - 5) return true;
          await page.mouse.wheel(0, 200);
          return false;
        }, '東の複製が窓の中に入らない')
        .toBe(true);

      const at = await worldToClient(page, { lon: replicaLon, lat: mid.lat });
      await page.mouse.click(at.x, at.y);
      await expect.poll(async () => (await committedVertices(page, featureId!)).size).toBe(5);

      const after = await committedVertices(page, featureId!);
      for (const [id, p] of before) expect(after.get(id)).toEqual(p);
      const added = [...after.entries()].filter(([id]) => !before.has(id));
      expect(added).toHaveLength(1);
      const stored = added[0]![1];
      expect(stored.lon).toBeGreaterThanOrEqual(-180);
      expect(stored.lon).toBeLessThan(180);
      expect(stored.lon).toBeCloseTo(mid.lon, 6);
      expect(stored.lat).toBeCloseTo(mid.lat, 6);
    } finally {
      await app.close();
    }
  });
});
