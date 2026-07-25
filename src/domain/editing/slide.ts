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

import { createCoordinate, type WorldCoordinate } from '../coordinate';
import { quantizeCoordinate, quantizeScalar } from '../geometry/quantize';
import { rigidMoveDelta } from './rigid-delta';
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

/**
 * The INVERSE containment constraint for a hole-ring / enclave vertex of the
 * dragged feature itself (受け入れ基準6 第4項 / FR-89). Where {@link CandidateTerminal}
 * forbids the vertex from entering ANOTHER terminal, this REQUIRES the vertex to
 * stay inside its OWN parent territory (the parent ring it lives within) and never
 * cross that parent's outer boundary:
 *   - a HOLE vertex must remain inside the territory the hole is punched into;
 *   - an ENCLAVE (飛び地) territory vertex nested inside a hole must remain inside
 *     that hole's solid region.
 *
 * The judgement is delegated to U07's geometry semantics: the moved vertex is
 * "contained" iff U07's {@link pointInPolygon} reports it Inside or on the Boundary
 * of {@link polygon} (the parent territory ring, optionally with its own inner
 * holes carved out), and the start→target motion does not properly cross any of
 * those boundary edges. The caller supplies the parent ring resolved through the
 * SAME U07 pipeline (ring-hierarchy.validateGeometry uses the identical predicate),
 * so the editing layer reuses U07's containment predicate rather than inventing a
 * second source of truth (層境界結線, spec §依存 U07).
 */
export interface ParentContainment {
  /** The owning feature (the dragged feature itself) — for boundary highlight identity. */
  readonly featureId: string;
  /**
   * The parent territory ring (index 0 = outer boundary the vertex must stay
   * inside; indices 1.. = inner holes the vertex must stay OUT of). For a hole
   * vertex this is the parent territory; for an enclave vertex this is the
   * enclosing hole, modelled as the region the enclave must remain within.
   */
  readonly polygon: GeoPolygon;
  /**
   * The boundary edges of {@link polygon} (outer + any inner holes), keyed for
   * highlight identity, so a slide along the parent boundary can be rendered the
   * same way as a slide along another terminal's boundary.
   */
  readonly edges: readonly BoundaryEdge[];
  /**
   * (N725-9 必須1-c) The parent region as a function of the SET-DELTA OFFSET applied to the
   * moving vertices: the COMMITTED parent ring with every vertex that moves with the gesture
   * translated by `offset`, and stationary vertices left in place. Present only on a
   * COMPANION's containment (the per-frame neighbour query knows which parent vertices are in
   * the moving set); absent on a single-point slide, where {@link polygon} is the fixed shape.
   *
   * WHY IT EXISTS: {@link polygon} is baked at the FULL set delta. Using it for the
   * point-in-polygon containment test while the admissible scale is STILL being searched
   * judged a companion against a parent already collapsed to its end-of-frame shape — so a
   * companion whose committed position is legally inside the committed parent read Outside a
   * shrunken full-delta parent and FALSELY abstained, dragging its FR-28 obstacle check down
   * with it (N725-9 敵対レビュー HIGH「棄権の巻き添え」). Evaluated at the SAME offset the point
   * is placed at, the premise holds at offset 0 and the constraint stays exact along the ray.
   *
   * The analytic {@link edges} are NOT rebuilt: the caller supplies only edges between two
   * STATIONARY parent vertices (incident-to-moving edges are dropped by the HB4-2 filter), so
   * their geometry is offset-independent and {@link firstContact} against them stays valid.
   */
  readonly regionAtScaledDelta?: (offset: { readonly lon: number; readonly lat: number }) => GeoPolygon;
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
/**
 * The SQUARED-length degeneracy tolerance — the square of {@link EPS}, used wherever
 * a value compared against the threshold is itself a squared magnitude (`dot(v, v)`),
 * NOT a true length. {@link EPS} is a length tolerance (compared against `len(...)`);
 * comparing a squared length against `EPS` directly would mis-apply the tolerance at
 * its square root, so any edge/motion shorter than sqrt(EPS)=3.16e-5 deg (~3.5 m)
 * was wrongly treated as degenerate. Coordinates are quantized to a 1e-7 grid, so
 * real short edges (1e-6..1e-5 deg) are legitimate; they must NOT degenerate. Using
 * `EPS2 = EPS*EPS = 1e-18` makes the squared-length checks degenerate-equivalent to
 * the length checks (a true length below EPS ⇔ its square below EPS2), so a short but
 * real edge yields a proper tangential slide instead of a silent zero/undefined.
 * 単一真実源: one length tolerance, its square for squared comparisons.
 */
const EPS2 = EPS * EPS;
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
  if (motionLen2 < EPS2) return undefined;
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
  if (edgeLen2 < EPS2) return { lon: 0, lat: 0 };
  const k = dot(v, edge) / edgeLen2;
  return { lon: edge.lon * k, lat: edge.lat * k };
}

interface Contact {
  readonly t: number;
  readonly edge: BoundaryEdge;
}

/** Find the earliest proper crossing of [start,target] among the candidate edges.
 *
 * SPECULATIVE (N725-9 敵対レビュー, 挙動継承): a segment that ENTERS a candidate exactly through
 * a vertex (an Endpoint touch, excluded at t≈0/1) and EXITS through an edge interior (a Proper
 * crossing) is detected by the Proper exit, so the set path handles it identically to the
 * single-vertex {@link constrainSlide}. This mixed entry/exit case is therefore INHERITED, not
 * newly reasoned for the set — its correctness is exactly the single-vertex one, no more.
 */
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
    const k = ab2 < EPS2 ? 0 : Math.max(0, Math.min(1, dot(ap, ab) / ab2));
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
  /**
   * INVERSE containment for a hole/enclave vertex of the dragged feature: the
   * vertex must stay inside this parent region and never cross its outer boundary
   * (受け入れ基準6 第4項 / FR-89, judged via U07's containment predicate). Absent
   * for a plain outer-ring / line / point vertex that has no parent ring to stay
   * within (受け入れ基準8 軽量 passthrough — nothing extra to check).
   */
  readonly containment?: ParentContainment;
}

