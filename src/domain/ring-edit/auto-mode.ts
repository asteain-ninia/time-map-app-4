// U25 — first-click hole/enclave auto-detection (FR-22).
//
// LAYER: pure `domain` logic. The hole/enclave add tool decides, from the FIRST
// click position, whether the user is creating a HOLE (a click inside the target
// face's solid fill) or an ENCLAVE / 飛び地 (a click outside the solid — outside
// the face, or inside one of its holes). This is the single自動判定 of FR-22.
//
// 単一の真実源 (技術方針 §4 / spec §依存): the point-in-ring判定 is delegated to
// U06's {@link pointInPolygon} (re-used via U07's geometry barrel). This unit does
// NOT re-implement any inside/outside predicate — it only COMPOSES the per-ring
// answers into "inside the solid fill" by the territory↔hole alternation U07 owns.
//
// 対概念へ判断を反映 (教訓 2.10): "hole mode" and "enclave mode" are the two
// outcomes of ONE classification; we compute the solid-fill membership once and
// return the matching mode, so neither branch can be defined without the other.
//
// Coordinates are resolved + quantized + seam-unwrapped exactly as U07 does for
// its own geometry (R2 / R3 防御層) so the classification matches the validation
// the rest of the unit runs (no divergent geometry — 教訓 5.26 趣旨).

import type { WorldCoordinate } from '../coordinate';
import { unwrapRing } from '../geo/index';
import {
  pointInPolygon,
  POINT_LOCATION,
  quantizeCoordinate,
  type GeoPolygon,
  type GeoRing,
} from '../geometry/index';
import { childrenOf } from '../ring-hierarchy';
import { RING_KIND, type Ring, type Shape } from '../ring';
import { getVertex, type VertexStore } from '../vertex';

/**
 * The two modes the FR-22 add tool auto-selects from the first click. Modeled as
 * a discriminated constant (教訓 5.19) so create / preview / confirm branch on one
 * value, never a bare string.
 */
export const RING_ADD_MODE = {
  /** First click landed in the face's solid fill → punch a HOLE. */
  Hole: 'hole',
  /** First click landed outside the solid (outside the face, or in a hole) → add an ENCLAVE (飛び地). */
  Enclave: 'enclave',
} as const;

export type RingAddMode = (typeof RING_ADD_MODE)[keyof typeof RING_ADD_MODE];

/**
 * Resolve a ring's vertex IDs to a quantized, seam-unwrapped world ring for the
 * point test — the SAME pipeline U07 uses (`unwrapRing` then `quantizeCoordinate`)
 * so detection and validation agree. Returns undefined when any vertex id is
 * missing from the store (an unresolvable ring is skipped, not silently emptied).
 */
function resolveRing(store: VertexStore, ring: Ring): GeoRing | undefined {
  const representative: WorldCoordinate[] = [];
  for (const vid of ring.vertexIds) {
    const vertex = getVertex(store, vid);
    if (vertex === undefined) return undefined;
    representative.push(vertex.coordinate);
  }
  return unwrapRing(representative).map((c) => quantizeCoordinate(c));
}

/**
 * True iff `point` lies strictly within `ring`'s solid (inside, not merely on its
 * boundary). Boundary contact is NOT "inside the fill" — a first click exactly on
 * an edge is treated as outside the solid, so it starts an enclave rather than an
 * ambiguous hole (consistent with U06's boundary-contact convention).
 */
function strictlyInsideRing(point: WorldCoordinate, ring: GeoRing): boolean {
  const poly: GeoPolygon = [ring];
  return pointInPolygon(quantizeCoordinate(point), poly) === POINT_LOCATION.Inside;
}

/**
 * Whether `point` is inside the SOLID FILL of `shape`: strictly inside some
 * territory ring AND not strictly inside any hole punched into that territory.
 * This is the territory↔hole alternation applied at depth: a point inside a
 * top-level territory but inside one of its holes is NOT solid (it is the hole's
 * void); a point inside an enclave territory that sits within that hole IS solid
 * again. We walk only ONE level of holes per territory because a hole's own
 * children are enclave territories whose solidity is decided when we visit THEM
 * as territory rings in the outer loop (every territory ring is considered).
 *
 * Returns true as soon as any territory claims the point as solid (教訓 5.18:
 * decided by explicit membership over the ring set, never a falsy short-circuit;
 * "0 territories" / "0 holes" are handled by the loops yielding false / true).
 */
export function isPointInSolidFill(
  shape: Shape,
  store: VertexStore,
  point: WorldCoordinate,
): boolean {
  for (const ring of shape.rings) {
    if (ring.kind !== RING_KIND.Territory) continue;
    const territoryGeo = resolveRing(store, ring);
    if (territoryGeo === undefined) continue;
    if (!strictlyInsideRing(point, territoryGeo)) continue;

    // Inside this territory's outer boundary. It is solid UNLESS the point falls
    // strictly inside one of this territory's direct hole children (the void).
    let inAHole = false;
    for (const child of childrenOf(shape, ring.id)) {
      if (child.kind !== RING_KIND.Hole) continue;
      const holeGeo = resolveRing(store, child);
      if (holeGeo === undefined) continue;
      if (strictlyInsideRing(point, holeGeo)) {
        inAHole = true;
        break;
      }
    }
    if (!inAHole) return true;
    // The point is in this territory's hole: keep scanning — an enclave territory
    // that nests inside that hole (a deeper territory ring) may re-claim it as
    // solid, and it is visited as its own territory ring in this same loop.
  }
  return false;
}

/**
 * Classify the FIRST click of the FR-22 add tool against the target face's shape
 * at the editing-base time. A click in the solid fill ⇒ hole mode; anything else
 * (outside the face, on a boundary, or inside a hole) ⇒ enclave mode. The two
 * modes are the complete partition of the plane (対概念 — 教訓 2.10): there is no
 * third outcome and neither branch is omitted.
 *
 * The caller passes the shape resolved AT the current timeline time (FR-57 /
 * 教訓 5.15): time fixes which anchor's rings are tested, so classification at a
 * different time can differ — this function never reads the system clock.
 */
export function classifyFirstClick(
  shape: Shape,
  store: VertexStore,
  firstClick: WorldCoordinate,
): RingAddMode {
  return isPointInSolidFill(shape, store, firstClick)
    ? RING_ADD_MODE.Hole
    : RING_ADD_MODE.Enclave;
}
