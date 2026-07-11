// U10 terminal-pair exclusion detection (FR-26 / FR-27, domain layer, pure).
//
// The map-wide rule: TERMINAL features (those that own a shape and have no
// sub-regions) must never overlap with positive area; boundary contact (shared
// edge / shared vertex / zero-area touch) is NOT an overlap (FR-26). Aggregate
// features carry no exclusion constraint and are never indexed nor tested
// (FR-27 / 教訓5.25) — this function only ever receives terminal shapes, so the
// "exclude aggregates" rule is enforced at the type boundary: an aggregate
// simply is not in the input list.
//
// Single source of truth (教訓5.30): "positive-area overlap vs boundary contact"
// is decided by U06's boolean `intersection` (the same defense-pipeline kernel
// that every other unit shares), NOT by a second predicate implemented here. An
// intersection that is a non-empty multi-polygon = overlap; an empty result
// (disjoint, or edge/vertex touch which has zero area) = no overlap.
//
// World seam (技術方針 R3 / spec §世界端ラップ対応): longitude is a continuous
// scalar. Two terminals stored near the +180 / −180 ends can be neighbours on
// the map; to catch that we generate ±360° replicas of each shape via U05's
// `worldWrapReplicas` and index/test the replicas too, while never reporting a
// shape as overlapping its own replica (a replica is the same feature one world
// turn away).
//
// Candidate narrowing (NFR 5.1 / 5.2): each terminal's bbox is queried against
// the R-tree, so only near neighbours run the (costly) geometric predicate —
// the O(n²) all-pairs scan is avoided. Pairs are reported once, normalised to
// (min id, max id) order, never double-counted (spec §注意点「ペアの二重計上」).

import type { WorldCoordinate } from '../coordinate';
import type { FeatureId } from '../ids';
import { idToString } from '../ids';
import { alignMultiPolygon, worldWrapReplicas, type WrapReplica } from '../geo/seam';
import { intersection, isOk } from '../geometry/boolean-ops';
import { pointInPolygon, POINT_LOCATION } from '../geometry/index';
import {
  EMPTY_MULTI_POLYGON,
  isMultiPolygonEmpty,
  type GeoMultiPolygon,
  type GeoRing,
} from '../geometry/types';
import { multiPolygonBBox, bboxesIntersect, type BBox } from './bbox';
import { SpatialIndex, type IndexEntry } from './rtree';

/** A terminal feature reduced to the only things exclusion checking needs. */
export interface TerminalShape {
  readonly id: FeatureId;
  /** The terminal's evaluated shape (continuous-longitude rings, U05). */
  readonly shape: GeoMultiPolygon;
}

/** One detected overlap: the unordered id pair plus the overlap area itself. */
export interface OverlapPair {
  readonly a: FeatureId;
  readonly b: FeatureId;
  /**
   * The intersection area (every piece — a single overlap may split into
   * several disjoint pieces, 教訓5.1; we keep them all). Always non-empty for a
   * reported pair.
   */
  readonly overlap: GeoMultiPolygon;
}

/**
 * A geometric-predicate counter. The exclusion run threads one through so tests
 * can prove the candidate narrowing kept predicate calls to O(n)-ish rather
 * than N(N-1)/2 (受け入れ基準3 / 5; 退行を計測で検出する, 教訓1.7).
 */
export interface PredicateCounter {
  count: number;
}

export interface DetectOptions {
  /**
   * The ±360° turn offsets used for seam replication. Default {-1, 0, +1}
   * (west / identity / east) covers neighbours across either seam. Passing
   * just {0} disables seam handling (used by tests to isolate behaviour).
   */
  readonly seamTurns?: readonly number[];
  /** Optional predicate-call counter (for the narrowing / benchmark tests). */
  readonly counter?: PredicateCounter;
}

const DEFAULT_SEAM_TURNS: readonly number[] = [-1, 0, 1];