/**
 * True iff `p` is OUTSIDE the parent containment region — i.e. it left the parent
 * territory (strictly outside the outer ring) OR entered one of the parent's inner
 * holes. Judged entirely through U07's {@link pointInPolygon} (single source of
 * truth): only a strict `Outside` is a violation; a point ON the boundary is still
 * legally contained (境界接触は外周非交差に含めない, matching FR-25 boundary conventions).
 */
function isOutsideContainment(p: WorldCoordinate, containment: ParentContainment): boolean {
  return pointInPolygon(p, containment.polygon) === POINT_LOCATION.Outside;
}

/**
 * Constrain the proposed move so a hole/enclave vertex stays inside its parent
 * region (受け入れ基準6 第4項 / FR-89). DETECTION ≠ RESPONSE, the mirror of the
 * other-terminal logic (教訓5.38): if the moved segment would exit the parent
 * outer boundary (or enter a parent hole), slide the remaining motion tangentially
 * along the contacted parent boundary edge; if even the tangential slide lands
 * outside (a concave parent corner), hold at the contact point. Repeats up to
 * {@link MAX_SLIDE_PASSES} so rounding a parent corner chains to the next edge.
 *
 * Pure. Returns the constrained position and every parent boundary edge contacted.
 */
function constrainWithinParent(
  start: WorldCoordinate,
  rawTarget: WorldCoordinate,
  containment: ParentContainment,
  candidates: readonly CandidateTerminal[],
): { position: WorldCoordinate; boundaries: SlideBoundary[]; collided: boolean } {
  const boundaries: SlideBoundary[] = [];
  let pos = start;
  let target = rawTarget;
  let collided = false;

  // The containment slide must NEVER relocate the vertex into another terminal
  // (受け入れ基準6 / FR-28): a slide candidate is acceptable only if it is neither
  // outside the parent NOR strictly inside any other terminal. `start` is safe by
  // precondition, so any unsafe slide result falls back to the last safe pos.
  const isSafe = (p: WorldCoordinate): boolean =>
    !isOutsideContainment(p, containment) && isInsideAnyCandidate(p, candidates) === undefined;

  for (let pass = 0; pass < MAX_SLIDE_PASSES; pass += 1) {
    const motion = sub(target, pos);
    if (len(motion) < EPS) break;

    // The proposed target is still inside the parent AND not inside another terminal:
    // no exit, accept it directly.
    if (!isOutsideContainment(target, containment)) {
      if (isInsideAnyCandidate(target, candidates) === undefined) {
        pos = target;
      }
      // If the target reads contained-but-inside-another-terminal, the other-terminal
      // pass already produced the safe `pos`; do not advance into the candidate.
      break;
    }

    // The motion exits the parent region: find the first parent-boundary crossing
    // and slide the remainder tangentially along that edge.
    const contact = firstContact(pos, target, containment.edges);
    if (contact === undefined) {
      // No proper crossing yet the target reads outside. This is the graze / denormal
      // case (e.g. the target lands essentially ON the parent boundary line and reads
      // Outside without a PROPER crossing). DO NOT slide the full remaining motion
      // along an edge chosen by distance-to-START — that can teleport the vertex clear
      // across the parent into another terminal (the U24 fuzz CEX). Instead keep the
      // largest prefix of pos→target that stays SAFE (contained AND outside every
      // other terminal); if no prefix beyond pos is safe, hold at pos.
      const safePrefix = largestSafePrefix(pos, target, isSafe);
      if (safePrefix !== undefined && len(sub(safePrefix, pos)) > EPS) {
        collided = true;
        const edge = nearestParentEdge(safePrefix, containment.edges);
        if (edge !== undefined) {
          boundaries.push({ featureId: edge.featureId, edgeKey: edge.edgeKey });
        }
        pos = safePrefix;
      }
      break;
    }

    const motionToContact = { lon: motion.lon * contact.t, lat: motion.lat * contact.t };
    // The raw contact point can land a hair OUTSIDE the parent boundary from
    // floating-point error in the crossing parameter; for a containment boundary
    // (the legal zone is up to and including the edge) that micro-overshoot would
    // trip the strict outside-check. Project it back exactly ONTO the contacted
    // edge line so the contact point lies on the boundary, not just past it.
    const contactPoint = projectOntoEdge(add(pos, motionToContact), contact.edge);
    const remaining = sub(target, contactPoint);
    const tangent = tangentialComponent(remaining, contact.edge.a, contact.edge.b);
    collided = true;
    boundaries.push({ featureId: contact.edge.featureId, edgeKey: contact.edge.edgeKey });

    // The contact point itself must be safe (contained AND outside other terminals)
    // before we accept advancing to it; if sliding INTO the parent boundary would seat
    // the vertex on another terminal, hold at the prior safe pos.
    const safeContact = isSafe(contactPoint) ? contactPoint : pos;

    // Slide tangentially, again projected onto the edge line so the slid point sits
    // exactly on the boundary (not a hair outside from FP) before the inside test.
    const newTarget = projectOntoEdge(add(contactPoint, tangent), contact.edge);
    if (!isSafe(newTarget)) {
      // The tangential slide along an oblique parent edge re-exits past the shared
      // corner OR seats the vertex inside another terminal: hold at the contact point
      // (on the boundary, contained) when that is itself safe. Mirror of the
      // other-terminal oblique guard.
      pos = safeContact;
      break;
    }
    pos = safeContact;
    target = newTarget;
  }

  return { position: pos, boundaries, collided };
}

