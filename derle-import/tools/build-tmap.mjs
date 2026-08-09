// borders.json (derle-map-visualizer 抽出結果) → time-map-app-4 の .tmap を生成する。
//
//   node derle-import/tools/build-tmap.mjs                        → derle-world-full.tmap
//   node derle-import/tools/build-tmap.mjs --target-vertices=16500 → derle-world.tmap (間引き版)
//
// 変換内容:
//   1. SVG 座標 → 経緯度 (世界矩形 = 海色レクト、world-rect.json 参照)
//   2. (間引き版のみ) 境界チェーン単位の Douglas-Peucker 間引き
//      — 隣接ポリゴンが同じチェーンを共有するため、チェーン単位で間引けば境界共有が壊れない
//   3. ポリゴン包含解析 → 内包ポリゴン (包領・島・内海) を外側ポリゴンの穴リングにする
//      (穴リングは内包ポリゴンと同じ頂点 ID を共有 → 末端排他が厳密に成立)
//   4. _国名 レイヤーのラベル位置 → 点包含で国名を割り当て
//   5. 各ポリゴン = 末端地物 1 つ = 単一錨 (year 0 〜 open-end) の履歴
//   6. manifest + basemap.png を fflate で ZIP 化 (.tmap)

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import pc from 'polygon-clipping';

const here = dirname(fileURLToPath(import.meta.url));
const IMPORT_DIR = resolve(here, '..');
// 2026-08-09: 最新版 (イラレ出界図BUR080809.svg) に切替 (ラベル抽出用)
const SVG_PATH = resolve(here, '../イラレ出界図BUR080809.svg');

// --- 引数 -------------------------------------------------------------------
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const targetVertices = args.has('target-vertices') ? Number(args.get('target-vertices')) : null;
// 間引きが交差(重なり)を生んだポリゴンの id を列挙すると、そのリングの点を全て
// 残す(=当該境界のみ間引き解除)。共有チェーンはグローバル keep 集合経由で
// 隣接ポリゴン側にも同一に反映されるため、境界共有は壊れない。
const keepFullIds = new Set(
  (args.get('keep-full') ?? '')
    .split(',')
    .filter((s) => s.length > 0)
    .map(Number),
);
// --keep-near=A:B[,A:B...] — ポリゴン A の境界点のうち、ポリゴン B の bbox 近傍に
// あるものだけ間引きを解除する (A の簡略化境界が B を横切った場合の局所修復)。
const keepNearPairs = (args.get('keep-near') ?? '')
  .split(',')
  .filter((s) => s.includes(':'))
  .map((s) => s.split(':').map(Number));
const outName = args.get('out') ?? (targetVertices ? 'derle-world.tmap' : 'derle-world-full.tmap');

// --- 入力 -------------------------------------------------------------------
// 面データ: 州境界込み抽出 (borders-states.json) があればそれを使い、国レベル抽出
// (borders.json) は「面→国」のグループ化 (階層化) にだけ使う。--flat で従来どおり
// 国レベルのみのフラットな出力になる。
const statesPath = resolve(IMPORT_DIR, 'borders-states.json');
const useStates = !args.has('flat') && existsSync(statesPath);
const borders = JSON.parse(
  readFileSync(useStates ? statesPath : resolve(IMPORT_DIR, 'borders.json'), 'utf-8'),
);
const countryBorders = useStates
  ? JSON.parse(readFileSync(resolve(IMPORT_DIR, 'borders.json'), 'utf-8'))
  : null;
if (useStates) console.log('階層モード: 面=borders-states.json / 国=borders.json');
const { worldRect } = JSON.parse(readFileSync(resolve(IMPORT_DIR, 'world-rect.json'), 'utf-8'));
// ベースマップ資産: ベクター (basemap-vector.json) があればそれを入れる。
// ラスターより速く読め (実測 焼き付け 19.8ms vs PNG デコード 162ms)、拡大してもぼやけない。
// --raster-basemap を付けると従来どおり PNG を入れる。
const vectorPath = resolve(IMPORT_DIR, 'basemap-vector.json');
const useVectorBaseMap = !args.has('raster-basemap') && existsSync(vectorPath);
const baseMapAsset = useVectorBaseMap
  ? readFileSync(vectorPath)
  : readFileSync(resolve(IMPORT_DIR, 'basemap.png'));
console.log(
  `ベースマップ: ${useVectorBaseMap ? 'ベクター (basemap-vector.json)' : 'ラスター (basemap.png)'} ${(baseMapAsset.length / 1024 / 1024).toFixed(2)} MB`,
);
const svgText = readFileSync(SVG_PATH, 'utf-8');

const pts = borders.points; // [{x,y}] SVG 座標
const NP = pts.length;

// デーレ界の測地系: 惑星半径 1.0489 地球半径 (derle-climate PROJECT_CONTEXT.md)
// → 赤道長 = 40075.017 × 1.0489 ≒ 42035 km。扁平率は未設定のため 0 (球面近似)。
const EQUATOR_KM = 42035;

// --- 1. リングの整形 ---------------------------------------------------------
// 閉包重複 (先頭=末尾) と連続重複を除去し、3 頂点未満は捨てる。
function cleanRing(indices) {
  let r = indices.slice();
  if (r.length >= 2 && r[0] === r[r.length - 1]) r = r.slice(0, -1);
  const out = [];
  for (const i of r) {
    if (out.length === 0 || out[out.length - 1] !== i) out.push(i);
  }
  while (out.length >= 2 && out[0] === out[out.length - 1]) out.pop();
  return new Set(out).size >= 3 ? out : null;
}

