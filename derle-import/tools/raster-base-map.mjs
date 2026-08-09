// デーレ界イラレ出界図 SVG → ベースマップ PNG (4096×2048, 正距円筒 2:1)
//
// 世界矩形 = SVG 内の海色レクト (x=5.262, y=0.5, w=4243.4, h=2121.7 ≒ 2:1)。
// viewBox をこの矩形に差し替え、preserveAspectRatio="none" で 4096×2048 に
// 引き伸ばして Chromium (Playwright) でラスタライズする。
// ベースマップには地形のみ焼き込む: _海 + _分高面 を表示、_境界(国境/州境) と
// _文字(各種地名) は非表示 (国境はアプリ側の面情報として編集対象になるため)。
//
// 実行: node derle-import/tools/raster-base-map.mjs
// 出力: derle-import/basemap.png

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
// 2026-08-09: 最新版 (イラレ出界図BUR080809.svg、ユーザーが .ai から書き出し) に切替
const SVG_PATH = resolve(here, '../イラレ出界図BUR080809.svg');
const OUT_PATH = resolve(here, '../basemap.png');

// 世界矩形 (海色レクトと同一)。座標変換の単一真実源として world-rect.json にも書き出す。
// BUR080809 版でも海色レクトは不変: x=5.26 y=.5 w=4243.4 h=2121.7
const WORLD_RECT = { x: 5.26, y: 0.5, width: 4243.4, height: 2121.7 };
// 2026-08-09: 実機報告「拡大すると背景がぼやける」への対応で 4096×2048 → 8192×4096。
// 既定の最大ズーム 50 倍では世界幅 = 360°×50 = 18,000px 相当なので、4096 だと 4.4 倍に
// 引き伸ばされて明確にぼやける。8192 なら 2.2 倍まで改善する (デコード後 8192×4096×4B
// ≒ 134MB。これ以上 (16384) は 512MB になり非現実的なので、ここが実用上の上限)。
const OUT_W = 8192;
const OUT_H = 4096;

const svgText = readFileSync(SVG_PATH, 'utf-8');

// ルート <svg ...> の属性を差し替え
const modified = svgText.replace(
  /<svg\b[^>]*>/,
  `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT_W}" height="${OUT_H}" ` +
    `viewBox="${WORLD_RECT.x} ${WORLD_RECT.y} ${WORLD_RECT.width} ${WORLD_RECT.height}" ` +
    `preserveAspectRatio="none">` +
    // 地形以外 (境界・文字・経緯線など新レイヤー含む) を非表示にするホワイトリスト方式
    `<style>svg > g:not([id="_海"]):not([id="_分高面"]) { display: none; }</style>`,
);

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; }
  svg { display: block; width: ${OUT_W}px; height: ${OUT_H}px; }
</style></head><body>${modified}</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: OUT_W, height: OUT_H },
  deviceScaleFactor: 1,
});
await page.setContent(html, { waitUntil: 'load', timeout: 120_000 });
// フォント/描画の安定を待つ (テキストは非表示なので保険程度)
await page.waitForTimeout(1000);
const png = await page.screenshot({
  clip: { x: 0, y: 0, width: OUT_W, height: OUT_H },
  timeout: 120_000,
});
await browser.close();

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, png);
writeFileSync(
  resolve(here, '../world-rect.json'),
  JSON.stringify({ worldRect: WORLD_RECT, outputPx: { width: OUT_W, height: OUT_H } }, null, 2),
);
console.log(`wrote ${OUT_PATH} (${png.length} bytes)`);