/**
 * The position farthest along start→target that still satisfies {@link isSafe},
 * found by a bounded bisection. `start` is assumed safe (frame precondition); the
 * search returns the largest-parameter safe point so a graze/denormal target cannot
 * teleport the vertex across the region — it advances only as far as it legally may.
 */
function largestSafePrefix(
  start: WorldCoordinate,
  target: WorldCoordinate,
  isSafe: (p: WorldCoordinate) => boolean,
): WorldCoordinate | undefined {
  const motion = sub(target, start);
  if (len(motion) < EPS) return undefined;
  if (isSafe(target)) return target;
  let lo = 0; // known safe (start)
  let hi = 1; // known unsafe (target)
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    const p = add(start, { lon: motion.lon * mid, lat: motion.lat * mid });
    if (isSafe(p)) lo = mid;
    else hi = mid;
  }
  return add(start, { lon: motion.lon * lo, lat: motion.lat * lo });
}

/**
 * Project `p` onto the INFINITE line through edge [a,b] (the nearest point on that
 * line). For a containment slide this removes the floating-point normal error that
 * a raw segment-parameter contact point carries, so the boundary contact sits
 * exactly on the edge line rather than a hair past it — keeping the strict
 * inside/outside test from misjudging legal boundary contact as an exit.
 */
function projectOntoEdge(p: WorldCoordinate, edge: BoundaryEdge): WorldCoordinate {
  const ab = sub(edge.b, edge.a);
  const ab2 = dot(ab, ab);
  if (ab2 < EPS2) return p;
  const k = dot(sub(p, edge.a), ab) / ab2;
  return add(edge.a, { lon: ab.lon * k, lat: ab.lat * k });
}

/** Nearest parent boundary edge to `p` (for the tangential slide direction when the
 * exit has no proper crossing — e.g. start already on the boundary). */
