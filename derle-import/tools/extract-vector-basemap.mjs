// 出界図 SVG から「ベクター背景地図」を抽出する。
//
// ラスター (PNG) の代わりに .gimoza へ入れるデータで、ズームしてもぼやけない。
// 形式は SVG のパス定義 (d 属性) をそのまま保持する:
//   - 曲線がそのまま残るので、点列にサンプリングするより小さく・かつ正確
//   - 描画側は Path2D でブラウザにパースさせて塗るだけ (実測 世界全体 19.8ms /
//     10倍ズーム 5.6ms — 8192×4096 PNG のデコード 162ms より速い)
//
// 実行: node derle-import/tools/extract-vector-basemap.mjs
// 出力: derle-import/basemap-vector.json

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const IMPORT_DIR = resolve(here, '..');
const svgText = readFileSync(resolve(IMPORT_DIR, 'イラレ出界図BUR080809.svg'), 'utf-8');
const { worldRect } = JSON.parse(readFileSync(resolve(IMPORT_DIR, 'world-rect.json'), 'utf-8'));

// 背景に含めるレイヤー (地形のみ。国境・州境・文字はアプリ側の地物なので除く)
const LAYER_IDS = [
  '_第一分高面',
  '_第二分高面',
  '_第三分高面',
  '_第四分高面',
  '_第五分高面',
];

const browser = await chromium.launch();
const page = await browser.newPage();
// SVG を実 DOM に載せる (getComputedStyle で class 由来の塗り色を解決するため)
await page.setContent(`<!doctype html><body style="margin:0">${svgText}</body>`, {
  waitUntil: 'load',
  timeout: 120_000,
});

const extracted = await page.evaluate(
  ({ layerIds }) => {
    const out = [];
    for (const id of layerIds) {
      const g = document.getElementById(id);
      if (g === null) continue;
      // 同じ塗り色ごとにパスをまとめる (描画時の状態変更を減らす)
      const byFill = new Map();
      for (const p of g.querySelectorAll('path, polygon, rect')) {
        const style = getComputedStyle(p);
        const fill = style.fill;
        if (fill === 'none' || fill === '' || style.display === 'none') continue;
        let d = null;
        if (p.tagName === 'path') {
          d = p.getAttribute('d');
        } else if (p.tagName === 'rect') {
          const x = Number(p.getAttribute('x') ?? 0);
          const y = Number(p.getAttribute('y') ?? 0);
          const w = Number(p.getAttribute('width') ?? 0);
          const h = Number(p.getAttribute('height') ?? 0);
          d = `M${x},${y}H${x + w}V${y + h}H${x}Z`;
        } else if (p.tagName === 'polygon') {
          const pts = (p.getAttribute('points') ?? '').trim();
          if (pts.length > 0) d = `M${pts}Z`;
        }
        if (d === null || d.length === 0) continue;
        if (!byFill.has(fill)) byFill.set(fill, []);
        byFill.get(fill).push(d);
      }
      for (const [fill, paths] of byFill) out.push({ layer: id, fill, paths });
    }
    // 海の色 (背景の下地) — 海色レクトの塗り
    const sea = document.getElementById('_海色');
    const background = sea === null ? '#4a6fb5' : getComputedStyle(sea).fill;
    return { groups: out, background };
  },
  { layerIds: LAYER_IDS },
);

await browser.close();

// rgb(a,b,c) → #rrggbb (JSON を小さく・描画側の扱いを単純に)
const toHex = (css) => {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css);
  if (m === null) return css;
  const h = (v) => Math.round(Number(v)).toString(16).padStart(2, '0');
  return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
};

const vector = {
  kind: 'tmap/basemap-vector@1',
  // SVG ユーザー座標のどの矩形が世界矩形 (経度 -180..180 / 緯度 90..-90) に対応するか。
  // 描画側はこれだけで SVG 座標 → 画面 の変換を決められる。
  viewBox: {
    x: worldRect.x,
    y: worldRect.y,
    width: worldRect.width,
    height: worldRect.height,
  },
  background: toHex(extracted.background),
  layers: extracted.groups.map((g) => ({ fill: toHex(g.fill), paths: g.paths })),
};

const json = JSON.stringify(vector);
writeFileSync(resolve(IMPORT_DIR, 'basemap-vector.json'), json);

const pathCount = vector.layers.reduce((n, l) => n + l.paths.length, 0);
console.log(`背景色: ${vector.background}`);
for (const l of vector.layers) console.log(`  塗り ${l.fill}: path ${l.paths.length} 本`);
console.log(
  `wrote basemap-vector.json: ${vector.layers.length} グループ / path ${pathCount} 本 / ${(json.length / 1024 / 1024).toFixed(2)} MB`,
);
