// U26 — split geometry: 分割可能検証 + 2 分割実行 (FR-44 / FR-90 / FR-91).
//
// Pure domain functions, framework-free. The face boolean演算 is delegated to U06
// (the single window to polygon-clipping; spec §依存 / 技術方針 2.8) — this unit
// NEVER imports polygon-clipping directly and never re-implements union/diff. The
// R2 defense (quantize前後 + 不変条件再検証) lives inside that U06 wrapper, so every
// op here inherits it (技術方針 R2).
//
// Strategy (spec §実装方針 4):
//   - CLOSED knife line: the drawn closed polygon is the clip. One half =
//     intersection(target, clip), the other = difference(target, clip). Either
//     side may come back as多片・多リング (穴・飛び地) — 片落とし禁止: we keep ALL
//     pieces of each side (教訓5.1).
//   - OPEN knife line: the open polyline must pierce the target境界 from outside
//     to outside (FR-90「外から外へ抜けて初めて 2 分割しうる」). We close the polyline
//     into a half-region clip polygon by walking the polyline then returning along
//     a far offset on one side; intersection/difference against the target then
//     yield the two halves. A polyline that does not cut the面 into two pieces is
//     rejected by验证 (貫通せず).
//
// 共有頂点継続 (FR-95) と リング再編記録 (FR-91) are produced as DATA here (旧→新
// 頂点対応写像の素材, 切断点) and consumed by U11 via the proposal layer; this unit
// generates the material, U11 owns the continuation rules (spec §依存 U11).

import { coordinatesEqual, createCoordinate, type WorldCoordinate } from '../coordinate';
import { LONGITUDE_PERIOD, unwrapRing } from '../geo/index';
import { countLongEdgesInMultiPolygon } from '../geo/long-edge';
import {
  difference,
  EMPTY_MULTI_POLYGON,
  intersection,
  isOk,
  multiPolygonFromRing,
  quantizeMultiPolygon,
  quantizeRing,
  ringSelfIntersects,
  union,
  pointInPolygon,
  POINT_LOCATION,
  QUANTIZE_SCALE,
  quantizeCoordinate,
  segmentsIntersect,
  SEGMENT_RELATION,
  type GeoMultiPolygon,
  type GeoPolygon,
  type GeoRing,
} from '../geometry/index';
import { ringAreaKm2 } from '../geo/geodesy';
import { createGeoParams, type GeoParams } from '../geo/geo-params';
import { FEATURE_KIND, type Feature, type LeafFeature } from '../feature';
import type { RingId, VertexId } from '../ids';
import { resolveLeafShape } from '../hierarchy/resolve-shape';
import { getVertex, type VertexStore } from '../vertex';
import {
  KNIFE_LINE_KIND,
  isKnifeLineEmpty,
  type KnifeLine,
} from './knife-line';

// ---------------------------------------------------------------------------
// Discriminated 分割可能検証結果 (spec §成果物「判別共用体」)
// ---------------------------------------------------------------------------

export const SPLIT_REJECT = {
  /** Target is not a terminal (leaf) feature — 集約地物は分割不可 (FR-44). */
  NotTerminal: 'not-terminal',
  /** The cut line does not pierce the面 into two pieces (貫通せず). */
  DoesNotPierce: 'does-not-pierce',
  /** A resulting side has fewer than 3 vertices on its outer ring (FR-44). */
  TooFewVertices: 'too-few-vertices',
  /** The boolean op produced an invalid shape (自己交差・不正形状). */
  InvalidShape: 'invalid-shape',
  /** The target's shape could not be resolved (a vertex id is missing). */
  Unresolvable: 'unresolvable',
  /** The cut line itself is degenerate (empty / fewer than 2 points). */
  DegenerateLine: 'degenerate-line',
  /**
   * The open cut self-intersects (figure-eight / chords crossing each other), so the
   * iterative per-chord n-way split cannot honestly resolve it into k+1 simple pieces
   * (HB3-5/19 G3). We reject rather than silently mis-process it.
   */
  SelfIntersectingCut: 'self-intersecting-cut',
  /**
   * n 分割の途中で、ある切片 (境界→内部→境界の一続き) の内側の代表点が、それまでに
   * 切ってできたどの片の内部にも入らなかった (V10 / N-08 の場面 (a))。
   * 以前は {@link SPLIT_REJECT.SelfIntersectingCut} と同じ理由コードを使い回していたので、
   * どちらで断られたかを測れなかった。
   */
  ChordOutsidePieces: 'chord-outside-pieces',
  /**
   * n 分割の途中で、ある切片で片を切った結果の片側 (交差か差) が空になった
   * (V10 / N-08 の場面 (b))。以前は {@link SPLIT_REJECT.SelfIntersectingCut} と共用だった。
   */
  ChordEmptiesSide: 'chord-empties-side',
  /**
   * 分割してできた形に「1 辺で経度 180 度以上を渡る辺」がある (N-51 / 技術方針 §6.8)。
   *
   * 保存形式は「隣り合う頂点は最短方向で繋がっている」と仮定して経度を連続量へ戻すので、
   * 1 辺で 180 度以上を渡る形は保存して読み直すと必ず別の形になる。これは不具合ではなく
   * 保存形式の恒久的な表現限界なので、**書く側で止める以外に手が無い**。
   *
   * 横に長い面を切ると、集合演算が一直線上に並ぶ途中の頂点を落とすため、切り口と関係の
   * ない外周が「1 本の長い辺」に化けることがある。追加の道具では同じ形を断っているので、
   * ここで素通りさせると「追加では作れない形がナイフでは作れる」という食い違いになる
   * (増分 3 の手直し A5 / 教訓 5.29 単一真実源)。
   */
  LongEdge: 'long-edge',
} as const;

export type SplitRejectKind = (typeof SPLIT_REJECT)[keyof typeof SPLIT_REJECT];

/** Japanese rejection messages (FR-115). Single source for UI + tests (教訓5.26). */
export const SPLIT_REJECT_MESSAGE: Readonly<Record<SplitRejectKind, string>> = {
  [SPLIT_REJECT.NotTerminal]: '集約地物は分割できません。末端地物を選んでください。',
  [SPLIT_REJECT.DoesNotPierce]: '分断線が対象面を 2 つに分けていません。面を貫くように引いてください。',
  [SPLIT_REJECT.TooFewVertices]: '分割結果が 3 頂点未満になります。分断線を引き直してください。',
  [SPLIT_REJECT.InvalidShape]: '分割結果が不正な形状になります。分断線を引き直してください。',
  [SPLIT_REJECT.Unresolvable]: '対象面の形状を取得できませんでした。',
  [SPLIT_REJECT.DegenerateLine]: '分断線の点が足りません。',
  [SPLIT_REJECT.SelfIntersectingCut]: '分断線が自己交差しています。交差しないように引き直してください。',
  [SPLIT_REJECT.ChordOutsidePieces]:
    '分断線の途中の区間が、切り分けた片のどれにも入りませんでした。分断線を引き直してください。',
  [SPLIT_REJECT.ChordEmptiesSide]:
    '分断線の途中の区間で片を切ると、片側が空になりました。分断線を引き直してください。',
  // 利用者はナイフでは頂点を打たないので「途中に点を打つ」とは言えない。この道具で実際に
  // 取れる次の手は「別の場所で切る」なので、そう書く (追加の道具の文言と同じ趣旨)。
  [SPLIT_REJECT.LongEdge]:
    '切り口が世界を半周以上します。別の場所で切ってください（1 辺で経度 180 度以上は保存できません）。',
};

/** The minimum vertex count for a valid terminal polygon outer ring (FR-44). */
export const MIN_POLYGON_VERTICES = 3;

/**
 * The two resulting sides of a successful split, each as a GeoMultiPolygon
 * holding ALL of its pieces (教訓5.1). `areaKm2` lets the inheritance layer pick
 * the小さい方 (FR-93) without recomputing.
 */
export interface SplitSide {
  readonly area: GeoMultiPolygon;
  readonly areaKm2: number;
}

/**
 * A point where the OPEN cut line crosses an EXISTING edge of the target leaf
 * partway along it (FR-95 共有辺途中切断点情報). The edge is identified by the ring
 * it belongs to and the edge's start vertex index within that ring, so the
 * proposal layer can turn it into a {@link SharedEdgeCutSpec} for U11's
 * `insertSharedEdgeCut` (which inserts a same-coordinate vertex on the共有相手
 * 地物's corresponding edge). The coordinate is quantize-aligned (技術方針 R2 /
 * 教訓5.38: judged by線分交差) so the same node lands on both features.
 */
export interface EdgeCutPoint {
  /** The target ring whose edge the cut crosses. */
  readonly ringId: RingId;
  /** The index of the edge's start vertex within that ring's vertexId list. */
  readonly edgeStartIndex: number;
  /** The start/end vertex ids of the crossed edge (for partner-edge matching). */
  readonly edgeStartVertexId: VertexId;
  readonly edgeEndVertexId: VertexId;
  /** The quantize-aligned cut-point coordinate (same node for both features). */
  readonly coordinate: WorldCoordinate;
}

export const SPLIT_CHECK_STATUS = {
  Splittable: 'splittable',
  NotSplittable: 'not-splittable',
} as const;

export type SplitCheckStatus =
  (typeof SPLIT_CHECK_STATUS)[keyof typeof SPLIT_CHECK_STATUS];

