// 面から別の形を引いて、保存できる形にする処理（B108・B105 と、重なりの解決の削り）。
//
// 引いた結果を記録に書く経路はここを通す（開発ガイド §5.44）。やることは 3 つある。
//   1. 引く形を、面の全部の周で引く。整列は基準 ±180 の窓の片側にしか置かないので、窓の外へ出ている
//      片や幅いっぱいの片と重なる部分は 1 周ずれて離れた形に見え、引かれない（B108）。
//   2. 引けたことを、別の計算で確かめる。面 = 差分 + 共通部分。差分の誤りを差分の結果と比べても
//      見つからない。引く形が面の外へはみ出す正当な場合があるので（所属変更）、引く形の面積とは
//      比べない。
//   3. 保存できる形へ戻す。集合演算が一直線上の点を消すと、幅の広い面の辺が経度 180 度以上の
//      1 本になり、読み直すと別の形になる（B105）。
//
// 純粋（I/O・時計・乱数なし）。

import { createCoordinate, type WorldCoordinate } from '../coordinate';
import {
  alignMultiPolygon,
  LONGITUDE_PERIOD,
  referenceLonForMultiPolygon,
  replicateAcrossSeam,
} from '../geo/index';
import {
  countLongEdgesInMultiPolygon,
  restoreDroppedPoints,
  subdivideLongEdges,
} from '../geo/long-edge';
import {
  difference,
  EMPTY_MULTI_POLYGON,
  intersection,
  isMultiPolygonEmpty,
  isOk,
  QUANTIZE_SCALE,
  union,
  type GeoMultiPolygon,
  type GeoRing,
} from '../geometry/index';
import { resolveLeafShape } from '../hierarchy/resolve-shape';
import type { Shape } from '../ring';
import { createVertexStore, type Vertex } from '../vertex';

/** {@link subtractAcrossSeam} の結果。 */
export type SubtractAcrossSeamResult =
  | {
      readonly kind: 'ok';
      /** 連続の座標の、保存できる形。 */
      readonly shape: GeoMultiPolygon;
      /** 差分の正味の面積（点を打ち直す前）。読み直しの検算に使う。 */
      readonly area: number;
    }
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'rejected';
      /**
       * `diff`: 集合演算が断った、または 面 = 差分 + 共通部分 が合わない。
       * `long-edge`: 点を打ち直しても経度 180 度以上の辺が残った。
       */
      readonly stage: 'diff' | 'long-edge';
    };

function ringArea(ring: GeoRing): number {
  let sum = 0;
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length]!;
    sum += a.lon * b.lat - b.lon * a.lat;
  });
  return Math.abs(sum) / 2;
}

/** 連続の座標の正味の面積（外周 − 穴）。 */
export function netLonLatArea(mp: GeoMultiPolygon): number {
  let total = 0;
  for (const poly of mp) {
    poly.forEach((ring, i) => {
      total += i === 0 ? ringArea(ring) : -ringArea(ring);
    });
  }
  return total;
}

function perimeter(mp: GeoMultiPolygon): number {
  let total = 0;
  for (const poly of mp) {
    for (const ring of poly) {
      ring.forEach((a, i) => {
        const b = ring[(i + 1) % ring.length]!;
        total += Math.hypot(b.lon - a.lon, b.lat - a.lat);
      });
    }
  }
  return total;
}

/** 浮動小数点の足し算の誤差ぶん（度²）。 */
const AREA_FLOAT_MARGIN = 1e-9;

/**
 * 2 つの面積が、座標の丸めの違いだけと言えるか。頂点を 1 格子ずらしても面積の変わりは「周の長さ ×
 * 格子の幅」を超えないので、これを上限にする。面積に比例する許容値にすると、大きな面で小さな子の
 * ぶんが丸ごと消えても通る。
 */
export function areasMatchWithinRounding(a: number, b: number, perimeterDeg: number): boolean {
  return Math.abs(a - b) <= perimeterDeg / QUANTIZE_SCALE + AREA_FLOAT_MARGIN;
}

