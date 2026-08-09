// ベクター背景地図の「実キャンバスへの焼き付け」コストを実測する。
// 併せて、集約形状 (デーレ共和国など) の実キャンバス塗り時間も測る。
//
// 実行: node derle-import/tools/measure-vector-raster.mjs

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const IMPORT_DIR = resolve(here, '..');
const svgText = readFileSync(resolve(IMPORT_DIR, 'イラレ出界図BUR080809.svg'), 'utf-8');
const aggShapes = JSON.parse(readFileSync(resolve(IMPORT_DIR, 'agg-shapes.json'), 'utf-8'));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.setContent('<!doctype html><body style="margin:0"><canvas id="c"></canvas></body>');

const result = await page.evaluate(
  ({ svgText, aggShapes }) => {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const layers = ['_第一分高面', '_第二分高面', '_第三分高面', '_第四分高面', '_第五分高面'];
    const paths = [];
    for (const id of layers) {
      const g = doc.getElementById(id);
      if (!g) continue;
      for (const p of g.querySelectorAll('path')) {
        const d = p.getAttribute('d');
        if (d) paths.push(new Path2D(d));
      }
    }

    const canvas = document.getElementById('c');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');

    const median = (xs) => {
      xs.sort((a, b) => a - b);
      return xs[Math.floor(xs.length / 2)];
    };
    // Canvas2D の描画命令は非同期にキューされるため、1px 読み戻して GPU の完了を待たせる
    // (これをしないと fill() が 0ms に見える)。
    const flush = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.getImageData(0, 0, 1, 1);
    };
    const bench = (fn, n) => {
      fn();
      flush();
      const xs = [];
      for (let i = 0; i < n; i += 1) {
        const t = performance.now();
        fn();
        flush();
        xs.push(performance.now() - t);
      }
      return median(xs);
    };

    // 世界全体 (4249×2123) を 1280×720 に収めるスケール
    const scale = 1280 / 4249;
    const drawAll = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, 1280, 720);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.fillStyle = '#8aa86a';
      for (const p of paths) ctx.fill(p);
    };
    const rasterWorld = bench(drawAll, 7);

    // 拡大時 (10 倍) — 画面外はブラウザがクリップするので実コストは下がるはず
    const drawZoomed = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, 1280, 720);
      ctx.setTransform(scale * 10, 0, 0, scale * 10, -1200 * scale * 10, -700 * scale * 10);
      ctx.fillStyle = '#8aa86a';
      for (const p of paths) ctx.fill(p);
    };
    const rasterZoom10 = bench(drawZoomed, 7);

    // 集約形状 (lon/lat の多角形) の塗り
    const aggResults = aggShapes.map((s) => {
      const p2 = new Path2D();
      for (const poly of s.rings) {
        for (const ring of poly) {
          for (let i = 0; i < ring.length; i += 2) {
            const x = ((ring[i] + 180) / 360) * 1280;
            const y = ((90 - ring[i + 1]) / 180) * 720;
            if (i === 0) p2.moveTo(x, y);
            else p2.lineTo(x, y);
          }
          p2.closePath();
        }
      }
      const t = bench(() => {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, 1280, 720);
        ctx.fillStyle = 'rgba(0,229,255,0.7)';
        ctx.fill(p2, 'evenodd');
      }, 9);
      return { id: s.id, points: s.points, ms: t };
    });

    return { pathCount: paths.length, rasterWorld, rasterZoom10, aggResults };
  },
  { svgText, aggShapes },
);

await browser.close();

console.log(`ベクター背景: path ${result.pathCount} 本`);
console.log(`  世界全体を 1280×720 に焼く : ${result.rasterWorld.toFixed(1)} ms`);
console.log(`  10 倍ズームで焼く          : ${result.rasterZoom10.toFixed(1)} ms`);
console.log('集約形状の実キャンバス塗り (1280×720):');
for (const a of result.aggResults) {
  console.log(`  ${a.id} (${a.points} 点): ${a.ms.toFixed(2)} ms`);
}