function nearestParentEdge(
  p: WorldCoordinate,
  edges: readonly BoundaryEdge[],
): BoundaryEdge | undefined {
  let best: BoundaryEdge | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const edge of edges) {
    const ab = sub(edge.b, edge.a);
    const ab2 = dot(ab, ab);
    const ap = sub(p, edge.a);
    const k = ab2 < EPS2 ? 0 : Math.max(0, Math.min(1, dot(ap, ab) / ab2));
    const closest = add(edge.a, { lon: ab.lon * k, lat: ab.lat * k });
    const d = len(sub(p, closest));
    if (d < bestDist) {
      bestDist = d;
      best = edge;
    }
  }
  return best;
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
  // Quantize BOTH endpoints to the world grid up front. Beyond normalising the
  // proposal this CLAMPS denormal coordinates (e.g. lon = -5e-324 or 2e-322) to a
  // clean grid value: a denormal that the point predicate reads as Outside without
  // yielding a PROPER boundary crossing was the trigger for both the containment
  // graze-fallback teleport AND a single-candidate leak where the safe-fallback
  // `start` was itself a denormal the math then mis-handled (U24 fuzz CEXs). All
  // downstream geometry — and the final fall-back to `start` — therefore operate on
  // grid-clean coordinates consistent with the quantized committed output.
  const start = quantizeCoordinate(input.start);
  let pos = start;
  let target = quantizeCoordinate(input.target);
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
    // The raw crossing parameter carries floating-point NORMAL error, so the point
    // `start + t·motion` lands a hair OFF the contacted edge line; on an OBLIQUE edge
    // that micro-offset can read as STRICTLY INSIDE the candidate. Project the contact
    // point exactly onto the contacted edge LINE so it sits on the boundary, not a hair
    // past it — the SAME correction the containment path already applies (技術方針 R2,
    // 単一真実源: one projection helper for both slide paths).
    const contactPoint = projectOntoEdge(add(pos, motionToContact), contact.edge);
    const remaining = sub(target, contactPoint);
    const tangent = tangentialComponent(remaining, contact.edge.a, contact.edge.b);
    collided = true;
    boundaries.push({ featureId: contact.edge.featureId, edgeKey: contact.edge.edgeKey });

    // Slide tangentially, again projected onto the edge line so the slid point sits
    // exactly on the boundary (not a hair inside from residual FP normal error) before
    // the inside test below — without this projection the leak put the committed vertex
    // strictly inside the diamond on oblique entry angles (U24 fuzz CEX).
    const newTarget = projectOntoEdge(add(contactPoint, tangent), contact.edge);
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

  // Quantize to the committed world grid BEFORE the invariant re-checks. The
  // returned position is `quantizeCoordinate(pos)`, so the invariant must be asserted
  // on the QUANTIZED value, not the pre-quantize one: quantization snaps lon/lat to
  // the 1e-7 grid and can move a point that read ON the boundary to a grid point that
  // pointInPolygon (exact-zero cross-product boundary test) classifies as strictly
  // inside. Checking the un-quantized pos let exactly that grid-snap leak through
  // (U24 fuzz CEX: a slid point on an oblique edge quantizes to lat≈lon+2 with a
  // 2e-16 cross-product residual → mis-read Inside). 技術方針 R2 / 単一真実源.
  pos = quantizeCoordinate(pos);

  // FINAL INVARIANT re-check (技術方針 R2「判定後に不変条件を再チェック」): whatever the
  // path above produced, the committed position must never be strictly inside any
  // candidate terminal (FR-28 / FR-89, 受け入れ基準6). If a residual numeric edge
  // case slips through, fall back to the last position known to be outside — the
  // original start is always outside by precondition (the previous accepted frame),
  // so it is the safe last resort.
  if (isInsideAnyCandidate(pos, candidates) !== undefined) {
    pos = start;
  }

  // INVERSE containment (受け入れ基準6 第4項 / FR-89): a hole/enclave vertex must also
  // stay inside its OWN parent region. Apply this AFTER the other-terminal slide so
  // the position fed in already respects the other-terminal constraint, then slide
  // it back inside the parent boundary if the other-terminal result drifted out.
  // The judgement reuses U07's containment predicate (single source of truth).
  const containment = input.containment;
  if (containment !== undefined) {
    // The position produced by the other-terminal pass: already candidate-safe (the
    // re-check above guarantees it is not strictly inside any candidate). The
    // containment pass may relocate it; if that relocation lands inside a candidate
    // we revert to this position rather than commit a vertex inside another terminal.
    const preContainmentPos = pos;
    const within = constrainWithinParent(start, pos, containment, candidates);
    // Quantize the containment result to the committed grid before its invariant
    // re-checks, for the SAME reason as the other-terminal pass above: the value that
    // is returned and tested is the quantized one, so the invariant must hold on the
    // quantized point, not the pre-quantize one.
    pos = quantizeCoordinate(within.position);
    for (const b of within.boundaries) boundaries.push(b);
    collided = collided || within.collided;
    // FINAL re-check AFTER the containment pass (the missing guard,
    // U24 high blocker / 受け入れ基準6 / FR-28 / FR-89「最終位置で末端地物同士が重ならない」
    // かつ 第4項「親領域の内側に留まる」): the containment pass runs LAST and could have
    // relocated the vertex strictly inside another terminal. The committed position
    // must satisfy BOTH invariants — inside the parent AND outside every other
    // terminal. If the containment result violates the other-terminal invariant we
    // fall back, but the fallback ITSELF must also satisfy BOTH invariants:
    // `preContainmentPos` is the other-terminal pass output that was fed INTO the
    // containment pass precisely because it could be OUTSIDE the parent (the reason
    // constrainWithinParent was invoked), so it is candidate-safe but NOT guaranteed
    // parent-contained. Therefore commit the first of
    // [containment-result, preContainmentPos, start] that satisfies BOTH invariants;
    // `start` is the previous accepted frame and is safe on both by precondition.
    const satisfiesBoth = (p: WorldCoordinate): boolean =>
      !isOutsideContainment(p, containment) && isInsideAnyCandidate(p, candidates) === undefined;
    if (!satisfiesBoth(pos)) {
      pos = satisfiesBoth(preContainmentPos) ? preContainmentPos : start;
    }
  }

  // `pos` is already quantized by every branch above; quantize once more defensively
  // (idempotent) so the committed value is unconditionally on the world grid.
  const committed = quantizeCoordinate(pos);

  // BOUNDARY/COLLISION CONSISTENCY (bughunt2): a reported `collided` + non-empty
  // `boundaries` means "the vertex was constrained — it slid ALONG these edges". The
  // render layer highlights those edges as the contact the vertex is riding. But two
  // fallback branches above commit the FRAME START unchanged when no constrained point
  // satisfies the invariants:
  //   - the other-terminal final invariant fallback `pos = start` (the candidate-inside
  //     residual case), and
  //   - the containment final fallback `pos = start` (neither the containment result nor
  //     `preContainmentPos` satisfies BOTH invariants).
  // In both, `collided`/`boundaries` were accumulated for a slide that was ultimately
  // ABANDONED — the committed position is exactly the input start, so the vertex did NOT
  // move one bit, let alone slide along the recorded edges. Returning collided=true with
  // those edges made the render layer highlight a boundary the pinned-in-place vertex is
  // not actually riding (it sits at the previous frame's position, not on the contact
  // edge), so the user saw a collision/highlight despite zero motion. When the committed
  // position is the unchanged frame start, the move was a no-op: report no slide. This
  // unifies every "rolled back to start" branch onto the invariant
  // "collided/boundaries ⇒ the vertex was actually displaced from start". 教訓5.18 /
  // 受け入れ基準6・7. (`start` is already quantized, so the comparison is grid-exact.)
  if (len(sub(committed, start)) < EPS) {
    return { position: committed, boundaries: [], collided: false };
  }

  return {
    position: committed,
    boundaries,
    collided: collided || boundaries.length > 0,
  };
}

// ---------------------------------------------------------------------------
// N725-9 — THE SET-DELTA CONSTRAINT (FR-80 × FR-28 / FR-89)
// ---------------------------------------------------------------------------
//
// WHAT IT SOLVES: {@link constrainSlide} constrains ONE point. In an N-vertex rigid
// drag (FR-80 複数頂点同時移動) the other N−1 vertices passed through no FR-28 collision
// and no FR-89 containment check at all, so a companion could be committed strictly
// inside a neighbouring terminal (the adapter's former KNOWN GAP; the live edit binding's
// `detectSpatial` is `() => []`, so nothing behind it caught that either).
//
// THE RULE (裁定 N725-9 / N725-10, 2026-07-25) —「方向は主頂点、量は集合の交叉」:
//   - the PRIMARY keeps the direction authority: it slides and snaps exactly as today,
//     yielding the gesture's rigid vector d (its own displacement from its COMMITTED
//     position, measured by the single {@link rigidMoveDelta} rule);
//   - every moving vertex holds an authority over the AMOUNT only: it may shrink the
//     shared vector by a scalar s in [0,1], never bend it. 「選択セット全体を同一ベクトル」
//     therefore stays literally true and no shear can arise.
//
// WHY A SCALAR IS ENOUGH (the maths): let A_i = { d : the segment [p_i, p_i+d] crosses
// none of vertex i's obstacle edges, p_i+d is in no candidate's strict interior, and (if
// it has one) p_i+d stays inside its parent region }. Each A_i is STAR-SHAPED about the
// origin: p_i is legal by the committed FR-28/FR-89 invariant, and a segment that crosses
// no boundary keeps every one of its points on the legal side (Jordan). So the restriction
// of A_i to the ray {t*d} is a closed interval [0, t_i], and the intersection over i of
// A_i, restricted to that ray, is [0, min_i t_i]. t_i is exactly what {@link firstContact}
// already computes — analytic, no search.
// PRECONDITION for the star-shape argument: for every terminal that is hit, ALL of its
// edges are supplied (the caller's polygonEdges emits a hit terminal's whole outline, it
// never clips edges to the query box). A partial edge set would break the argument.
//
// WHY NOT A PURE SCALAR CLAMP OF THE WHOLE GESTURE: `constrainSlide` bends the motion
// (tangential slide), so reducing it to "how far along start→target" would make a single
// vertex STOP at a wall instead of sliding along it — the FR-28 UX and the 23 slide tests.
// Hence two phases: phase 1 is today's slide verbatim, phase 2 only shrinks its result.