/**
 * Make a terminal's shape SEAM-CONTINUOUS before it is indexed / tested (M6 root
 * fix). The shapes arrive from U08's `resolveLeafShape`, which returns RAW stored
 * representatives with zero seam handling — so a single leaf whose territory
 * straddles the seam can be stored folded (e.g. a ring `[179, −179, …]`). Read
 * verbatim, its bbox spans the WRONG way round the world (~358° instead of ~2°),
 * which both (1) blows up candidate narrowing to all-pairs (NFR 5.1/5.2 退行) and
 * (2) feeds polygon-clipping a backwards ring, producing phantom overlaps /
 * missed real ones. `replicateShape` only shifts whole rings by ±360°, so it can
 * never repair an intra-ring 179→−179 jump.
 *
 * `alignMultiPolygon` is the SINGLE seam-continuity source (audit root cause A/B):
 * it unwraps each ring across its closing edge AND anchors every ring (outer +
 * holes + enclaves) onto one common branch, so a folded seam ring becomes its
 * true ~2°-wide continuous self and a hole on the opposite seam side does not land
 * a world-turn away. For an already-continuous single-branch shape this is the
 * identity. Pure; the input is never mutated.
 */
function seamContinuousShape(shape: GeoMultiPolygon): GeoMultiPolygon {
  return alignMultiPolygon(shape) as GeoMultiPolygon;
}

/** Shift every ring of a multi-polygon by `turns` world turns (via U05 per ring). */
function replicateShape(shape: GeoMultiPolygon, turns: number): GeoMultiPolygon {
  return shape.map((poly) =>
    poly.map((ring) => {
      // worldWrapReplicas over a single turn returns exactly one replica; we use
      // U05 so the ±360° offset lives in one place (单一真实源), never re-derived.
      const replicas: WrapReplica[] = worldWrapReplicas(ring, [turns]);
      const replica = replicas[0];
      return (replica?.ring ?? ring) as GeoRing;
    }),
  );
}

/** A candidate placement of a terminal: its (possibly seam-shifted) shape + bbox. */
interface Placement {
  readonly id: FeatureId;
  readonly turns: number;
  readonly shape: GeoMultiPolygon;
  readonly bbox: BBox;
}

// --- candidate early-reject: does a placement REACH the shared overlap box? ----
//
// The R-tree + `bboxesIntersect` pre-filter already discards pairs whose whole-shape
// bboxes are disjoint, but a WIDE shape's bbox (a sprawling multi-island country, a
// shape spanning a hemisphere) still intersects the bbox of many features its actual
// geometry never comes near — a small feature sitting in the CONCAVE notch of a big
// one, or anywhere inside its bbox but far from every edge. Each such pair otherwise
// pays a full `polygon-clipping` intersection that returns empty (real-data load
// benchmark: ~1/3 of the bbox-candidate pairs, and HALF the clipping time, were
// exactly these). This cheap linear test skips them BEFORE the kernel (task 手順3(b)).
//
// SOUNDNESS (the output must be byte-for-byte unchanged — 完全不変): A∩B lies wholly
// inside R = bbox(A) ∩ bbox(B), because A∩B ⊆ A ⊆ bbox(A) and A∩B ⊆ B ⊆ bbox(B). So
// A∩B ⊆ A∩R and A∩B ⊆ B∩R: if EITHER side does not reach R at all, A∩B is provably
// empty and the clipping call is skipped. The test can therefore only skip pairs the
// kernel would report empty — never a real overlap — so the pair set AND the
// accumulated overlap geometry are identical to the un-narrowed run (the naive
// reference in overlap.test.ts pins this as a property, seams on). It is applied only
// to the indexed detector; the naive reference stays exhaustive so the equality holds.
//
// `reaches R` is itself a conservative over-approximation of "P ∩ R ≠ ∅":
//   (1) any EDGE of P whose bbox meets R — covers every case where P's boundary
//       enters R (a vertex of P in R, or an edge passing through R); AND
//   (2) R wholly inside P (P's interior covers R with NO boundary of P inside R) —
//       caught by one corner of R lying inside an outer ring of P.
// Returning `true` too readily merely forgoes a skip (still correct); a false `false`
// would drop a detection, which (1)+(2) provably never do. Holes are ignored in (2)
// (a corner falling in a hole only makes us KEEP the pair — a safe over-approx).

