// derle-map-visualizer をヘッドレス Chromium で駆動し、デーレ界の国ポリゴンを
// JSON (borders.json) に抽出する。
//
// パイプライン (visualizer 側の実装をそのまま使う):
//   loadSvgText(svg) → buildGraph() → extractPolygons()
//   結果は state.graph (points/edges) と state.polygons / state.polygonTypes。
//
// 高速化: requestAnimationFrame を setTimeout(0) に差し替え、描画チェックを全 OFF、
// Wikipedia 風出力のキャッシュ構築をスタブ化する。
//
// 実行: node derle-import/tools/extract-polygons.mjs
// 出力: derle-import/borders.json

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const VIS_DIR = resolve(here, '../../../derle-map-visualizer');
// 2026-08-09: 最新版 (イラレ出界図BUR080809.svg、ユーザーが .ai から書き出し) に切替
const SVG_PATH = resolve(here, '../イラレ出界図BUR080809.svg');
// --states: _州境界 レイヤーも国境と同じグラフに混ぜて抽出する (州レベルの面が取れる)。
// 出力は borders-states.json。国レベル抽出 (既定) は borders.json。
const WITH_STATES = process.argv.includes('--states');
const OUT_PATH = resolve(here, WITH_STATES ? '../borders-states.json' : '../borders.json');

const svgText = readFileSync(SVG_PATH, 'utf-8');

const browser = await chromium.launch();
const page = await browser.newPage();

// rAF を実質 setTimeout(0) 化 (visualizer はチャンクごとに nextFrame() を待つ)
await page.addInitScript(() => {
  const timers = new Map();
  let nextId = 1;
  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      cb(performance.now());
    }, 0));
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
  };
});

page.on('pageerror', (err) => console.error('[pageerror]', err.message));
await page.goto(pathToFileURL(resolve(VIS_DIR, 'index.html')).href);

// SVG を直接流し込む (ファイル選択 UI をバイパス)
await page.evaluate((text) => {
  loadSvgText(text);
}, svgText);
const viewBox = await page.evaluate(() => state.viewBox);
console.log('viewBox:', viewBox);

if (WITH_STATES) {
  // 州境界の子要素を国境界グループへ移し、国境と同じパイプラインで処理させる
  const moved = await page.evaluate(() => {
    const doc = state.svgDoc;
    const st = doc.getElementById('_州境界');
    const kb = doc.getElementById('_国境界');
    if (!st || !kb) return -1;
    let n = 0;
    while (st.firstChild) {
      kb.appendChild(st.firstChild);
      n += 1;
    }
    return n;
  });
  console.log(`州境界 → 国境界へ ${moved} 要素を統合`);
}

// パラメータは visualizer の既定値のまま。重い描画・投影を無効化。
await page.evaluate(() => {
  el.showEdges.checked = false;
  el.showPolys.checked = false;
  el.showPoints.checked = false;
  if (el.wikiAuto) el.wikiAuto.checked = false;
  if (el.wikiAnimate) el.wikiAnimate.checked = false;
  window.collectLandVectorPaths = () => [];
  window.scheduleWikipediaUpdate = () => {};
});

// グラフ構築 (国境線+海岸線のサンプリング → 吸着/分割 → グラフ化)
await page.evaluate(() => {
  window.__buildDone = false;
  buildGraph().then(() => {
    window.__buildDone = true;
  });
});

// 進捗を表示しつつ完了待ち (最大 30 分)
const t0 = Date.now();
for (;;) {
  const st = await page.evaluate(() => ({
    done: window.__buildDone === true && !buildGraphInProgress,
    msg: el.statusBox ? el.statusBox.textContent : '',
  }));
  if (st.done) break;
  if (Date.now() - t0 > 30 * 60 * 1000) {
    throw new Error(`buildGraph timeout: ${st.msg}`);
  }
  console.log('  ...', st.msg.replace(/\s+/g, ' ').slice(0, 100));
  await new Promise((r) => setTimeout(r, 5000));
}
const graphOk = await page.evaluate(() => ({
  ok: !!state.graph,
  msg: el.statusBox.textContent,
}));
if (!graphOk.ok) throw new Error(`buildGraph failed: ${graphOk.msg}`);
console.log('graph built:', graphOk.msg.replace(/\s+/g, ' ').slice(0, 120));

