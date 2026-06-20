// U26 — KnifeLine value object (FR-90 / FR-92).
//
// The 分断線 ("cut line") the user draws to split a terminal feature in two. It
// is an immutable value carrying an ordered list of world coordinates plus a
// discriminant for OPEN (a polyline that must pierce the target boundary from
// outside to outside) vs CLOSED (a polygon whose interior is one half and whose
// exterior is the other — FR-92「任意の閉じた形状」). The discriminant makes the
// two interpretations a type-level choice rather than a guessed-from-shape one
// (技術方針 2.1: 不正状態を表現不能に).
//
// 点配置に幾何制約は課さない (FR-90): construction never validates the geometry;
//成立可否は確定時の検証 (split-geometry.ts) で判定する。This module only models the
// value and the closed-via-fixed-circle decision (FR-92) as pure helpers.

import type { WorldCoordinate } from '../coordinate';

export const KNIFE_LINE_KIND = {
  /** An open polyline (must cross the target boundary to split it). */
  Open: 'open',
  /** A closed polygon (interior = one half, exterior = the other). */
  Closed: 'closed',
} as const;

export type KnifeLineKind = (typeof KNIFE_LINE_KIND)[keyof typeof KNIFE_LINE_KIND];

/**
 * The cut line. `points` is the ordered vertex list as drawn (continuous
 * longitude scalars, never pre-normalized — seam handling is the geometry
 * layer's job, R3). For a CLOSED line the polygon is `points` returning to
 * `points[0]`; the first point is NOT repeated at the end (the closing edge is
 * implicit, matching the GeoRing convention in U06).
 */
export interface KnifeLine {
  readonly kind: KnifeLineKind;
  readonly points: readonly WorldCoordinate[];
}

export function createOpenKnifeLine(points: readonly WorldCoordinate[]): KnifeLine {
  return { kind: KNIFE_LINE_KIND.Open, points };
}

export function createClosedKnifeLine(points: readonly WorldCoordinate[]): KnifeLine {
  return { kind: KNIFE_LINE_KIND.Closed, points };
}

/** True iff the line carries no points (decided by length — 教訓5.18). */
export function isKnifeLineEmpty(line: KnifeLine): boolean {
  return line.points.length === 0;
}

/**
 * The minimum number of points needed before a CLOSED line may be formed
 * (FR-92「3 点以上入力した状態で円内をクリックすると分断線を閉じ」). With fewer than
 * three placed points there is no enclosed area, so closing is refused.
 */
export const MIN_POINTS_TO_CLOSE = 3;

/**
 * Decide whether a click that lands inside the fixed circle should CLOSE the
 * cut line. FR-92: 3 点以上入力した状態で円内をクリックすると閉じる。This is the pure
 * decision the UI layer drives from a hit test; the固定円 itself is a render-layer
 * screen-fixed visual guide (FR-17 と同じスクリーン座標一定サイズ), not part of the
 * closed shape — the shape is the任意の閉多角形 the user actually drew (FR-92
 * 「円形に限定しない」). Returns true only when there are ≥3 points AND the click is
 * reported inside the circle.
 */
export function shouldCloseOnCircleClick(
  pointCount: number,
  clickInsideCircle: boolean,
): boolean {
  return pointCount >= MIN_POINTS_TO_CLOSE && clickInsideCircle;
}

/** Drop the last placed point (頂点取り消し; FR-78 共通機能). Empty stays empty. */
export function withoutLastPoint(line: KnifeLine): KnifeLine {
  if (line.points.length === 0) return line;
  return { kind: line.kind, points: line.points.slice(0, -1) };
}

/** Append a placed point (クリックで頂点を順に置く; FR-90). */
export function withAppendedPoint(line: KnifeLine, point: WorldCoordinate): KnifeLine {
  return { kind: line.kind, points: [...line.points, point] };
}
