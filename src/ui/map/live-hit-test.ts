// HB-15 / Codex #2 — the LIVE map hit-test rule: a screen point → a U22 {@link HitResult}.
//
// WHY THIS FILE EXISTS (教訓 5.7 合成ルートの結線漏れ / 教訓 5.29 単一真実源):
// The screen→world math (HB-7) and the live domain-lookup (live-lookup.ts) both
// exist and are correct, but the map pointer dispatcher in the composition root was
// backed by EMPTY_HIT_TESTER, so a real edit-mode click on a vertex / feature
// resolved to nothing and could never select. This module is the ONE place that
// turns "the click landed HERE on screen" into "this vertex / this feature was hit".
//
// CODEX #2 ROOT FIX (集約表示中の不一致 P1): the hit-test must resolve against the
// SAME set the renderer DRAWS — not the raw leaf set. The map draws AREAS through
// the U34 display pipeline (`resolveDisplayControl` → committed-features /
// buildDisplayAreas), which applies the store's displayControl (global depth N +
// individual focus M, FR-42 / FR-43) and resolves each drawable's 集約/実形状 via
// U08's SINGLE `resolveFeatureArea`. With the default N=0 the map shows top-level
// AGGREGATES rolled up (not every leaf), and the child leaves are OMITTED (not
// drawn). The previous hit-test ignored that: it tested the raw leaf bodies
// (live-lookup.leafAtPoint) and EVERY committed leaf's vertices, so a click on an
// aggregate body selected a HIDDEN child leaf, and a click near a hidden child's
// vertex selected an undrawn vertex (描画されていないものがクリックで選ばれる).
//
// The fix aligns the hit-test to the SAME DISPLAY RESOLUTION the renderer uses: the
// area hit-test runs the EXACT `resolveDisplayControl` that `committed-features`
// feeds `buildDisplayAreas`, so the集約/実形状/省略 decision is one source. Vertices
// are grabbable ONLY for area features drawn with their OWN real shape (verdict Real);
// an AGGREGATE-displayed feature's body click selects the AGGREGATE (its `featureId`),
// and the hidden children / derived vertices are never picked. (NOTE: the renderer
// additionally applies LOD simplification at low zoom before painting; the hit-test
// uses the UN-simplified resolved shape, so this aligns the DISPLAY-CONTROL decision,
// not the per-pixel painted outline — the P1 集約/省略 不一致 is what this closes.)
//
// POINTS / LINES carry no hierarchy area (no rollup); `committed-features` draws them
// directly at every depth. So their proximity hit-test is unchanged — they are always
// drawn as-is and always grabbable.
//
// PRIORITY (受け入れ基準: 頂点優先 → なければ地物, 教訓 5.9 排他分岐の優先順位):
//   1. The nearest DRAWN VERTEX within `radiusPx` SCREEN pixels of the cursor — only
//      vertices of features actually drawn with their own shape (Real-verdict areas,
//      plus every point/line). Aggregated / omitted areas contribute none.
//   2. Else the topmost DRAWN AREA whose resolved shape contains the cursor (world
//      containment, 穴透過). For an aggregate that is the AGGREGATE's集約形状, so the
//      aggregate is selected — never a hidden child leaf.
//   3. Else a POINT / LINE feature within the screen-px radius (no fillable body).
//   4. Else {@link EMPTY_HIT} (empty space → clears selection downstream).
//
// PURITY: no React, no store, no Canvas. It builds fresh arrays; inputs are never
// mutated.