/** Intersection rectangle of two bboxes KNOWN to intersect (may be degenerate to a
 * line/point when they only touch). Precondition: `bboxesIntersect(a, b)`. */
function bboxOverlapRect(a: BBox, b: BBox): BBox {
  return {
    minX: Math.max(a.minX, b.minX),
    minY: Math.max(a.minY, b.minY),
    maxX: Math.min(a.maxX, b.maxX),
    maxY: Math.min(a.maxY, b.maxY),
  };
}

/** True iff segment [p→q]'s axis-aligned bbox meets rect `r` (inclusive) — a
 * conservative superset of "the edge intersects r": an edge that truly enters r
 * always passes, so relying on it can never drop a real overlap. */
function edgeBoxMeetsRect(p: WorldCoordinate, q: WorldCoordinate, r: BBox): boolean {
  const minLon = p.lon < q.lon ? p.lon : q.lon;
  const maxLon = p.lon < q.lon ? q.lon : p.lon;
  if (minLon > r.maxX || maxLon < r.minX) return false;
  const minLat = p.lat < q.lat ? p.lat : q.lat;
  const maxLat = p.lat < q.lat ? q.lat : p.lat;
  return minLat <= r.maxY && maxLat >= r.minY;
}

/** True iff shape `mp` MAY intersect rectangle `r` — the sound `reaches R` test
 * documented above. One linear pass over every ring's edges, plus (only when no edge
 * reaches r) a single point-in-outer-ring probe for the R-wholly-inside-P case. */
function shapeReachesRect(mp: GeoMultiPolygon, r: BBox): boolean {
  for (const poly of mp) {
    for (const ring of poly) {
      const n = ring.length;
      for (let i = 0; i < n; i += 1) {
        const p = ring[i];
        const q = ring[(i + 1) % n];
        if (p === undefined || q === undefined) continue;
        if (edgeBoxMeetsRect(p, q, r)) return true;
      }
    }
  }
  // No boundary of P enters R, so P∩R is nonempty only if R sits wholly inside P.
  // One corner of R against each piece's OUTER ring settles that (pointInPolygon is
  // the single point-in-polygon truth source — 教訓5.30; holes omitted = safe
  // over-approx). Anything but a strict `outside` keeps the pair.
  const corner: WorldCoordinate = { lon: r.minX, lat: r.minY };
  for (const poly of mp) {
    const outer = poly[0];
    if (outer !== undefined && pointInPolygon(corner, [outer]) !== POINT_LOCATION.Outside) {
      return true;
    }
  }
  return false;
}

/**
 * Detect every positive-area overlap among the given TERMINAL shapes, using the
 * R-tree to narrow candidates and U05 replicas to catch seam-crossing pairs.
 *
 * Pure: same input → same output, no mutation of the inputs. The returned pairs
 * are unique (normalised id order) and each carries the full overlap area.
 */