export type SplitCheckResult =
  | {
      readonly status: typeof SPLIT_CHECK_STATUS.Splittable;
      /**
       * All resulting pieces (HB3-5/19 n-way: an open cut crossing the boundary 2k
       * times yields k+1 pieces). `pieces.length >= 2`. The inheritance layer keeps one
       * piece (`smallestPieceIndex` seeds FR-93) and mints the rest as new features.
       * Optional ONLY during the n-way consumer migration so hand-built 2-way test
       * literals still compile; `checkSplittable`/`executeSplit` ALWAYS populate it.
       */
      readonly pieces?: readonly SplitSide[];
      /** 2-way alias = `pieces[0]` (kept while consumers migrate to `pieces`). */
      readonly sideA: SplitSide;
      /** 2-way alias = `pieces[1]` (kept while consumers migrate to `pieces`). */
      readonly sideB: SplitSide;
      /**
       * 真のとき、開いた分断線を **延ばした先** でも面が切れている（B69 の残り。飛び地の
       * ある面・外周が自分に接する面・線の端が穴の中にある線は、遠い枠までの延長で切る
       * 2 分割の経路を通る）。画面は確定の前にこれを言う。省略＝偽。
       */
      readonly cutsBeyondLine?: boolean;
    }
  | {
      readonly status: typeof SPLIT_CHECK_STATUS.NotSplittable;
      readonly reason: SplitRejectKind;
      /** Japanese user-facing message (FR-115). */
      readonly message: string;
    };

function rejection(reason: SplitRejectKind): SplitCheckResult {
  return {
    status: SPLIT_CHECK_STATUS.NotSplittable,
    reason,
    message: SPLIT_REJECT_MESSAGE[reason],
  };
}

// ---------------------------------------------------------------------------
// Clip-polygon construction
// ---------------------------------------------------------------------------

/** Default geo params for area comparison (FR-93 小さい方判定; full-Earth scale).
 * Area is used only for the relative小さい方 choice, so the exact equator length
 * (40075 km) and a spherical flattening of 0 are sufficient and stable. */
const DEFAULT_GEO_PARAMS: GeoParams = createGeoParams(40075, 0);

/** Total positive area of a multi-polygon (outer − holes), in km² (FR-20). */
function multiPolygonAreaKm2(mp: GeoMultiPolygon, geo: GeoParams): number {
  let total = 0;
  for (const poly of mp) {
    poly.forEach((ring, i) => {
      const a = ringAreaKm2(ring, geo);
      total += i === 0 ? a : -a;
    });
  }
  return total;
}

/**
 * Snap every cut-line vertex onto U06's integer quantization grid, dropping the
 * zero-length edges the snap can create (two distinct screen points collapsing
 * onto one grid node). This is the seam-sliver root fix (技術方針 R2 / 単一真実源):
 * the cut line — the ONLY non-grid input to the split — is brought onto the grid
 * BEFORE the clip is built, so the seam crossing both halves derive is computed
 * from grid-aligned segments and the two halves coincide to the quantum. We reuse
 * `quantizeCoordinate` (the single tolerance source) rather than re-deriving a
 * grid here. The array is never mutated; consecutive duplicates that snapping
 * produces are removed so the clip never carries a zero-length seam edge.
 *
 * `closed` mirrors `quantizeRing`'s convention: a CLOSED line's closing edge is
 * implicit, so a trailing vertex that snapped onto the FIRST one is a zero-length
 * closing edge and must be removed too — otherwise a degenerate closed cut like
 * `[A, B, A']` (A' collapsing onto A) would survive the post-snap minimum check
 * (the count would read 3 while only 2 distinct nodes remain — review P2).
 */
function snapCutLine(
  line: readonly WorldCoordinate[],
  closed: boolean,
): WorldCoordinate[] {
  const out: WorldCoordinate[] = [];
  for (const p of line) {
    if (p === undefined) continue;
    const q = quantizeCoordinate(p);
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.lon === q.lon && prev.lat === q.lat) continue;
    out.push(q);
  }
  // For a CLOSED line the closing edge (last → first) is implicit; drop a trailing
  // vertex equal to the first so first === last cannot masquerade as an extra node.
  if (closed) {
    while (out.length >= 2) {
      const first = out[0];
      const last = out[out.length - 1];
      if (first !== undefined && last !== undefined && first.lon === last.lon && first.lat === last.lat) {
        out.pop();
      } else {
        break;
      }
    }
  }
  return out;
}

/** An axis-aligned bounding box in the seam-anchored planar (continuous-lon) system. */
interface PlanarBBox {
  readonly minLon: number;
  readonly maxLon: number;
  readonly minLat: number;
  readonly maxLat: number;
}

/**
 * Build the CLOSED clip polygon for an open knife line by CONTINUING the polyline's
 * two END SEGMENTS outward to a far frame that strictly contains the target, then
 * closing the loop by walking that frame's border on ONE side. The resulting clip's
 * ONLY boundary that appears inside the target is the drawn polyline itself — the two
 * end-segment continuations run outward (away from the face, since `linePiercesFace`
 * guarantees both endpoints are already strictly outside), and the frame walk is far
 * outside the target entirely. So intersection / difference of the target against this
 * clip yield the two halves cut by EXACTLY the drawn line, whatever its shape.
 *
 * WHY the frame walk replaces the old parallel-offset reverse path (第8波 flagship):
 * the previous construction returned along a copy of the whole polyline translated by
 * a SINGLE fixed normal, joined to the forward path by two straight CONNECTOR edges in
 * that normal direction. For an AXIS-NON-PARALLEL or BENT (L/V) cut those connectors —
 * running sideways from an endpoint to the far offset copy — sliced THROUGH the target,
 * so the clip's in-face boundary was NOT the drawn line: a legitimate straight tilted
 * cut got rejected as invalid-shape (the offset copy landed on the wrong side and the
 * boolean op degenerated), and an L/V cut manufactured false diagonal chamfers / phantom
 * triangle pieces at the corners the connectors crossed (area was still conserved, so an
 * area-only test passed). Extending the END SEGMENTS along their OWN direction — the way
 * the user's stroke was already heading out of the face — and closing on a far frame keeps
 * every non-drawn boundary edge outside the target, so no phantom edge/vertex can appear.
 * For an axis-parallel straight cut this reduces to the same two vertical/horizontal
 * halves the old path produced (the extensions are collinear with the cut, the frame walk
 * is outside), so the common case is unchanged.
 *
 * Degenerate-extent guard (bug-hunt2 lineage): when an end segment has no usable
 * direction (a looping cut whose endpoints coincide, or a single collapsed node) the
 * continuation direction is derived from the polyline's overall bbox diagonal instead;
 * the caller additionally rejects a clip whose ring area is still ~0 with DegenerateLine,
 * so a polyline with no extent at all can never form a clip.
 */