// リングの正規化: 面抽出の一筆書きは「橋渡し辺を往復して島を除外する」自己接触
// リング (スリット付き) を生むことがある。同一頂点の再訪で閉じる部分ループを検出し、
//   - 面積 ≈ 0 (往復スパー) → 除去
//   - 外周と逆回り (ポケット = island 等の除外領域) → 明示的な穴リングに分解
//   - 外周と同回り (頂点接触のローブ) → そのまま残す
function ringSignedArea(indices) {
  let a = 0;
  for (let i = 0; i < indices.length; i += 1) {
    const p = pts[indices[i]];
    const q = pts[indices[(i + 1) % indices.length]];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}
function decomposeRing(indices) {
  const outerSign = Math.sign(ringSignedArea(indices));
  let out = [];
  const pockets = [];
  let posOf = new Map();
  for (const v of indices) {
    if (posOf.has(v)) {
      const s = posOf.get(v);
      const loop = out.slice(s);
      const area = ringSignedArea(loop);
      if (Math.abs(area) < 1e-9 || new Set(loop).size < 3) {
        // 往復スパー: 捨てる (v の最初の出現だけ残す)
        out = out.slice(0, s + 1);
        posOf = new Map(out.map((u, k) => [u, k]));
        continue;
      }
      if (Math.sign(area) !== outerSign) {
        // ポケット: 穴リングとして分解
        pockets.push(loop);
        out = out.slice(0, s + 1);
        posOf = new Map(out.map((u, k) => [u, k]));
        continue;
      }
      // 同回りのローブ: 残す (頂点重複を許容)
    }
    posOf.set(v, out.length);
    out.push(v);
  }
  return { outer: out, pockets };
}

const polygons = [];
let pocketCount = 0;
let spurTrimmed = 0;
for (const p of borders.polygons) {
  const ring = cleanRing(p.points);
  if (ring === null) {
    console.warn(`skip degenerate polygon id=${p.id} (${p.points.length} pts)`);
    continue;
  }
  const { outer, pockets } = decomposeRing(ring);
  const cleaned = cleanRing(outer);
  if (cleaned === null) {
    console.warn(`skip degenerate polygon after decompose id=${p.id}`);
    continue;
  }
  if (outer.length !== ring.length) spurTrimmed += 1;
  pocketCount += pockets.length;
  polygons.push({
    id: p.id,
    type: p.type,
    ring: cleaned,
    pockets: pockets.map((l) => cleanRing(l)).filter((l) => l !== null),
    absArea: Math.abs(p.area),
  });
}
if (pocketCount > 0 || spurTrimmed > 0) {
  console.log(`リング正規化: ポケット穴 ${pocketCount} 件 / スパー除去 ${spurTrimmed} 面`);
}

// --- 2. チェーン単位の間引き (targetVertices 指定時のみ) ---------------------
// グラフの次数 2 でない点 = 分岐点 (junction)。分岐点間の道 (チェーン) を DP で
// 間引き、リング列を「残す点集合」でフィルタする。両隣のポリゴンが同じチェーンを
// 参照するため境界共有は保たれる。
function simplifyKeepSet(epsilon) {
  const adj = Array.from({ length: NP }, () => []);
  for (const e of borders.edges) {
    adj[e.a].push(e.b);
    adj[e.b].push(e.a);
  }
  const degree = adj.map((l) => l.length);
  const keep = new Uint8Array(NP);

  const perpDist = (p, a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    const cx = a.x + t * dx;
    const cy = a.y + t * dy;
    return Math.hypot(p.x - cx, p.y - cy);
  };

  // chain: 点インデックス列 (両端含む)。両端は必ず keep、内部を DP。
  function dpChain(chain) {
    keep[chain[0]] = 1;
    keep[chain[chain.length - 1]] = 1;
    const stack = [[0, chain.length - 1]];
    while (stack.length > 0) {
      const [s, e] = stack.pop();
      if (e - s < 2) continue;
      const a = pts[chain[s]];
      const b = pts[chain[e]];
      let maxD = -1;
      let maxI = -1;
      for (let i = s + 1; i < e; i += 1) {
        const d = perpDist(pts[chain[i]], a, b);
        if (d > maxD) {
          maxD = d;
          maxI = i;
        }
      }
      if (maxD > epsilon) {
        keep[chain[maxI]] = 1;
        stack.push([s, maxI], [maxI, e]);
      }
    }
  }

  // 辺の訪問管理 (無向)
  const edgeKey = (a, b) => (a < b ? a * NP + b : b * NP + a);
  const visited = new Set();

  // 分岐点から伸びるチェーンを歩く
  for (let v = 0; v < NP; v += 1) {
    if (degree[v] === 2 || degree[v] === 0) continue;
    for (const first of adj[v]) {
      if (visited.has(edgeKey(v, first))) continue;
      const chain = [v];
      let prev = v;
      let cur = first;
      visited.add(edgeKey(prev, cur));
      chain.push(cur);
      while (degree[cur] === 2) {
        const next = adj[cur][0] === prev ? adj[cur][1] : adj[cur][0];
        visited.add(edgeKey(cur, next));
        prev = cur;
        cur = next;
        chain.push(cur);
      }
      dpChain(chain);
    }
  }
  // 残り = 分岐点を含まない純サイクル (孤島など)。2 分割して DP。
  for (let v = 0; v < NP; v += 1) {
    if (degree[v] !== 2) continue;
    if (visited.has(edgeKey(v, adj[v][0])) && visited.has(edgeKey(v, adj[v][1]))) continue;
    const cycle = [v];
    let prev = v;
    let cur = adj[v][0];
    visited.add(edgeKey(prev, cur));
    while (cur !== v) {
      cycle.push(cur);
      const next = adj[cur][0] === prev ? adj[cur][1] : adj[cur][0];
      visited.add(edgeKey(cur, next));
      prev = cur;
      cur = next;
    }
    // アンカー2点 (始点と最遠点) で半分ずつ DP
    let far = 1;
    let farD = -1;
    for (let i = 1; i < cycle.length; i += 1) {
      const d = Math.hypot(pts[cycle[i]].x - pts[v].x, pts[cycle[i]].y - pts[v].y);
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    dpChain(cycle.slice(0, far + 1));
    dpChain([...cycle.slice(far), v]);
    // 極小の島も最低 4 点は残す (退化リング防止)
    const keptInCycle = cycle.filter((i) => keep[i] === 1);
    if (keptInCycle.length < 4) {
      for (let k = 0; k < 4; k += 1) keep[cycle[Math.floor((k * cycle.length) / 4)]] = 1;
    }
  }
  return keep;
}

// 冗長点の除去 (フル版の既定): visualizer は SVG パスを一定間隔 (1.2 地図単位 ≒ 11 km) で
// サンプリングするため、元データで 2 点だけの直線国境も等間隔の点列になってしまう。
// 実測では、リング上の点の 20% が「前後の点と 10 m 以内で一直線」= 完全な冗長点。
// ここで小さい epsilon の間引きを掛けると、直線は元どおり両端 2 点へ戻る。
//
// 既定 0.02 地図単位 = 約 190 m。最大ズーム (50 倍) でも画面上 0.085 px 相当なので、
// 見た目は変化しない (--cleanup-epsilon=0 で無効化、大きくすればより積極的に削る)。
const CLEANUP_EPSILON = args.has('cleanup-epsilon')
  ? Number(args.get('cleanup-epsilon'))
  : 0.02;

let activePolygons = polygons;
if (targetVertices !== null || CLEANUP_EPSILON > 0) {
  let best = null;
  if (targetVertices !== null) {
    // epsilon を二分探索して目標頂点数へ寄せる
    let lo = 0.01;
    let hi = 20;
    for (let iter = 0; iter < 24; iter += 1) {
      const mid = Math.sqrt(lo * hi); // 対数スケールで二分
      const keep = simplifyKeepSet(mid);
      const rings = polygons.map((p) => p.ring.filter((i) => keep[i] === 1));
      const used = new Set();
      for (const r of rings) for (const i of r) used.add(i);
      const count = used.size;
      if (
        best === null ||
        Math.abs(count - targetVertices) < Math.abs(best.count - targetVertices)
      ) {
        best = { epsilon: mid, keep, count };
      }
      if (Math.abs(count - targetVertices) / targetVertices < 0.03) break;
      if (count > targetVertices) lo = mid;
      else hi = mid;
    }
    console.log(`simplify: epsilon=${best.epsilon.toFixed(4)} → ${best.count} 共有頂点`);
  } else {
    const keep = simplifyKeepSet(CLEANUP_EPSILON);
    const used = new Set();
    for (const p of polygons) for (const i of p.ring) if (keep[i] === 1) used.add(i);
    best = { epsilon: CLEANUP_EPSILON, keep, count: used.size };
    const before = new Set();
    for (const p of polygons) for (const i of p.ring) before.add(i);
    console.log(
      `冗長点の除去: epsilon=${CLEANUP_EPSILON} (約 ${(CLEANUP_EPSILON * 9.42).toFixed(2)} km / 最大ズームで ${(CLEANUP_EPSILON * 4.24).toFixed(3)} px) → ${before.size} → ${used.size} 共有頂点`,
    );
  }
  // 保護 (全周リング/ポケット/内包の原型維持) は「積極的な間引き」でのみ必要。
  // 冗長点の除去 (epsilon 0.02 = 最大ズームで 0.085px) は形をほぼ動かさないので保護を
  // 掛けず、代わりに生成後の整合性チェックで担保する (崩れたら keep-full で個別救済)。
  const aggressive = targetVertices !== null;
  // 全周リングの解除と --keep-full での個別救済は、軽い除去でも必要 (実測: 南極域の
  // 全周リングは epsilon 0.02 でもシーム解釈が変わり重なりを生む)。
  for (const p of polygons) {
    // 経度全周に及ぶリング (南極域など bbox が世界幅の 9 割超) はシーム跨ぎ展開の
    // 解釈が間引きで変わり偽の重なりを生むため、常に間引きを解除する。
    let minX = Infinity;
    let maxX = -Infinity;
    for (const i of p.ring) {
      const q = pts[i];
      if (q.x < minX) minX = q.x;
      if (q.x > maxX) maxX = q.x;
    }
    const wraps = maxX - minX >= worldRect.width * 0.9;
    if (wraps || keepFullIds.has(p.id)) {
      for (const i of p.ring) best.keep[i] = 1;
      console.log(`keep-full: polygon id=${p.id} は間引きを解除${wraps ? ' (全周リング)' : ''}`);
    }
  }
  // ポケット穴 (自己接触リングの分解で生まれた穴) は、外周とは独立に間引かれると
  // 親からはみ出す (hole-not-contained/hole-crosses-parent が実測 18 件)。ポケットの
  // 頂点と、その近傍にある外周頂点は間引かない — ポケットは小さいので費用は僅か。
  let pocketKept = 0;
  for (const p of aggressive ? polygons : []) {
    if (p.pockets.length === 0) continue;
    for (const loop of p.pockets) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const i of loop) {
        const q = pts[i];
        if (q.x < minX) minX = q.x;
        if (q.y < minY) minY = q.y;
        if (q.x > maxX) maxX = q.x;
        if (q.y > maxY) maxY = q.y;
        if (best.keep[i] !== 1) {
          best.keep[i] = 1;
          pocketKept += 1;
        }
      }
      const pad = best.epsilon * 6;
      for (const i of p.ring) {
        const q = pts[i];
        if (
          q.x >= minX - pad &&
          q.x <= maxX + pad &&
          q.y >= minY - pad &&
          q.y <= maxY + pad &&
          best.keep[i] !== 1
        ) {
          best.keep[i] = 1;
          pocketKept += 1;
        }
      }
    }
  }
  if (pocketKept > 0) console.log(`ポケット穴の保持: ${pocketKept} 点を間引き対象から除外`);

  // 内包関係の穴 (島・包領・内海) も、外周と独立に間引かれると親からはみ出す
  // (hole-not-contained が実測 18 件)。内包ペアを間引き前に求め、内側の bbox 近傍の
  // 外周頂点を保持して、外周が内側を横切らないようにする。
  const preParents = aggressive ? computeParents(polygons, bboxesOf(polygons)) : [];
  // --keep-full で指定した面は、その内包子 (穴になる面) も併せて原型維持する。
  // 親だけ原型・穴だけ間引きだと、穴が親を跨いで hole-crosses-parent になるため。
  for (let i = 0; aggressive && i < polygons.length; i += 1) {
    const parent = preParents[i];
    if (parent !== -1 && keepFullIds.has(polygons[parent].id)) {
      for (const vi of polygons[i].ring) best.keep[vi] = 1;
      for (const loop of polygons[i].pockets) for (const vi of loop) best.keep[vi] = 1;
    }
  }
  let containKept = 0;
  for (let i = 0; aggressive && i < polygons.length; i += 1) {
    const parent = preParents[i];
    if (parent === -1) continue;
    const inner = polygons[i];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const vi of inner.ring) {
      const q = pts[vi];
      if (q.x < minX) minX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.x > maxX) maxX = q.x;
      if (q.y > maxY) maxY = q.y;
    }
    // 内側リングも間引かない: 内外の隙間が epsilon 未満だと、内側だけが動いても
    // 外周を跨いでしまう (穴と親の距離は保証されていない)。
    for (const vi of inner.ring) {
      if (best.keep[vi] !== 1) {
        best.keep[vi] = 1;
        containKept += 1;
      }
    }
    const pad = best.epsilon * 6;
    for (const vi of polygons[parent].ring) {
      const q = pts[vi];
      if (
        q.x >= minX - pad &&
        q.x <= maxX + pad &&
        q.y >= minY - pad &&
        q.y <= maxY + pad &&
        best.keep[vi] !== 1
      ) {
        best.keep[vi] = 1;
        containKept += 1;
      }
    }
  }
  if (containKept > 0) {
    console.log(`内包穴の周辺保持: ${containKept} 点を間引き対象から除外`);
  }
  for (const [aId, bId] of keepNearPairs) {
    const a = polygons.find((p) => p.id === aId);
    const b = polygons.find((p) => p.id === bId);
    if (!a || !b) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const i of b.ring) {
      const q = pts[i];
      if (q.x < minX) minX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.x > maxX) maxX = q.x;
      if (q.y > maxY) maxY = q.y;
    }
    const pad = best.epsilon * 4;
    let restored = 0;
    for (const i of a.ring) {
      const q = pts[i];
      if (
        q.x >= minX - pad &&
        q.x <= maxX + pad &&
        q.y >= minY - pad &&
        q.y <= maxY + pad &&
        best.keep[i] !== 1
      ) {
        best.keep[i] = 1;
        restored += 1;
      }
    }
    console.log(`keep-near: polygon ${aId} の ${restored} 点を ${bId} 近傍で復元`);
  }
  activePolygons = [];
  for (const p of polygons) {
    const ring = cleanRing(p.ring.filter((i) => best.keep[i] === 1));
    if (ring === null) {
      console.warn(`simplify: polygon id=${p.id} が退化したため原型を維持`);
      activePolygons.push(p);
    } else {
      const pockets = p.pockets
        .map((l) => cleanRing(l.filter((i) => best.keep[i] === 1)))
        .filter((l) => l !== null);
      activePolygons.push({ ...p, ring, pockets });
    }
  }
}