/**
 * One vertex that MOVES with the gesture, with the obstacle sets narrowed around ITS OWN
 * swept path. The primary is described by {@link SetSlideInput} itself; this type carries
 * the companions.
 *
 * `from` is the vertex's COMMITTED position — the point the shared delta is measured from
 * and the point that is legal by precondition. (Note the deliberate asymmetry with the
 * primary, whose own slide is still measured from the PRESS point `start`: `updateDrag`
 * never advances `start`, and changing that would change single-vertex behaviour.)
 *
 * HB4-2 discipline is the CALLER's, and it is one set for the whole gesture: an edge
 * incident to ANY moving vertex is a wall for NO moving vertex (the set translates
 * rigidly), and a polygon piece that references a moving vertex supplies no candidate.
 */
export interface MovingVertexConstraint {
  /** Identity, for diagnostics / dedupe. Never used as geometry (R3 seam / 診断 H5). */
  readonly vertexId: string;
  /** The vertex's committed position. Legal by the committed FR-28 / FR-89 invariant. */
  readonly from: WorldCoordinate;
  readonly edges: readonly BoundaryEdge[];
  readonly candidates: readonly CandidateTerminal[];
  readonly containment?: ParentContainment;
}

/** {@link constrainSlide}'s input plus the rest of the rigid set (FR-80). */
export interface SetSlideInput extends SlideInput {
  /**
   * The PRIMARY's committed position — the origin the shared delta is measured from.
   * It differs from {@link SlideInput.start} (the press point) by the grab offset, so
   * naming it explicitly is required: the slide is judged from the press point, the
   * rigid vector is measured from the committed position (the same asymmetry
   * `moveDraggedVertexSet` already has).
   */
  readonly primaryFrom: WorldCoordinate;
  /** The companions. EMPTY ⇒ this is a single-vertex drag and nothing changes at all. */
  readonly companions: readonly MovingVertexConstraint[];
}

export interface SetSlideResult extends SlideResult {
  /**
   * The vector every moving vertex (primary included) is displaced by, from its own
   * committed position — exactly what `moveDraggedVertexSet` re-derives from
   * {@link SlideResult.position}.
   */
  readonly delta: { readonly dLon: number; readonly dLat: number };
  /** True iff a companion (or the re-checked chord) shortened the gesture this frame. */
  readonly retracted: boolean;
}

interface ScaleLimit {
  readonly scale: number;
  /** The boundary that imposed {@link scale}, for the slide highlight. */
  readonly edge?: BoundaryEdge;
}

/**
 * The parent containment REGION when the moving set is displaced by `offset` (N725-9 必須1-c).
 * Falls back to the fixed {@link ParentContainment.polygon} when the containment carries no
 * scale-rebuild — a single-point slide, or a test parent with no moving vertex on it.
 */
function containmentRegionAt(
  containment: ParentContainment,
  offset: { lon: number; lat: number },
): GeoPolygon {
  return containment.regionAtScaledDelta === undefined
    ? containment.polygon
    : containment.regionAtScaledDelta(offset);
}

/** True iff `p` is strictly OUTSIDE the containment region evaluated at displacement `offset`. */
function isOutsideContainmentAt(
  p: WorldCoordinate,
  containment: ParentContainment,
  offset: { lon: number; lat: number },
): boolean {
  return pointInPolygon(p, containmentRegionAt(containment, offset)) === POINT_LOCATION.Outside;
}

const ZERO_OFFSET = { lon: 0, lat: 0 } as const;

/**
 * Whether each invariant is ENFORCEABLE for a moving vertex, decided at its COMMITTED position
 * (offset 0). A premise is BROKEN when the committed data already violates that invariant —
 * `from` sits inside an obstacle, or outside its committed parent — and then the invariant is
 * NOT enforced (necessarily 棄権, to avoid the HB4-2 固着 failure). Decided per invariant, so a
 * broken parent premise never silences the FR-28 obstacle check (必須1-a). The SAME flags are
 * used by phase 2 and the R2 re-check, so the two never disagree about who abstains.
 */
function premisesOf(
  from: WorldCoordinate,
  candidates: readonly CandidateTerminal[],
  containment: ParentContainment | undefined,
): { readonly enforceCandidates: boolean; readonly enforceContainment: boolean } {
  return {
    enforceCandidates: isInsideAnyCandidate(from, candidates) === undefined,
    enforceContainment:
      containment !== undefined && !isOutsideContainmentAt(from, containment, ZERO_OFFSET),
  };
}

/**
 * True iff the already-displaced point `moved` keeps every ENFORCED invariant satisfied. FR-89
 * is judged on the parent region at `offset` (the set delta applied to the moving set, 必須1-c),
 * and each invariant is checked only when its premise held at the committed position (必須1-a,
 * `premises`). `moved` is passed already-placed so the PRIMARY (placed absolutely) and a
 * COMPANION (placed at `from + offset`) share one legality rule.
 */
