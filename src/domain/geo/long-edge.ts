// Domain layer (U05 / geo): **1 辺で経度 180 度以上を渡る辺** の検出（N-51 / 技術方針 §6.8）。
//
// **なぜ 1 か所に置くのか**（増分 3 の手直し A5 / 反証 #4 / GPT #7）。保存形式は
// 「隣り合う頂点は最短方向で繋がっている」と仮定して経度を連続量へ戻すので、**1 辺で
// 180 度以上を渡る形は保存して読み直すと必ず別の形になる**。これは不具合ではなく保存形式の
// 恒久的な表現限界なので、**書く側で止めるか、点を打ち直すしかない**（技術方針 §6.8）。
//
// ところが増分 3 の時点で、この関門は **追加の道具にしか無かった**。編集で頂点を大きく
// 引きずる／ナイフで切る／結合する／穴をあける／リングを足す、のどれを通っても素通りする
// ので、「追加では断られる形が、編集では作れてしまう」という食い違いが残っていた。
// そこで述語をここへ移し、**追加も編集も同じ 1 本を呼ぶ**（教訓 5.29 単一真実源）。
//
// **入力は「連続経度」の列である。** [-180,180) へ畳んだ代表値の列に掛けてはいけない。
// 継ぎ目をまたぐ正しい形（179° → −179°）は代表値では 358° の差に見えるが、読み込み側が
// 最短方向で繋ぐので往復は正しく戻る ―― これを断ると、日付変更線をまたぐ地物が
// 1 つも編集できなくなる。断るべきなのは **利用者が意図した差が 180 度以上のとき**で、
// それが表れるのは「描いている枠／画面の枠に置き直した連続な列」である。
//
// 純粋（I/O・時計・乱数なし）。

import { createCoordinate, type WorldCoordinate } from '../coordinate';
import { QUANTIZE_SCALE, quantizeScalar } from '../geometry/quantize';
import type { GeoMultiPolygon, GeoRing } from '../geometry/types';

/**
 * 1 辺で許される経度差の上限（度）。技術方針 §6.8:「読み込み側は隣り合う頂点の経度差が
 * **180 度を超えたら** ±360 度ずらす」。ちょうど 180 度はどちら回りか決まらないので、
 * **180 度以上を「渡れない」とみなす**（境界を安全側に倒す）。
 */
export const MAX_EDGE_LON_SPAN_DEG = 180;

/**
 * 経度差が {@link MAX_EDGE_LON_SPAN_DEG} 以上の辺の、**始点の添字**を返す。
 *
 * `closed` が真（面のリング）のときは最後の頂点から先頭へ戻る「閉じる辺」も見る（その添字は
 * `coordinates.length - 1`）。線・点は開いた列として見る。
 *
 * 単一の真実源（教訓 5.29）: 追加の確定の関門も、作図中に辺を赤くする描画も、編集・ナイフ・
 * 結合・穴あけ・リング編集の確定の関門も、この 1 本を呼ぶ。「確定は止まるのに赤くならない」
 * ような食い違いが構造的に起きない。
 */
export function longEdgeStartIndexes(
  coordinates: readonly WorldCoordinate[],
  closed: boolean,
): readonly number[] {
  const out: number[] = [];
  const n = coordinates.length;
  if (n < 2) return out;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i += 1) {
    const a = coordinates[i]!;
    const b = coordinates[(i + 1) % n]!;
    if (Math.abs(b.lon - a.lon) >= MAX_EDGE_LON_SPAN_DEG) out.push(i);
  }
  return out;
}

/** その列に長すぎる辺が 1 本でもあるか（数を数えない呼び出し側のための薄い口）。 */
export function hasLongEdge(coordinates: readonly WorldCoordinate[], closed: boolean): boolean {
  return longEdgeStartIndexes(coordinates, closed).length > 0;
}

/**
 * 多角形の集まり（ブーリアン演算の出力など）の中で、長すぎる辺の **本数** を数える。
 * リングは必ず閉じているものとして数える（外周も穴も飛び地も同じ規則）。
 *
 * **渡す多角形は連続経度でなければならない**（`alignMultiPolygon` を通した後の値）。
 * ナイフ・結合・穴あけの出力は代表値へ畳む前がその形なので、確定の直前にそのまま渡せる。
 */
export function countLongEdgesInMultiPolygon(mp: GeoMultiPolygon): number {
  let count = 0;
  for (const polygon of mp) {
    for (const ring of polygon) {
      count += longEdgeStartIndexes(ring, true).length;
    }
  }
  return count;
}

/** 長い辺を刻むときの、1 辺の経度差の上限（度）。{@link MAX_EDGE_LON_SPAN_DEG} より十分小さい。 */
export const LONG_EDGE_FILL_STEP_DEG = 90;

/** 量子化の格子の 1 周（整数）。 */
const TURN_CELLS = 360 * QUANTIZE_SCALE;

const toCell = (v: number): number => Math.round(v * QUANTIZE_SCALE);

/**
 * 長い辺を {@link LONG_EDGE_FILL_STEP_DEG} 度以下に刻む（輪を閉じる辺も見る）。長い辺が無ければ
 * 入力をそのまま返す。**渡す多角形は連続経度でなければならない。**
 *
 * 集合演算は一直線上の点を消すので、幅の広い面の和や差の結果には長い辺ができる。その座標は
 * 1 度でも整列（`alignMultiPolygon`）を通すと最短方向へ繋ぎ直され、別の形になる。
 * だから次の演算や画面へ渡す前にここを通す（B105）。
 */
