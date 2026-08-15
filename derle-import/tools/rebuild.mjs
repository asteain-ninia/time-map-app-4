// デーレ界の .gimoza を作り直す。
//
// 変換ロジックは持たない。`../derle-map-visualizer` をヘッドレス Chromium で開き、
// ブラウザで手作業するのと同じ手順を自動で踏むだけ（実装は 1 つのまま）。
// 手でやる場合の手順は README にある。
//
// 実行:
//   node derle-import/tools/rebuild.mjs                        → derle-world-full.gimoza
//   node derle-import/tools/rebuild.mjs --target-vertices=16500 → derle-world.gimoza
//   node derle-import/tools/rebuild.mjs --out=試作.gimoza       → 名前を指定して書き出す
//
// 書き出したら整合性チェックを掛けること:
//   npx vite-node derle-import/tools/diagnose-consistency.ts derle-world-full.gimoza

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const importDir = resolve(here, '..');
const visualizer = resolve(importDir, '../../derle-map-visualizer/index.html');
const sourceSvg = resolve(importDir, 'イラレ出界図BUR080809.svg');

const argOf = (name) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};
const rawTarget = argOf('target-vertices');
const targetVertices = rawTarget === null ? null : Number(rawTarget);
if (targetVertices !== null && !(targetVertices > 0)) {
  console.error('--target-vertices には正の数を指定してください。');
  process.exit(1);
}
const outName = argOf('out') ?? (targetVertices === null ? 'derle-world-full.gimoza' : 'derle-world.gimoza');
const outPath = resolve(importDir, outName);

const svgText = readFileSync(sourceSvg, 'utf-8');
const browser = await chromium.launch();
const page = await browser.newPage();
// 実データでは requestAnimationFrame の待ちだけで数十秒かかる。描画結果は使わないので潰す。
await page.addInitScript(() => {
  const timers = new Map();
  let next = 1;
  window.requestAnimationFrame = (cb) => {
    const id = next++;
    timers.set(id, setTimeout(() => { timers.delete(id); cb(performance.now()); }, 0));
    return id;
  };
  window.cancelAnimationFrame = (id) => { clearTimeout(timers.get(id)); timers.delete(id); };
});
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(pathToFileURL(visualizer).href);
await page.evaluate((text) => loadSvgText(text), svgText);
await page.evaluate(() => {
  // 重ね描きと Wikipedia 風プレビューは書き出しに要らない
  el.showEdges.checked = false;
  el.showPolys.checked = false;
  el.showPoints.checked = false;
  if (el.wikiAuto) el.wikiAuto.checked = false;
  window.collectLandVectorPaths = () => [];
  window.scheduleWikipediaUpdate = () => {};
});

// 「州境界で階層化する」= 国レベルと州レベルを続けて抽出し、国レベルはグループ化にだけ使う
await page.evaluate((target) => {
  window.__result = null;
  window.__error = null;
  window.__progress = '';
  (async () => {
    try {
      const countryPass = await runExtractionPass(false);
      const basePass = await runExtractionPass(true);
      const bytes = await Gimoza.exportGimoza({
        points: basePass.points,
        edges: basePass.edges,
        polygons: basePass.polygons,
        types: basePass.types,
        svgDoc: state.svgDoc,
        countryPolygons: countryPass,
        options: target === null
          ? {}
          : { targetVertices: target, onProgress: (m) => { window.__progress = m; } },
      });
      window.__result = {
        bytes: Array.from(bytes),
        countryFaces: countryPass.polygons.length,
        stateFaces: basePass.polygons.length,
      };
    } catch (err) {
      window.__error = `${err.message}\n${err.stack}`;
    }
  })();
}, targetVertices);

const started = Date.now();
for (;;) {
  const snapshot = await page.evaluate(() => ({
    done: window.__result !== null,
    err: window.__error,
    line: (window.__progress || (document.getElementById('status') || {}).textContent || '').split('\n')[0],
  }));
  if (snapshot.err !== null && snapshot.err !== undefined) throw new Error(snapshot.err);
  if (snapshot.done) break;
  if (Date.now() - started > 30 * 60 * 1000) throw new Error('30 分を過ぎました');
  process.stdout.write(`\r[${Math.round((Date.now() - started) / 1000)}s] ${snapshot.line.slice(0, 70)}   `);
  await new Promise((r) => setTimeout(r, 3000));
}
const result = await page.evaluate(() => window.__result);
await browser.close();

writeFileSync(outPath, Buffer.from(result.bytes));
console.log(`\n国レベル ${result.countryFaces} 面 / 州レベル ${result.stateFaces} 面`);
console.log(`${outName} を書き出しました (${(result.bytes.length / 1024 / 1024).toFixed(2)} MB)`);