// --- 3. 包含解析 → 穴リング --------------------------------------------------
// 各ポリゴンの代表点 (最大 9 頂点の多数決) が他ポリゴンのリング内にあるかを判定。
// 内包する最小面積のポリゴン = 直接の親。親の shape に穴リングを追加する。
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = pts[ring[i]];
    const b = pts[ring[j]];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function bboxesOf(polys) {
  return polys.map((p) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const i of p.ring) {
      const q = pts[i];
      if (q.x < minX) minX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.x > maxX) maxX = q.x;
      if (q.y > maxY) maxY = q.y;
    }
    return { minX, minY, maxX, maxY };
  });
}

/** 各ポリゴンを直接内包する最小面積ポリゴンの index (無ければ -1)。 */
function computeParents(polys, bbs) {
  const parents = new Array(polys.length).fill(-1);
  for (let i = 0; i < polys.length; i += 1) {
    const p = polys[i];
    const bb = bbs[i];
    let bestJ = -1;
    for (let j = 0; j < polys.length; j += 1) {
      if (j === i) continue;
      const q = polys[j];
      if (q.absArea <= p.absArea) continue;
      const qb = bbs[j];
      if (qb.minX > bb.minX || qb.minY > bb.minY || qb.maxX < bb.maxX || qb.maxY < bb.maxY) {
        continue;
      }
      // ポリゴン同士が辺を共有する隣接ペアは互いのリング上に頂点が乗るため、
      // 共有していない頂点だけで多数決する
      const qSet = new Set(q.ring);
      const samples = [];
      for (const vi of p.ring) {
        if (!qSet.has(vi)) samples.push(vi);
        if (samples.length >= 9) break;
      }
      if (samples.length === 0) continue; // 全頂点共有 = 隣接であり内包ではない
      let inCount = 0;
      for (const vi of samples) {
        if (pointInRing(pts[vi].x, pts[vi].y, q.ring)) inCount += 1;
      }
      if (inCount * 2 <= samples.length) continue;
      if (bestJ === -1 || q.absArea < polys[bestJ].absArea) bestJ = j;
    }
    parents[i] = bestJ;
  }
  return parents;
}

