// V10 / N-09（増分 8B）: 分けた片を「面 1 / 面 2」ではなく、番号札・方角・面積で呼ぶための
// 材料を作る（純粋関数）。
//
// 画面（継承先の板）と地図の下見（render の knife-batch）が **同じ番号と同じ札の位置**を
// 使うように、ここ 1 か所で決める（教訓 5.29 単一の真実源）。面積は画面側がプロジェクトの
// 測地設定で測る（素性欄の面積と同じ数を出すため）ので、ここでは扱わない。
//
// 方角は「切る前の面全体の外接矩形の中心」から見た、片の重心の向き。縦長・横長の面でも
// 北と南・東と西が素直に出るよう、外接矩形の半幅・半高で割ってから角度を取る。

import { createCoordinate, type WorldCoordinate } from '../coordinate';
import {
  pointInPolygon,
  POINT_LOCATION,
  type GeoMultiPolygon,
  type GeoPolygon,
} from '../geometry/index';

/** 片の方角（8 方位＋中央）。日本語の語は UI の文言表が持つ。 */
export const PIECE_DIRECTION = {
  North: 'n',
  NorthEast: 'ne',
  East: 'e',
  SouthEast: 'se',
  South: 's',
  SouthWest: 'sw',
  West: 'w',
  NorthWest: 'nw',
  Center: 'center',
} as const;

export type PieceDirection = (typeof PIECE_DIRECTION)[keyof typeof PIECE_DIRECTION];

export interface PieceSummary {
  /** 画面に出す番号（1 始まり。`SplitResult.pieces` の並びのまま）。 */
  readonly number: number;
  /** 面全体の中心から見た向き。 */
  readonly direction: PieceDirection;
  /** 番号札を置く点（必ず片の内側。凹んだ片でも外に出ない）。 */
  readonly labelPoint: WorldCoordinate;
}

/**
 * 中心からのずれ（半幅・半高で割った値）がこれ未満なら「中央」と呼ぶ。0.2 は外接矩形の
 * 中央 2 割の範囲で、そこに重心がある片に方角を付けても読み手の役に立たない。
 */
const CENTER_RADIUS = 0.2;

/** 8 方位を 45 度ずつ、東から反時計回りに並べたもの。 */
const SECTORS: readonly PieceDirection[] = [
  PIECE_DIRECTION.East,
  PIECE_DIRECTION.NorthEast,
  PIECE_DIRECTION.North,
  PIECE_DIRECTION.NorthWest,
  PIECE_DIRECTION.West,
  PIECE_DIRECTION.SouthWest,
  PIECE_DIRECTION.South,
  PIECE_DIRECTION.SouthEast,
];

interface Box {
  readonly minLon: number;
  readonly maxLon: number;
  readonly minLat: number;
  readonly maxLat: number;
}

function boxOf(mps: readonly GeoMultiPolygon[]): Box | undefined {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const mp of mps) {
    for (const poly of mp) {
      for (const c of poly[0] ?? []) {
        if (c.lon < minLon) minLon = c.lon;
        if (c.lon > maxLon) maxLon = c.lon;
        if (c.lat < minLat) minLat = c.lat;
        if (c.lat > maxLat) maxLat = c.lat;
      }
    }
  }
  if (!Number.isFinite(minLon)) return undefined;
  return { minLon, maxLon, minLat, maxLat };
}

/** 平面の符号付き面積の 2 倍と、重心のモーメント（靴紐公式）。 */
function ringMoments(ring: readonly WorldCoordinate[]): {
  a2: number;
  cx6: number;
  cy6: number;
} {
  let a2 = 0;
  let cx6 = 0;
  let cy6 = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    const cross = p.lon * q.lat - q.lon * p.lat;
    a2 += cross;
    cx6 += (p.lon + q.lon) * cross;
    cy6 += (p.lat + q.lat) * cross;
  }
  return { a2, cx6, cy6 };
}

/** 多角形（外周−穴）の平面の面積。 */
function polygonArea(poly: GeoPolygon): number {
  let total = 0;
  poly.forEach((ring, i) => {
    const a = Math.abs(ringMoments(ring).a2) / 2;
    total += i === 0 ? a : -a;
  });
  return total;
}

