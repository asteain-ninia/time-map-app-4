// U24 — edge slide: real-time collision detection + response for面頂点 editing
// (FR-28 / FR-89, 教訓5.38).
//
// LAYER: pure `domain` logic. The per-frame light path: it operates on already
// narrowed near-candidate boundary edges (the caller passes the edges the U10
// spatial index returned, spec §二段戦略) and uses ONLY U06's cheap geometric
// predicates (segment intersection / point-in-polygon). It never calls the
// boolean kernel — that is the confirm-time full integrity path (技術方針 R12).
//
// 教訓5.38 — detection and response are SEPARATE:
//   - DETECTION: does the START→TARGET *segment* cross a boundary edge? We test
//     the moved segment against every candidate edge (line-segment crossing), NOT
//     only "is the target point inside" (a fast move can tunnel through a thin
//     feature or hop a convex vertex with the target landing back outside — FR-28
//     尖り飛び越し). The first contact along the segment (smallest parameter t) is
//     the collision.
//   - RESPONSE: keep only the TANGENTIAL component of the remaining motion along
//     the contacted edge; drop the NORMAL (penetrating) component, so the vertex
//     slides along the edge.
//   - EXISTING CONTACT (t=0): a move starting already on an edge is NOT re-stopped
//     as a fresh collision; we drop the penetrating component and allow tangential
//     motion (教訓5.38「既存接触は止め直さない」).
//
// The slide is applied ITERATIVELY (a bounded number of passes) so a vertex that
// rounds a corner contacts the next edge and slides along it too (角を回り込む
// 連続接触, FR-28). Each pass re-narrows nothing (the caller supplies the candidate
// edge set once for the frame); convergence is by a small fixed iteration cap.

import type { WorldCoordinate } from '../coordinate';
import { quantizeCoordinate } from '../geometry/quantize';
import {
  pointInPolygon,
  POINT_LOCATION,
  segmentsIntersect,
  SEGMENT_RELATION,
} from '../geometry/predicates';
import type { GeoPolygon } from '../geometry/types';

/** One boundary edge of another terminal feature, with its owner's identity. */
export interface BoundaryEdge {
  /** Stable identity of the edge's owner terminal (for slide-boundary output). */
  readonly featureId: string;
  /** A stable key for the edge (e.g. `${ringId}:${i}`) for highlight identity. */
  readonly edgeKey: string;
  readonly a: WorldCoordinate;
  readonly b: WorldCoordinate;
}

/** A near-candidate terminal: its polygon (outer + holes) + identity, for the
 * point-in-polygon containment guard that backs detection at t=0 / endpoints. */
export interface CandidateTerminal {
  readonly featureId: string;
  readonly polygon: GeoPolygon;
}

/** The identifier of the boundary the vertex is sliding along (render highlight). */
export interface SlideBoundary {
  readonly featureId: string;
  readonly edgeKey: string;
}

/**
 * The result of constraining one proposed move (受け入れ基準6 / 7). When there is
 * no collision the position is the input target and `boundaries` is empty
 * (教訓5.18: empty is the real "no slide" value, never a null). When a collision
 * occurred the position is the slid (tangential) position and `boundaries` lists
 * every edge contacted during the slide so the render layer can highlight them.
 */
export interface SlideResult {
  readonly position: WorldCoordinate;
  readonly boundaries: readonly SlideBoundary[];
  /** True iff at least one collision constrained the move (for tests / UI). */
  readonly collided: boolean;
}

const EPS = 1e-9;
/** Iteration cap for chained corner slides (角を回り込む連続接触). */
const MAX_SLIDE_PASSES = 4;

function sub(a: WorldCoordinate, b: WorldCoordinate): { lon: number; lat: number } {
  return { lon: a.lon - b.lon, lat: a.lat - b.lat };
}
function add(a: WorldCoordinate, d: { lon: number; lat: number }): WorldCoordinate {
  return { lon: a.lon + d.lon, lat: a.lat + d.lat };
}
function dot(u: { lon: number; lat: number }, v: { lon: number; lat: number }): number {
  return u.lon * v.lon + u.lat * v.lat;
}
function len(u: { lon: number; lat: number }): number {
  return Math.hypot(u.lon, u.lat);
}

/**
 * The parameter t in [0,1] of the FIRST crossing of segment [start,target]
 * against edge [a,b], or undefined when the moved segment does not cross the edge.
 *
 * A `Proper` crossing (interiors meet) is always a contact. An `Endpoint` touch is
 * ALSO a contact when the touch point lies in the INTERIOR of the moved segment
 * (0 < t < 1): that is the 尖り飛び越し case (FR-28) where the path passes exactly
 * through a polygon VERTEX — both edges adjacent to the tip classify as Endpoint
 * (never Proper), so without this a tip lying on the path would let the vertex
 * tunnel straight across the other terminal's interior. An Endpoint touch at the
 * very start (t≈0, existing contact) or at the very target (t≈1) is NOT a fresh
 * crossing here — those are handled by the existing-contact / target-inside paths.
 * Collinear runs are likewise left to those paths. 教訓5.38.
 */