//
// 増分 8B の手直し（B69）: the "runs outward, away from the face" above holds only for a
// CONVEX face. On a concave one a continuation re-enters the face and cuts where the user
// drew nothing. The function therefore also returns the two CONTINUATIONS (line end →
// frame) so the caller can tell whether that happened and say so (`cutsBeyondLine`).
// Simple and holed single-polygon faces no longer come here for an open line at all.
function openLineToClip(
  line: readonly WorldCoordinate[],
  targetBox: PlanarBBox,
): {
  readonly ring: GeoRing;
  readonly continuations: readonly (readonly [WorldCoordinate, WorldCoordinate])[];
} {
  const first = line[0];
  const last = line[line.length - 1];
  if (first === undefined || last === undefined) return { ring: [], continuations: [] };

  // The frame must strictly contain the target AND the whole drawn polyline, with a
  // generous margin so the two end-segment continuations reach it well outside the face
  // and the frame walk never grazes the target. The margin scales with the combined
  // extent (min 720° so a tiny target near the seam still gets a far frame).
  let minLon = targetBox.minLon;
  let maxLon = targetBox.maxLon;
  let minLat = targetBox.minLat;
  let maxLat = targetBox.maxLat;
  for (const p of line) {
    if (p === undefined) continue;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  const margin = Math.max((maxLon - minLon + maxLat - minLat) * 10, 720);
  const frame: PlanarBBox = {
    minLon: minLon - margin,
    maxLon: maxLon + margin,
    minLat: minLat - margin,
    maxLat: maxLat + margin,
  };

  // The outward continuation direction of each end. `last` continues along the last
  // segment (prev → last); `first` continues along the first segment REVERSED (next →
  // first), i.e. the direction the stroke was already leaving the face by. A degenerate
  // end segment (repeated node) falls back to the endpoint chord, then to the overall
  // bbox diagonal — never a zero vector (which would give no exit ray).
  const chord = endDirection(last.lon - first.lon, last.lat - first.lat, line);
  const lastPrev = line[line.length - 2];
  const firstNext = line[1];
  const lastDir = segmentDirection(
    lastPrev !== undefined ? last.lon - lastPrev.lon : chord.dx,
    lastPrev !== undefined ? last.lat - lastPrev.lat : chord.dy,
    chord,
  );
  const firstDir = segmentDirection(
    firstNext !== undefined ? first.lon - firstNext.lon : -chord.dx,
    firstNext !== undefined ? first.lat - firstNext.lat : -chord.dy,
    { dx: -chord.dx, dy: -chord.dy },
  );

  const exitLast = rayToFrame(last, lastDir, frame);
  const exitFirst = rayToFrame(first, firstDir, frame);
  if (exitLast === undefined || exitFirst === undefined) return { ring: [], continuations: [] };

  // Clip = drawn line + continuation out to the frame at `last`, walk the frame border
  // to the `first` exit, then the continuation back in to `first`. Walking the frame
  // corners keeps the closing path strictly on the (outside-the-target) frame boundary.
  const forward: WorldCoordinate[] = line.map((p) => ({ lon: p.lon, lat: p.lat }));
  const frameWalk = walkFrameBorder(exitLast, exitFirst, frame);
  return {
    ring: [...forward, exitLast, ...frameWalk, exitFirst],
    continuations: [
      [first, exitFirst],
      [last, exitLast],
    ],
  };
}

/** Whether segment a→b touches or crosses any ring edge of the face. Pure. */
function segmentMeetsFace(a: WorldCoordinate, b: WorldCoordinate, mp: GeoMultiPolygon): boolean {
  for (const poly of mp) {
    for (const ring of poly) {
      const n = ring.length;
      for (let j = 0; j < n; j += 1) {
        const c = ring[j];
        const d = ring[(j + 1) % n];
        if (c === undefined || d === undefined) continue;
        if (segmentsIntersect(a, b, c, d).relation !== SEGMENT_RELATION.Disjoint) return true;
      }
    }
  }
  return false;
}

/** A non-zero direction for the polyline as a whole (chord, else bbox diagonal). */
function endDirection(
  dx: number,
  dy: number,
  line: readonly WorldCoordinate[],
): { dx: number; dy: number } {
  if (Math.hypot(dx, dy) > CHORD_DEGENERATE_EPS) return { dx, dy };
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const p of line) {
    if (p === undefined) continue;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  return {
    dx: Number.isFinite(minLon) ? maxLon - minLon : 0,
    dy: Number.isFinite(minLat) ? maxLat - minLat : 0,
  };
}

/** A usable segment direction, falling back to `fallback` when the segment is degenerate. */
function segmentDirection(
  dx: number,
  dy: number,
  fallback: { dx: number; dy: number },
): { dx: number; dy: number } {
  if (Math.hypot(dx, dy) > CHORD_DEGENERATE_EPS) return { dx, dy };
  return fallback;
}

/**
 * Where the ray from `origin` (strictly inside `frame`) along direction `dir` first
 * crosses the frame border — the largest slab parameter that keeps the point inside.
 * Returns undefined only for a zero direction (guarded upstream). Pure.
 */
function rayToFrame(
  origin: WorldCoordinate,
  dir: { dx: number; dy: number },
  frame: PlanarBBox,
): WorldCoordinate | undefined {
  let t = Number.POSITIVE_INFINITY;
  if (dir.dx > 0) t = Math.min(t, (frame.maxLon - origin.lon) / dir.dx);
  else if (dir.dx < 0) t = Math.min(t, (frame.minLon - origin.lon) / dir.dx);
  if (dir.dy > 0) t = Math.min(t, (frame.maxLat - origin.lat) / dir.dy);
  else if (dir.dy < 0) t = Math.min(t, (frame.minLat - origin.lat) / dir.dy);
  if (!Number.isFinite(t) || t <= 0) return undefined;
  return { lon: origin.lon + dir.dx * t, lat: origin.lat + dir.dy * t };
}

/**
 * The frame-corner vertices strictly BETWEEN the border points `from` and `to`, walking
 * counter-clockwise around the frame. `from`/`to` themselves are NOT included (the caller
 * emits them). This closes the clip along the outside-the-target frame border. Pure.
 */
function walkFrameBorder(
  from: WorldCoordinate,
  to: WorldCoordinate,
  frame: PlanarBBox,
): WorldCoordinate[] {
  // The four corners at their CCW perimeter params (see framePerimeterParam): the
  // bottom→right corner sits at param 1, right→top at 2, top→left at 3, left→bottom at 0.
  const corners: { param: number; point: WorldCoordinate }[] = [
    { param: 1, point: { lon: frame.maxLon, lat: frame.minLat } },
    { param: 2, point: { lon: frame.maxLon, lat: frame.maxLat } },
    { param: 3, point: { lon: frame.minLon, lat: frame.maxLat } },
    { param: 0, point: { lon: frame.minLon, lat: frame.minLat } },
  ];
  const start = framePerimeterParam(from, frame);
  const arcTo = forwardArc(start, framePerimeterParam(to, frame));
  // Each corner strictly between `from` and `to` along the CCW walk, in walk order.
  const out = corners
    .filter((c) => {
      const arc = forwardArc(start, c.param);
      return arc > PERIM_EPS && arc < arcTo;
    })
    .sort((a, b) => forwardArc(start, a.param) - forwardArc(start, b.param))
    .map((c) => c.point);
  return out;
}

/**
 * Map a point ON the frame border to a scalar in [0,4) that increases counter-clockwise
 * from the bottom edge: [0,1) bottom (left→right), [1,2) right (bottom→top), [2,3) top
 * (right→left), [3,4) left (top→bottom). A point exactly on a corner maps to that
 * corner's integer. Pure.
 */
function framePerimeterParam(p: WorldCoordinate, frame: PlanarBBox): number {
  const w = frame.maxLon - frame.minLon || 1;
  const h = frame.maxLat - frame.minLat || 1;
  const onBottom = p.lat <= frame.minLat + (frame.maxLat - frame.minLat) * PERIM_EPS;
  const onTop = p.lat >= frame.maxLat - (frame.maxLat - frame.minLat) * PERIM_EPS;
  const onRight = p.lon >= frame.maxLon - (frame.maxLon - frame.minLon) * PERIM_EPS;
  const onLeft = p.lon <= frame.minLon + (frame.maxLon - frame.minLon) * PERIM_EPS;
  if (onBottom && !onRight) return (p.lon - frame.minLon) / w; // [0,1)
  if (onRight) return 1 + (p.lat - frame.minLat) / h; // [1,2)
  if (onTop) return 2 + (frame.maxLon - p.lon) / w; // [2,3)
  if (onLeft) return 3 + (frame.maxLat - p.lat) / h; // [3,4)
  return 0;
}

/** CCW arc length from `a` to `b` on the [0,4) perimeter, always in [0,4). */
function forwardArc(a: number, b: number): number {
  const d = b - a;
  return d >= 0 ? d : d + 4;
}

/**
 * Border-classification tolerance for {@link framePerimeterParam}: a point produced by
 * {@link rayToFrame} lands on a frame edge up to float rounding, so "on this edge" is
 * judged within a tiny fraction of the frame extent rather than by exact equality.
 */
const PERIM_EPS = 1e-9;

/**
 * Below this chord/extent length (in continuous-lon degrees) the polyline has no
 * usable direction for the offset normal — i.e. effectively a single point. It is
 * one quantum of the U06 grid (1 / QUANTIZE_SCALE), the smallest distance two
 * distinct grid nodes can differ by, so a chord at or below it is treated as having
 * collapsed onto one node.
 */
const CHORD_DEGENERATE_EPS = 1 / QUANTIZE_SCALE;

/**
 * Planar (continuous-lon) twice-signed area of a ring via the shoelace formula. The
 * clip ring is built in the seam-anchored planar system, so this cheap planar area
 * is the right degeneracy probe (we only test for ~0, not a geodesic magnitude).
 */
function planarRingArea2(ring: GeoRing): number {
  let acc = 0;
  const n = ring.length;
  for (let i = 0; i < n; i += 1) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    if (p === undefined || q === undefined) continue;
    acc += p.lon * q.lat - q.lon * p.lat;
  }
  return Math.abs(acc);
}

// ---------------------------------------------------------------------------
// n-way OPEN split (HB3-5/19): a cut crossing the boundary 2k times → k+1 pieces.
//
// Strategy (確定プラン iterative-per-chord, G1〜G8): decompose the open line into
// INTERIOR CHORDS (boundary-node → 面内部 → boundary-node), then split whichever
// current piece the chord runs through ALONG THAT CHORD ONLY (ring walk, see
// splitRingByChord). k chords → k+1 pieces. The dangling head/tail (line ends that
// stop inside / start outside) are naturally dropped because a chord needs a boundary
// crossing at BOTH ends (G2). A self-intersecting cut (chords crossing / touching each
// other inside the face) is rejected (G3) rather than mis-processed.
//
// V10 / N-08 (増分 8B): this path used to cut each chord with openLineToClip — the chord
// CONTINUED along its end segments out to a far frame. For a concave face that
// continuation re-enters the face: for a straight line every later chord is collinear
// with chord 1's continuation, so chord 1 already cut along chords 2..k, their interior
// samples then sat exactly ON a piece boundary, no piece "contained" them, and every
// straight line crossing a concave country 4+ times was refused (実データのアルラーク国で
// 南北 110/199・東西 99/199 本). Splitting the ring by the chord itself cuts nothing else.
// ---------------------------------------------------------------------------

/** Whether `point` is strictly inside the multi-polygon (inside ANY polygon; 穴透過 via U06 even-odd). */
function multiPolygonContains(mp: GeoMultiPolygon, point: WorldCoordinate): boolean {
  for (const poly of mp) {
    if (pointInPolygon(point, poly) === POINT_LOCATION.Inside) return true;
  }
  return false;
}