const bboxes = bboxesOf(activePolygons);
const parentOf = computeParents(activePolygons, bboxes);
const holeCount = parentOf.filter((v) => v !== -1).length;
console.log(`包含解析: ${holeCount} 個のポリゴンが他ポリゴンに内包 → 穴リング化`);

// --- 4. 国名ラベルの割り当て --------------------------------------------------
function extractLabels(layerId) {
  const open = svgText.indexOf(`id="${layerId}"`);
  if (open === -1) return [];
  const gStart = svgText.lastIndexOf('<g', open);
  // 対応する </g> を深さ追跡で探す
  let depth = 0;
  let end = -1;
  const re = /<g\b|<\/g>/g;
  re.lastIndex = gStart;
  for (let m = re.exec(svgText); m !== null; m = re.exec(svgText)) {
    if (m[0] === '<g') depth += 1;
    else {
      depth -= 1;
      if (depth === 0) {
        end = m.index;
        break;
      }
    }
  }
  const section = svgText.slice(gStart, end === -1 ? undefined : end);
  // クラスごとの font-size (CJK は正方形グリフなので 1 文字 ≒ font-size)
  const fontSizes = {};
  const styleRe = /\.((?:cls-\d+)(?:\s*,\s*\.cls-\d+)*)\s*\{([^}]*)\}/g;
  for (let m = styleRe.exec(svgText); m !== null; m = styleRe.exec(svgText)) {
    const fs = m[2].match(/font-size:\s*([\d.]+)px/);
    if (!fs) continue;
    for (const cls of m[1].split(',')) fontSizes[cls.trim().replace(/^\./, '')] = Number(fs[1]);
  }
  const labels = [];
  const textRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  for (let m = textRe.exec(section); m !== null; m = textRe.exec(section)) {
    const tr = m[1].match(/translate\(\s*([-\d.]+)[\s,]+([-\d.]+)\s*\)/);
    if (!tr) continue;
    const rot = m[1].match(/rotate\(\s*([-\d.]+)/);
    const cls = m[1].match(/class="([^"]+)"/);
    const firstLine = (m[2].match(/<tspan[^>]*>([^<]*)<\/tspan>/) ?? [null, ''])[1].trim();
    const name = m[2]
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, '')
      .trim();
    if (name.length === 0) continue;
    labels.push({
      x: Number(tr[1]),
      y: Number(tr[2]),
      angleDeg: rot ? Number(rot[1]) : 0,
      fontSize: (cls && fontSizes[cls[1].split(/\s+/)[0]]) || 12,
      firstLineLen: firstLine.length || name.length,
      name,
    });
  }
  return labels;
}

const countryLabels = extractLabels('_国名');
console.log(`国名ラベル: ${countryLabels.length} 件`);