export function detectTerminalOverlaps(
  terminals: readonly TerminalShape[],
  options: DetectOptions = {},
): OverlapPair[] {
  const seamTurns = options.seamTurns ?? DEFAULT_SEAM_TURNS;
  const counter = options.counter;

  // 1. Build placements: the identity (turns 0) plus a seam replica per turn for
  //    shapes that have any extent. Replicas at turn 0 duplicate the identity, so
  //    we only add non-zero turns as extra placements.
  const placements: Placement[] = [];
  for (const t of terminals) {
    // Seam-continuous the raw representative shape FIRST (M6): the bbox and every
    // ±360° replica are then derived from a ring that never folds backwards.
    const shape = seamContinuousShape(t.shape);
    const baseBox = multiPolygonBBox(shape);
    if (baseBox === undefined) continue; // empty shape: cannot overlap anything.
    placements.push({ id: t.id, turns: 0, shape, bbox: baseBox });
    for (const turns of seamTurns) {
      if (turns === 0) continue;
      const shifted = replicateShape(shape, turns);
      const box = multiPolygonBBox(shifted);
      if (box === undefined) continue;
      placements.push({ id: t.id, turns, shape: shifted, bbox: box });
    }
  }

  // 2. Index every placement (identity + replicas) so a query rectangle can find
  //    seam-shifted neighbours too.
  const index = new SpatialIndex<number>();
  const entries: IndexEntry<number>[] = placements.map((p, i) => ({
    ref: i,
    minX: p.bbox.minX,
    minY: p.bbox.minY,
    maxX: p.bbox.maxX,
    maxY: p.bbox.maxY,
  }));
  index.bulkLoad(entries);

  // 3. For each identity placement, query its bbox and test only candidates.
  //    We anchor queries on the CANONICAL-side identity placement (turns 0, and
  //    a.id is the smaller id of the pair) so each unordered pair is reached from
  //    exactly one direction; the candidate may be ANY placement (identity or
  //    replica) of the *other* feature.
  //
  //    Anchoring on the canonical side matters for two reasons:
  //    - It is the SAME test family the naïve reference runs (A-identity against
  //      every ±360° turn of B), so the indexed and naïve overlap geometries agree
  //      piece-for-piece (narrowing-correctness invariant). A-identity∩B+1 is the
  //      same intersection as A−1∩B-identity one turn over, so testing A-identity
  //      against every B turn captures the whole pair without anchoring A's
  //      replicas too.
  //    - It prevents DOUBLE counting: A-identity∩B-identity and B-identity∩
  //      A-identity are the same geometric piece; anchoring on only the smaller id
  //      records it once.
  //
  //    A given unordered pair (A,B) can be reachable through MULTIPLE placements
  //    of B — B's identity AND B's ±360° replica — when A is wide enough to span
  //    both world turns. We must NOT short-circuit on "pair already seen" and keep
  //    only the first piece: that drops the other seam turn's overlap (片落とし禁止,
  //    教訓5.1). Instead we ACCUMULATE every non-empty intersection piece across
  //    all placements of the same pair, mirroring the naïve accumulation, and emit
  //    each pair once with the full overlap area (受け入れ基準3「取りこぼさない」).
  const accumulated = new Map<string, OverlapPair>();
  for (const a of placements) {
    if (a.turns !== 0) continue; // anchor on identity placements only.
    const aKey = idToString(a.id);
    const candidates = index.search(a.bbox);
    for (const cand of candidates) {
      const b = placements[cand.ref];
      if (b === undefined) continue;
      // Skip self (same feature id): a feature never overlaps itself, and its own
      // ±360° replica is the same feature one turn away (排他検証から自己複製を除外).
      if (b.id === a.id) continue;
      // Canonical direction only: process each unordered pair from its smaller-id
      // anchor (mirrors the naïve i<j ordering; avoids counting A∩B twice and
      // matches the naïve test family A-identity × B-turns).
      if (aKey > idToString(b.id)) continue;
      // Cheap reject: bbox must actually intersect (search is inclusive; this also
      // mirrors the touch boundary, but the real decision is the area test below).
      if (!bboxesIntersect(a.bbox, b.bbox)) continue;

      // Sound early-reject BEFORE the costly polygon-clipping kernel: A∩B ⊆ the shared
      // overlap box, so if either side does not reach that box the intersection is
      // provably empty (see shapeReachesRect). Skipping such a pair cannot change the
      // detector's output — only avoid an empty-result kernel call (完全不変).
      const overlapBox = bboxOverlapRect(a.bbox, b.bbox);
      if (!shapeReachesRect(a.shape, overlapBox) || !shapeReachesRect(b.shape, overlapBox)) {
        continue;
      }

      if (counter !== undefined) counter.count += 1;
      const piece = overlapArea(a.shape, b.shape);
      if (piece === undefined) continue; // boundary contact / disjoint: not overlap.

      // Accumulate this placement's piece into the pair's running overlap. Each
      // distinct B placement (identity / replica) contributes its own geometry;
      // none is dropped (full overlap area per 受け入れ基準3).
      const key = pairKey(a.id, b.id);
      const prior = accumulated.get(key);
      if (prior === undefined) {
        accumulated.set(key, makePair(a.id, b.id, piece));
      } else {
        accumulated.set(key, { ...prior, overlap: [...prior.overlap, ...piece] });
      }
    }
  }

  return [...accumulated.values()];
}