/** Scalar projection parameter of `p` onto segment a→b (0 at a, 1 at b). Pure. */
function paramAlong(a: WorldCoordinate, b: WorldCoordinate, p: WorldCoordinate): number {
  const dx = b.lon - a.lon;
  const dy = b.lat - a.lat;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 0) return 0;
  return ((p.lon - a.lon) * dx + (p.lat - a.lat) * dy) / len2;
}

/** The boundary crossings of ONE line segment a→b, quantized + sorted by position along a→b. */
function segmentBoundaryCrossings(
  a: WorldCoordinate,
  b: WorldCoordinate,
  mp: GeoMultiPolygon,
): WorldCoordinate[] {
  const hits: { t: number; point: WorldCoordinate }[] = [];
  for (const poly of mp) {
    for (const ring of poly) {
      const n = ring.length;
      for (let j = 0; j < n; j += 1) {
        const c = ring[j];
        const d = ring[(j + 1) % n];
        if (c === undefined || d === undefined) continue;
        const hit = segmentsIntersect(a, b, c, d);
        if (hit.point === undefined) continue;
        if (hit.relation !== SEGMENT_RELATION.Proper && hit.relation !== SEGMENT_RELATION.Endpoint) {
          continue;
        }
        const t = paramAlong(a, b, hit.point);
        if (t < -1e-9 || t > 1 + 1e-9) continue;
        hits.push({ t, point: quantizeCoordinate(hit.point) });
      }
    }
  }
  hits.sort((x, y) => x.t - y.t);
  const out: WorldCoordinate[] = [];
  for (const h of hits) {
    const prev = out[out.length - 1];
    if (prev !== undefined && coordinatesEqual(prev, h.point)) continue; // a face-vertex hit by both edges
    out.push(h.point);
  }
  return out;
}

/**
 * Decompose the open cut line into INTERIOR CHORDS. Each chord is a polyline that
 * ENTERS the face at a boundary crossing, runs through its interior, and EXITS at a
 * boundary crossing (G2: both ends must be crossings; a dangling head/tail at a line
 * endpoint that is inside the face is dropped). A non-self-intersecting cut crossing
 * the boundary 2k times yields k chords. Pure.
 */
function splitIntoChords(
  linePts: readonly WorldCoordinate[],
  mp: GeoMultiPolygon,
): WorldCoordinate[][] {
  // 1. Build the augmented vertex list: every original vertex PLUS each segment's
  //    boundary crossings, in order, flagged whether each is a boundary crossing.
  const aug: { point: WorldCoordinate; crossing: boolean }[] = [];
  const first = linePts[0];
  if (first === undefined) return [];
  aug.push({ point: first, crossing: false });
  for (let i = 0; i + 1 < linePts.length; i += 1) {
    const a = linePts[i]!;
    const b = linePts[i + 1]!;
    for (const cr of segmentBoundaryCrossings(a, b, mp)) aug.push({ point: cr, crossing: true });
    aug.push({ point: b, crossing: false });
  }

  // 2. Classify each gap (in/out via its midpoint) and collect the INSIDE runs bounded by
  //    boundary crossings at BOTH ends — those are the chords.
  //
  //    増分 8B の手直し（反証 2-3）: a run is ALSO ended at every boundary node it meets
  //    on the way, even when the gaps on both sides of that node are inside. That is the
  //    line touching the ring from inside (the tip of a notch) and going back in. Before,
  //    the run went on through the touch point, which then became an INTERIOR node of one
  //    chord lying ON the ring: the ring walk produced a pinched half (不正形状) and the
  //    chord's sample point sat on the boundary (chord-outside-pieces). Two chords that
  //    share that node are fine (chordsSelfIntersect allows a shared end), and the result
  //    is the same as a line drawn a hair away from the tip.
  const chords: WorldCoordinate[][] = [];
  let i = 0;
  while (i + 1 < aug.length) {
    const inside = multiPolygonContains(mp, midpoint(aug[i]!.point, aug[i + 1]!.point));
    if (!inside) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (
      !aug[j]!.crossing &&
      j + 1 < aug.length &&
      multiPolygonContains(mp, midpoint(aug[j]!.point, aug[j + 1]!.point))
    ) {
      j += 1;
    }
    if (aug[i]!.crossing && aug[j]!.crossing) {
      chords.push(aug.slice(i, j + 1).map((p) => p.point));
    }
    i = j;
  }
  return chords;
}

/** Midpoint of two world coordinates (planar; inputs are already seam-anchored). */
function midpoint(a: WorldCoordinate, b: WorldCoordinate): WorldCoordinate {
  return createCoordinate((a.lon + b.lon) / 2, (a.lat + b.lat) / 2);
}

/**
 * A point strictly inside the face along a chord: the midpoint of the chord's FIRST
 * segment. {@link splitIntoChords} classified exactly that gap as inside by exactly
 * that midpoint, so it is never on the ring (増分 8B の手直し / 反証 2-3: the old pick,
 * an interior vertex of the chord, could be a point where the line touched the ring).
 * Chords never cross or touch each other inside the face (G3), so no earlier chord runs
 * through it either.
 */
function chordInteriorSample(chord: readonly WorldCoordinate[]): WorldCoordinate {
  return midpoint(chord[0]!, chord[1] ?? chord[chord.length - 1]!);
}

/** The discriminated result of the n-way piece collector. */
type PiecesResult =
  | { readonly ok: true; readonly pieces: readonly GeoMultiPolygon[] }
  | { readonly ok: false; readonly reason: SplitRejectKind };

/**
 * Whether two chords cross or touch each other INSIDE the face (G3: a genuinely
 * self-intersecting cut). Two chords may legitimately share an END node (the line
 * touched the boundary at one point and went back in), so a contact that is an end of
 * both chords is allowed; every other contact — a proper crossing, a touch at an
 * interior point, a collinear overlap — is a self-intersection. A chord is also checked
 * against itself (non-adjacent segments). Pure.
 */
function chordsSelfIntersect(chords: readonly (readonly WorldCoordinate[])[]): boolean {
  const isEndOf = (chord: readonly WorldCoordinate[], p: WorldCoordinate): boolean =>
    coordinatesEqual(chord[0]!, p) || coordinatesEqual(chord[chord.length - 1]!, p);
  for (let ci = 0; ci < chords.length; ci += 1) {
    const a = chords[ci]!;
    for (let cj = ci; cj < chords.length; cj += 1) {
      const b = chords[cj]!;
      for (let i = 0; i + 1 < a.length; i += 1) {
        const startJ = ci === cj ? i + 2 : 0; // same chord: skip itself and its neighbour
        for (let j = startJ; j + 1 < b.length; j += 1) {
          const hit = segmentsIntersect(a[i]!, a[i + 1]!, b[j]!, b[j + 1]!);
          if (hit.relation === SEGMENT_RELATION.Disjoint) continue;
          if (hit.relation === SEGMENT_RELATION.Endpoint && hit.point !== undefined) {
            const p = quantizeCoordinate(hit.point);
            if (ci !== cj && isEndOf(a, p) && isEndOf(b, p)) continue;
          }
          return true;
        }
      }
    }
  }
  return false;
}

/** Squared planar distance from `p` to segment a→b, plus the clamped parameter along it. */
function pointSegmentDistance2(
  p: WorldCoordinate,
  a: WorldCoordinate,
  b: WorldCoordinate,
): { readonly d2: number; readonly t: number } {
  const t = Math.min(1, Math.max(0, paramAlong(a, b, p)));
  const x = a.lon + (b.lon - a.lon) * t - p.lon;
  const y = a.lat + (b.lat - a.lat) * t - p.lat;
  return { d2: x * x + y * y, t };
}

/**
 * A chord end located on a ring: on an existing vertex (`t === 0` at `edge`) or partway
 * along the edge `edge → edge+1` (`0 < t < 1`).
 */
interface RingSpot {
  readonly edge: number;
  readonly t: number;
}

/**
 * How far (in grid quanta) a chord end may sit from the ring edge it was computed on.
 * The crossing is quantized onto the U06 grid, so it lies within half a quantum of the
 * true edge per axis; 2 quanta leaves slack without ever reaching a different edge of a
 * real map (the closest distinct vertices on the derle data are many quanta apart).
 */
const RING_SPOT_TOLERANCE = 2 / QUANTIZE_SCALE;

/** Locate a chord end on `ring` (vertex equality first, else the nearest edge). */
function locateOnRing(ring: GeoRing, p: WorldCoordinate): RingSpot | undefined {
  const n = ring.length;
  for (let i = 0; i < n; i += 1) {
    if (coordinatesEqual(ring[i]!, p)) return { edge: i, t: 0 };
  }
  let best: RingSpot | undefined;
  let bestD2 = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i += 1) {
    const { d2, t } = pointSegmentDistance2(p, ring[i]!, ring[(i + 1) % n]!);
    if (d2 < bestD2) {
      bestD2 = d2;
      best = { edge: i, t };
    }
  }
  if (best === undefined || bestD2 > RING_SPOT_TOLERANCE * RING_SPOT_TOLERANCE) return undefined;
  // A spot that clamps onto an edge END is that vertex — but then the vertex-equality
  // pass above would have matched unless the point is off-grid by a hair. Keep it strictly
  // mid-edge so the walk below inserts it as its own node.
  return { edge: best.edge, t: Math.min(Math.max(best.t, Number.EPSILON), 1 - Number.EPSILON) };
}