const nameOf = new Array(activePolygons.length).fill(null);
const unmatched = [];
function smallestContaining(x, y) {
  let bestI = -1;
  for (let i = 0; i < activePolygons.length; i += 1) {
    const bb = bboxes[i];
    if (x < bb.minX || x > bb.maxX || y < bb.minY || y > bb.maxY) continue;
    if (!pointInRing(x, y, activePolygons[i].ring)) continue;
    if (bestI === -1 || activePolygons[i].absArea < activePolygons[bestI].absArea) bestI = i;
  }
  return bestI;
}
// テキストはアンカーから rotate 方向へ「文字数 × font-size」だけ伸び、グリフは
// ベースラインの上に乗る。文字列に沿って密にサンプルし、いずれかの点を含む
// ポリゴンのうち最小面積のものを選ぶ (デルレイス帝国のような極小の飛び国の上を
// 文字列が横切る場合、周囲の大国でなく飛び国に割り当てるため)。
// 同君連合の親名ラベルは集約 (UNION_GROUPS) 側で使うため、面への割当から除外する
const UNION_PARENT_NAMES = new Set(['ラヴィエンド・ウィル同君王国']);
for (const label of countryLabels) {
  if (countryBorders !== null && UNION_PARENT_NAMES.has(label.name)) continue;
  const rad = (label.angleDeg * Math.PI) / 180;
  const len = label.firstLineLen * label.fontSize;
  const lift = label.fontSize * 0.35; // ベースラインからグリフ中央への持ち上げ
  const at = (t) => [
    label.x + Math.cos(rad) * len * t + Math.sin(rad) * lift,
    label.y + Math.sin(rad) * len * t - Math.cos(rad) * lift,
  ];
  // ベースライン上 (lift 0) とグリフ中央 (lift あり) の 2 段を密にサンプル
  const atLift = (t, liftScale) => [
    label.x + Math.cos(rad) * len * t + Math.sin(rad) * lift * liftScale,
    label.y + Math.sin(rad) * len * t - Math.cos(rad) * lift * liftScale,
  ];
  const dense = [];
  for (let t = 0; t <= 1.0001; t += 0.1) {
    dense.push(atLift(t, 1), atLift(t, 0));
  }
  // 1) マイクロ国家 (面積 < 100): 文字列がその上を通っていれば最優先で採用
  const MICRO_AREA = 100;
  let bestI = -1;
  for (const [x, y] of dense) {
    const i = smallestContaining(x, y);
    if (
      i !== -1 &&
      activePolygons[i].absArea < MICRO_AREA &&
      (bestI === -1 || activePolygons[i].absArea < activePolygons[bestI].absArea)
    ) {
      bestI = i;
    }
  }
  // 2) 通常国: 文字列の中央 → 1/4・3/4 点 → アンカー の先着順
  if (bestI === -1) {
    const candidates = [at(0.5), at(0.25), at(0.75), [label.x, label.y], at(1.0)];
    for (const [x, y] of candidates) {
      bestI = smallestContaining(x, y);
      if (bestI !== -1) break;
    }
  }
  if (bestI === -1) {
    unmatched.push(label.name);
  } else if (nameOf[bestI] === null) {
    nameOf[bestI] = label.name;
  } else {
    nameOf[bestI] = `${nameOf[bestI]}・${label.name}`;
    console.warn(`ラベル衝突: ${nameOf[bestI]} (ポリゴン ${activePolygons[bestI].id})`);
  }
}
// 点包含で割当できなかった洋上ラベルの手動割当 (ユーザー裁定 2026-08-08)。
// キー = ラベル文言、値 = 割当先ポリゴンの内部点 (SVG 座標)。
// ポリゴン id は再抽出で変わるため、座標→点包含で解決する。
const MANUAL_LABEL_ASSIGN = {
  ピニア: [1713.4, 953.3], // 隣の小島 (島国)
  テレン合議国: [290.3, 395.3], // 北西の大島
  バアカ: [2053.8, 1639.2], // 南方の巨大沿岸国
  'ヤシュー・アレファクト': [2430.8, 763.8], // 最寄りの大島 (洋上ラベル)
  ニィル: [3581.4, 1491.4], // 最寄りの大島 (洋上ラベル)
};
for (const [name, [mx, my]] of Object.entries(MANUAL_LABEL_ASSIGN)) {
  const idx = unmatched.indexOf(name);
  if (idx === -1) continue;
  const pi = smallestContaining(mx, my);
  if (pi === -1) {
    console.warn(`手動割当先 (${mx},${my}) を含むポリゴンがありません (${name})`);
    continue;
  }
  unmatched.splice(idx, 1);
  nameOf[pi] = nameOf[pi] === null ? name : `${nameOf[pi]}・${name}`;
  console.log(`手動割当: ${name} → ポリゴン ${activePolygons[pi].id}`);
}
if (unmatched.length > 0) {
  console.warn(`どのポリゴンにも入らなかった国名ラベル (${unmatched.length}): ${unmatched.join(', ')}`);
}
console.log(`名前が付いたポリゴン: ${nameOf.filter((n) => n !== null).length}`);

// --- 4b. 地域名レイヤーからの仮名格上げ ---------------------------------------
// 国名が付かなかった地物の仮名 (島NNN/領域NNN/海域NNN) を、_州名・_地名・_海名 の
// ラベルから導出した地域名に置き換える:
//   - ポリゴン内に 州名/地名 ラベル → その名前 (島の固有名・州名・地方名)
//   - 海域ポリゴン内に 海名 ラベル → その海名
//   - 上記なしの島 → 最寄りの海名から「〇〇海の島NN」
const labelCenter = (label) => {
  const rad = (label.angleDeg * Math.PI) / 180;
  const len = label.firstLineLen * label.fontSize;
  const lift = label.fontSize * 0.35;
  return [
    label.x + (Math.cos(rad) * len) / 2 + Math.sin(rad) * lift,
    label.y + (Math.sin(rad) * len) / 2 - Math.cos(rad) * lift,
  ];
};

const regionNamesOf = new Array(activePolygons.length).fill(null).map(() => []);
for (const label of [...extractLabels('_州名'), ...extractLabels('_地名')]) {
  const [cx, cy] = labelCenter(label);
  const i = smallestContaining(cx, cy);
  if (i !== -1 && !regionNamesOf[i].includes(label.name)) regionNamesOf[i].push(label.name);
}
const seaLabels = extractLabels('_海名').map((l) => {
  const [cx, cy] = labelCenter(l);
  return { name: l.name, cx, cy };
});
const seaNamesOf = new Array(activePolygons.length).fill(null).map(() => []);
for (const sea of seaLabels) {
  const i = smallestContaining(sea.cx, sea.cy);
  if (i !== -1 && !seaNamesOf[i].includes(sea.name)) seaNamesOf[i].push(sea.name);
}
const centroids = activePolygons.map((p) => {
  let sx = 0;
  let sy = 0;
  for (const i of p.ring) {
    sx += pts[i].x;
    sy += pts[i].y;
  }
  return { x: sx / p.ring.length, y: sy / p.ring.length };
});
function nearestOf(i, labels) {
  const c = centroids[i];
  let best = null;
  let bestD = Infinity;
  for (const l of labels) {
    const d = Math.hypot(l.cx - c.x, l.cy - c.y);
    if (d < bestD) {
      bestD = d;
      best = l.name;
    }
  }
  return best;
}
const nearestSeaName = (i) => nearestOf(i, seaLabels);
// 陸域の位置手掛かり: 州名 + 地名 (山岳名も地形の目印として加える)
const landmarkLabels = [
  ...extractLabels('_州名'),
  ...extractLabels('_地名'),
  ...extractLabels('_山岳名'),
].map((l) => {
  const [cx, cy] = labelCenter(l);
  return { name: l.name, cx, cy };
});

// --- 5. 座標変換 -------------------------------------------------------------
// 作図が海色レクト (世界矩形) をわずかにはみ出す点があり、経度 +180 を超えると
// 周回して反対端の地物と極小の重なりを作る (島184/島186 で実測)。±180/±90 に
// クランプして世界矩形内へ収める。
function toLonLat(i) {
  const p = pts[i];
  const lon = ((p.x - worldRect.x) / worldRect.width) * 360 - 180;
  const lat = 90 - ((p.y - worldRect.y) / worldRect.height) * 180;
  return {
    lon: Math.min(180, Math.max(-180, Math.round(lon * 1e7) / 1e7)),
    lat: Math.min(90, Math.max(-90, Math.round(lat * 1e7) / 1e7)),
  };
}