import { FEATURE_KIND, type Feature } from '../../domain/feature';
import type { FeatureId, VertexId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import type { TimePoint } from '../../domain/time/time-point';
import { getVertex } from '../../domain/vertex';
import { unwrapLonSequence } from '../../domain/geo/longitude';
import {
  EMPTY_HIT,
  featureBodyHit,
  vertexHit,
  type HitResult,
} from '../../domain/selection';
import type { ScreenPoint } from '../../render';
import { featuresAt, verticesAt } from '../live-lookup';
import type { WorldCoordinate } from '../../domain/coordinate';
import { buildForest } from '../../domain/hierarchy/forest';
import {
  DISPLAY_VERDICT,
  type ResolvedDisplayShape,
} from '../../domain/display';
import { pointInPolygon, POINT_LOCATION } from '../../domain/geometry/predicates';
import {
  resolveDisplayControl,
  type DisplayControlInput,
} from '../../render/display-pipeline';

/** Project a world coordinate to surface-relative screen px (U17 forward transform). */
export type ProjectToScreen = (world: WorldCoordinate) => ScreenPoint;

/** The inputs one hit-test needs (the live root + time + projector + click). */
export interface LiveHitTestInput {
  readonly root: DomainProject;
  readonly time: TimePoint;
  /**
   * The display-control (FR-42 / FR-43) THIS frame drew with: global depth N +
   * individual focus M. The hit-test resolves the SAME aggregate/real shape set the
   * renderer fills (committed-features), so what is hit is exactly what is drawn
   * (Codex #2: 単一真実源). When omitted, the hit-test falls back to N=0 / no focus
   * (the same default the store and renderer use).
   */
  readonly displayControl?: DisplayControlInput;
  /** World → surface screen px (the SAME transform the renderer drew with). */
  readonly toScreen: ProjectToScreen;
  /** The click point in surface-relative screen px (box-offset already removed). */
  readonly point: ScreenPoint;
  /** The grab radius in SCREEN px for a vertex / point / line hit (default 8). */
  readonly radiusPx?: number;
}

/** Default screen-px grab radius for a vertex / point / line hit. */
export const DEFAULT_HIT_RADIUS_PX = 8;

/** The display-control fallback when none is supplied (= the store/renderer default). */
const DEFAULT_DISPLAY_CONTROL: DisplayControlInput = {
  globalDepth: 0,
  focus: { originId: null, depth: 0, emphasize: false },
};

/**
 * Collect every committed vertex's OWNING feature (point.vertexId / line.vertexIds /
 * leaf ring vertexIds), but ONLY for features whose ids are in `grabbable`. The
 * first owner encountered wins for a shared vertex — a shared vertex still selects A
 * real owner feature, which is all the U22 contract needs (a vertex hit carries its
 * owner + the vertex id). Aggregates carry no own vertices (their area is derived),
 * so they contribute none even when present.
 *
 * `grabbable` is the set of feature ids actually DRAWN with their own vertices this
 * frame (Real-verdict areas + every point / line). An aggregated or omitted area
 * leaf is NOT in the set, so its (hidden) vertices are never offered for selection
 * (Codex #2: 描画されていない頂点は拾わない).
 */
export function vertexOwners(
  features: readonly Feature[],
  grabbable: ReadonlySet<FeatureId>,
): Map<VertexId, FeatureId> {
  const owners = new Map<VertexId, FeatureId>();
  const claim = (vid: VertexId, fid: FeatureId): void => {
    if (!owners.has(vid)) owners.set(vid, fid);
  };
  for (const f of features) {
    if (!grabbable.has(f.id)) continue;
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
 * The AREA features (leaf + aggregate) effective at `time`, resolved through the
 * U34 display pipeline against `control` — i.e. the EXACT `ResolvedDisplayShape`
 * set the renderer draws (committed-features runs the same `resolveDisplayControl`).
 * Omitted features and U08 failures are not in the list, so they are never hit.
 */
function drawnAreas(
  features: readonly Feature[],
  store: ReturnType<typeof verticesAt>,
  control: DisplayControlInput,
): readonly ResolvedDisplayShape[] {
  const areaFeatures = features.filter(
    (f) => f.kind === FEATURE_KIND.Leaf || f.kind === FEATURE_KIND.Aggregate,
  );
  const forest = buildForest(areaFeatures);
  return resolveDisplayControl(forest, store, control).shapes;
}

/**
 * The topmost drawn AREA whose resolved (drawn) shape contains `worldPoint`, else
 * null. The shape is whatever U34 resolved for the verdict — an aggregate's集約形状
 * or a leaf's own shape — so a body click selects the feature the user actually SEES
 * (the aggregate when aggregated; the leaf when real). 穴透過 honoured via the domain
 * `pointInPolygon` predicate (single containment rule); a point on / inside a hole is
 * not a hit. Later drawables (drawn on top) win on overlap, matching the paint order.
 *
 * The renderer draws each polygon at its canonical longitude AND at ±360° replicas
 * (a polygon spanning the antimeridian is shown wrapped); the hit-test must agree, so
 * we probe the click point in each ±360° longitude frame (same rule as
 * live-lookup.leafAtPoint — 単一真実源 of the wrap probe).
 */
function drawnAreaAtPoint(
  areas: readonly ResolvedDisplayShape[],
  worldPoint: WorldCoordinate,
): FeatureId | null {
  const probes: WorldCoordinate[] = [
    worldPoint,
    { lon: worldPoint.lon + 360, lat: worldPoint.lat },
    { lon: worldPoint.lon - 360, lat: worldPoint.lat },
  ];
  let hit: FeatureId | null = null;
  for (const area of areas) {
    const inside = area.shape.some((polygon) =>
      probes.some((p) => pointInPolygon(p, polygon) === POINT_LOCATION.Inside),
    );
    if (inside) hit = area.featureId; // keep scanning; a later (top) area wins
  }
  return hit;
}

/**
 * Resolve what a screen click hit, vertex-first then feature body (受け入れ基準:
 * 頂点優先 → なければ地物). The set considered is EXACTLY what the renderer drew this
 * frame: areas through the U34 display pipeline (`displayControl` honoured —
 * aggregate/real/omit), points / lines directly. Vertex / point / line proximity uses
 * a SCREEN-px radius so the grab area is a constant on-screen size at every zoom; the
 * area body uses the drawn shape's world-space containment (穴透過 honoured).
 * Returns {@link EMPTY_HIT} when nothing drawn is within reach.
 */
export function liveHitTestAt(
  input: LiveHitTestInput,
  worldPoint: WorldCoordinate,
): HitResult {
  const { root, time, toScreen, point } = input;
  const control = input.displayControl ?? DEFAULT_DISPLAY_CONTROL;
  const radius = input.radiusPx ?? DEFAULT_HIT_RADIUS_PX;
  const radiusSq = radius * radius;

  const features = featuresAt(root, time);
  const vertices = verticesAt(root, time);

  // The drawn area set (集約/実形状) — the SAME resolution committed-features draws.
  const areas = drawnAreas(features, vertices, control);

  // Which features expose their OWN vertices this frame: area features drawn with
  // their own real shape (verdict Real), plus every point / line (always drawn
  // directly). An aggregate-displayed area (verdict Aggregate) draws derived geometry
  // with NO grabbable own vertices, and an omitted leaf is not drawn at all — so
  // neither contributes a vertex (Codex #2: 非表示頂点は拾わない).
  const grabbable = new Set<FeatureId>();
  for (const area of areas) {
    if (area.verdict === DISPLAY_VERDICT.Real) grabbable.add(area.featureId);
  }
  for (const f of features) {
    if (f.kind === FEATURE_KIND.Point || f.kind === FEATURE_KIND.Line) {
      grabbable.add(f.id);
    }
  }

  // 1. Nearest DRAWN VERTEX within the screen-px radius (vertex-first priority).
  const owners = vertexOwners(features, grabbable);
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

  // 2. Topmost DRAWN AREA body under the cursor (resolved-shape containment, 穴透過).
  //    For an aggregate this is the AGGREGATE's 集約形状 → the aggregate is selected,
  //    never a hidden child leaf.
  const area = drawnAreaAtPoint(areas, worldPoint);
  if (area !== null) return featureBodyHit(area);

  // 3. A POINT / LINE feature near the cursor (screen-px proximity — no fillable
  //    body). Nearest representative vertex / segment wins, so a click on a stand-alone
  //    point / line selects that feature as its body.
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
      //
      // SEAM 単一真実源 (bughunt): the renderer (committed-features) does NOT project
      // each vertex's raw stored longitude — it first runs U04's `unwrapLonSequence`
      // so a line straddling the antimeridian draws as ONE continuous run (e.g. the
      // stored representatives [179, -179] become [179, 181], a short ~2° segment).
      // The hit-test MUST project the SAME unwrapped geometry; projecting the raw
      // stored lon (-179) instead makes the body a ~358° segment crossing the screen
      // centre, so the click misses the drawn seam segment and false-hits mid-screen.
      // We delegate to the SAME unwrap rule the renderer uses (never re-derive it).
      //
      // Resolve the line's vertices into a per-vertex {coord | gap} list, then unwrap
      // the longitudes of each CONTIGUOUS resolvable run independently (a gap breaks
      // the run, matching the segment-break below). Latitude is never wrapped.
      const resolved = f.vertexIds.map((vid) => getVertex(vertices, vid));
      let runStart = 0;
      while (runStart < resolved.length) {
        if (resolved[runStart] === undefined) {
          runStart += 1;
          continue;
        }
        let runEnd = runStart;
        while (runEnd < resolved.length && resolved[runEnd] !== undefined) {
          runEnd += 1;
        }
        const run = resolved.slice(runStart, runEnd).map((v) => v!.coordinate);
        const unwrappedLons = unwrapLonSequence(run.map((c) => c.lon));
        let prev: ScreenPoint | null = null;
        run.forEach((c, i) => {
          const cur = toScreen({ lon: unwrappedLons[i]!, lat: c.lat });
          const d = prev === null ? distSq(cur, point) : distToSegmentSq(point, prev, cur);
          if (d <= bestDistSq) {
            bestDistSq = d;
            bestBody = f.id;
          }
          prev = cur;
        });
        runStart = runEnd;
      }
    }
  }
  if (bestBody !== null) return featureBodyHit(bestBody);

  return EMPTY_HIT;
}