// 閉じ損ねた国境の橋渡し: 行き止まり (次数1) の国境端点が、自分の隣接点以外の
// 点から 2 地図単位以内にある場合、そこへ辺を追加して面を閉じる。
// (作図精度の問題で吸着許容値 1 をわずかに超える隙間が実在する —
//  中央イノン/東イノン間で 0.95〜、他にも同種の隙間がある)
const bridged = await page.evaluate(() => {
  const g = state.graph;
  const deg = new Array(g.points.length).fill(0);
  const adjOne = new Map(); // 次数1点 → 隣接点
  for (const e of g.edges) {
    deg[e.a] += 1;
    deg[e.b] += 1;
  }
  for (const e of g.edges) {
    if (deg[e.a] === 1) adjOne.set(e.a, e.b);
    if (deg[e.b] === 1) adjOne.set(e.b, e.a);
  }
  // 隣接リスト (3 ホップ以内の自チェーン点を橋渡し先から除外するため)
  const adjAll = new Map();
  for (const e of g.edges) {
    if (!adjAll.has(e.a)) adjAll.set(e.a, []);
    if (!adjAll.has(e.b)) adjAll.set(e.b, []);
    adjAll.get(e.a).push(e.b);
    adjAll.get(e.b).push(e.a);
  }
  const bridges = [];
  const BRIDGE_RADIUS = 2.5;
  // 国境線の行き止まり同士はより大きい半径で接続する (バアカ/コルニア南方の長い
  // 海上国境線に、縦の区切り線や島周りの境界線が 2.6〜5.7 届かないケースが多数)。
  // 海の中で自由に終わる共有海式の国境線が誤って海岸線に繋がるのを避けるため、
  // 大きい半径は「接続先も国境線の点」の場合に限る。
  const BRIDGE_RADIUS_BORDER = 6.0;
  const isBorderPoint = new Uint8Array(g.points.length);
  for (const e of g.edges) {
    if (e.sources.has('border')) {
      isBorderPoint[e.a] = 1;
      isBorderPoint[e.b] = 1;
    }
  }
  // 個別指定の橋渡し (座標 ±0.5 に一致する行き止まりだけ、より大きい半径を許す)。
  // ラヴィエンド・ウィル西方の岬: 点線国境の終端が岬の先端にあり、最寄りの海岸線
  // サンプル点まで 4.41 ある (地図の意図は海岸への接続)。
  const EXTRA_BRIDGES = [{ x: 783.4, y: 739.8, r: 5.0 }];

  // 平面性の維持 (必須): 橋渡し辺が既存の辺と交差すると、交点にノードが無いまま
  // グラフが非平面になり、面探索が破綻する (リングが自己交差 → 穴が外周をはみ出す
  // "hole-crosses-parent" が実測 6 件)。既存辺と真に交差する橋渡しは棄却する。
  // 探索は一様グリッドで近傍辺だけに絞る (辺 10 万本 × 橋渡し 100 本の総当たりを回避)。
  const CELL = 8;
  const cellKey = (cx, cy) => `${cx},${cy}`;
  const grid = new Map();
  const addToGrid = (idx, a, b) => {
    const x0 = Math.floor(Math.min(a.x, b.x) / CELL);
    const x1 = Math.floor(Math.max(a.x, b.x) / CELL);
    const y0 = Math.floor(Math.min(a.y, b.y) / CELL);
    const y1 = Math.floor(Math.max(a.y, b.y) / CELL);
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        const k = cellKey(cx, cy);
        let list = grid.get(k);
        if (list === undefined) {
          list = [];
          grid.set(k, list);
        }
        list.push(idx);
      }
    }
  };
  for (let i = 0; i < g.edges.length; i += 1) {
    addToGrid(i, g.points[g.edges[i].a], g.points[g.edges[i].b]);
  }
  const orient = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  /** 端点を共有しない 2 線分が真に交差するか (端点接触は交差としない)。 */
  const properlyCrosses = (p1, p2, p3, p4) => {
    const d1 = orient(p3, p4, p1);
    const d2 = orient(p3, p4, p2);
    const d3 = orient(p1, p2, p3);
    const d4 = orient(p1, p2, p4);
    return (
      ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
    );
  };
  /** 橋渡し tip→target が既存辺と交差するなら true (= 採用不可)。 */
  const bridgeCrosses = (ti, tj) => {
    const p1 = g.points[ti];
    const p2 = g.points[tj];
    const x0 = Math.floor(Math.min(p1.x, p2.x) / CELL);
    const x1 = Math.floor(Math.max(p1.x, p2.x) / CELL);
    const y0 = Math.floor(Math.min(p1.y, p2.y) / CELL);
    const y1 = Math.floor(Math.max(p1.y, p2.y) / CELL);
    const seen = new Set();
    for (let cx = x0 - 1; cx <= x1 + 1; cx += 1) {
      for (let cy = y0 - 1; cy <= y1 + 1; cy += 1) {
        const list = grid.get(cellKey(cx, cy));
        if (list === undefined) continue;
        for (const ei of list) {
          if (seen.has(ei)) continue;
          seen.add(ei);
          const e = g.edges[ei];
          if (e.a === ti || e.b === ti || e.a === tj || e.b === tj) continue;
          if (properlyCrosses(p1, p2, g.points[e.a], g.points[e.b])) return true;
        }
      }
    }
    return false;
  };

  let rejected = 0;
  for (const [tip] of adjOne) {
    if (deg[tip] !== 1) continue; // 既に橋渡しで次数が増えた場合
    const near = new Set([tip]);
    let frontier = [tip];
    for (let hop = 0; hop < 3; hop += 1) {
      const next = [];
      for (const v of frontier) {
        for (const w of adjAll.get(v) ?? []) {
          if (!near.has(w)) {
            near.add(w);
            next.push(w);
          }
        }
      }
      frontier = next;
    }
    const p = g.points[tip];
    let radius = BRIDGE_RADIUS;
    for (const ex of EXTRA_BRIDGES) {
      if (Math.abs(p.x - ex.x) <= 0.5 && Math.abs(p.y - ex.y) <= 0.5) radius = ex.r;
    }
    // 国境線の行き止まりは、国境線の点に対してだけ大きい半径で探す
    const borderRadius =
      isBorderPoint[tip] === 1 ? Math.max(radius, BRIDGE_RADIUS_BORDER) : radius;
    // 候補を距離順に並べ、既存辺と交差しない最も近い相手を採用する
    const candidates = [];
    for (let j = 0; j < g.points.length; j += 1) {
      if (near.has(j)) continue;
      const q = g.points[j];
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      const limit = isBorderPoint[j] === 1 ? borderRadius : radius;
      if (d < limit) candidates.push({ j, d });
    }
    candidates.sort((u, v) => u.d - v.d);
    let best = -1;
    let bestD = 0;
    for (const c of candidates) {
      if (bridgeCrosses(tip, c.j)) continue;
      best = c.j;
      bestD = c.d;
      break;
    }
    if (best === -1) {
      if (candidates.length > 0) rejected += 1;
      continue;
    }
    const newIdx = g.edges.length;
    g.edges.push({ a: tip, b: best, sources: new Set(['border']) });
    addToGrid(newIdx, g.points[tip], g.points[best]);
    deg[tip] += 1;
    deg[best] += 1;
    bridges.push({ x: p.x, y: p.y, d: bestD });
  }
  return { bridges, rejected };
});
console.log(
  `橋渡しした国境の隙間: ${bridged.bridges.length} 箇所 (交差により棄却 ${bridged.rejected} 箇所)`,
);

// ポリゴン抽出 + 国タイプ判定 (同期)
await page.evaluate(() => {
  extractPolygons();
});

const result = await page.evaluate(() => ({
  meta: {
    viewBox: state.viewBox,
    sampleStep: Number(el.sampleStep.value),
    snapTolerance: Number(el.snapTolerance.value),
    dashSnapMultiplier: Number(el.dashSnapMultiplier.value),
  },
  points: state.graph.points.map((p) => ({ x: p.x, y: p.y })),
  edges: state.graph.edges.map((e) => ({ a: e.a, b: e.b, sources: Array.from(e.sources) })),
  polygons: state.polygons.map((p) => ({
    id: p.id,
    area: p.area,
    points: p.points,
    type: state.polygonTypes.get(String(p.id)) || '不明',
  })),
}));
await browser.close();

console.log(
  `points=${result.points.length} edges=${result.edges.length} polygons=${result.polygons.length}`,
);
const typeCounts = {};
for (const p of result.polygons) typeCounts[p.type] = (typeCounts[p.type] || 0) + 1;
console.log('types:', JSON.stringify(typeCounts));

writeFileSync(OUT_PATH, JSON.stringify(result));
console.log(`wrote ${OUT_PATH}`);
