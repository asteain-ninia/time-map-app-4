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
import { unwrapClosedLonSequence, unwrapLonSequence, wrapLonDeg } from './longitude';

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
  //
  // This is the OPEN unwrap (anchored at the first vertex; every STORED adjacent gap
  // ≤ 180): its per-vertex output and first-vertex identity are a contract many
  // consumers rely on (spatial bbox, hit-test span, the round-trip rewrap). The
  // CLOSED-edge generalization (audit root cause B — making the implicit last→first
  // edge continuous too) is the job of {@link unwrapRingClosed}, used by the
  // boolean-op / area paths that actually close the ring; it must NOT silently
  // change `unwrapRing`'s open-sequence semantics.
  const unwrappedLons = unwrapLonSequence(ring.map((c) => c.lon));
  return ring.map((c, i) => createCoordinate(unwrappedLons[i]!, c.lat));
}

/**
 * Unwrap a CLOSED ring so it is continuous across the implicit closing edge
 * (last → first) as well as every interior edge (audit root cause B). Unlike
 * {@link unwrapRing}, this does NOT keep the first vertex's stored value or the
 * "every STORED adjacent gap ≤ 180" open-sequence shape: it chooses the cyclic
 * rotation whose continuous run has the smallest longitude span, which removes the
 * artificial ~360° jump an unlucky start vertex pushes into the closing edge while
 * preserving the ring's genuine net winding (a pole-encircling ring keeps its
 * >360° span). It then re-anchors the whole run by whole ±360° turns so its first
 * vertex lands on the SAME branch the open unwrap would have given it (keeping the
 * result near the stored representatives for downstream quantization).
 *
 * Use this — not {@link unwrapRing} — wherever the ring is fed to shoelace area or
 * polygon clipping, so a representative ring whose first vertex is not at the seam
 * crossing (e.g. [0, 120, -120]) is not mis-built with a spurious closing-edge
 * span. The ±360° turn-counting itself is NOT re-implemented here; it lives in
 * `unwrapClosedLonSequence` (单一真实源). Input never mutated.
 */
export function unwrapRingClosed(ring: readonly WorldCoordinate[]): WorldCoordinate[] {
  const continuous = unwrapClosedLonSequence(ring.map((c) => c.lon));
  const first = ring[0];
  const c0 = continuous[0];
  const anchored =
    first === undefined || c0 === undefined
      ? continuous
      : shiftWholeTurns(continuous, anchorLonToRef(c0, first.lon) - c0);
  return ring.map((c, i) => createCoordinate(anchored[i]!, c.lat));
}

/** Shift every value by a whole number of ±360° turns equal to the given (already
 * whole-turn) delta, keeping the run continuous (all values move by the same
 * amount). A non-whole `rawDelta` is rounded to the nearest turn. */
