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

import { type WorldCoordinate } from '../coordinate';
import { unwrapRing } from '../geo/index';
import {
  difference,
  intersection,
  isOk,
  pointInPolygon,
  POINT_LOCATION,
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
      readonly sideA: SplitSide;
      readonly sideB: SplitSide;
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

/**
 * Build the CLOSED clip polygon for an open knife line by extruding the polyline
 * far to one side, forming a half-region whose boundary is the polyline. The
 * extrusion offset is large relative to the target's bounding box so the clip
 * fully contains "one side" of any pierce. intersection / difference of the
 * target against this clip then yield the two halves regardless of how the line
 * weaves, because the clip's only relevant boundary inside the target is the
 * polyline itself (the far closing edge is outside the target).
 *
 * The offset direction is the outward normal of the polyline's overall chord; a
 * generous magnitude (10× the span, min 720°) guarantees the closing path lies
 * well outside the target and the seam-unwrapped span.
 */
function openLineToClip(
  line: readonly WorldCoordinate[],
  targetSpan: number,
): GeoRing {
  // Walk the polyline forward, then return along a parallel-offset reverse path.
  const offset = Math.max(targetSpan * 10, 720);
  const first = line[0];
  const last = line[line.length - 1];
  if (first === undefined || last === undefined) return [];
  // Chord direction (start → end); the offset normal is perpendicular to it.
  const dx = last.lon - first.lon;
  const dy = last.lat - first.lat;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const forward: WorldCoordinate[] = line.map((p) => ({ lon: p.lon, lat: p.lat }));
  const back: WorldCoordinate[] = [];
  for (let i = line.length - 1; i >= 0; i -= 1) {
    const p = line[i];
    if (p === undefined) continue;
    back.push({ lon: p.lon + nx * offset, lat: p.lat + ny * offset });
  }
  return [...forward, ...back];
}

/** Horizontal+vertical span of a multi-polygon's outer extent (for offset sizing). */
function multiPolygonSpan(mp: GeoMultiPolygon): number {
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
  if (!Number.isFinite(minLon)) return 0;
  return Math.max(maxLon - minLon, maxLat - minLat);
}

// ---------------------------------------------------------------------------
// Pierce detection (FR-90 / 教訓5.38: 線分交差で判定)
// ---------------------------------------------------------------------------

/**
 * Decide whether the OPEN cut polyline pierces the target face — i.e. whether it
 * enters the face interior at all and so could divide it into two pieces.
 *
 * 教訓5.38: the判定 is by線分交差, not point-in-polygon alone. BUT a Proper-only
 * crossing parity is over-strict: a cut that enters or exits through an EXISTING
 * polygon vertex (FR-77 grid-snap makes this a common, realistic input — the cut
 * endpoint lands on a grid node that is also a polygon corner) classifies as an
 * Endpoint contact, never Proper, so a corner-to-corner diagonal or a
 * corner-entry/edge-exit cut would be wrongly rejected as 貫通せず even though it
 * geometrically bisects the face. We therefore detect pierce by interior contact:
 * the line pierces iff ANY of its segments has a point strictly inside the face.
 * The authoritative 2-piece gate is the post-op sideA/sideB non-empty check
 * (`checkSplittable` :=> both intersection() and difference() non-empty); this
 * pre-check only short-circuits obviously non-piercing lines (e.g. a line fully
 * outside the face) with the correct 貫通せず message.
 *
 * "Strictly inside" is sampled at each segment's midpoint AND endpoints, and a
 * proper/endpoint crossing of any boundary edge also counts as a pierce (the line
 * touches the boundary on its way through). A line that only grazes the boundary
 * without any interior contact is NOT a pierce.
 */
function linePiercesFace(line: readonly WorldCoordinate[], mp: GeoMultiPolygon): boolean {
  // 1. Any vertex of the polyline strictly inside the face → it pierces.
  for (const p of line) {
    if (p !== undefined && pointStrictlyInsideFace(p, mp)) return true;
  }
  // 2. Any segment whose midpoint is strictly inside the face → it pierces.
  //    This catches a chord that enters and exits through boundary vertices
  //    (corner-to-corner diagonal) where every polyline vertex sits ON the
  //    boundary, not strictly inside (so step 1 alone would miss it).
  for (let i = 0; i + 1 < line.length; i += 1) {
    const a = line[i];
    const b = line[i + 1];
    if (a === undefined || b === undefined) continue;
    const mid = { lon: (a.lon + b.lon) / 2, lat: (a.lat + b.lat) / 2 };
    if (pointStrictlyInsideFace(mid, mp)) return true;
  }
  // 3. Count distinct boundary crossings (Proper OR vertex-transit). A line that
  //    enters and exits through boundary vertices may have NO interior midpoint
  //    when the chord runs exactly along the boundary, but a transit through two
  //    distinct boundary points still pierces. Two or more boundary contacts on
  //    one outer ring means it entered and left the interior.
  return countBoundaryTransits(line, mp) >= 2;
}

/**
 * Point strictly inside the multi-polygon's filled area (inside an outer ring and
 * not inside any of that piece's holes), excluding the boundary. 教訓5.1: every
 * piece is considered (no 片落とし).
 */
function pointStrictlyInsideFace(p: WorldCoordinate, mp: GeoMultiPolygon): boolean {
  for (const poly of mp as readonly GeoPolygon[]) {
    if (pointInPolygon(p, poly) === POINT_LOCATION.Inside) return true;
  }
  return false;
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
  const targetMp = resolveLeafShape(leaf.shape, store);
  if (targetMp === undefined) {
    return rejection(SPLIT_REJECT.Unresolvable);
  }

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
    unwrapRing([...line.points]),
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
    const span = multiPolygonSpan(targetMp);
    clip = [[openLineToClip(linePts, span)]];
  }

  const inside = intersection(targetMp, clip);
  const outside = difference(targetMp, clip);
  if (!isOk(inside) || !isOk(outside)) {
    return rejection(SPLIT_REJECT.InvalidShape);
  }

  const sideA = inside.result;
  const sideB = outside.result;

  // Both sides must be non-empty (a 2-piece split) — otherwise the line did not
  // actually divide the face (貫通せず / fully-inside line that vanished).
  if (sideA.length === 0 || sideB.length === 0) {
    return rejection(SPLIT_REJECT.DoesNotPierce);
  }

  // Each side's every outer ring must have ≥3 vertices (FR-44 最低 3 頂点).
  if (!everyOuterRingHasMinVertices(sideA) || !everyOuterRingHasMinVertices(sideB)) {
    return rejection(SPLIT_REJECT.TooFewVertices);
  }

  return {
    status: SPLIT_CHECK_STATUS.Splittable,
    sideA: { area: sideA, areaKm2: multiPolygonAreaKm2(sideA, DEFAULT_GEO_PARAMS) },
    sideB: { area: sideB, areaKm2: multiPolygonAreaKm2(sideB, DEFAULT_GEO_PARAMS) },
  };
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
  readonly sideA: SplitSide;
  readonly sideB: SplitSide;
  /**
   * Every point where the OPEN cut line crosses an existing target edge partway
   * along it (FR-95). Empty for a closed cut, or when the cut only meets existing
   * vertices (no mid-edge crossing). 片落とし禁止: every crossed edge is recorded.
   */
  readonly edgeCuts: readonly EdgeCutPoint[];
}