/**
 * `subject` から `clip` を引いて保存できる形にする。`keepPoints` は集合演算が消しても辺へ戻す点
 * （ふつうは `subject` の頂点。同じ座標へ戻せば同じ id に当たる）。
 *
 * 入力は `resolveLeafShape` の出力のように、どの周にあってもよい。結果は 1 つの連続の枠にある。
 */
export function subtractAcrossSeam(
  subject: GeoMultiPolygon,
  clip: GeoMultiPolygon,
  keepPoints: readonly WorldCoordinate[],
): SubtractAcrossSeamResult {
  const ref = referenceLonForMultiPolygon(subject);
  const alignedSubject = alignMultiPolygon(subject, ref);
  const alignedClip = alignMultiPolygon(clip, ref);
  const diff = difference(alignedSubject, replicateAcrossSeam(alignedClip, alignedSubject));
  if (!isOk(diff)) return { kind: 'rejected', stage: 'diff' };
  if (isMultiPolygonEmpty(diff.result)) return { kind: 'empty' };

  if (!differenceAddsUp(alignedSubject, alignedClip, diff.result)) {
    return { kind: 'rejected', stage: 'diff' };
  }

  const shape = subdivideLongEdges(restoreDroppedPoints(diff.result, keepPoints));
  if (countLongEdgesInMultiPolygon(shape) > 0) return { kind: 'rejected', stage: 'long-edge' };
  return { kind: 'ok', shape, area: netLonLatArea(diff.result) };
}

/**
 * 2 つの形の共通部分を、`clip` の周ごとに返す。整列は基準 ±180 の窓の片側にしか置かないので、1 周ずれた
 * 所の重なりは写しと比べないと見えない。周ごとに分けて返すのは、写しどうしが隣り合う形でも足し算で
 * 測れるようにするため。入力は同じ基準へ揃えておく。集合演算が断ったら `undefined`。
 */
export function commonPartsAcrossSeam(
  subject: GeoMultiPolygon,
  clip: GeoMultiPolygon,
): GeoMultiPolygon[] | undefined {
  const parts: GeoMultiPolygon[] = [];
  for (const turn of [-LONGITUDE_PERIOD, 0, LONGITUDE_PERIOD]) {
    const shifted = clip.map((poly) =>
      poly.map((ring) => ring.map((c) => createCoordinate(c.lon + turn, c.lat))),
    );
    const common = intersection(subject, shifted);
    if (!isOk(common)) return undefined;
    parts.push(common.result);
  }
  return parts;
}

/**
 * 面 = 差分 + 共通部分 を確かめる。共通部分は ±360 の写しごとに測る。差分の複製の処理を通さないのは、
 * その処理の誤りをここで捕まえるため。面は正規化してから測る（古いデータの重なった片で誤って断らない）。
 */
function differenceAddsUp(
  subject: GeoMultiPolygon,
  clip: GeoMultiPolygon,
  diff: GeoMultiPolygon,
): boolean {
  const normalized = union(subject, EMPTY_MULTI_POLYGON);
  if (!isOk(normalized)) return false;
  const commons = commonPartsAcrossSeam(subject, clip);
  if (commons === undefined) return false;
  const removed = commons.reduce((sum, common) => sum + netLonLatArea(common), 0);
  return areasMatchWithinRounding(
    netLonLatArea(normalized.result),
    netLonLatArea(diff) + removed,
    perimeter(normalized.result) + perimeter(clip),
  );
}

/**
 * 組み立てた形を読み直した面積が、差分の面積と合うか。読み直しは隣り合う頂点を最短方向で繋ぐので、
 * 打ち直せていない形はここで面積が変わる。
 */
export function shapeKeepsArea(
  shape: Shape,
  vertices: readonly Vertex[],
  expectedArea: number,
): boolean {
  const readBack = resolveLeafShape(shape, createVertexStore(vertices));
  if (readBack === undefined) return false;
  const aligned = alignMultiPolygon(readBack);
  return areasMatchWithinRounding(netLonLatArea(aligned), expectedArea, perimeter(aligned));
}