// --- 6. マニフェスト構築 ------------------------------------------------------
const TYPE_STYLE = {
  海まで国境線: '#a8c98a',
  内陸国: '#dbc472',
  完全島国: '#d9a066',
  海岸線まで国境界: '#b79fd0',
  共有する海: '#8fb8dd',
  島国: '#89c9b8',
  不明: '#c0c0c0',
};
const NAME_PREFIX = { 共有する海: '海域', 島国: '島' };

const pad = (n, w) => String(n).padStart(w, '0');
const typeCounters = {};

// --- 6a. 国レベルのグループ化 (階層化) ----------------------------------------
// 面データが州境界込みの場合、各面の内部点を国レベル抽出のポリゴンへ包含判定し、
// 同じ国に複数の面が属する国 (デーレ共和国の州+領海) を「集約地物 (親) +
// 末端地物 (子)」にする。UNION_GROUPS は複数の国を 1 集約に統合する (同君連合)。
const groupOfFace = new Array(activePolygons.length).fill(-1);
const groups = [];
// 養子 (隙間吸収で追加領有された面): 子でも命名は単独地物と同じ規則を使う
const adoptedFaces = new Set();
if (countryBorders !== null) {
  const cPts = countryBorders.points;
  function pirCountry(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const a = cPts[ring[i]];
      const b = cPts[ring[j]];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
    return inside;
  }
  const cPolys = [];
  for (const p of countryBorders.polygons) {
    let r = p.points.slice();
    if (r.length >= 2 && r[0] === r[r.length - 1]) r = r.slice(0, -1);
    if (r.length < 3) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const i of r) {
      const q = cPts[i];
      if (q.x < minX) minX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.x > maxX) maxX = q.x;
      if (q.y > maxY) maxY = q.y;
    }
    cPolys.push({
      id: p.id,
      type: p.type,
      ring: r,
      absArea: Math.abs(p.area),
      minX,
      minY,
      maxX,
      maxY,
    });
  }
  const smallestCountryAt = (x, y) => {
    let best = -1;
    for (let i = 0; i < cPolys.length; i += 1) {
      const c = cPolys[i];
      if (x < c.minX || x > c.maxX || y < c.minY || y > c.maxY) continue;
      if (!pirCountry(x, y, c.ring)) continue;
      if (best === -1 || c.absArea < cPolys[best].absArea) best = i;
    }
    return best;
  };
  // 面の内部点。重心が外 (凹形) や自面の穴 (内包面) に落ちる場合はグリッド走査。
  const interiorOf = (i) => {
    const holes = [];
    for (let j = 0; j < activePolygons.length; j += 1) if (parentOf[j] === i) holes.push(j);
    const ok = (x, y) =>
      pointInRing(x, y, activePolygons[i].ring) &&
      !holes.some((j) => pointInRing(x, y, activePolygons[j].ring));
    const c = centroids[i];
    if (ok(c.x, c.y)) return [c.x, c.y];
    const bb = bboxes[i];
    for (let gy = 1; gy < 32; gy += 1) {
      for (let gx = 1; gx < 32; gx += 1) {
        const x = bb.minX + ((bb.maxX - bb.minX) * gx) / 32;
        const y = bb.minY + ((bb.maxY - bb.minY) * gy) / 32;
        if (ok(x, y)) return [x, y];
      }
    }
    return [c.x, c.y];
  };
  const byCountry = new Map();
  for (let i = 0; i < activePolygons.length; i += 1) {
    const [x, y] = interiorOf(i);
    const ci = smallestCountryAt(x, y);
    if (ci === -1) continue;
    if (!byCountry.has(ci)) byCountry.set(ci, []);
    byCountry.get(ci).push(i);
  }
  // 同君連合 (ユーザー裁定 2026-08-09): 構成国の内部点で国を特定し 1 集約へ。
  const UNION_GROUPS = [
    {
      name: 'ラヴィエンド・ウィル同君王国',
      childKindLabel: '構成国',
      members: [
        [509.2, 493.1], // ラヴィエン
        [610.4, 716.5], // ウィル
      ],
    },
  ];
  for (const u of UNION_GROUPS) {
    const faces = [];
    let type = null;
    for (const [mx, my] of u.members) {
      const ci = smallestCountryAt(mx, my);
      if (ci === -1 || !byCountry.has(ci)) {
        console.warn(`同君連合 ${u.name}: 構成国が見つかりません (${mx},${my})`);
        continue;
      }
      faces.push(...byCountry.get(ci));
      type = type ?? cPolys[ci].type;
      byCountry.delete(ci);
    }
    if (faces.length >= 2) {
      groups.push({
        name: u.name,
        lift: false,
        childKindLabel: u.childKindLabel,
        type: type ?? '不明',
        faces,
      });
    } else {
      console.warn(`同君連合 ${u.name}: 構成面 ${faces.length} — 集約化を見送り`);
    }
  }
  for (const [ci, faces] of byCountry) {
    if (faces.length > 1) {
      groups.push({ name: null, lift: true, childKindLabel: '州', type: cPolys[ci].type, faces });
    }
  }
  groups.forEach((g, gi) => {
    for (const f of g.faces) groupOfFace[f] = gi;
  });
  // 隙間の吸収 (養子縁組): 子の合併の外周に囲まれるのに、どの子の領域にも属さない
  // 面 (子同士の境界上に挟まれた島・海の断片) を集約の子として追加領有する。
  // visualizer 仕様の「共有海の島々は海領域に領有される」の階層版。
  const pirLL = (x, y, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[j];
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    }
    return inside;
  };
  const llOf = (vi) => {
    const c = toLonLat(vi);
    return [c.lon, c.lat];
  };
  for (let round = 0; round < 3; round += 1) {
    let adoptedAny = false;
    groups.forEach((g, gi) => {
      let u = null;
      for (const f of g.faces) {
        const p = activePolygons[f];
        const geom = [[p.ring.map(llOf), ...p.pockets.map((l) => l.map(llOf))]];
        u = u === null ? geom : pc.union(u, geom);
      }
      for (let f = 0; f < activePolygons.length; f += 1) {
        if (groupOfFace[f] !== -1 || parentOf[f] !== -1) continue;
        const [ix, iy] = interiorOf(f);
        // 内部点 (SVG座標) を lon/lat に直接変換
        const lon = ((ix - worldRect.x) / worldRect.width) * 360 - 180;
        const lat = 90 - ((iy - worldRect.y) / worldRect.height) * 180;
        let insideOuter = false;
        let insideRegion = false;
        for (const piece of u) {
          if (!pirLL(lon, lat, piece[0])) continue;
          insideOuter = true;
          if (!piece.slice(1).some((hole) => pirLL(lon, lat, hole))) insideRegion = true;
        }
        if (insideOuter && !insideRegion) {
          g.faces.push(f);
          groupOfFace[f] = gi;
          adoptedFaces.add(f);
          adoptedAny = true;
          console.log(
            `養子: 面 id=${activePolygons[f].id} (${activePolygons[f].type}) → ${g.name ?? 'グループ' + (gi + 1)}`,
          );
        }
      }
    });
    if (!adoptedAny) break;
  }
  for (const g of groups) {
    console.log(`階層化: ${g.name ?? '(国名ラベルから命名)'} — 子 ${g.faces.length} 面 [${g.type}]`);
  }
}

