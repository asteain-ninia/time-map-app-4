// basemap-vector.json をブラウザで焼いて目視確認用の PNG にする。
// 描画側 (アプリ) が行う処理と同じ手順: viewBox → 目標ピクセル矩形への変換を組み、
// 背景を塗ってから、レイヤー順に Path2D を fill するだけ。
//
// 実行: node derle-import/tools/preview-vector-basemap.mjs [出力幅]
// 出力: derle-import/preview-vector.png

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const IMPORT_DIR = resolve(here, '..');
const vector = JSON.parse(readFileSync(resolve(IMPORT_DIR, 'basemap-vector.json'), 'utf-8'));
const W = Number(process.argv[2] ?? 2048);
const H = Math.round(W / 2);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.setContent('<!doctype html><body style="margin:0"><canvas id="c"></canvas></body>');

const dataUrl = await page.evaluate(
  ({ vector, W, H }) => {
    const c = document.getElementById('c');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');

    // 背景 (海)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = vector.background;
    ctx.fillRect(0, 0, W, H);

    // viewBox 矩形 → 出力ピクセル矩形 の線形変換
    const vb = vector.viewBox;
    const sx = W / vb.width;
    const sy = H / vb.height;
    ctx.setTransform(sx, 0, 0, sy, -vb.x * sx, -vb.y * sy);

    for (const layer of vector.layers) {
      ctx.fillStyle = layer.fill;
      for (const d of layer.paths) ctx.fill(new Path2D(d));
    }
    return c.toDataURL('image/png');
  },
  { vector, W, H },
);

await browser.close();
const png = Buffer.from(dataUrl.split(',')[1], 'base64');
const out = resolve(IMPORT_DIR, 'preview-vector.png');
writeFileSync(out, png);
console.log(`wrote ${out} (${W}×${H}, ${(png.length / 1024).toFixed(0)} KB)`);