function movedPointLegal(
  moved: WorldCoordinate,
  candidates: readonly CandidateTerminal[],
  containment: ParentContainment | undefined,
  offset: { lon: number; lat: number },
  premises: { readonly enforceCandidates: boolean; readonly enforceContainment: boolean },
): boolean {
  if (premises.enforceCandidates && isInsideAnyCandidate(moved, candidates) !== undefined) {
    return false;
  }
  if (
    premises.enforceContainment &&
    containment !== undefined &&
    isOutsideContainmentAt(moved, containment, offset)
  ) {
    return false;
  }
  return true;
}

/**
 * The largest s <= `hi` for which `legalAtScale(s)` holds, by bounded bisection on the ray.
 * Used for the GRAZE / denormal case the analytic crossing cannot see (the endpoint reads
 * illegal without a PROPER crossing). 40 halvings of a <=360 deg span reach ~3e-10 — far
 * below the 1e-7 world grid, so the answer is exact at committed resolution.
 *
 * It bisects on the SCALE (not on a fixed point set), because the parent containment region
 * is itself a function of s (必須1-c): each `legalAtScale(mid)` evaluates the moved point
 * against the parent shape at THAT scale. `s = 0` is legal by precondition — the committed
 * position, judged only on the premises that actually hold.
 */
function largestLegalScaleBy(legalAtScale: (s: number) => boolean, hi: number): number {
  if (legalAtScale(hi)) return hi;
  let lo = 0;
  let high = hi;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + high) / 2;
    if (legalAtScale(mid)) lo = mid;
    else high = mid;
  }
  return lo;
}

/**
 * How far along the shared vector `d` this vertex may travel: `max{ s in [0, hi] :
 * from + s*d is legal }`, plus the boundary that stopped it.
 *
 * ANALYTIC FIRST, bisection only as a fallback: the earliest crossing of the swept
 * segment against the obstacle edges (and, when present, against the parent boundary the
 * vertex must not leave) is exactly {@link firstContact}'s parameter. The endpoint is then
 * re-tested, because a graze / denormal target can read illegal WITHOUT producing a proper
 * crossing (the U24 fuzz CEX class); only then do we bisect.
 *
 * CONTAINMENT IS ANALYTIC TOO, despite the parent ring's shape depending on s: an edge
 * whose BOTH endpoints move translates with the set (never an obstacle), and an edge with
 * ONE moving endpoint is already dropped by the HB4-2 incident filter. What remains are
 * edges between two STATIONARY vertices, whose geometry does not depend on s at all. Only
 * the terminal point-in-polygon test is s-dependent, and that is what the endpoint re-test
 * and the caller's final re-check cover.
 *
 * PRECONDITION FAILURE IS NOT A BLANKET VETO, BUT IT IS PER-INVARIANT (必須1-a): FR-28
 * (candidates) and FR-89 (parent containment) guard DIFFERENT invariants, so a broken premise
 * on one must not silence the other. If `from` is already inside an obstacle (corrupt data) we
 * cannot bound the FR-28 side — abstain THERE only. If `from` already reads outside its
 * committed parent (a parent that deformed out from under it) we cannot bound the FR-89 side —
 * abstain THERE only. Abstaining on BOTH at once (the former `if (!legal(from)) return
 * {scale: hi}`) let a broken parent premise wave a companion straight through an obstacle
 * (N725-9 敵対レビュー HIGH「棄権の巻き添え」). Returning 0 was never an option either: it would
 * FREEZE the drag at the press point, the exact HB4-2 固着 failure.
 */
function admissibleScale(
  from: WorldCoordinate,
  d: { lon: number; lat: number },
  hi: number,
  edges: readonly BoundaryEdge[],
  candidates: readonly CandidateTerminal[],
  containment: ParentContainment | undefined,
): ScaleLimit {
  if (hi <= 0) return { scale: 0 };
  const at = (s: number): WorldCoordinate => ({
    lon: from.lon + d.lon * s,
    lat: from.lat + d.lat * s,
  });
  const insideCandidate = (p: WorldCoordinate): boolean =>
    isInsideAnyCandidate(p, candidates) !== undefined;
  // (必須1-c) The parent region at the scale being probed: moving parent vertices at
  // `committed + s·d`, so at s=0 it is the committed parent (where `from` is legal by the
  // FR-89 invariant) and it deforms along the ray exactly as the gesture deforms it.
  const outsideParentAt = (s: number, p: WorldCoordinate): boolean =>
    containment !== undefined &&
    isOutsideContainmentAt(p, containment, { lon: d.lon * s, lat: d.lat * s });

  // (必須1-a) SEPARATE premises: enforce each invariant only where ITS premise holds — the
  // SAME flags the R2 re-check uses (single source, {@link premisesOf}).
  const { enforceCandidates, enforceContainment } = premisesOf(from, candidates, containment);

  const target = at(hi);
  let scale = hi;
  let edge: BoundaryEdge | undefined;

  if (enforceCandidates) {
    const otherContact = firstContact(from, target, edges);
    if (otherContact !== undefined) {
      scale = otherContact.t * hi;
      edge = otherContact.edge;
    }
  }
  if (enforceContainment) {
    // The parent edges are between two STATIONARY vertices (incident-to-moving edges are
    // dropped by the caller's HB4-2 filter), so their geometry is s-independent and this
    // analytic crossing is valid even though the point-in-polygon region deforms with s.
    const parentContact = firstContact(from, target, containment!.edges);
    if (parentContact !== undefined && parentContact.t * hi < scale) {
      scale = parentContact.t * hi;
      edge = parentContact.edge;
    }
  }

  // Endpoint / graze re-test (the U24 fuzz CEX class): a crossing the analytic firstContact
  // cannot see. Each invariant is re-tested ONLY where its premise held, on the s-consistent
  // parent shape — so a legitimately-inside `from` is never blocked by the full-delta parent.
  const legalAtScale = (s: number): boolean => {
    const p = at(s);
    if (enforceCandidates && insideCandidate(p)) return false;
    if (enforceContainment && outsideParentAt(s, p)) return false;
    return true;
  };
  if (!legalAtScale(scale)) {
    const safe = largestLegalScaleBy(legalAtScale, scale);
    if (safe < scale) {
      scale = safe;
      if (edge === undefined) {
        const all = containment === undefined ? edges : [...edges, ...containment.edges];
        edge = nearestParentEdge(at(scale), all);
      }
    }
  }
  return edge === undefined ? { scale } : { scale, edge };
}