/**
 * Split ONE simple ring along a chord whose two ends lie on the ring and whose interior
 * runs strictly inside it (V10 / N-08 root fix). The ring is walked from the chord's
 * start P to its end Q and closed back along the chord (one half), and from Q to P and
 * closed along the chord forwards (the other half). NOTHING but the chord is cut — unlike
 * the old far-frame clip, whose continuation re-entered a concave face.
 *
 * P and Q are inserted as their own nodes when they fall mid-edge. Their coordinates are
 * the quantized crossings `splitIntoChords` computed against the QUANTIZED ring, i.e. the
 * same node `computeEdgeCuts` hands to the shared-edge neighbour (FR-95), so the seam node
 * and the neighbour's inserted node coincide. Returns undefined when either end cannot be
 * located on the ring, or both ends are the same spot (no area on one side). Pure.
 */
function splitRingByChord(
  ring: GeoRing,
  chord: readonly WorldCoordinate[],
): readonly [GeoRing, GeoRing] | undefined {
  const p = chord[0];
  const q = chord[chord.length - 1];
  if (p === undefined || q === undefined || chord.length < 2) return undefined;
  const sp = locateOnRing(ring, p);
  const sq = locateOnRing(ring, q);
  if (sp === undefined || sq === undefined) return undefined;
  if (sp.edge === sq.edge && sp.t === sq.t) return undefined;

  // Walk the ring once, inserting P / Q (mid-edge) right after their edge's start vertex,
  // ordered by their position along that edge; remember where each landed.
  const aug: WorldCoordinate[] = [];
  let ip = -1;
  let iq = -1;
  const n = ring.length;
  for (let i = 0; i < n; i += 1) {
    if (sp.edge === i && sp.t === 0) ip = aug.length;
    if (sq.edge === i && sq.t === 0) iq = aug.length;
    aug.push(ring[i]!);
    const mids: { t: number; which: 'p' | 'q' }[] = [];
    if (sp.edge === i && sp.t > 0) mids.push({ t: sp.t, which: 'p' });
    if (sq.edge === i && sq.t > 0) mids.push({ t: sq.t, which: 'q' });
    mids.sort((x, y) => x.t - y.t);
    for (const m of mids) {
      if (m.which === 'p') {
        ip = aug.length;
        aug.push(p);
      } else {
        iq = aug.length;
        aug.push(q);
      }
    }
  }
  if (ip < 0 || iq < 0 || ip === iq) return undefined;

  const walk = (from: number, to: number): WorldCoordinate[] => {
    const out: WorldCoordinate[] = [];
    const m = aug.length;
    for (let k = from; ; k = (k + 1) % m) {
      out.push(aug[k]!);
      if (k === to) break;
    }
    return out;
  };
  const inner = chord.slice(1, chord.length - 1);
  const half1 = [...walk(ip, iq), ...[...inner].reverse()];
  const half2 = [...walk(iq, ip), ...inner];
  return [half1, half2];
}

/**
 * Normalize a ring-walk half through U06 (quantize + kernel normalize + invariant check),
 * the same defense every boolean result gets (技術方針 R2). A chord strictly inside a
 * simple ring yields a simple half, so anything other than ONE polygon with ONE ring is a
 * degeneracy and is refused rather than silently reshaped.
 */
function normalizeHalf(ring: GeoRing): GeoMultiPolygon | undefined {
  const res = union(multiPolygonFromRing(ring), EMPTY_MULTI_POLYGON);
  if (!isOk(res)) return undefined;
  if (res.result.length !== 1 || res.result[0]!.length !== 1) return undefined;
  return res.result;
}

/**
 * Collect the k+1 pieces of an OPEN cut on a SIMPLE face (one polygon, one ring) by
 * splitting, chord by chord, the piece each chord runs through along that chord only
 * (G1/G6). `mp` must already be quantized onto the U06 grid (checkSplittable does it) so
 * the chord ends are the same nodes {@link computeEdgeCuts} produces (FR-95).
 *
 * Rejections (each its own reason, V10 / §M-6):
 *   - no chord at all → 貫通せず;
 *   - chords crossing / touching each other inside the face → 自己交差 (G3, a real one);
 *   - a chord whose interior lies in no current piece → chord-outside-pieces (should not
 *     happen once self-intersection is excluded; kept as an honest defensive code);
 *   - a chord whose ends cannot be placed on that piece's ring, or that leaves one side
 *     without area → chord-empties-side;
 *   - a half that U06 cannot normalize into one simple polygon → 不正形状.
 * Pure.
 */
export function collectOpenPieces(
  linePts: readonly WorldCoordinate[],
  mp: GeoMultiPolygon,
  span: number,
): PiecesResult {
  void span; // kept for the stable test/consumer API.
  const chords = splitIntoChords(linePts, mp);
  if (chords.length === 0) return { ok: false, reason: SPLIT_REJECT.DoesNotPierce };
  if (chordsSelfIntersect(chords)) return { ok: false, reason: SPLIT_REJECT.SelfIntersectingCut };

  // Each chord cuts exactly ONE current piece (the one its interior sample lands in); that
  // piece is replaced by its two halves, so k chords ⇒ k+1 pieces.
  const pieces: GeoMultiPolygon[] = [mp];
  for (const chord of chords) {
    const sample = chordInteriorSample(chord);
    const idx = pieces.findIndex((piece) => multiPolygonContains(piece, sample));
    if (idx < 0) return { ok: false, reason: SPLIT_REJECT.ChordOutsidePieces };
    const piece = pieces[idx]!;
    const outer = piece.length === 1 && piece[0]!.length === 1 ? piece[0]![0] : undefined;
    if (outer === undefined) return { ok: false, reason: SPLIT_REJECT.InvalidShape };
    const halves = splitRingByChord(outer, chord);
    if (halves === undefined) return { ok: false, reason: SPLIT_REJECT.ChordEmptiesSide };
    const a = normalizeHalf(halves[0]);
    const b = normalizeHalf(halves[1]);
    if (a === undefined || b === undefined) return { ok: false, reason: SPLIT_REJECT.InvalidShape };
    pieces.splice(idx, 1, a, b);
  }

  if (pieces.length < 2) return { ok: false, reason: SPLIT_REJECT.DoesNotPierce };
  for (const p of pieces) {
    if (!everyOuterRingHasMinVertices(p)) return { ok: false, reason: SPLIT_REJECT.TooFewVertices };
  }
  return { ok: true, pieces };
}

// ---------------------------------------------------------------------------
// Seam alignment (R3: U05 owns ±360° unwrap; we anchor BOTH inputs to one branch)
// ---------------------------------------------------------------------------

/**
 * Shift `lon` by a whole number of ±360° turns so it lies within (ref-180, ref+180]
 * — i.e. on the SAME longitude branch as `ref`. Pure; the turn count is chosen so
 * the anchored value is the representative of `lon` closest to `ref`.
 */
function anchorLon(lon: number, ref: number): number {
  const turns = Math.round((ref - lon) / LONGITUDE_PERIOD);
  return lon + turns * LONGITUDE_PERIOD;
}

/**
 * Make a ring self-continuous (U05 `unwrapRing`, R3 single source of truth) and
 * then shift the WHOLE ring by whole ±360° turns so its first vertex sits on the
 * branch of `ref`. This anchors every ring/line of the split onto ONE common
 * longitude branch (Codex M-antimeridian): `checkSplittable` previously unwrapped
 * only the cut line while the target kept its stored branch, so a target near
 * −180° and a cut drawn on the +180° replica were ~360° apart and the boolean ops
 * saw no overlap → a false 貫通せず / malformed result. Anchoring both to the same
 * reference lets intersection/difference operate in one continuous system. For
 * inputs already in a single representative branch (the common, non-seam case) the
 * unwrap is the identity and the anchor adds 0 turns, so behaviour is unchanged.
 */
function unwrapAnchoredRing(ring: readonly WorldCoordinate[], ref: number): WorldCoordinate[] {
  const continuous = unwrapRing([...ring]);
  const first = continuous[0];
  if (first === undefined) return continuous;
  const shift = anchorLon(first.lon, ref) - first.lon;
  if (shift === 0) return continuous;
  return continuous.map((cc) => createCoordinate(cc.lon + shift, cc.lat));
}

/**
 * The reference longitude every input is anchored to: the first outer-ring vertex
 * of the target, made self-continuous. Defaults to 0 for an empty target.
 */
function targetReferenceLon(mp: GeoMultiPolygon): number {
  const outer = mp[0]?.[0];
  if (outer === undefined || outer.length === 0) return 0;
  const continuous = unwrapRing([...outer]);
  return continuous[0]?.lon ?? 0;
}

/** Anchor every ring of a multi-polygon to a common reference branch (R3). */
function anchorMultiPolygon(mp: GeoMultiPolygon, ref: number): GeoMultiPolygon {
  return mp.map((poly) => poly.map((ring) => unwrapAnchoredRing(ring, ref)));
}