// 州名ラベル → 面 (集約の子の命名用)
const stateNamesOf = new Array(activePolygons.length).fill(null).map(() => []);
for (const label of extractLabels('_州名')) {
  const [cx, cy] = labelCenter(label);
  const i = smallestContaining(cx, cy);
  if (i !== -1 && !stateNamesOf[i].includes(label.name)) stateNamesOf[i].push(label.name);
}
// 地名ラベル → 面 (州名の無い子の命名用。ノルの区分など、州名は無いが対応する地名が
// 載っている場合に使う — ユーザー指摘 2026-08-09)
const placeNamesOf = new Array(activePolygons.length).fill(null).map(() => []);
for (const label of extractLabels('_地名')) {
  const [cx, cy] = labelCenter(label);
  const i = smallestContaining(cx, cy);
  if (i !== -1 && !placeNamesOf[i].includes(label.name)) placeNamesOf[i].push(label.name);
}
// 州名ラベルの無い子 (領海など) の手動命名: 面の内部点 (SVG 座標) で指定
const CHILD_NAME_ASSIGN = [
  // 例: { at: [x, y], name: 'デーレ共和国領海', kindLabel: '領海' },
];

// 子地物の塗り分け: 親色を明暗に振る
function shadeColor(hex, step) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.max(0, Math.min(255, Math.round(c + step * 14)));
  const r = f((n >> 16) & 255);
  const g = f((n >> 8) & 255);
  const b = f(n & 255);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

// --- 6b. 地物と履歴の構築 ----------------------------------------------------
const histories = [];
const groupBuild = groups.map(() => ({ features: [], childIds: [], used: new Set(), childNo: 0 }));
for (let i = 0; i < activePolygons.length; i += 1) {
  const p = activePolygons[i];
  const fid = `area-${pad(p.id, 3)}`;
  const territoryRingId = `${fid}-r0`;

  const rings = [
    { kind: 'territory', id: territoryRingId, vertexIds: p.ring.map((v) => `v${v}`) },
  ];
  // 正規化で分解したポケット (橋渡し経由で繋がった島などの除外領域) を穴に
  let holeNo = 0;
  for (const loop of p.pockets) {
    holeNo += 1;
    rings.push({
      kind: 'hole',
      id: `${fid}-h${holeNo}`,
      vertexIds: loop.map((v) => `v${v}`),
      parentRingId: territoryRingId,
    });
  }
  // このポリゴンを直接内包親とするポリゴン = 穴。ただし既にポケット穴に覆われて
  // いる領域 (島全体のポケット vs 島を分割した面など) は二重に開けない。
  for (let j = 0; j < activePolygons.length; j += 1) {
    if (parentOf[j] !== i) continue;
    const jRing = activePolygons[j].ring;
    let covered = false;
    for (const loop of p.pockets) {
      const loopSet = new Set(loop);
      const samples = jRing.filter((v) => !loopSet.has(v)).slice(0, 9);
      if (samples.length === 0) {
        covered = true;
        break;
      }
      let inCount = 0;
      for (const v of samples) {
        if (pointInRing(pts[v].x, pts[v].y, loop)) inCount += 1;
      }
      if (inCount * 2 > samples.length) {
        covered = true;
        break;
      }
    }
    if (covered) continue;
    holeNo += 1;
    rings.push({
      kind: 'hole',
      id: `${fid}-h${holeNo}`,
      vertexIds: jRing.map((v) => `v${v}`),
      parentRingId: territoryRingId,
    });
  }

  // この地物が参照する頂点 (重複除去、座標変換)
  const usedIdx = new Set();
  for (const r of rings) for (const v of r.vertexIds) usedIdx.add(Number(v.slice(1)));
  const vertices = [...usedIdx].sort((a, b) => a - b).map((v) => ({
    id: `v${v}`,
    coordinate: toLonLat(v),
  }));

  const gi = groupOfFace[i];
  let kindLabel = p.type;
  let fillColor = TYPE_STYLE[p.type] ?? TYPE_STYLE['不明'];
  let name;
  if (gi !== -1 && adoptedFaces.has(i)) {
    // 養子面: 集約の子だが、命名は単独地物と同じ規則 (島名・海域名など) を使う
    name = nameOf[i];
  } else if (gi !== -1) {
    // 集約の子: lift グループでは国名ラベルは親に使うため、子は州名などから命名。
    const g = groups[gi];
    const gb = groupBuild[gi];
    gb.childNo += 1;
    kindLabel = g.childKindLabel;
    fillColor = shadeColor(TYPE_STYLE[g.type] ?? TYPE_STYLE['不明'], (gb.childNo % 5) - 2);
    name = g.lift ? null : nameOf[i];
    if (name === null && stateNamesOf[i].length > 0) {
      name = stateNamesOf[i].slice(0, 2).join('・');
      kindLabel = '州';
    }
    if (name === null && placeNamesOf[i].length > 0) {
      // 州名は無いが地名が載っている子 (ノルの区分など) はその地名を仮名に使う
      name = placeNamesOf[i].slice(0, 2).join('・');
      kindLabel = '地方';
    }
    if (name === null) {
      const m = CHILD_NAME_ASSIGN.find((c) => pointInRing(c.at[0], c.at[1], p.ring));
      if (m !== undefined) {
        name = m.name;
        if (m.kindLabel !== undefined) kindLabel = m.kindLabel;
      }
    }
    // 親名はグループ確定後に決まるため、フォールバックは後で置換する
    if (name === null && p.type === '共有する海') {
      // 海面タイプの無名の子は領海として命名
      name = `__CHILD_SEA__${gb.childNo}`;
      kindLabel = '領海';
    }
    if (name === null) name = `__CHILD_FALLBACK__${gb.childNo}`;
  } else {
    name = nameOf[i];
  }
  if (
    name === null &&
    (p.type === '島国' || p.type === '完全島国') &&
    regionNamesOf[i].length > 0
  ) {
    // 島は内側の地名 (島の固有名) をそのまま仮名に使う (最大 2 件連結)。
    // 島以外の陸域は直接命名しない (例:「ピニア島」ラベルが隣の沿岸国に載る誤命名
    // を防ぐ) — 後段の「〇〇付近の領域NN」形式に落とす。
    name = regionNamesOf[i].slice(0, 2).join('・');
  }
  if (name === null && p.type === '共有する海' && seaNamesOf[i].length > 0) {
    // 海域ポリゴンは内側の海名そのまま
    name = seaNamesOf[i].slice(0, 2).join('・');
  }
  if (name === null && (p.type === '島国' || p.type === '完全島国')) {
    // 無名の島は最寄りの海名で「〇〇海の島NN」
    const sea = nearestSeaName(i);
    if (sea !== null) {
      const key = `${sea}の島`;
      typeCounters[key] = (typeCounters[key] || 0) + 1;
      name = `${key}${pad(typeCounters[key], 2)}`;
    }
  }
  if (name === null && p.type === '共有する海') {
    // 無名海域は最寄りの海名で「〇〇の海域NN」
    const sea = nearestSeaName(i);
    if (sea !== null) {
      const key = `${sea}の海域`;
      typeCounters[key] = (typeCounters[key] || 0) + 1;
      name = `${key}${pad(typeCounters[key], 2)}`;
    }
  }
  if (name === null) {
    // 無名陸域は内包する地名/州名を優先し、なければ最寄りの地名/州名/山岳名で
    // 「〇〇付近の領域NN」
    const mark = regionNamesOf[i][0] ?? nearestOf(i, landmarkLabels);
    if (mark !== null) {
      const key = `${mark}付近の領域`;
      typeCounters[key] = (typeCounters[key] || 0) + 1;
      name = `${key}${pad(typeCounters[key], 2)}`;
    }
  }
  if (name === null) {
    const prefix = NAME_PREFIX[p.type] ?? '領域';
    typeCounters[prefix] = (typeCounters[prefix] || 0) + 1;
    name = `${prefix}${pad(typeCounters[prefix], 3)}`;
  }

  const feature = {
    kind: 'leaf',
    id: fid,
    attributes: { name, startYear: 0, endYear: 9999 },
    color: {
      autoColorEnabled: false,
      fillColor,
      fillOpacity: 0.45,
      selectedColor: '#00e5ff',
      selectedOpacity: 0.7,
      borderColor: '#4a4a4a',
    },
    kindLabel,
    shape: { rings },
  };

  if (gi === -1) {
    histories.push({
      featureId: fid,
      entries: [
        {
          anchor: { id: `${fid}-anc0`, snapshot: { features: [feature], vertices } },
          start: { granularity: 'year', year: 0 },
          end: null,
        },
      ],
    });
  } else {
    const gb = groupBuild[gi];
    feature.parentId = `agg-${pad(gi + 1, 2)}`;
    gb.features.push(feature);
    gb.childIds.push(fid);
    for (const v of usedIdx) gb.used.add(v);
  }
}