export function subdivideLongEdges(mp: GeoMultiPolygon): GeoMultiPolygon {
  if (countLongEdgesInMultiPolygon(mp) === 0) return mp;
  return mp.map((polygon) =>
    polygon.map((ring) => {
      const starts = new Set(longEdgeStartIndexes(ring, true));
      if (starts.size === 0) return ring;
      const out: WorldCoordinate[] = [];
      ring.forEach((a, i) => {
        out.push(a);
        if (!starts.has(i)) return;
        const b = ring[(i + 1) % ring.length]!;
        const parts = Math.ceil(Math.abs(b.lon - a.lon) / LONG_EDGE_FILL_STEP_DEG);
        for (let k = 1; k < parts; k += 1) {
          const t = k / parts;
          out.push(
            createCoordinate(
              quantizeScalar(a.lon + (b.lon - a.lon) * t),
              quantizeScalar(a.lat + (b.lat - a.lat) * t),
            ),
          );
        }
      });
      return out;
    }),
  );
}

interface CellPoint {
  readonly lon: number;
  readonly lat: number;
}

/**
 * 集合演算が消した `candidates` の点のうち、結果の辺の上に**ちょうど**乗るものを、元の座標の
 * まま辺へ挿し直す（経度は結果の枠の周へ置く）。形は 1 格子も変わらない。
 *
 * 分け残しの辺で、消えた点を挿し直す理由は 2 つある。(1) 頂点が消えると 1 本の長い辺になり
 * 保存できない（B105）。(2) 消えた頂点を隣も引いていると、隣との共有が切れる。元の座標へ
 * 戻せば、組み立ての座標の照合で同じ id に当たる。
 *
 * 「乗る」の判定は格子の整数の外積が 0 のときだけ（§5.45。実在の頂点と、同じ格子の結果の辺を
 * 比べるので許容値を持たない）。整数は最大で 3.6e9 なので、積は BigInt で計算する。
 * 渡す多角形は連続経度で、量子化された座標であること。
 */
export function restoreDroppedPoints(
  mp: GeoMultiPolygon,
  candidates: readonly WorldCoordinate[],
): GeoMultiPolygon {
  const wrap = (lon: number): number => ((lon % TURN_CELLS) + TURN_CELLS) % TURN_CELLS;
  const keyOf = (lon: number, lat: number): string => `${String(wrap(lon))},${String(lat)}`;
  const present = new Set<string>();
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  for (const polygon of mp) {
    for (const ring of polygon) {
      for (const c of ring) {
        const lon = toCell(c.lon);
        present.add(keyOf(lon, toCell(c.lat)));
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
      }
    }
  }
  const missing: CellPoint[] = [];
  for (const c of candidates) {
    const lat = toCell(c.lat);
    const stored = toCell(c.lon);
    const key = keyOf(stored, lat);
    if (present.has(key)) continue;
    present.add(key); // 同じ座標を 2 度数えない（+180 と -180 も同じ点）。
    const first = Math.ceil((minLon - stored) / TURN_CELLS);
    const last = Math.floor((maxLon - stored) / TURN_CELLS);
    for (let turn = first; turn <= last; turn += 1) {
      missing.push({ lon: stored + turn * TURN_CELLS, lat });
    }
  }
  if (missing.length === 0) return mp;
  missing.sort((p, q) => p.lon - q.lon);

  const firstAtOrAbove = (lon: number): number => {
    let lo = 0;
    let hi = missing.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (missing[mid]!.lon < lon) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const restoreOnRing = (ring: GeoRing): GeoRing => {
    const out: WorldCoordinate[] = [];
    let changed = false;
    ring.forEach((a, i) => {
      out.push(a);
      const b = ring[(i + 1) % ring.length]!;
      const ax = toCell(a.lon);
      const ay = toCell(a.lat);
      const bx = toCell(b.lon);
      const by = toCell(b.lat);
      const loX = Math.min(ax, bx);
      const hiX = Math.max(ax, bx);
      const loY = Math.min(ay, by);
      const hiY = Math.max(ay, by);
      const hits: CellPoint[] = [];
      for (let j = firstAtOrAbove(loX); j < missing.length; j += 1) {
        const p = missing[j]!;
        if (p.lon > hiX) break;
        if (p.lat < loY || p.lat > hiY) continue;
        if ((p.lon === ax && p.lat === ay) || (p.lon === bx && p.lat === by)) continue;
        const cross =
          BigInt(bx - ax) * BigInt(p.lat - ay) - BigInt(by - ay) * BigInt(p.lon - ax);
        if (cross === 0n) hits.push(p);
      }
      if (hits.length === 0) return;
      const along = (p: CellPoint): number => Math.abs(p.lon - ax) + Math.abs(p.lat - ay);
      hits.sort((p, q) => along(p) - along(q));
      for (const h of hits) {
        out.push(createCoordinate(h.lon / QUANTIZE_SCALE, h.lat / QUANTIZE_SCALE));
      }
      changed = true;
    });
    return changed ? out : ring;
  };

  return mp.map((polygon) => polygon.map(restoreOnRing));
}