/** Axis-aligned bounding box of a multi-polygon's outer rings (clip-frame sizing). */
function multiPolygonBBox(mp: GeoMultiPolygon): PlanarBBox {
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const poly of mp) {
    const outer = poly[0];
    if (outer === undefined) continue;
    for (const c of outer) {
      if (c.lon < minLon) minLon = c.lon;
      if (c.lon > maxLon) maxLon = c.lon;
      if (c.lat < minLat) minLat = c.lat;
      if (c.lat > maxLat) maxLat = c.lat;
    }
  }
  if (!Number.isFinite(minLon)) return { minLon: 0, maxLon: 0, minLat: 0, maxLat: 0 };
  return { minLon, maxLon, minLat, maxLat };
}

// ---------------------------------------------------------------------------
// Pierce detection (FR-90 / 教訓5.38: 線分交差で判定)
// ---------------------------------------------------------------------------

/**
 * Decide whether the OPEN cut polyline pierces the target face — i.e. whether it
 * truly transits FROM outside the face, THROUGH its interior, BACK to outside,
 * which is the only way an open polyline can divide a single face into two pieces
 * (FR-90「外から外へ抜けて初めて 2 分割しうる」).
 *
 * The gate is a HARD outside→outside transit, not mere interior contact:
 *   (1) BOTH endpoints of the polyline must be STRICTLY OUTSIDE the filled face
 *       (not inside, not on the boundary). A cut wholly inside the face, or with
 *       one endpoint dangling inside (a "T" that does not exit), never bisects the
 *       面 — yet such a line has interior points, so an interior-contact test would
 *       wrongly accept it and the openLineToClip extrusion would then manufacture a
 *       split along edges the user never drew (Codex H1: OPEN cut over-acceptance).
 *   (2) The line must cross the outer boundary at ≥2 distinct boundary positions
 *       (`countBoundaryTransits`). 教訓5.38: judged by線分交差, and a transit through
 *       an EXISTING polygon vertex (FR-77 grid-snap: a corner-to-corner diagonal or
 *       a corner-entry/edge-exit cut) classifies as an Endpoint contact, never
 *       Proper — `countBoundaryTransits` counts BOTH so those真の貫通 are accepted.
 *
 * Both conditions are required: (1) alone would accept a line that merely touches
 * the boundary twice without spanning it from outside to outside; (2) alone would
 * accept a line that starts inside and only exits once. Together they pin the
 * outside→through→outside transit FR-90 mandates. The post-op sideA/sideB
 * non-empty check remains as defense-in-depth, but is no longer the sole gate.
 */
function linePiercesFace(line: readonly WorldCoordinate[], mp: GeoMultiPolygon): boolean {
  const first = line[0];
  const last = line[line.length - 1];
  if (first === undefined || last === undefined) return false;
  // (1) Both endpoints strictly OUTSIDE the face — a true outside→outside cut.
  if (!pointStrictlyOutsideFace(first, mp) || !pointStrictlyOutsideFace(last, mp)) {
    return false;
  }
  // (2) ≥2 distinct boundary transits (Proper OR through-vertex): the line spans
  //     the boundary, entering and leaving the interior.
  return countBoundaryTransits(line, mp) >= 2;
}

/**
 * Point strictly OUTSIDE the multi-polygon's filled area: outside every piece's
 * filled region AND not lying on any ring boundary. Used to assert a cut endpoint
 * begins/ends clear of the面 (FR-90 外から外へ). 教訓5.1: every piece is considered.
 */
function pointStrictlyOutsideFace(p: WorldCoordinate, mp: GeoMultiPolygon): boolean {
  for (const poly of mp as readonly GeoPolygon[]) {
    // Inside a filled piece OR on its boundary → not strictly outside the face.
    if (pointInPolygon(p, poly) !== POINT_LOCATION.Outside) return false;
  }
  return true;
}

/**
 * Count boundary transits: a Proper crossing of a boundary edge counts as one;
 * an Endpoint contact (the line passes THROUGH a boundary vertex) also counts as
 * one transit, so a cut entering/exiting via an existing polygon vertex is not
 * mis-classified as a non-pierce. Each (line-segment, ring-edge) contact is
 * counted at most once; an Endpoint shared with the next edge of the same ring is
 * de-duplicated by keying on the quantized contact coordinate.
 */
function countBoundaryTransits(line: readonly WorldCoordinate[], mp: GeoMultiPolygon): number {
  const contacts = new Set<string>();
  let proper = 0;
  for (let i = 0; i + 1 < line.length; i += 1) {
    const a = line[i];
    const b = line[i + 1];
    if (a === undefined || b === undefined) continue;
    for (const poly of mp) {
      for (const ring of poly) {
        const n = ring.length;
        for (let j = 0; j < n; j += 1) {
          const c = ring[j];
          const d = ring[(j + 1) % n];
          if (c === undefined || d === undefined) continue;
          const hit = segmentsIntersect(a, b, c, d);
          if (hit.relation === SEGMENT_RELATION.Proper) {
            proper += 1;
          } else if (hit.relation === SEGMENT_RELATION.Endpoint && hit.point !== undefined) {
            contacts.add(`${hit.point.lon},${hit.point.lat}`);
          }
        }
      }
    }
  }
  return proper + contacts.size;
}

// ---------------------------------------------------------------------------
// Public: 分割可能検証 (spec §成果物 主関数 1)
// ---------------------------------------------------------------------------

/**
 * Validate that `target` (a terminal leaf feature) can be split by `line` into
 * two valid polygons, each with ≥3 vertices (FR-44 / FR-90). Returns a
 * discriminated result carrying both halves on success or a machine-readable
 * reason + Japanese message on failure (教訓5.26: テスト可能な戻り値 + 通知用文言).
 *
 * 集約地物は受け取らない (FR-44 / 教訓5.25): a non-leaf target is rejected before any
 * geometry runs, so the幾何・編集案 path never sees an aggregate.
 */