/**
 * Compute every mid-edge crossing of the OPEN cut line against the target leaf's
 * existing edges (FR-95 / 教訓5.38: 線分交差で判定). For each ring edge the cut line
 * crosses Properly (interior crossing, not an endpoint touch — an endpoint touch
 * lands on an existing vertex and needs no new vertex), record the ring id, the
 * edge's start index, the two edge vertex ids, and the quantize-aligned crossing
 * coordinate. The proposal layer maps these to {@link SharedEdgeCutSpec}s when the
 * crossed edge is a共有辺 (shared with a partner feature). Pure.
 */
function computeEdgeCuts(
  target: LeafFeature,
  store: VertexStore,
  linePts: readonly WorldCoordinate[],
): EdgeCutPoint[] {
  const cuts: EdgeCutPoint[] = [];
  const seen = new Set<string>();
  for (const ring of target.shape.rings) {
    const n = ring.vertexIds.length;
    for (let j = 0; j < n; j += 1) {
      const startId = ring.vertexIds[j];
      const endId = ring.vertexIds[(j + 1) % n];
      if (startId === undefined || endId === undefined) continue;
      const startV = getVertex(store, startId);
      const endV = getVertex(store, endId);
      if (startV === undefined || endV === undefined) continue;
      // Quantize the target edge endpoints onto the SAME grid the split boolean op
      // works on (U06 quantizes its inputs) before computing the crossing. WHY:
      // the cut line is grid-snapped (snapCutLine) but the stored target coords
      // can be sub-grid; intersecting the snapped line against RAW edge endpoints
      // can quantize to a DIFFERENT grid node than the seam the split actually
      // produced — FR-95 would then insert a mismatched node on the共有相手 edge.
      // Quantizing both sides keeps the共有辺途中切断点 on the split's exact seam node.
      const startC = quantizeCoordinate(startV.coordinate);
      const endC = quantizeCoordinate(endV.coordinate);
      for (let i = 0; i + 1 < linePts.length; i += 1) {
        const a = linePts[i];
        const b = linePts[i + 1];
        if (a === undefined || b === undefined) continue;
        const hit = segmentsIntersect(a, b, startC, endC);
        if (hit.relation !== SEGMENT_RELATION.Proper || hit.point === undefined) continue;
        const coordinate = quantizeCoordinate(hit.point);
        const key = `${ring.id}:${j}:${coordinate.lon},${coordinate.lat}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cuts.push({
          ringId: ring.id,
          edgeStartIndex: j,
          edgeStartVertexId: startId,
          edgeEndVertexId: endId,
          coordinate,
        });
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
  // Mid-edge cut points only arise for an OPEN cut crossing existing edges (R3:
  // seam-unwrap the line first so the crossing is computed in one continuous run).
  const edgeCuts =
    target.kind === FEATURE_KIND.Leaf && line.kind === KNIFE_LINE_KIND.Open
      ? computeEdgeCuts(target, store, snapCutLine(unwrapRing([...line.points]), false))
      : [];
  return { sideA: check.sideA, sideB: check.sideB, edgeCuts };
}

/**
 * Identify which side is the smaller (FR-93 小さい方プレビュー). Returns 'a' when
 * sideA is strictly smaller, otherwise 'b' (ties resolve to 'b' deterministically;
 * the value is only a preview hint). Pure.
 */
export function smallerSide(result: SplitResult): 'a' | 'b' {
  return result.sideA.areaKm2 < result.sideB.areaKm2 ? 'a' : 'b';
}
