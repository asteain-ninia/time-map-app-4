// HB-15 — the LIVE map hit-test rule: a screen point → a U22 {@link HitResult}.
//
// WHY THIS FILE EXISTS (教訓 5.7 合成ルートの結線漏れ / 教訓 5.29 単一真実源):
// The screen→world math (HB-7) and the live domain-lookup (live-lookup.ts:
// featuresAt / verticesAt / leafAtPoint) both exist and are correct, but the map
// pointer dispatcher in the composition root was backed by EMPTY_HIT_TESTER, so a
// real edit-mode click on a vertex / feature resolved to nothing and could never
// select. This module is the ONE place that turns "the click landed HERE on screen"
// into "this vertex / this feature was hit", reusing:
//   - the renderer's box-corrected screenToWorld (the SAME transform draw uses), and
//   - live-lookup's featuresAt / verticesAt / leafAtPoint (the SAME resolution the
//     U13 binding + U26 knife ports use), so what is DRAWN, what is HIT, and what the
//     consistency path resolves can never disagree (二重真実源を作らない).
//
// PRIORITY (受け入れ基準: 頂点優先 → なければ地物, 教訓 5.9 排他分岐の優先順位):
//   1. The nearest committed VERTEX within `radiusPx` SCREEN pixels of the cursor
//      (vertex handles are small, so the tolerance is screen-px based — it stays a
//      constant on-screen grab radius at every zoom, FR-17 一定サイズ same spirit).
//   2. Else the topmost committed LEAF BODY under the cursor (live-lookup.leafAtPoint
//      world-space containment, 穴透過 honoured — the single body containment rule).
//   3. Else a POINT / LINE feature within the screen-px radius (no fillable body).
//   4. Else {@link EMPTY_HIT} (empty space → clears selection downstream).
//
// PURITY: no React, no store, no Canvas. The caller injects the live root + time +
// the world→screen projector (so the screen-px distances match what the user sees),
// the click point AND the click's world coordinate (the renderer inverse, for the
// world-space leaf containment). It builds fresh arrays; inputs are never mutated.