// --- 6c. 集約 (親) の履歴 -----------------------------------------------------
groups.forEach((g, gi) => {
  const gb = groupBuild[gi];
  const aggId = `agg-${pad(gi + 1, 2)}`;
  let parentName = g.name;
  if (g.lift) {
    const names = [...new Set(g.faces.map((f) => nameOf[f]).filter((n) => n !== null))];
    parentName = names.length > 0 ? names.join('・') : `集約${pad(gi + 1, 2)}`;
  }
  // 子のフォールバック名を親名で確定 (領海/領域を別々に連番)
  let seaNo = 0;
  let restNo = 0;
  for (const f of gb.features) {
    if (/^__CHILD_SEA__\d+$/.test(f.attributes.name)) {
      seaNo += 1;
      f.attributes.name = `${parentName}領海${pad(seaNo, 2)}`;
    } else if (/^__CHILD_FALLBACK__\d+$/.test(f.attributes.name)) {
      restNo += 1;
      f.attributes.name = `${parentName}の領域${pad(restNo, 2)}`;
    }
  }
  const aggregate = {
    kind: 'aggregate',
    id: aggId,
    attributes: { name: parentName, startYear: 0, endYear: 9999 },
    color: {
      autoColorEnabled: false,
      fillColor: TYPE_STYLE[g.type] ?? TYPE_STYLE['不明'],
      fillOpacity: 0.45,
      selectedColor: '#00e5ff',
      selectedOpacity: 0.7,
      borderColor: '#4a4a4a',
    },
    kindLabel: g.type,
    childIds: gb.childIds,
  };
  histories.push({
    featureId: aggId,
    entries: [
      {
        anchor: {
          id: `${aggId}-anc0`,
          snapshot: {
            features: [...gb.features, aggregate],
            vertices: [...gb.used]
              .sort((a, b) => a - b)
              .map((v) => ({ id: `v${v}`, coordinate: toLonLat(v) })),
          },
        },
        start: { granularity: 'year', year: 0 },
        end: null,
      },
    ],
  });
  console.log(`集約: ${parentName} (${aggId}) — 子 ${gb.childIds.length} 地物`);
});

const manifest = {
  version: 'tmap/1',
  histories,
  settings: {
    project: {
      calendarId: 'gregorian',
      geo: { equatorKm: EQUATOR_KM, flattening: 0 },
      gridSpacingDeg: 10,
      snapDistancePx: 50,
    },
    app: { autoColorDefault: true },
  },
  baseMap: {
    source: 'assets/basemap.img',
    meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 },
  },
  ui: {
    project: {
      projectName: 'デーレ界',
      projectDescription:
        'イラレ出界図.svg から derle-map-visualizer のポリゴン抽出でインポート。赤道長 42035 km (惑星半径 1.0489 地球半径)。',
      equatorLengthKm: EQUATOR_KM,
      flattening: 0,
      timelineMinYear: 0,
      timelineMaxYear: 10000,
      gridVisible: true,
      gridSpacingDeg: 10,
      gridColor: '#888888',
      gridOpacity: 0.5,
      baseMapId: 'assets/basemap.img',
      areaLabelOccupancyThreshold: 0.02,
      newAreaAutoColorDefault: true,
      defaultPaletteTheme: 'default',
      customPalette: [],
      zoomMin: 1,
      zoomMax: 50,
    },
    app: {
      snapDistancePx: 50,
      renderFps: 60,
      vertexMarkerCap: 2000,
      showConflictGuide: true,
      undoStackSize: 100,
    },
  },
};

// --- 7. ZIP (.tmap) ----------------------------------------------------------
const tmap = zipSync({
  'manifest.json': strToU8(JSON.stringify(manifest)),
  'assets/basemap.img': new Uint8Array(baseMapAsset),
});
const outPath = resolve(IMPORT_DIR, outName);
writeFileSync(outPath, tmap);

const allUsed = new Set();
for (const p of activePolygons) for (const v of p.ring) allUsed.add(v);
console.log(
  `wrote ${outPath}: 地物 ${histories.length} / 共有頂点 ${allUsed.size} / ${(tmap.length / 1024 / 1024).toFixed(1)} MB`,
);
