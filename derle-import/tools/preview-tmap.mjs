// 生成した .gimoza の目視確認用プレビュー PNG を作る。
// manifest を読み、ベースマップの上に面情報 (穴は evenodd で抜く) を重ね描きする。
//
// 実行: node derle-import/tools/preview-tmap.mjs [derle-world.gimoza]
// 出力: derle-import/preview.png

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const IMPORT_DIR = resolve(here, '..');
const tmapName = process.argv[2] ?? 'derle-world.gimoza';

const entries = unzipSync(new Uint8Array(readFileSync(resolve(IMPORT_DIR, tmapName))));
const manifest = JSON.parse(strFromU8(entries['manifest.json']));
const basemapB64 = Buffer.from(entries['assets/basemap.img']).toString('base64');

const W = 2048;
const H = 1024;
const sx = (lon) => ((lon + 180) / 360) * W;
const sy = (lat) => ((90 - lat) / 180) * H;

let paths = '';
for (const h of manifest.histories) {
  const snap = h.entries[0].anchor.snapshot;
  const vmap = new Map(snap.vertices.map((v) => [v.id, v.coordinate]));
  for (const f of snap.features) {
    if (f.kind !== 'leaf') continue;
    let d = '';
    for (const ring of f.shape.rings) {
      const cmds = ring.vertexIds.map((vid, k) => {
        const c = vmap.get(vid);
        return `${k === 0 ? 'M' : 'L'}${sx(c.lon).toFixed(2)},${sy(c.lat).toFixed(2)}`;
      });
      d += `${cmds.join('')}Z`;
    }
    const fill = f.color.fillColor;
    const op = f.color.fillOpacity ?? 1;
    paths += `<path d="${d}" fill="${fill}" fill-opacity="${op}" stroke="${f.color.borderColor}" stroke-width="0.4" fill-rule="evenodd"/>`;
  }
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0}svg{display:block}
</style></head><body>
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <image href="data:image/png;base64,${basemapB64}" x="0" y="0" width="${W}" height="${H}"/>
  ${paths}
</svg></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.setContent(html, { waitUntil: 'load', timeout: 120_000 });
await page.waitForTimeout(500);
const png = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
await browser.close();

const out = resolve(IMPORT_DIR, 'preview.png');
writeFileSync(out, png);
console.log(`wrote ${out}`);
