// Periodic-seam (±360°) ring continuation, inverse normalization and world-wrap
// replication (U05; tech policy R3, FR-07 / FR-12).
//
// This is the domain's single source of truth for treating *rings* (closed
// vertex sequences) across the longitude seam, so that downstream consumers
// (geometric predicates, boolean ops, exclusion checks, spatial index) can
// operate on continuous coordinates without re-deriving any ±360° logic
// themselves (开发ガイド §4 单一真実源 / §5.30 過少共有の戒め).
//
// It is layered strictly on the scalar primitives in `./longitude` (U04's
// `wrapLonDeg` = the representative [-180, 180) fold, `shortestLonDeltaDeg` =
// the minimal-direction step). We do NOT re-implement seam detection or ±360°
// folding here — there is exactly one such implementation, reused (避免 drift).
//
// Latitude is never wrapped (过剰共有の戒め): the equirectangular projection
// (FR-05) treats latitude as a non-periodic coordinate, passed through verbatim.
//
// All functions are pure: inputs are never mutated, new values are returned
// (lesson 5.17), and the same input always yields the same output.

import { coordinatesEqual, createCoordinate, type WorldCoordinate } from '../coordinate';
import { unwrapLonSequence, wrapLonDeg } from './longitude';

/** Full periodic span of longitude (degrees). One world turn. */
export const LONGITUDE_PERIOD = 360;

/**
 * Normalize a single coordinate's longitude into the representative half-open
 * interval [-180, +180); latitude is passed through untouched (no latitude
 * periodicity, per FR-05). Delegates the fold to U04's `wrapLonDeg` so the
 * boundary convention (+180 -> -180, -180 stays -180) lives in exactly one
 * place.
 *
 * Returns a new coordinate; the input is never mutated.
 */
export function normalizeCoordinate(coord: WorldCoordinate): WorldCoordinate {
  // Fail loudly on a corrupt coordinate rather than letting the modulo fold
  // silently propagate NaN/Infinity into downstream geometry (病的入力の落とし穴).
  if (!Number.isFinite(coord.lon)) {
    throw new RangeError(
      `normalizeCoordinate: longitude must be finite, got ${coord.lon}`,
    );
  }
  return createCoordinate(wrapLonDeg(coord.lon), coord.lat);
}

/** True iff every coordinate's longitude is already in [-180, +180). */
export function isRepresentativeRing(ring: readonly WorldCoordinate[]): boolean {
  for (const c of ring) {
    if (!(c.lon >= -180 && c.lon < 180)) {
      return false;
    }
  }
  return true;
}

/**
 * Unwrap a ring (closed vertex sequence) into a *continuous* longitude run.
 *
 * Each vertex after the first is offset by a whole number of ±360° turns so that
 * the step from the previous vertex is the shortest signed delta. After
 * unwrapping, every adjacent longitude difference is at most 180° in magnitude,
 * and strictly less than 180° unless the two vertices are *exactly antipodal*
 * (criterion 2: the ring forms a single, undivided continuous path). The
 * antipodal case (e.g. a vertex at 0° immediately followed by one at ±180°) is
 * genuinely 180° apart in *either* unwinding direction — no offset can shrink it
 * below 180° — so it is the unavoidable boundary of the invariant, not a seam
 * crossing that should be reduced. Latitude is copied verbatim.
 *
 * Single source of truth (技術方針 R3 / 単一真実源 §4 / §5.30): the ±360°
 * turn-counting algorithm is NOT re-implemented here. This function delegates the
 * longitude unwrap to U04's `unwrapLonSequence` (the one canonical implementation)
 * and simply re-pairs each continuous longitude with its original latitude. Any
 * fix to the unwrap rule (e.g. the antipodal float-spill correction) therefore
 * lives in exactly one place and cannot drift between a ring copy and a sequence
 * copy.
 *
 * Float-error discipline (技術方針 R2 / spec §量子化との整合) is enforced inside
 * `unwrapLonSequence`: each vertex is placed at `previousUnwrapped + clampedStep`,
 * where the step is the canonical shortest delta whose magnitude is bounded at
 * exactly 180°. This makes each adjacent gap exactly the bounded step magnitude,
 * so a near-antipodal pair yields a gap of exactly 180° rather than spilling to
 * 180.00000000000003 (which the older `lon + turns * 360` formulation did).
 *
 * Degenerate rings (0, 1 or 2 vertices) are returned with longitudes made
 * continuous the same way; emptiness is decided by length, never by a falsy
 * short-circuit (lesson 5.18). The input array is never mutated.
 */
export function unwrapRing(ring: readonly WorldCoordinate[]): WorldCoordinate[] {
  // Delegate the ±360° unwrap to the single scalar implementation, then zip the
  // continuous longitudes back with the verbatim latitudes (lat is never wrapped).
  const unwrappedLons = unwrapLonSequence(ring.map((c) => c.lon));
  return ring.map((c, i) => createCoordinate(unwrappedLons[i]!, c.lat));
}

/**
 * Inverse of {@link unwrapRing}: fold each continuous longitude back into the
 * representative interval [-180, +180), per vertex. Latitude is passed through.
 *
 * Round-trip invariant (criterion 3): for any ring whose longitudes are already
 * representative, `rewrapRing(unwrapRing(ring))` equals the input vertex-for-
 * vertex (under coordinate value equality), because unwrapping only adds whole
 * ±360° turns and rewrapping removes exactly those turns. The same holds after
 * an identity geometric operation between the two steps.
 *
 * The input array is never mutated.
 */
