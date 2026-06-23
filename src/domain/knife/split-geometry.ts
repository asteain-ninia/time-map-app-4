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
import {
  difference,
  intersection,
  isOk,
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
 *
 * Degenerate-chord guard (bug-hunt2): the offset normal must NOT be derived from
 * the endpoint chord alone. A U-shaped / looping OPEN polyline whose first and last
 * vertices quantize onto the SAME grid node (snapCutLine drops only consecutive
 * duplicates for an open line, never first==last) gives dx=dy=0, so the old
 * `len = hypot(0,0) || 1 = 1` produced nx=ny=0: the `back` path retraced `forward`
 * with ZERO offset, yielding a zero-AREA clip ring whose boolean op vanished and
 * mis-reported downstream as 貫通せず/不正形状 instead of an honest rejection. More
 * generally a near-degenerate short chord with a far-bulging cut points the normal
 * along the wrong axis, landing the half-region on the geometrically wrong side. So
 * when the endpoint chord is ~0 we fall back to the polyline's OVERALL extent (its
 * bbox diagonal) for the direction; the perpendicular of that is a stable normal
 * that pushes `back` cleanly to one side. The caller (checkSplittable) additionally
 * rejects a clip whose ring area is still ~0 with DegenerateLine, so a polyline with
 * no extent at all (every vertex on one node) can never form a clip.
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
  // Chord direction (start → end); the offset normal is perpendicular to it. When
  // the endpoints coincide (first===last, a looping cut) the chord is degenerate, so
  // derive the direction from the polyline's overall bbox diagonal instead — never
  // from the zero chord (which would collapse the normal to (0,0)).
  let dx = last.lon - first.lon;
  let dy = last.lat - first.lat;
  if (Math.hypot(dx, dy) <= CHORD_DEGENERATE_EPS) {
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
    dx = Number.isFinite(minLon) ? maxLon - minLon : 0;
    dy = Number.isFinite(minLat) ? maxLat - minLat : 0;
  }
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
// INTERIOR CHORDS (boundary-node → 面内部 → boundary-node), then apply the EXISTING
// 2-way mechanism (openLineToClip + U06 intersection/difference) ONE chord at a time
// to whichever current piece the chord runs through. k chords → k+1 pieces. The
// dangling head/tail (line ends that stop inside / start outside) are naturally
// dropped because a chord needs a boundary crossing at BOTH ends (G2). A self-
// intersecting cut (chords crossing) is rejected (G3) rather than mis-processed.
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

  // 2. Classify each gap (in/out via its midpoint) and collect maximal INSIDE runs
  //    bounded by boundary crossings at BOTH ends — those are the chords.
  const chords: WorldCoordinate[][] = [];
  let i = 0;
  while (i + 1 < aug.length) {
    const inside = multiPolygonContains(mp, midpoint(aug[i]!.point, aug[i + 1]!.point));
    if (!inside) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < aug.length && multiPolygonContains(mp, midpoint(aug[j]!.point, aug[j + 1]!.point))) {
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

/** A point strictly inside the face along a chord (an interior vertex if any, else its midpoint). */
function chordInteriorSample(chord: readonly WorldCoordinate[]): WorldCoordinate {
  if (chord.length > 2) return chord[Math.floor(chord.length / 2)]!;
  return midpoint(chord[0]!, chord[chord.length - 1]!);
}

/** The discriminated result of the n-way piece collector. */
type PiecesResult =
  | { readonly ok: true; readonly pieces: readonly GeoMultiPolygon[] }
  | { readonly ok: false; readonly reason: SplitRejectKind };

/**
 * Collect the k+1 pieces of an OPEN cut by applying each chord's 2-way clip to the
 * piece it runs through (G1/G6: the piece count is the actual connected-component
 * count the iterated boolean ops yield, not a `pieces.length===k+1` assert). Rejects
 * a self-intersecting cut (a chord whose interior lands in no current piece, or whose
 * clip empties a side) honestly (G3). Pure.
 */
export function collectOpenPieces(
  linePts: readonly WorldCoordinate[],
  mp: GeoMultiPolygon,
  span: number,
): PiecesResult {
  const chords = splitIntoChords(linePts, mp);
  if (chords.length === 0) return { ok: false, reason: SPLIT_REJECT.DoesNotPierce };

  // Each chord is a boundary→interior→boundary cut of exactly ONE current piece (the one
  // its interior sample lands in). Applying the SAME 2-way clip (openLineToClip +
  // intersection/difference) to that piece replaces it with its two halves; k chords ⇒
  // k+1 pieces. NOTE (documented limitation, plan G1/G6): each half is kept WHOLE — we do
  // NOT split a half into connected components. A single chord that genuinely disconnects
  // a CONCAVE half into two regions therefore yields ONE multi-part (exclave) piece rather
  // than two — the SAME conservative grouping the prior 2-way split produced. We avoid the
  // naive component-split because the chord's own clip (a half-plane extrusion of a BENT
  // chord) routinely produces disjoint boolean artifacts that are NOT real pieces, and
  // splitting those over-counts the common comb cut. A true component collector that
  // distinguishes real cut-disconnections from clip artifacts is future work.
  const pieces: GeoMultiPolygon[] = [mp];
  for (const chord of chords) {
    const clipRing = openLineToClip(chord, span);
    if (planarRingArea2(clipRing) <= CHORD_DEGENERATE_EPS) {
      return { ok: false, reason: SPLIT_REJECT.DegenerateLine };
    }
    const clip: GeoMultiPolygon = [[clipRing]];
    const sample = chordInteriorSample(chord);
    const idx = pieces.findIndex((p) => multiPolygonContains(p, sample));
    if (idx < 0) return { ok: false, reason: SPLIT_REJECT.SelfIntersectingCut };
    const piece = pieces[idx]!;
    const inside = intersection(piece, clip);
    const outside = difference(piece, clip);
    if (!isOk(inside) || !isOk(outside)) return { ok: false, reason: SPLIT_REJECT.InvalidShape };
    if (inside.result.length === 0 || outside.result.length === 0) {
      return { ok: false, reason: SPLIT_REJECT.SelfIntersectingCut };
    }
    pieces.splice(idx, 1, inside.result, outside.result);
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

  // HB3-5/19 n-way split scope — PURELY ADDITIVE: the n-way path is taken ONLY for an
  // OPEN cut on a SIMPLE face (one polygon, one ring) that decomposes into ≥2 interior
  // chords (i.e. crosses the boundary ≥4 times ⇒ ≥3 pieces). Every ≤2-piece cut (one
  // chord), every CLOSED cut, and every holed / multi-region face fall through to the
  // EXISTING single-clip 2-way path UNCHANGED — so the common 2-piece behaviour (incl.
  // the FR-95 shared-edge-cut seam node, all existing tests) is bit-for-bit preserved.
  // Only the genuinely-multi-crossing comb cut (which the 2-way grouped into one
  // exclave-bearing side) now correctly yields k+1 separate pieces. targetMp + linePts
  // are already seam-anchored to ONE branch above (R3) so the chord planar geometry is
  // correct across the antimeridian. (Holes/exclaves + n-way edge-cut coincidence remain
  // future work — verify-workflow findings.)
  let pieces: GeoMultiPolygon[];
  const simpleFace = targetMp.length === 1 && (targetMp[0]?.length ?? 0) === 1;
  const nwayChords =
    line.kind === KNIFE_LINE_KIND.Open && simpleFace
      ? splitIntoChords(linePts, targetMp)
      : [];
  if (nwayChords.length >= 2) {
    const collected = collectOpenPieces(linePts, targetMp, multiPolygonSpan(targetMp));
    if (!collected.ok) return rejection(collected.reason);
    pieces = [...collected.pieces];
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
      const span = multiPolygonSpan(targetMp);
      const clipRing = openLineToClip(linePts, span);
      // Reject a degenerate clip (bug-hunt2): even with the chord guard, a polyline
      // with no spatial extent at all (every snapped vertex on one grid node) yields a
      // zero-area ring. A zero-area clip makes intersection/difference vanish and would
      // mis-report as 貫通せず/不正形状 — surface the honest 分断線の点が足りません instead.
      if (planarRingArea2(clipRing) <= CHORD_DEGENERATE_EPS) {
        return rejection(SPLIT_REJECT.DegenerateLine);
      }
      clip = [[clipRing]];
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

  const sides = pieces.map(sideOf);
  return {
    status: SPLIT_CHECK_STATUS.Splittable,
    pieces: sides,
    sideA: sides[0]!,
    sideB: sides[1]!,
  };
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
  /**
   * Every point where the OPEN cut line crosses an existing target edge partway
   * along it (FR-95). Empty for a closed cut, or when the cut only meets existing
   * vertices (no mid-edge crossing). 片落とし禁止: every crossed edge is recorded.
   */
  readonly edgeCuts: readonly EdgeCutPoint[];
}

/**
 * Compute every mid-edge crossing of the OPEN cut line against the target leaf's
 * existing edges (FR-95 / 教訓5.38: 線分交差で判定). A mid-edge cut is recorded when:
 *   - the cut line crosses the edge PROPERLY (interiors cross), OR
 *   - the cut line TOUCHES the edge at an Endpoint contact whose point lands PARTWAY
 *     along the edge — i.e. a cut-line vertex lands mid-edge (not on an existing
 *     target vertex). Codex M1: this Endpoint case is also a真の共有辺途中切断点 — the
 *     共有相手 edge still needs a same-coordinate node there (FR-95). Only an Endpoint
 *     contact that coincides with an existing edge ENDPOINT (an existing target
 *     vertex) needs no new node and is skipped.
 * For each recorded cut we store the ring id, the edge's start index, the two edge
 * vertex ids, and the quantize-aligned cut coordinate. The proposal layer maps
 * these to {@link SharedEdgeCutSpec}s when the crossed edge is a共有辺. Pure.
 */
function computeEdgeCuts(
  target: LeafFeature,
  store: VertexStore,
  linePts: readonly WorldCoordinate[],
  refLon: number,
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
      // Anchor both endpoints onto the cut line's longitude branch (refLon) first
      // so a seam-crossing edge (e.g. 170° → −170°) is compared against the line in
      // ONE continuous system (R3), matching the checkSplittable boolean op.
      const startA = createCoordinate(anchorLon(startV.coordinate.lon, refLon), startV.coordinate.lat);
      const endA = createCoordinate(anchorLon(endV.coordinate.lon, startA.lon), endV.coordinate.lat);
      const startC = quantizeCoordinate(startA);
      const endC = quantizeCoordinate(endA);
      for (let i = 0; i + 1 < linePts.length; i += 1) {
        const a = linePts[i];
        const b = linePts[i + 1];
        if (a === undefined || b === undefined) continue;
        const hit = segmentsIntersect(a, b, startC, endC);
        if (hit.point === undefined) continue;
        if (hit.relation !== SEGMENT_RELATION.Proper && hit.relation !== SEGMENT_RELATION.Endpoint) {
          continue;
        }
        const coordinate = quantizeCoordinate(hit.point);
        // A mid-edge cut is recorded ONLY when the (quantized) intersection point
        // falls strictly between the edge's (quantized) endpoints. This applies to
        // BOTH a Proper crossing AND an Endpoint contact: an intersection that
        // quantizes onto an existing edge vertex (startC/endC) needs no new node and
        // would otherwise produce a zero-length edge / duplicate-coordinate node on
        // the共有相手 edge (Codex M1; bug-hunt: a near-endpoint Proper crossing that
        // quantizes onto startC/endC is degenerate and must be skipped too).
        if (coordinatesEqual(coordinate, startC) || coordinatesEqual(coordinate, endC)) {
          continue;
        }
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
  // Mid-edge cut points only arise for an OPEN cut crossing existing edges. Compute
  // them in the SAME seam-anchored system checkSplittable used (R3): the reference
  // is the target's outer-ring branch, and the cut line + target edges are anchored
  // to it before the line-segment crossing test.
  let edgeCuts: readonly EdgeCutPoint[] = [];
  if (target.kind === FEATURE_KIND.Leaf && line.kind === KNIFE_LINE_KIND.Open) {
    const resolvedMp = resolveLeafShape(target.shape, store);
    const refLon = resolvedMp === undefined ? 0 : targetReferenceLon(resolvedMp);
    const anchoredLine = snapCutLine(unwrapAnchoredRing([...line.points], refLon), false);
    edgeCuts = computeEdgeCuts(target, store, anchoredLine, refLon);
  }
  return {
    pieces: check.pieces ?? [check.sideA, check.sideB],
    sideA: check.sideA,
    sideB: check.sideB,
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
 * @deprecated 2-way preview hint (kept while consumers migrate to {@link smallestPieceIndex}).
 * Returns 'a' when `pieces[0]` is the smaller of the FIRST TWO pieces, else 'b'.
 */
export function smallerSide(result: SplitResult): 'a' | 'b' {
  return result.sideA.areaKm2 < result.sideB.areaKm2 ? 'a' : 'b';
}
