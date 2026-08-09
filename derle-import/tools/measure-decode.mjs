// 「焼いた画像を保存して読む」vs「ベクターから毎回焼く」のコスト比較。
// 現行のベースマップ PNG (8192×4096) を実ブラウザでデコードする時間を測る。
//
// 実行: node derle-import/tools/measure-decode.mjs

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const png = readFileSync(resolve(here, '../basemap.png'));
const b64 = png.toString('base64');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.setContent('<!doctype html><body style="margin:0"></body>');

const out = await page.evaluate(async (b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'image/png' });

  const runs = [];
  for (let i = 0; i < 3; i += 1) {
    const t = performance.now();
    const bmp = await createImageBitmap(blob);
    // 実際に一度描いて GPU へのアップロードまで含める
    const c = document.createElement('canvas');
    c.width = 1280;
    c.height = 720;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0, 1280, 720);
    ctx.getImageData(0, 0, 1, 1);
    runs.push(performance.now() - t);
    bmp.close();
  }
  runs.sort((a, b) => a - b);
  return { bytes: bytes.length, median: runs[1], runs };
}, b64);

await browser.close();
console.log(`basemap.png ${(out.bytes / 1024 / 1024).toFixed(1)} MB (8192×4096)`);
console.log(`  デコード+初回描画: 中央値 ${out.median.toFixed(0)} ms (計測 ${out.runs.map((r) => r.toFixed(0)).join(' / ')} ms)`);