/**
 * How many times the shortened scale may be halved when the QUANTIZED delta fails the
 * final invariant re-check. Quantization moves a point by at most half a grid cell
 * (5e-8 deg), so one or two rungs already cover any realistic residue; the ladder ends at
 * delta = 0, which is unconditionally legal.
 */
const QUANTIZED_RETRY_RUNGS = 4;

/**
 * Constrain a RIGID multi-vertex move (FR-80) so that EVERY moving vertex — not just the
 * grabbed one — honours FR-28 排他 and FR-89 親領域包含, without ever breaking the
 * 「同一ベクトル」 invariant.
 *
 * Phase 1 is {@link constrainSlide} on the primary, UNCHANGED. Phase 2 shrinks the
 * resulting rigid vector to the intersection of every moving vertex's admissible interval
 * along that vector. Phase 2b re-checks the PRIMARY against the shortened CHORD: the
 * phase-1 vector is bent by tangential sliding, so a shortened straight chord can cut a
 * corner the slid polyline went around.
 *
 * NO COMPANIONS ⇒ the {@link constrainSlide} result is returned BY VALUE, untouched: a
 * single-vertex drag is bit-for-bit what it was before this function existed (the
 * strongest non-regression gate we can state).
 *
 * QUANTIZATION (HB4-2 教訓, 案A「デルタを量子化する」): when the gesture IS shortened, the
 * shared delta — not the individual positions — is snapped to the world grid, so every
 * moving vertex receives the identical vector and rigidity survives the rounding
 * (quantizing positions per vertex would introduce up to 5e-8 of shear). When it is NOT
 * shortened, nothing is quantized here at all, so the primary keeps landing on its slid /
 * snapped position bit-for-bit (`moveDraggedVertexSet`'s EXACTNESS rule).
 *
 * SEAM (R3): the scale is applied to a delta whose branch was already fixed by
 * {@link rigidMoveDelta}. Multiplying by s in [0,1] can never change that branch, so the
 * whole-turn semantics are preserved. The order is FIXED — take the shortest delta, THEN
 * scale; never re-derive a shortest delta from an already-scaled vector.
 *
 * Pure. 技術方針 R2「判定後に不変条件を再チェック」 is honoured at the end: the committed
 * delta is re-validated for EVERY moving vertex, with a halving ladder down to zero.
 */
