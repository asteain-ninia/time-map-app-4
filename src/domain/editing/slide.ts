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
  return {
    position: quantizeCoordinate(pos),
    boundaries,
    collided: collided || boundaries.length > 0,
  };
}