import { FEATURE_KIND, type Feature } from '../../domain/feature';
import type { FeatureId, VertexId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import type { TimePoint } from '../../domain/time/time-point';
import { getVertex } from '../../domain/vertex';
import {
  EMPTY_HIT,
  featureBodyHit,
  vertexHit,
  type HitResult,
} from '../../domain/selection';
import type { ScreenPoint } from '../../render';
import { featuresAt, leafAtPoint, verticesAt } from '../live-lookup';
import type { WorldCoordinate } from '../../domain/coordinate';

/** Project a world coordinate to surface-relative screen px (U17 forward transform). */
export type ProjectToScreen = (world: WorldCoordinate) => ScreenPoint;

/** The inputs one hit-test needs (the live root + time + projector + click). */
export interface LiveHitTestInput {
  readonly root: DomainProject;
  readonly time: TimePoint;
  /** World → surface screen px (the SAME transform the renderer drew with). */
  readonly toScreen: ProjectToScreen;
  /** The click point in surface-relative screen px (box-offset already removed). */
  readonly point: ScreenPoint;
  /** The grab radius in SCREEN px for a vertex / point / line hit (default 8). */
  readonly radiusPx?: number;
}

/** Default screen-px grab radius for a vertex / point / line hit. */
export const DEFAULT_HIT_RADIUS_PX = 8;

/**
 * Collect every committed vertex's OWNING feature (point.vertexId / line.vertexIds /
 * leaf ring vertexIds). The first owner encountered wins for a shared vertex — a
 * shared vertex still selects A real owner feature, which is all the U22 contract
 * needs (a vertex hit carries its owner + the vertex id). Aggregates carry no
 * vertices (their area is derived), so they contribute none.
 */
export function vertexOwners(features: readonly Feature[]): Map<VertexId, FeatureId> {
  const owners = new Map<VertexId, FeatureId>();
  const claim = (vid: VertexId, fid: FeatureId): void => {
    if (!owners.has(vid)) owners.set(vid, fid);
  };
  for (const f of features) {
    switch (f.kind) {
      case FEATURE_KIND.Point:
        claim(f.vertexId, f.id);
        break;
      case FEATURE_KIND.Line:
        for (const vid of f.vertexIds) claim(vid, f.id);
        break;
      case FEATURE_KIND.Leaf:
        for (const ring of f.shape.rings) {
          for (const vid of ring.vertexIds) claim(vid, f.id);
        }
        break;
      default:
        // Aggregate: no own vertices.
        break;
    }
  }
  return owners;
}

/** Squared screen distance between two points (sqrt-free hot-path compare). */
function distSq(a: ScreenPoint, b: ScreenPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * Squared screen distance from point `p` to the segment `a`→`b` (the line BODY is its
 * segments, not just its endpoints — Codex P1). Projects `p` onto the segment, clamps
 * to the endpoints, and returns the squared distance to the clamped foot.
 */
function distToSegmentSq(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return distSq(p, a); // degenerate segment (a === b).
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const foot: ScreenPoint = { x: a.x + t * vx, y: a.y + t * vy };
  return distSq(p, foot);
}

/**
 * Resolve what a screen click hit, vertex-first then feature body (受け入れ基準:
 * 頂点優先 → なければ地物). Vertex / point / line proximity uses a SCREEN-px radius so
 * the grab area is a constant on-screen size at every zoom; the leaf body uses
 * live-lookup's world-space containment (穴透過 honoured) — the single body rule.
 * Returns {@link EMPTY_HIT} when nothing is within reach.
 */
export function liveHitTestAt(
  input: LiveHitTestInput,
  worldPoint: WorldCoordinate,
): HitResult {
  const { root, time, toScreen, point } = input;
  const radius = input.radiusPx ?? DEFAULT_HIT_RADIUS_PX;
  const radiusSq = radius * radius;

  const features = featuresAt(root, time);
  const vertices = verticesAt(root, time);

  // 1. Nearest VERTEX within the screen-px radius (vertex-first priority).
  const owners = vertexOwners(features);
  let bestVertex: { featureId: FeatureId; vertexId: VertexId } | null = null;
  let bestDistSq = radiusSq;
  for (const [vertexId, featureId] of owners) {
    const v = getVertex(vertices, vertexId);
    if (v === undefined) continue;
    const d = distSq(toScreen(v.coordinate), point);
    if (d <= bestDistSq) {
      bestDistSq = d;
      bestVertex = { featureId, vertexId };
    }
  }
  if (bestVertex !== null) {
    return vertexHit(bestVertex.featureId, bestVertex.vertexId);
  }

  // 2. Topmost LEAF body under the cursor (world-space containment, 穴透過).
  const leaf = leafAtPoint(root, time, worldPoint);
  if (leaf !== null) return featureBodyHit(leaf);

  // 3. A POINT / LINE feature near the cursor (screen-px proximity — no fillable
  //    body). Nearest representative vertex wins, so a click on a stand-alone point /
  //    line selects that feature as its body.
  let bestBody: FeatureId | null = null;
  bestDistSq = radiusSq;
  for (const f of features) {
    if (f.kind === FEATURE_KIND.Point) {
      const v = getVertex(vertices, f.vertexId);
      if (v === undefined) continue;
      const d = distSq(toScreen(v.coordinate), point);
      if (d <= bestDistSq) {
        bestDistSq = d;
        bestBody = f.id;
      }
    } else if (f.kind === FEATURE_KIND.Line) {
      // A line BODY is its SEGMENTS (not just its endpoints — Codex P1): test the
      // screen distance from the cursor to each segment so a click on the middle of a
      // long segment selects the line.
      let prev: ScreenPoint | null = null;
      for (const vid of f.vertexIds) {
        const v = getVertex(vertices, vid);
        if (v === undefined) {
          prev = null; // a gap (unresolvable vertex) breaks the run.
          continue;
        }
        const cur = toScreen(v.coordinate);
        const d = prev === null ? distSq(cur, point) : distToSegmentSq(point, prev, cur);
        if (d <= bestDistSq) {
          bestDistSq = d;
          bestBody = f.id;
        }
        prev = cur;
      }
    }
  }
  if (bestBody !== null) return featureBodyHit(bestBody);

  return EMPTY_HIT;
}