export function constrainSetSlide(input: SetSlideInput): SetSlideResult {
  const base = constrainSlide(input);
  const { companions, primaryFrom } = input;
  const measured = rigidMoveDelta(primaryFrom, base.position);
  const asDelta = { dLon: measured.dLon, dLat: measured.dLat };

  // Single-vertex drag (and the degenerate zero-motion frame): today's answer, verbatim.
  if (companions.length === 0) {
    return { ...base, delta: asDelta, retracted: false };
  }
  const d = { lon: measured.dLon, lat: measured.dLat };
  if (len(d) < EPS) {
    return { ...base, delta: asDelta, retracted: false };
  }

  // PHASE 2 — the intersection over the companions. Each is capped by the running
  // minimum, so a vertex can only ever tighten the answer (and the search is cheaper).
  let scale = 1;
  let blocker: BoundaryEdge | undefined;
  for (const companion of companions) {
    const limit = admissibleScale(
      companion.from,
      d,
      scale,
      companion.edges,
      companion.candidates,
      companion.containment,
    );
    if (limit.scale < scale) {
      scale = limit.scale;
      // LOW#1: a tighter limit with NO edge (a graze-based cap) must not ERASE the blocker a
      // prior companion already recorded — keep the last real edge for the slide highlight.
      blocker = limit.edge ?? blocker;
    }
    if (scale <= 0) {
      scale = 0;
      break;
    }
  }

  // PHASE 2b — the shortened chord re-checked against the PRIMARY's own obstacles. The
  // phase-1 vector is a BENT path (contact point + tangential slide); the straight chord
  // p0 → p0 + s*d is not the path the primary actually took, so it can cut a corner.
  if (scale < 1) {
    const primaryLimit = admissibleScale(
      primaryFrom,
      d,
      scale,
      input.edges,
      input.candidates,
      input.containment,
    );
    if (primaryLimit.scale < scale) {
      scale = primaryLimit.scale;
      blocker = primaryLimit.edge ?? blocker;
    }
  }

  // R2 FINAL RE-CHECK on the value that will actually be committed. The admissible scales
  // were computed on the RAW ray; the committed points are `from + quantized(s*d)`, up to
  // half a grid cell away. Validate that exact expression for every moving vertex and, if
  // it fails, halve the scale a bounded number of times before conceding the frame
  // (delta = 0 keeps every vertex at its committed position, which is legal by
  // precondition — the set-level analogue of `constrainSlide`'s `pos = start`).
  // The delta the COMMIT will apply is not literally `quantized(s*d)`: the session carries
  // one value (the primary's `position`), and `moveDraggedVertexSet` re-derives the
  // companions' vector from it as `position − primaryFrom`, whose floating-point rounding
  // can differ from the value we scaled by a ULP. The point predicates are EXACT
  // arithmetic, so a companion parked ON a boundary could flip to Inside on that ULP. We
  // therefore build the candidate position first and re-derive the delta the SAME way the
  // move will, then validate THAT (単一真実源 — one vector, derived once).
  const trialAt = (
    s: number,
  ): { position: WorldCoordinate; delta: { dLon: number; dLat: number } } => {
    // LOW#2: quantize the pullback frame's primary position ONTO the world grid (not merely
    // its per-component delta), so the committed primary sits on the same grid the
    // point-in-polygon predicate and `constrainSlide` classify against (格子保証).
    const position = quantizeCoordinate(
      createCoordinate(
        primaryFrom.lon + quantizeScalar(d.lon * s),
        primaryFrom.lat + quantizeScalar(d.lat * s),
      ),
    );
    const applied = rigidMoveDelta(primaryFrom, position);
    return { position, delta: { dLon: applied.dLon, dLat: applied.dLat } };
  };
  // Premise flags for every moving vertex, decided ONCE at their committed positions, so the
  // R2 re-check enforces exactly the invariants phase 2 enforced (必須1-a): a companion whose
  // committed data is genuinely broken (outside its own committed parent) stays abstained here
  // too rather than being frozen at delta 0.
  const primaryPremises = premisesOf(primaryFrom, input.candidates, input.containment);
  const companionPremises = companions.map((c) => premisesOf(c.from, c.candidates, c.containment));
  // True iff `position` (primary) and every companion at `from + delta` are legal, each judged
  // on its OWN s-consistent parent region at the applied offset (必須1-c) so the re-check never
  // re-introduces the full-delta parent it was meant to remove.
  const movingSetLegal = (
    position: WorldCoordinate,
    delta: { dLon: number; dLat: number },
  ): boolean => {
    const offset = { lon: delta.dLon, lat: delta.dLat };
    if (!movedPointLegal(position, input.candidates, input.containment, offset, primaryPremises)) {
      return false;
    }
    for (let i = 0; i < companions.length; i += 1) {
      const c = companions[i]!;
      const moved = { lon: c.from.lon + delta.dLon, lat: c.from.lat + delta.dLat };
      if (!movedPointLegal(moved, c.candidates, c.containment, offset, companionPremises[i]!)) {
        return false;
      }
    }
    return true;
  };
  const legalTrial = (s: number): ReturnType<typeof trialAt> | undefined => {
    const trial = trialAt(s);
    return movingSetLegal(trial.position, trial.delta) ? trial : undefined;
  };

  // (必須1-b) NO early bypass of the R2 re-check. When nothing shrank in phase 2/2b the
  // committed value is the primary's slide result VERBATIM (exactness — no quantization) and
  // the companions ride the full `measured` delta; but a moving vertex may have ABSTAINED on a
  // broken premise or been missed by the analytic crossing, so the FULL delta must still be
  // validated for every moving vertex on its s-consistent region. Only when it holds do we
  // return phase 1 BY VALUE (bit-identical to the single-vertex path); otherwise we retract
  // through the halving ladder like any other constrained frame.
  if (scale >= 1) {
    if (movingSetLegal(base.position, asDelta)) {
      return { ...base, delta: asDelta, retracted: false };
    }
    scale = 1;
  }

  let committed: ReturnType<typeof trialAt> | undefined;
  let rungScale = scale;
  for (let rung = 0; rung < QUANTIZED_RETRY_RUNGS; rung += 1) {
    committed = legalTrial(rungScale);
    if (committed !== undefined) break;
    rungScale /= 2;
  }
  const finalDelta = committed?.delta ?? { dLon: 0, dLat: 0 };
  const position = committed?.position ?? createCoordinate(primaryFrom.lon, primaryFrom.lat);

  // BOUNDARY/COLLISION CONSISTENCY, the set-level restatement of the single-vertex rule
  // (「滑ったと報告するなら実際に変位していること」): a zero delta leaves EVERY moving
  // vertex exactly where it was committed, so no boundary is being ridden.
  if (finalDelta.dLon === 0 && finalDelta.dLat === 0) {
    return { position, boundaries: [], collided: false, delta: finalDelta, retracted: true };
  }

  const boundaries: SlideBoundary[] = [...base.boundaries];
  if (blocker !== undefined) {
    boundaries.push({ featureId: blocker.featureId, edgeKey: blocker.edgeKey });
  }
  return { position, boundaries, collided: true, delta: finalDelta, retracted: true };
}

/**
 * True iff displacing EVERY companion by the vector `primaryFrom → snapPosition` keeps it
 * legal — no candidate's strict interior (FR-28 排他) and inside its own s-consistent parent
 * region (FR-89 親領域包含).
 *
 * The adapter uses this to decide whether a surviving share-snap of the PRIMARY may carry the
 * whole rigid set (裁定 N725-10「移動ベクトル = 主頂点変位」, 必須3). A share-snap welds the
 * primary onto its target vertex, so at commit the whole set is displaced by
 * d_snap = snapPosition − primaryFrom — NOT by the retracted preview delta. If d_snap would
 * push a companion into an obstacle, the snap must be DROPPED (拘束 > スナップ) rather than
 * shearing the set (the primary jumping to the pin while the companions stay put breaks
 * 「同一ベクトル」). Measured with the SAME {@link rigidMoveDelta} rule the move applies
 * (単一真実源). Pure.
 */
export function setDeltaAdmitsSnap(
  primaryFrom: WorldCoordinate,
  snapPosition: WorldCoordinate,
  companions: readonly MovingVertexConstraint[],
): boolean {
  const delta = rigidMoveDelta(primaryFrom, snapPosition);
  const offset = { lon: delta.dLon, lat: delta.dLat };
  for (const companion of companions) {
    const moved = { lon: companion.from.lon + delta.dLon, lat: companion.from.lat + delta.dLat };
    const premises = premisesOf(companion.from, companion.candidates, companion.containment);
    if (!movedPointLegal(moved, companion.candidates, companion.containment, offset, premises)) {
      return false;
    }
  }
  return true;
}