/** 片全体（全多角形・穴を引く）の平面の重心。面積が 0 なら外接矩形の中心。 */
function centroidOf(mp: GeoMultiPolygon): WorldCoordinate | undefined {
  let area = 0;
  let mx = 0;
  let my = 0;
  for (const poly of mp) {
    poly.forEach((ring, i) => {
      const m = ringMoments(ring);
      // 外周は正、穴は負に寄せる（向きは保存形式で決まっていないので絶対値で揃える）。
      const sign = (i === 0 ? 1 : -1) * Math.sign(m.a2 || 1);
      area += sign * m.a2;
      mx += sign * m.cx6;
      my += sign * m.cy6;
    });
  }
  if (Math.abs(area) < 1e-12) {
    const b = boxOf([mp]);
    return b === undefined
      ? undefined
      : createCoordinate((b.minLon + b.maxLon) / 2, (b.minLat + b.maxLat) / 2);
  }
  return createCoordinate(mx / (3 * area), my / (3 * area));
}

/**
 * 多角形の内側に必ず入る札の位置。重心が内側ならそれ、外れる（凹んだ形）なら、外接矩形を
 * 横に 8 等分した 7 本の水平線のうち、多角形の中を通るいちばん長い区間の中点。
 */
function interiorPoint(poly: GeoPolygon): WorldCoordinate | undefined {
  const c = centroidOf([poly]);
  if (c !== undefined && pointInPolygon(c, poly) === POINT_LOCATION.Inside) return c;
  const b = boxOf([[poly]]);
  if (b === undefined) return c;
  let best: { len: number; point: WorldCoordinate } | undefined;
  for (let k = 1; k < 8; k += 1) {
    const y = b.minLat + ((b.maxLat - b.minLat) * k) / 8;
    const xs: number[] = [];
    for (const ring of poly) {
      for (let i = 0; i < ring.length; i += 1) {
        const p = ring[i]!;
        const q = ring[(i + 1) % ring.length]!;
        if (p.lat > y !== q.lat > y) {
          xs.push(p.lon + ((y - p.lat) * (q.lon - p.lon)) / (q.lat - p.lat));
        }
      }
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const len = xs[i + 1]! - xs[i]!;
      if (best === undefined || len > best.len) {
        best = { len, point: createCoordinate((xs[i]! + xs[i + 1]!) / 2, y) };
      }
    }
  }
  return best?.point ?? c;
}

function directionOf(point: WorldCoordinate, box: Box): PieceDirection {
  const cx = (box.minLon + box.maxLon) / 2;
  const cy = (box.minLat + box.maxLat) / 2;
  const hx = Math.max((box.maxLon - box.minLon) / 2, 1e-12);
  const hy = Math.max((box.maxLat - box.minLat) / 2, 1e-12);
  const dx = (point.lon - cx) / hx;
  const dy = (point.lat - cy) / hy;
  if (Math.hypot(dx, dy) < CENTER_RADIUS) return PIECE_DIRECTION.Center;
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180, 東が 0、北が 90
  const sector = Math.round(((deg + 360) % 360) / 45) % 8;
  return SECTORS[sector]!;
}

/**
 * 分けた片ごとに番号・方角・札の位置を決める。並びは `pieces` のまま（番号＝添字＋1）。
 * 札は各片の **いちばん大きい多角形** の内側に置く（飛び地付きの片でも本体に出す）。
 */
export function summarizePieces(pieces: readonly GeoMultiPolygon[]): PieceSummary[] {
  const box = boxOf(pieces);
  return pieces.map((mp, i) => {
    const centroid = centroidOf(mp) ?? createCoordinate(0, 0);
    let largest: GeoPolygon | undefined;
    let largestArea = -Infinity;
    for (const poly of mp) {
      const a = polygonArea(poly);
      if (a > largestArea) {
        largestArea = a;
        largest = poly;
      }
    }
    const labelPoint = (largest !== undefined ? interiorPoint(largest) : undefined) ?? centroid;
    return {
      number: i + 1,
      direction: box === undefined ? PIECE_DIRECTION.Center : directionOf(centroid, box),
      labelPoint,
    };
  });
}