export function rewrapRing(ring: readonly WorldCoordinate[]): WorldCoordinate[] {
  return ring.map((c) => normalizeCoordinate(c));
}

/**
 * The maximum adjacent-vertex longitude gap magnitude in a ring (treating the
 * ring as the given sequence, not closing first → last). Used by tests to
 * assert that an unwrapped ring is continuous (every gap < 180°). A ring with
 * fewer than 2 vertices has no gaps and returns 0.
 */
export function maxAdjacentLonGap(ring: readonly WorldCoordinate[]): number {
  let max = 0;
  for (let i = 1; i < ring.length; i++) {
    // noUncheckedIndexedAccess: both reads are within [0, length), but the
    // compiler still types them as possibly-undefined, so we guard.
    const prev = ring[i - 1];
    const cur = ring[i];
    if (prev === undefined || cur === undefined) {
      continue;
    }
    const gap = Math.abs(cur.lon - prev.lon);
    if (gap > max) {
      max = gap;
    }
  }
  return max;
}

/**
 * A world-wrap replica: a ring whose longitudes have all been shifted by a whole
 * number of ±360° turns, tagged with that turn count so the post-processing step
 * can fold it back. `turns === 0` is the identity replica (kept, never dropped —
 * lesson 5.18: a zero offset is a real value).
 */
export interface WrapReplica {
  /** Number of full ±360° turns added to every longitude of this replica. */
  readonly turns: number;
  /** The ring with `turns * 360` added to each longitude. */
  readonly ring: readonly WorldCoordinate[];
}

/** Shift every longitude of a ring by `turns * 360`; latitude unchanged. */
function shiftRing(ring: readonly WorldCoordinate[], turns: number): WorldCoordinate[] {
  if (turns === 0) {
    return ring.map((c) => createCoordinate(c.lon, c.lat));
  }
  const delta = turns * LONGITUDE_PERIOD;
  return ring.map((c) => createCoordinate(c.lon + delta, c.lat));
}

/**
 * Generate ±360° world-wrap replicas of a ring for boolean ops / exclusion /
 * spatial overlap pre-processing (criterion 4 / 5). For each turn count in
 * `turns` (default {-1, 0, +1}, i.e. west / identity / east) a replica is
 * produced, so two ring sets that should overlap across the seam can be aligned
 * in one continuous coordinate system.
 *
 * The replicas are a *temporary* coordinate-system alignment: every replica must
 * be carried through to post-processing and folded back (rewrapped) — the caller
 * must not keep only the first replica (lesson 5.1: set ops yield multiple
 * pieces; do not drop pieces). An empty `turns` list yields no replicas and is a
 * valid (true) result, not an error (lesson 5.18).
 *
 * The input ring is never mutated.
 */
export function worldWrapReplicas(
  ring: readonly WorldCoordinate[],
  turns: readonly number[] = [-1, 0, 1],
): WrapReplica[] {
  return turns.map((t) => ({ turns: t, ring: shiftRing(ring, t) }));
}

/**
 * Post-processing companion to {@link worldWrapReplicas}: fold every replica's
 * ring back into the representative interval. All replicas are processed (no
 * piece is dropped, lesson 5.1); the result is one rewrapped ring per replica,
 * in input order.
 */
export function rewrapReplicas(replicas: readonly WrapReplica[]): WorldCoordinate[][] {
  return replicas.map((r) => rewrapRing(r.ring));
}

/**
 * Whether two rings, once aligned in a common *continuous* coordinate system via
 * ±360° replicas, share any vertex. This is the minimal "do these overlap across
 * the seam?" wiring used by the contract test (criterion 5): it proves a consumer
 * can decide overlap *using only this module's primitives*, with no external seam
 * logic.
 *
 * The alignment happens in continuous space, which is the whole point of the
 * world-wrap machinery (技術方針 R3). Each ring is first unwrapped into a single
 * continuous longitude run; then `a` is held fixed while every ±360° replica of
 * the continuous `b` (across the given turns) is tested against it. A vertex of
 * `a` and a vertex of a replica coincide when their *continuous* coordinates are
 * equal — so a vertex stored near +179 and one stored near −181 (the same point
 * one world-turn away) are recognised as the same vertex via the +1 replica.
 *
 * Crucially the comparison is NOT done after folding the replicas back to the
 * representative interval: folding is periodic mod 360, so `rewrap(shift(x, k·360))
 * === rewrap(x)` for every k, which would collapse all replicas to one ring and
 * make the ±360° offsets inert (dead code). Comparing the *shifted* continuous
 * coordinates keeps the offsets load-bearing: changing the `turns` set changes
 * the result for cross-seam inputs.
 *
 * Returns true on the first shared continuous vertex found.
 */
export function ringsShareVertexAcrossSeam(
  a: readonly WorldCoordinate[],
  b: readonly WorldCoordinate[],
  turns: readonly number[] = [-1, 0, 1],
): boolean {
  const baseA = unwrapRing(a);
  const baseB = unwrapRing(b);
  // ±360° replicas of B's continuous run; each replica is compared in continuous
  // space (no rewrap) so the world-turn offset actually shifts the coordinates.
  for (const replica of worldWrapReplicas(baseB, turns)) {
    for (const ca of baseA) {
      for (const cb of replica.ring) {
        if (coordinatesEqual(ca, cb)) {
          return true;
        }
      }
    }
  }
  return false;
}