export function checkSplittable(
  target: Feature,
  store: VertexStore,
  line: KnifeLine,
): SplitCheckResult {
  if (target.kind !== FEATURE_KIND.Leaf) {
    return rejection(SPLIT_REJECT.NotTerminal);
  }
  const minPoints = line.kind === KNIFE_LINE_KIND.Closed ? 3 : 2;
  if (isKnifeLineEmpty(line) || line.points.length < minPoints) {
    return rejection(SPLIT_REJECT.DegenerateLine);
  }

  const leaf: LeafFeature = target;
  const resolvedMp = resolveLeafShape(leaf.shape, store);
  if (resolvedMp === undefined) {
    return rejection(SPLIT_REJECT.Unresolvable);
  }

  // R3 seam alignment: anchor BOTH the target rings AND the cut line onto ONE
  // common longitude branch (the target's outer-ring reference) before any
  // geometry. The resolved target keeps its stored ±360° branch; if the cut was
  // drawn on a different replica (target near −180°, cut near +180°) the two would
  // be ~360° apart and the boolean ops would see no overlap. Anchoring removes that
  // mismatch; for single-branch (non-seam) inputs it is the identity.
  const refLon = targetReferenceLon(resolvedMp);
  const targetMp = anchorMultiPolygon(resolvedMp, refLon);

  // Seam-unwrap the cut line into a single continuous run before geometry (R3),
  // then SNAP every cut vertex onto the same integer grid U06 quantizes to
  // (技術方針 R2 / 単一真実源). WHY this is the seam-sliver root fix: a cut drawn from
  // SCREEN pixels (screen→world) carries sub-grid float residue. If the clip is
  // built from those raw floats, U06 quantizes the clip and the target
  // INDEPENDENTLY inside intersection() and difference(), and the seam crossing
  // the kernel computes can land a sub-grid distance apart between the two halves
  // — U10 then sees a thin positive-area SEAM SLIVER and U06's difference cannot
  // converge within the round cap (ConvergenceFailure). Snapping the cut line to
  // the grid HERE makes the clip's seam edge grid-aligned, so both halves derive
  // their shared seam vertices from the identical grid-aligned segments and the
  // two halves coincide to the quantum (proven for screen-derived non-integer
  // cuts in split-geometry.seam.test.ts). The snap is the SAME grid the proposal
  // layer mints vertices on (quantizeCoordinate), so no second tolerance is born.
  const linePts = snapCutLine(
    unwrapAnchoredRing([...line.points], refLon),
    line.kind === KNIFE_LINE_KIND.Closed,
  );

  // Re-check the minimum AFTER the snap: distinct screen points can collapse onto
  // one grid node (an open line whose two clicks landed within one grid cell, or a
  // closed line whose first/last fold together), leaving too few unique vertices to
  // form a cut. Without this the degenerate input would mis-report as 貫通せず /
  // 不正形状 instead of the honest 分断線の点が足りません (FR-115 / 教訓5.26).
  if (linePts.length < minPoints) {
    return rejection(SPLIT_REJECT.DegenerateLine);
  }

  // HB3-5/19 n-way split scope: the chord path is taken for an OPEN cut on a face of ONE
  // polygon whose outer ring is simple (holes allowed — see below); a cut crossing the
  // outer boundary 2k times yields k+1 pieces. Every CLOSED cut and every multi-region
  // (exclave) / pinched-outer face goes through the single-clip 2-way path. targetMp +
  // linePts are already seam-anchored to ONE branch above (R3) so the chord planar geometry
  // is correct across the antimeridian.
  //
  // V10 / N-08 (増分 8B): the chord path now cuts along the chords ONLY (ring walk), so it
  // also takes the ONE-chord case. The far-frame clip of the 2-way path continues the
  // line's end segments outward, and on a CONCAVE face that continuation re-enters the
  // face and silently cuts parts the user never crossed (a short line over one arm of a U
  // also slices the other arm). The 2-way path stays for CLOSED cuts (no continuation) and
  // for exclave / pinched faces (現状分析 §11-14: those still fall to 2 pieces — the UI says
  // so before confirming, and `cutsBeyondLine` says when the continuation cut something).
  // The chord path works on the QUANTIZED face so its chord ends are exactly the nodes
  // computeEdgeCuts inserts on a shared-edge neighbour (FR-95).
  //
  // 増分 8B の手直し（B69 / GPT 重 3・反証 2-1）: a face with HOLES (one polygon, simple
  // outer ring) takes the chord path too. Only the OUTER ring is split along the chords
  // (the chords are found against the outer ring alone, so a chord runs straight over a
  // hole), and each piece then has the holes subtracted (`difference`). A hole a chord
  // crosses is thereby cut along the chord as well; a hole it does not touch stays whole in
  // the piece around it. Before, such faces took the far-frame path, and a short line over
  // one arm of a concave sea also cut its other arms (実データ 34 地物・面積で 18%).
  let pieces: GeoMultiPolygon[];
  let cutsBeyondLine = false;
  const manyPiecesFace = splitsIntoManyPieces(targetMp);
  const quantizedTarget = manyPiecesFace ? quantizeMultiPolygon(targetMp) : targetMp;
  const quantizedOuter: GeoMultiPolygon = manyPiecesFace ? [[quantizedTarget[0]![0]!]] : [];
  const quantizedHoles: GeoMultiPolygon = manyPiecesFace
    ? quantizedTarget[0]!.slice(1).map((hole) => [hole])
    : [];
  const chordCount =
    line.kind === KNIFE_LINE_KIND.Open && manyPiecesFace
      ? splitIntoChords(linePts, quantizedOuter).length
      : 0;
  if (chordCount >= 1) {
    // One chord keeps the 2-way gate's meaning: the line must run outside → through →
    // outside (FR-90). A line that dangles inside stays 貫通せず, as before. The gate looks
    // at the WHOLE face: a line end inside a hole is outside the face.
    if (chordCount === 1 && !linePiercesFace(linePts, targetMp)) {
      return rejection(SPLIT_REJECT.DoesNotPierce);
    }
    const collected = collectOpenPieces(linePts, quantizedOuter, 0);
    if (!collected.ok) return rejection(collected.reason);
    pieces = [...collected.pieces];
    if (quantizedHoles.length > 0) {
      const holed: GeoMultiPolygon[] = [];
      for (const piece of pieces) {
        const res = difference(piece, quantizedHoles);
        // A piece always keeps the stretch of the outer ring it was cut from, so it can
        // never vanish into the holes; an empty result is a degeneracy → refuse honestly.
        if (!isOk(res) || res.result.length === 0) return rejection(SPLIT_REJECT.InvalidShape);
        holed.push(res.result);
      }
      pieces = holed;
    }
  } else {
    let clip: GeoMultiPolygon;
    if (line.kind === KNIFE_LINE_KIND.Closed) {
      clip = [[linePts]];
    } else {
      // Pre-gate: cheaply reject a line that does not enter the face at all (貫通せず)
      // with the correct message. NOT a Proper-only parity check — a cut entering or
      // exiting through an existing polygon vertex (FR-77 grid-snap) must still pass
      // here; the authoritative 2-piece test is the post-op non-empty gate below.
      if (!linePiercesFace(linePts, targetMp)) {
        return rejection(SPLIT_REJECT.DoesNotPierce);
      }
      const { ring: clipRing, continuations } = openLineToClip(
        linePts,
        multiPolygonBBox(targetMp),
      );
      // Reject a degenerate clip (bug-hunt2): even with the chord guard, a polyline
      // with no spatial extent at all (every snapped vertex on one grid node) yields a
      // zero-area ring. A zero-area clip makes intersection/difference vanish and would
      // mis-report as 貫通せず/不正形状 — surface the honest 分断線の点が足りません instead.
      if (planarRingArea2(clipRing) <= CHORD_DEGENERATE_EPS) {
        return rejection(SPLIT_REJECT.DegenerateLine);
      }
      clip = [[clipRing]];
      // B69 の残り（飛び地・外周が自分に接する面・線の端が穴の中の線）: the continuation
      // may cut where nothing was drawn. Tell the caller so the UI can say so before the
      // split is saved (所有者の原則「削除以外でデータが勝手に変わるのは良くない」).
      cutsBeyondLine = continuations.some(([from, to]) => segmentMeetsFace(from, to, targetMp));
    }

    const inside = intersection(targetMp, clip);
    const outside = difference(targetMp, clip);
    if (!isOk(inside) || !isOk(outside)) {
      return rejection(SPLIT_REJECT.InvalidShape);
    }
    // Both sides must be non-empty (a 2-piece split) — otherwise the line did not
    // actually divide the face (貫通せず / fully-inside line that vanished).
    if (inside.result.length === 0 || outside.result.length === 0) {
      return rejection(SPLIT_REJECT.DoesNotPierce);
    }
    pieces = [inside.result, outside.result];
  }

  // Each piece's every outer ring must have ≥3 vertices (FR-44 最低 3 頂点). collectOpenPieces
  // already enforces this; the 2-way path is checked here.
  for (const p of pieces) {
    if (!everyOuterRingHasMinVertices(p)) {
      return rejection(SPLIT_REJECT.TooFewVertices);
    }
  }

  // N-51 / 技術方針 §6.8: 1 辺で経度 180 度以上を渡る形は保存して読み直すと必ず別の形に
  // なるので、確定させずにここで断る。ここで見るのは `targetMp` / `linePts` と同じ **連続
  // 経度** の系 (R3 で 1 本の枝へ寄せた後) の値である。代表値 ([-180,180) へ畳んだ値) に
  // 掛けると、正常な日付変更線またぎ (179° → −179°) が 358° と出て誤爆する。述語は
  // `domain/geo/long-edge.ts` の 1 本だけを呼ぶ (教訓 5.29 単一真実源)。
  for (const p of pieces) {
    if (countLongEdgesInMultiPolygon(p) > 0) {
      return rejection(SPLIT_REJECT.LongEdge);
    }
  }

  const sides = pieces.map(sideOf);
  return {
    status: SPLIT_CHECK_STATUS.Splittable,
    pieces: sides,
    sideA: sides[0]!,
    sideB: sides[1]!,
    ...(cutsBeyondLine ? { cutsBeyondLine: true } : {}),
  };
}

/**
 * Whether an OPEN cut can split this face into k+1 pieces (現状分析 §11-14): exactly one
 * polygon whose outer ring does not touch or cross itself (some real islands are stored as
 * one ring pinched into a lagoon — that is a hole in disguise, and walking such a ring along
 * a chord does not give two simple halves). HOLES ARE ALLOWED (増分 8B の手直し / B69): the
 * outer ring is split along the chords and the holes are subtracted from each piece. A face
 * with exclaves, or with a pinched outer ring, falls to the 2-piece path. Exported so the UI
 * can say so BEFORE confirming (V10 ④).
 *
 * The outer ring is first made longitude-continuous (`unwrapRing`) and then judged on the
 * U06 grid — the same values the split itself works on (反証 2-4: the UI passes the STORED
 * ring, and a face spanning the antimeridian read as self-crossing there while the split,
 * which unwraps first, cut it into 3 pieces). For an already continuous ring the unwrap is
 * the identity. Pure.
 */
export function splitsIntoManyPieces(mp: GeoMultiPolygon): boolean {
  if (mp.length !== 1 || (mp[0]?.length ?? 0) < 1) return false;
  return !ringSelfIntersects(quantizeRing(unwrapRing([...mp[0]![0]!])));
}

/** Wrap a resolved multi-polygon piece as a {@link SplitSide} with its geodesic area (FR-93). */
function sideOf(mp: GeoMultiPolygon): SplitSide {
  return { area: mp, areaKm2: multiPolygonAreaKm2(mp, DEFAULT_GEO_PARAMS) };
}