function shiftWholeTurns(lons: readonly number[], rawDelta: number): number[] {
  const turns = Math.round(rawDelta / LONGITUDE_PERIOD);
  if (turns === 0) return [...lons];
  const delta = turns * LONGITUDE_PERIOD;
  return lons.map((v) => v + delta);
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

// ---------------------------------------------------------------------------
// Cross-ring world-turn alignment — THE single source of truth (audit root cause
// A). Per-ring `unwrapRing` anchors each ring to its OWN first vertex, so two
// independently-unwrapped rings (a hole vs its parent, an aggregate's two children,
// the outer ring vs an enclave) are NOT guaranteed to share a world turn: rings
// whose vertex lists start on opposite seam sides land ~360° apart even though they
// coincide geometrically (the latent R3 bug ring-hierarchy.ts塞いだ). Every consumer
// that compares / combines rings across the seam (ring-hierarchy, drill, aggregate
// union, the display unwrap) MUST align them through THESE helpers first, rather
// than re-deriving any ±360° folding (单一真实源 §4 / §5.30).
// ---------------------------------------------------------------------------

/**
 * Shift `lon` by the whole number of ±360° turns that lands it on the SAME branch
 * as `ref` — i.e. the representative of `lon` closest to `ref` (within
 * (ref-180, ref+180]). Pure. This is the scalar primitive every ring/multi-polygon
 * alignment below is built from.
 */
export function anchorLonToRef(lon: number, ref: number): number {
  if (!Number.isFinite(lon) || !Number.isFinite(ref)) return lon;
  const turns = Math.round((ref - lon) / LONGITUDE_PERIOD);
  return lon + turns * LONGITUDE_PERIOD;
}

/** Mean longitude of a continuous (already-unwrapped) ring; 0 for an empty ring
 * (lesson 5.18: length-decided). The mean — not the first vertex — is the ring's
 * anchor so a ring WIDER than 180° is placed onto the branch nearest its CENTROID,
 * not nearest an arbitrary corner that could pull the whole ring a turn away
 * (Codex root-cause review #2: first-vertex anchoring breaks >180° rings). */
function ringLonMean(ring: readonly WorldCoordinate[]): number {
  if (ring.length === 0) return 0;
  let sum = 0;
  for (const c of ring) sum += c.lon;
  return sum / ring.length;
}

/**
 * Make a ring self-continuous ({@link unwrapRingClosed}) and then shift the WHOLE
 * ring by whole ±360° turns so its MEAN longitude sits on the branch of `ref`. This
 * anchors every ring of a multi-ring shape onto ONE common longitude branch so
 * cross-ring geometry (containment, union, difference, intersection, bbox) runs in a
 * single continuous frame.
 *
 * Anchoring by the ring's MEAN (not its first vertex) is load-bearing for rings that
 * span more than 180° (Codex review #2): a region at lon 220..230 inside an outer
 * ring spanning 0..240 has a first vertex (~220, stored −140) that, anchored to
 * reference 0, would be pulled to −140 while the outer stays at 0..240 — breaking
 * containment. Anchoring the region by its mean (~225) keeps it on the outer's
 * branch. For inputs already on a single representative branch (the common, non-seam
 * case) the unwrap is the identity and the anchor adds 0 turns, so behaviour is
 * unchanged. The input is never mutated.
 */
export function unwrapRingAnchored(
  ring: readonly WorldCoordinate[],
  ref: number,
): WorldCoordinate[] {
  // The CLOSED unwrap (root cause B): these alignment helpers feed boolean ops,
  // shoelace area and hole/enclave containment — all of which CLOSE the ring — so a
  // ring whose first vertex is not at the seam crossing must be continuous across
  // its closing edge, not just its interior edges.
  const continuous = unwrapRingClosed(ring);
  if (continuous.length === 0) return continuous;
  const mean = ringLonMean(continuous);
  const shift = anchorLonToRef(mean, ref) - mean;
  if (shift === 0) return continuous;
  return continuous.map((c) => createCoordinate(c.lon + shift, c.lat));
}

/**
 * The reference longitude a whole multi-polygon is anchored to: the MEAN longitude
 * of the first piece's outer ring, made self-continuous (so the reference reflects
 * the whole extent of a >180° outer ring, not an arbitrary corner — Codex review
 * #2). Defaults to 0 for an empty multi-polygon (lesson 5.18: length-decided, never
 * a falsy default; the identity alignment results).
 */
export function referenceLonForMultiPolygon(
  mp: readonly (readonly (readonly WorldCoordinate[])[])[],
): number {
  const outer = mp[0]?.[0];
  if (outer === undefined || outer.length === 0) return 0;
  return ringLonMean(unwrapRingClosed(outer));
}

/**
 * Align every ring of a multi-polygon onto the common branch `ref` (defaulting to
 * the multi-polygon's own outer-ring reference). The single helper drill, the
 * aggregate union, and the display unwrap all funnel their per-ring unwrap through,
 * so a seam-crossing outer ring, its holes, and its enclaves never land a world
 * turn apart (audit root cause A). Pieces are kept intact (教訓5.1) — no ring is
 * merged or dropped. The input is never mutated.
 */
export function alignMultiPolygon(
  mp: readonly (readonly (readonly WorldCoordinate[])[])[],
  ref: number = referenceLonForMultiPolygon(mp),
): WorldCoordinate[][][] {
  return mp.map((poly) => poly.map((ring) => unwrapRingAnchored(ring, ref)));
}
