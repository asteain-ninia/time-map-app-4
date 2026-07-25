// U24 — THE rigid-move delta rule (FR-80 同一ベクトル / R3 seam), extracted so the
// two places that need it cannot drift (教訓 5.29 単一真実源):
//   - {@link moveDraggedVertexSet} (./move) applies it to produce the moved bodies;
//   - {@link constrainSetSlide} (./slide) measures the set's gesture vector with it
//     before scaling that vector down to the admissible intersection (N725-9).
//
// LONGITUDE is measured as the SHORTEST wrapped delta: a primary at 179.9° dragged to
// −179.9° has moved 0.2° east, not 359.8° west, and the companions must not be flung
// around the globe. The whole-turn verdict is compared with a HALF-PERIOD tolerance,
// NOT with `===`: `shortestLonDeltaDeg` folds through a modulo, so even a plainly
// in-range delta comes back a few ULPs off its raw self and an exact comparison would
// mistake that rounding for a seam crossing.
//
// Pure: no mutation, no globals.

import type { WorldCoordinate } from '../coordinate';
import { shortestLonDeltaDeg } from '../geo/longitude';
import { LONGITUDE_PERIOD } from '../geo/seam';

/** The one vector a rigid set move applies, plus whether the gesture wrapped the world. */
export interface RigidDelta {
  readonly dLon: number;
  readonly dLat: number;
  /**
   * True iff the RAW longitude delta carried a whole ±360° turn (the user grabbed a
   * wrap replica / dragged past the seam). Callers that place a point ABSOLUTELY must
   * then re-place it on the branch {@link dLon} names, so one feature never straddles
   * two ±360° frames (its bbox would degenerate to ~360° wide).
   */
  readonly wholeTurns: boolean;
}

/**
 * The displacement from `from` to `target` as ONE rigid vector.
 *
 * EXACTNESS in the overwhelmingly common case (|Δlon| ≤ 180): `dLon` is the RAW
 * difference — already the shortest one and bit-exact — so a caller that places the
 * primary at `target` verbatim and shifts companions by `dLon` moves them by exactly
 * the primary's own displacement.
 */
export function rigidMoveDelta(from: WorldCoordinate, target: WorldCoordinate): RigidDelta {
  const rawDLon = target.lon - from.lon;
  const wrappedDLon = shortestLonDeltaDeg(from.lon, target.lon);
  const wholeTurns = Math.abs(rawDLon - wrappedDLon) >= LONGITUDE_PERIOD / 2;
  return {
    dLon: wholeTurns ? wrappedDLon : rawDLon,
    dLat: target.lat - from.lat,
    wholeTurns,
  };
}