/** Every polygon piece's outer ring (index 0) must have ≥3 vertices (FR-44). */
function everyOuterRingHasMinVertices(mp: GeoMultiPolygon): boolean {
  for (const poly of mp) {
    const outer = poly[0];
    if (outer === undefined || outer.length < MIN_POLYGON_VERTICES) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public: 分割実行 (spec §成果物 主関数 2)
// ---------------------------------------------------------------------------

/**
 * The geometric result of a split (spec §成果物 SplitResult 相当). Carries both
 * sides' resolved geometry + area (片落とし禁止: each side is a full multi-polygon),
 * keyed so the inheritance layer can pick the小さい方 (FR-93), PLUS the共有辺途中
 * 切断点情報 (`edgeCuts`) the proposal layer turns into U11 `SharedEdgeCutSpec`s
 * (FR-95). The 旧→新頂点対応写像 needs minted ids and so is produced at the proposal
 * layer; the cut-point edge identities + coordinates are pure geometry and live
 * here (spec §成果物 SplitResult「共有辺途中切断点情報」).
 */
export interface SplitResult {
  /**
   * All resulting pieces (HB3-5/19 n-way: k+1 for 2k crossings). `pieces.length >= 2`.
   * Optional ONLY during the consumer migration; `executeSplit` ALWAYS populates it.
   */
  readonly pieces?: readonly SplitSide[];
  /** 2-way alias = `pieces[0]` (kept while consumers migrate to `pieces`). */
  readonly sideA: SplitSide;
  /** 2-way alias = `pieces[1]` (kept while consumers migrate to `pieces`). */
  readonly sideB: SplitSide;
  /** {@link SplitCheckResult} と同じ印（延ばした先でも切れている）。省略＝偽。 */
  readonly cutsBeyondLine?: boolean;
  /**
   * Every point where the split cut an existing target edge partway along it (FR-95):
   * the new piece vertices lying on an original edge (増分 8B の再手直し — read off the
   * pieces, so the neighbour's node and the piece's vertex are one source). Empty when
   * the cut only meets existing vertices. 片落とし禁止: every cut edge is recorded.
   */
  readonly edgeCuts: readonly EdgeCutPoint[];
}

/**
 * Compute every 共有辺途中切断点 (FR-95) **from the vertices the pieces actually have**
 * (増分 8B の再手直し / 再検証 3-1・2-1): every piece vertex that is NOT an original
 * target vertex and lies on an original target edge (strictly between its ends, within
 * {@link RING_SPOT_TOLERANCE}) is a point where the split cut that edge, and the
 * neighbour sharing the edge needs the same node there.
 *
 * WHY not intersect the drawn line with the edges any more: the cut seam the pieces carry
 * is computed by the split itself — by the ring walk on the QUANTIZED chord ends, by U06's
 * `difference` against the holes along that quantized chord, or by the far-frame clip's
 * continuations. Re-deriving the crossing from the drawn segment a→b put the neighbour's
 * node on a DIFFERENT grid point whenever the chord P→Q was a hair off a→b (a slanted
 * line over a hole: one grid step apart, in 265 of 1,278 real-data lines), the apply step
 * then found no piece vertex there and dropped the cut, and the island kept a T-junction
 * against the sea. The continuation of the far-frame path also cut shared edges the drawn
 * line never crossed, and those were never transferred at all. Taking the cut points from
 * the pieces makes the neighbour's node and the piece's vertex ONE source, whatever path
 * produced it; it also works for a closed cut that crosses the boundary.
 *
 * Every candidate is assigned to its NEAREST original edge only (a point near a corner is
 * not inserted into both edges). Coordinates are in the seam-anchored system the pieces
 * use (R3): each original vertex is anchored to `refLon`, the edge end to its start, then
 * both are quantized onto the U06 grid. For each recorded cut we store the ring id, the
 * edge's start index, the two edge vertex ids and the piece vertex's coordinate. Pure.
 */
function computeEdgeCuts(
  target: LeafFeature,
  store: VertexStore,
  pieces: readonly GeoMultiPolygon[],
  refLon: number,
): EdgeCutPoint[] {
  interface Edge {
    readonly ringId: RingId;
    readonly index: number;
    readonly startId: VertexId;
    readonly endId: VertexId;
    readonly start: WorldCoordinate;
    readonly end: WorldCoordinate;
  }
  const keyOf = (p: WorldCoordinate): string => `${p.lon},${p.lat}`;
  const edges: Edge[] = [];
  const original = new Set<string>();
  for (const ring of target.shape.rings) {
    const n = ring.vertexIds.length;
    for (let j = 0; j < n; j += 1) {
      const startId = ring.vertexIds[j];
      const endId = ring.vertexIds[(j + 1) % n];
      if (startId === undefined || endId === undefined) continue;
      const startV = getVertex(store, startId);
      const endV = getVertex(store, endId);
      if (startV === undefined || endV === undefined) continue;
      const startA = createCoordinate(anchorLon(startV.coordinate.lon, refLon), startV.coordinate.lat);
      const endA = createCoordinate(anchorLon(endV.coordinate.lon, startA.lon), endV.coordinate.lat);
      const start = quantizeCoordinate(startA);
      const end = quantizeCoordinate(endA);
      original.add(keyOf(start));
      original.add(keyOf(end));
      edges.push({ ringId: ring.id, index: j, startId, endId, start, end });
    }
  }

  const cuts: EdgeCutPoint[] = [];
  const seen = new Set<string>();
  const tol2 = RING_SPOT_TOLERANCE * RING_SPOT_TOLERANCE;
  for (const piece of pieces) {
    for (const poly of piece) {
      for (const ring of poly) {
        for (const raw of ring) {
          const p = quantizeCoordinate(raw);
          const key = keyOf(p);
          if (original.has(key) || seen.has(key)) continue;
          let best: Edge | undefined;
          let bestD2 = Number.POSITIVE_INFINITY;
          for (const e of edges) {
            if (
              p.lon < Math.min(e.start.lon, e.end.lon) - RING_SPOT_TOLERANCE ||
              p.lon > Math.max(e.start.lon, e.end.lon) + RING_SPOT_TOLERANCE ||
              p.lat < Math.min(e.start.lat, e.end.lat) - RING_SPOT_TOLERANCE ||
              p.lat > Math.max(e.start.lat, e.end.lat) + RING_SPOT_TOLERANCE
            ) {
              continue;
            }
            const { d2, t } = pointSegmentDistance2(p, e.start, e.end);
            if (t <= 0 || t >= 1) continue; // at or beyond an end → not mid-edge
            if (d2 < bestD2) {
              bestD2 = d2;
              best = e;
            }
          }
          if (best === undefined || bestD2 > tol2) continue;
          seen.add(key);
          cuts.push({
            ringId: best.ringId,
            edgeStartIndex: best.index,
            edgeStartVertexId: best.startId,
            edgeEndVertexId: best.endId,
            coordinate: p,
          });
        }
      }
    }
  }
  return cuts;
}

/**
 * Execute the split, assuming `checkSplittable` already passed. Re-runs the same
 * validation (教訓5.26: コマンド確定前にも同じドメインサービスで再検証) and returns the
 * two sides + the共有辺途中切断点情報 (FR-95), or undefined when (re)validation fails
 * — the caller treats undefined as "do not commit" and surfaces the message from a
 * fresh `checkSplittable`.
 */
export function executeSplit(
  target: Feature,
  store: VertexStore,
  line: KnifeLine,
): SplitResult | undefined {
  const check = checkSplittable(target, store, line);
  if (check.status !== SPLIT_CHECK_STATUS.Splittable) return undefined;
  // Mid-edge cut points are read off the pieces themselves (増分 8B の再手直し): every
  // new piece vertex lying on an original edge. Same seam-anchored system as
  // checkSplittable (R3): the reference is the target's outer-ring branch.
  const pieces = check.pieces ?? [check.sideA, check.sideB];
  let edgeCuts: readonly EdgeCutPoint[] = [];
  if (target.kind === FEATURE_KIND.Leaf) {
    const resolvedMp = resolveLeafShape(target.shape, store);
    const refLon = resolvedMp === undefined ? 0 : targetReferenceLon(resolvedMp);
    edgeCuts = computeEdgeCuts(
      target,
      store,
      pieces.map((piece) => piece.area),
      refLon,
    );
  }
  return {
    pieces,
    sideA: check.sideA,
    sideB: check.sideB,
    ...(check.cutsBeyondLine === true ? { cutsBeyondLine: true } : {}),
    edgeCuts,
  };
}

/**
 * The index of the SMALLEST piece by area (FR-93 小さい方プレビュー, generalized to n-way).
 * Ties resolve to the LOWEST index deterministically; the value is only a preview/seed
 * hint. Pure.
 */
export function smallestPieceIndex(result: SplitResult): number {
  const pieces = result.pieces ?? [result.sideA, result.sideB];
  let best = 0;
  for (let i = 1; i < pieces.length; i += 1) {
    if (pieces[i]!.areaKm2 < pieces[best]!.areaKm2) best = i;
  }
  return best;
}

/**
 * The index of the LARGEST piece by area — the 既定の継承先 (増分 8B の手直し / 設計適合の
 * 重 1). The piece that keeps the original feature (its id, name, colour and timeline)
 * defaults to the biggest remainder: cutting a strip off a country should make the STRIP
 * new, not rename the bulk. With 3〜7 pieces the old default (the smallest) handed the
 * original identity to a sliver. FR-93 still boxes the SMALLEST piece in the preview
 * ({@link smallestPieceIndex}); only the seeded selection moved. Ties resolve to the LOWEST
 * index deterministically. Pure.
 */
export function largestPieceIndex(result: SplitResult): number {
  const pieces = result.pieces ?? [result.sideA, result.sideB];
  let best = 0;
  for (let i = 1; i < pieces.length; i += 1) {
    if (pieces[i]!.areaKm2 > pieces[best]!.areaKm2) best = i;
  }
  return best;
}

/**
 * @deprecated 2-way preview hint (kept while consumers migrate to {@link smallestPieceIndex}).
 * Returns 'a' when `pieces[0]` is the smaller of the FIRST TWO pieces, else 'b'.
 */
export function smallerSide(result: SplitResult): 'a' | 'b' {
  return result.sideA.areaKm2 < result.sideB.areaKm2 ? 'a' : 'b';
}