function crossingParameter(
  start: WorldCoordinate,
  target: WorldCoordinate,
  a: WorldCoordinate,
  b: WorldCoordinate,
): number | undefined {
  const rel = segmentsIntersect(start, target, a, b);
  const isProper = rel.relation === SEGMENT_RELATION.Proper;
  const isInteriorEndpoint = rel.relation === SEGMENT_RELATION.Endpoint;
  if ((!isProper && !isInteriorEndpoint) || rel.point === undefined) return undefined;
  const motion = sub(target, start);
  const motionLen2 = dot(motion, motion);
  if (motionLen2 < EPS) return undefined;
  // t = projection of (point - start) onto motion, normalized.
  const toPoint = sub(rel.point, start);
  const t = dot(toPoint, motion) / motionLen2;
  if (t < -EPS || t > 1 + EPS) return undefined;
  // For an endpoint touch, only count it as a fresh crossing when the touch lies
  // strictly INSIDE the moved segment (a tip on the path). A touch at the moved
  // segment's own start (existing contact) or target is excluded here.
  if (isInteriorEndpoint && (t <= EPS || t >= 1 - EPS)) return undefined;
  return Math.max(0, Math.min(1, t));
}

/** Project vector `v` onto the direction of edge [a,b] (the tangential part). */
function tangentialComponent(
  v: { lon: number; lat: number },
  a: WorldCoordinate,
  b: WorldCoordinate,
): { lon: number; lat: number } {
  const edge = sub(b, a);
  const edgeLen2 = dot(edge, edge);
  if (edgeLen2 < EPS) return { lon: 0, lat: 0 };
  const k = dot(v, edge) / edgeLen2;
  return { lon: edge.lon * k, lat: edge.lat * k };
}

interface Contact {
  readonly t: number;
  readonly edge: BoundaryEdge;
}

/** Find the earliest proper crossing of [start,target] among the candidate edges. */
function firstContact(
  start: WorldCoordinate,
  target: WorldCoordinate,
  edges: readonly BoundaryEdge[],
): Contact | undefined {
  let best: Contact | undefined;
  for (const edge of edges) {
    const t = crossingParameter(start, target, edge.a, edge.b);
    if (t === undefined) continue;
    if (best === undefined || t < best.t) best = { t, edge };
  }
  return best;
}

/** True iff `p` lies strictly inside any candidate terminal polygon (penetration). */
function isInsideAnyCandidate(
  p: WorldCoordinate,
  candidates: readonly CandidateTerminal[],
): CandidateTerminal | undefined {
  for (const c of candidates) {
    if (pointInPolygon(p, c.polygon) === POINT_LOCATION.Inside) return c;
  }
  return undefined;
}

/**
 * Find a boundary edge of `terminal` that `p` lies on, to use for the tangential
 * slide direction when the start point is ALREADY on (or inside) the candidate
 * (existing-contact / t=0 case, 教訓5.38). Returns the nearest edge by distance.
 */
function nearestEdgeOf(
  p: WorldCoordinate,
  terminal: CandidateTerminal,
  edges: readonly BoundaryEdge[],
): BoundaryEdge | undefined {
  let best: BoundaryEdge | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const edge of edges) {
    if (edge.featureId !== terminal.featureId) continue;
    const ab = sub(edge.b, edge.a);
    const ab2 = dot(ab, ab);
    const ap = sub(p, edge.a);
    const k = ab2 < EPS ? 0 : Math.max(0, Math.min(1, dot(ap, ab) / ab2));
    const closest = add(edge.a, { lon: ab.lon * k, lat: ab.lat * k });
    const d = len(sub(p, closest));
    if (d < bestDist) {
      bestDist = d;
      best = edge;
    }
  }
  return best;
}

export interface SlideInput {
  /** Where the dragged vertex started this frame (the previous accepted position). */
  readonly start: WorldCoordinate;
  /** The raw proposed target this frame (cursor world position). */
  readonly target: WorldCoordinate;
  /** Near-candidate boundary edges (U10-narrowed; the caller supplies them). */
  readonly edges: readonly BoundaryEdge[];
  /** Near-candidate terminal polygons for containment guards (U10-narrowed). */
  readonly candidates: readonly CandidateTerminal[];
}

