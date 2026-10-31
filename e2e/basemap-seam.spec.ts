// 背景地図の絵は経度 180 度でつながる。
//
// 焼き付ける矩形が継ぎ目をまたぐと（中心経度 180 の表示など）、180 より東の帯が海の下地のままに
// なっていた。陸の上の同じ面が、赤線の西で緑がかり、東で紫がかって見えた。実データの
// `area-188`（経度 -180〜179.99、1 色）の上で、継ぎ目の両側の画素を比べる。

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { samplePng } from './basemap-image-helpers';
import { jumpToYear, launchApp, liveCamera, loadProject, worldToClient } from './helpers';

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);

/** 背景の絵も面も、継ぎ目の両側で同じ色の緯度（背景の陸 `#7fb86e` の上の `area-188`）。 */
const LAT = -84;

/** 中心経度の前後 `offset` 度の画素の色（RGB）を返す。 */
async function pixelsAroundCenter(page: Page, offset: number): Promise<[number[], number[]]> {
  const { centerLon } = await liveCamera(page);
  const west = await worldToClient(page, { lon: centerLon - offset, lat: LAT });
  const east = await worldToClient(page, { lon: centerLon + offset, lat: LAT });
  const png = await page.screenshot();
  // 写真は画素、`worldToClient` は CSS の座標（表示倍率が 1 でない機械で揃わない）。
  const scale = await page.evaluate(() => window.devicePixelRatio);
  const { pixels } = await samplePng(page, png, [
    [Math.round(west.x * scale), Math.round(west.y * scale)],
    [Math.round(east.x * scale), Math.round(east.y * scale)],
  ]);
  return [pixels[0]!.slice(0, 3), pixels[1]!.slice(0, 3)];
}

function expectSameColor(a: readonly number[], b: readonly number[], where: string): void {
  const diff = Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
  expect(diff, `${where}: 西 ${a.join(',')} / 東 ${b.join(',')}`).toBeLessThanOrEqual(2);
}

test('中心経度 180 で、継ぎ目の両側の背景の絵がつながる', async () => {
  test.skip(!existsSync(canonicalPath), '実データが無い');
  test.setTimeout(200_000);
  const dir = mkdtempSync(join(tmpdir(), 'gimoza-basemap-seam-'));
  const copy = join(dir, REAL_DATA_FILE);
  copyFileSync(canonicalPath, copy);
  const { app, page } = await launchApp();
  try {
    expect(await loadProject(page, copy)).toBe('loaded');
    await jumpToYear(page, 3000);

    await page.getByTestId('center-lon-absolute-input').fill('180');
    await page.getByTestId('center-lon-absolute-input').press('Enter');
    await expect.poll(async () => Math.abs((await liveCamera(page)).centerLon)).toBe(180);

    // 引いた表示（矩形が世界の半分以上をまたぐ）。
    await page.waitForTimeout(300);
    const [farWest, farEast] = await pixelsAroundCenter(page, 5);
    expectSameColor(farWest, farEast, '引いた表示');

    // 寄せた表示（継ぎ目の近くだけを焼く）。
    for (let i = 0; i < 40 && (await liveCamera(page)).zoom < 40; i += 1) {
      const at = await worldToClient(page, { lon: (await liveCamera(page)).centerLon, lat: LAT });
      await page.mouse.move(at.x, at.y);
      await page.mouse.wheel(0, -240);
      await page.waitForTimeout(50);
    }
    expect((await liveCamera(page)).zoom).toBeGreaterThanOrEqual(40);
    await page.waitForTimeout(300);
    const [nearWest, nearEast] = await pixelsAroundCenter(page, 3);
    expectSameColor(nearWest, nearEast, '寄せた表示');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