/**
 * The positive-area intersection of two shapes, or undefined when they do not
 * overlap (disjoint, or only touch at edges/vertices → zero area). Delegates to
 * U06's `intersection` so the overlap/contact distinction is the SINGLE shared
 * one (教訓5.30). A rejected boolean op (degenerate input) is treated as "no
 * decidable overlap" → undefined, matching U06's no-silent-empty contract: the
 * caller asked only "do they overlap?", and a defense-layer rejection is not a
 * positive overlap.
 */
function overlapArea(a: GeoMultiPolygon, b: GeoMultiPolygon): GeoMultiPolygon | undefined {
  const res = intersection(a, b);
  if (!isOk(res)) return undefined;
  if (isMultiPolygonEmpty(res.result)) return undefined;
  return res.result;
}

/** Stable unordered-pair key: smaller id string first (normalised order). */
function pairKey(x: FeatureId, y: FeatureId): string {
  const sx = idToString(x);
  const sy = idToString(y);
  return sx <= sy ? `${sx} ${sy}` : `${sy} ${sx}`;
}

/** Build a pair in normalised (min id, max id) order. */
function makePair(x: FeatureId, y: FeatureId, overlap: GeoMultiPolygon): OverlapPair {
  const sx = idToString(x);
  const sy = idToString(y);
  return sx <= sy ? { a: x, b: y, overlap } : { a: y, b: x, overlap };
}

// --- reference implementation (for narrowing-correctness tests) -------------

/**
 * Naïve all-pairs reference detector: tests every unordered pair with the same
 * U06 predicate and seam replication, with NO spatial index. Used by tests to
 * prove the indexed `detectTerminalOverlaps` returns the SAME set (受け入れ基準3:
 * 絞りが取りこぼさない) and to benchmark the predicate-call advantage (基準5).
 */
export function detectTerminalOverlapsNaive(
  terminals: readonly TerminalShape[],
  options: DetectOptions = {},
): OverlapPair[] {
  const seamTurns = options.seamTurns ?? DEFAULT_SEAM_TURNS;
  const counter = options.counter;
  const reported = new Map<string, OverlapPair>();

  for (let i = 0; i < terminals.length; i += 1) {
    const a = terminals[i];
    if (a === undefined) continue;
    // Same seam-continuity normalization as the indexed detector (M6) so the two
    // detectors test identical geometry (narrowing-correctness invariant).
    const aShape = seamContinuousShape(a.shape);
    if (multiPolygonBBox(aShape) === undefined) continue;
    for (let j = i + 1; j < terminals.length; j += 1) {
      const b = terminals[j];
      if (b === undefined) continue;
      const bShape = seamContinuousShape(b.shape);
      if (multiPolygonBBox(bShape) === undefined) continue;
      if (a.id === b.id) continue;

      // Test the identity A against every ±360° replica of B (and identity).
      let overlap: GeoMultiPolygon = EMPTY_MULTI_POLYGON;
      for (const turns of seamTurns) {
        const shiftedB = turns === 0 ? bShape : replicateShape(bShape, turns);
        if (counter !== undefined) counter.count += 1;
        const piece = overlapArea(aShape, shiftedB);
        if (piece !== undefined) {
          // Accumulate all pieces across replicas (片落とし禁止, 教訓5.1).
          overlap = [...overlap, ...piece];
        }
      }
      if (!isMultiPolygonEmpty(overlap)) {
        reported.set(pairKey(a.id, b.id), makePair(a.id, b.id, overlap));
      }
    }
  }
  return [...reported.values()];
}