/**
 * Constrain a proposed move so the dragged面 vertex never ends INSIDE another
 * terminal: detect the first boundary crossing along the start→target segment,
 * then slide the remaining motion tangentially along the contacted edge. Repeats
 * up to {@link MAX_SLIDE_PASSES} so rounding a corner contacts the next edge.
 *
 * Pure: no mutation of inputs. When nothing is contacted the target passes through
 * unchanged with an empty boundary list (受け入れ基準6 / 7 / 8 軽量判定).
 */
export function constrainSlide(input: SlideInput): SlideResult {
  const { edges, candidates } = input;
  const boundaries: SlideBoundary[] = [];
  let pos = input.start;
  let target = input.target;
  let collided = false;

  for (let pass = 0; pass < MAX_SLIDE_PASSES; pass += 1) {
    const motion = sub(target, pos);
    if (len(motion) < EPS) break;

    // EXISTING CONTACT (t=0): the start already lies inside / on a candidate. Do
    // not re-stop; drop the penetrating component, keep tangential (教訓5.38).
    const startInside = isInsideAnyCandidate(pos, candidates);
    if (startInside !== undefined) {
      const edge = nearestEdgeOf(pos, startInside, edges);
      if (edge === undefined) break; // no edge to slide along → cannot move safely.
      const tangent = tangentialComponent(motion, edge.a, edge.b);
      const slidTarget = add(pos, tangent);
      // If the tangential slide still lands inside, give up the rest of the motion
      // (a concave pocket): hold at the current position.
      if (isInsideAnyCandidate(slidTarget, candidates) !== undefined) break;
      collided = true;
      boundaries.push({ featureId: edge.featureId, edgeKey: edge.edgeKey });
      pos = slidTarget;
      break;
    }

    // FRESH CROSSING: earliest proper crossing of the moved segment.
    const contact = firstContact(pos, target, edges);
    if (contact === undefined) {
      // No crossing AND start outside: but guard against the target landing inside
      // via a path that only grazed (endpoint-touch). If the target is inside a
      // candidate, hold at the pre-target position (don't penetrate).
      if (isInsideAnyCandidate(target, candidates) !== undefined) {
        // Slide along the nearest candidate's edge instead of penetrating.
        const owner = isInsideAnyCandidate(target, candidates);
        const edge = owner === undefined ? undefined : nearestEdgeOf(pos, owner, edges);
        if (edge === undefined) {
          // Cannot resolve: stop short at current position.
          return { position: pos, boundaries, collided: collided || boundaries.length > 0 };
        }
        const tangent = tangentialComponent(sub(target, pos), edge.a, edge.b);
        const slidTarget = add(pos, tangent);
        collided = true;
        boundaries.push({ featureId: edge.featureId, edgeKey: edge.edgeKey });
        if (isInsideAnyCandidate(slidTarget, candidates) !== undefined) break;
        pos = slidTarget;
        break;
      }
      pos = target;
      break;
    }

    // Move up to (just before) the contact point, then slide the remainder.
    const motionToContact = { lon: motion.lon * contact.t, lat: motion.lat * contact.t };
    const contactPoint = add(pos, motionToContact);
    const remaining = sub(target, contactPoint);
    const tangent = tangentialComponent(remaining, contact.edge.a, contact.edge.b);
    collided = true;
    boundaries.push({ featureId: contact.edge.featureId, edgeKey: contact.edge.edgeKey });

    const newTarget = add(contactPoint, tangent);
    // GUARD (same as the existing-contact / target-inside branches): the tangential
    // slide along an OBLIQUE entry edge can land STRICTLY INSIDE a candidate when the
    // adjacent edge bends inward (a convex polygon with non-axis-aligned edges, e.g.
    // the diamond). Projecting onto the edge LINE keeps us on that line, but the line
    // re-enters the interior past the shared vertex. If the slid target is inside,
    // do NOT advance to it — hold at the contact point (which lies ON the boundary,
    // outside the strict interior) and stop. FR-28 / FR-89, 受け入れ基準6, 教訓5.38.
    if (isInsideAnyCandidate(newTarget, candidates) !== undefined) {
      pos = contactPoint;
      break;
    }
    // Continue from the contact point toward the tangential target next pass so a
    // corner can chain to the next edge.
    pos = contactPoint;
    target = newTarget;
  }

  // FINAL INVARIANT re-check (技術方針 R2「判定後に不変条件を再チェック」): whatever the
  // path above produced, the committed position must never be strictly inside any
  // candidate terminal (FR-28 / FR-89, 受け入れ基準6). If a residual numeric edge
  // case slips through, fall back to the last position known to be outside — the
  // original start is always outside by precondition (the previous accepted frame),
  // so it is the safe last resort.
  if (isInsideAnyCandidate(pos, candidates) !== undefined) {
    pos = input.start;
  }

  return {
    position: quantizeCoordinate(pos),
    boundaries,
    collided: collided || boundaries.length > 0,
  };
}
