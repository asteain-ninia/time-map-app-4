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
import { wrapTurnsForLonSpan, type Camera, type Viewport } from '../../render';
import { LONGITUDE_PERIOD } from '../../domain/geo/seam';

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
  /**
   * The camera + viewport THIS frame drew with. Supplied so the hit-test can derive
   * the EXACT set of ±360° wrap turns the renderer painted each drawable at
   * (`wrapTurnsForLonSpan` — the SAME helper the Canvas renderer uses, 単一真実源).
   *
   * WHY (bughunt — ラップ複製で表示される点/頂点/線が掴めない): the renderer draws every
   * primitive once per ±360° turn its continuous longitude span overlaps the view
   * (canvas2d-renderer drawBatch). A point/vertex/line whose CANONICAL longitude is
   * off-screen but whose wrap REPLICA is on-screen is therefore visible — yet the
   * screen-px proximity test, projecting only the canonical longitude, could never
   * reach it. With `wrap` present the proximity test projects each drawable at every
   * drawn turn, and the area body probe enumerates the same per-shape turns (not a
   * fixed ±1), so『見えている＝掴める』holds at any pan/zoom (clip ⊇ draw ⊇ hit).
   *
   * When omitted (legacy callers / unit tests that draw a single non-wrapped frame),
   * the hit-test falls back to the canonical projection plus a ±1 turn area probe —
   * the previous behaviour, unchanged.
   */
  readonly wrap?: { readonly camera: Camera; readonly viewport: Viewport };
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
 * Does EVERY vertex of this line resolve in the live store this frame? The renderer
 * (committed-features Line branch) draws a line ALL-OR-NOTHING: if any one of its
 * vertexIds is unresolved it sets `resolvable=false` and drops the WHOLE primitive
 * (a line `[v1, missing, v2]` is NOT drawn). The hit-test MUST mirror that rule so
 * what-is-hit == what-is-drawn (clip ⊇ draw ⊇ hit): an undrawn line must contribute
 * NEITHER a grabbable vertex (vertexOwners) NOR a hittable body segment. Without this
 * the two paths diverged — vertexOwners claimed v1/v2 and the body path built
 * per-contiguous-run geometry around the gap, so an invisible line stayed selectable
 * by clicking its surviving endpoints / segments (bughunt: 描画とヒットの不一致).
 */
function lineFullyResolved(
  vertexIds: readonly VertexId[],
  vertices: ReturnType<typeof verticesAt>,
): boolean {
  return vertexIds.every((vid) => getVertex(vertices, vid) !== undefined);
}

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
 *
 * A LINE is additionally all-or-nothing (`lineFullyResolved`): a partially-corrupt
 * line whose render primitive is dropped contributes NO grabbable vertices — its
 * surviving endpoints must not stay selectable while invisible (bughunt 単一真実源:
 * committed-features と同じ全頂点解決チェック).
 */
export function vertexOwners(
  features: readonly Feature[],
  grabbable: ReadonlySet<FeatureId>,
  vertices: ReturnType<typeof verticesAt>,
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
        // Mirror the renderer's all-or-nothing draw: a line with ANY unresolved
        // vertex is not drawn, so none of its vertices are grabbable.
        if (lineFullyResolved(f.vertexIds, vertices)) {
          for (const vid of f.vertexIds) claim(vid, f.id);
        }
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

/**
 * The MINIMUM squared screen distance from `point` to a single world coordinate as the
 * renderer drew it — i.e. across every ±360° wrap replica its longitude was painted at
 * (bughunt: a vertex / point whose canonical lon is off-screen but whose replica is
 * on-screen must still be grabbable). The replica longitude is `coord.lon + offset`;
 * latitude is never wrapped. With no `wrap` frame `drawnLonOffsets` yields the
 * canonical ±1 set, so the canonical projection is always among the probes.
 */
function nearestDrawnDistSq(
  coord: WorldCoordinate,
  point: ScreenPoint,
  toScreen: ProjectToScreen,
  wrap: WrapFrame,
): number {
  const offsets = drawnLonOffsets(coord.lon, coord.lon, wrap);
  let best = Infinity;
  for (const off of offsets) {
    const d = distSq(toScreen({ lon: coord.lon + off, lat: coord.lat }), point);
    if (d < best) best = d;
  }
  return best;
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

/** The wrap configuration the hit-test resolves turns against (see LiveHitTestInput.wrap). */
type WrapFrame = { readonly camera: Camera; readonly viewport: Viewport } | undefined;

/**
 * The ±360° world-turn offsets (in DEGREES) at which the renderer drew a drawable
 * whose continuous-longitude content spans `[lonMin, lonMax]` (bughunt 単一真実源).
 *
 * With a `wrap` frame this delegates to the SAME `wrapTurnsForLonSpan` the Canvas
 * renderer uses, so the proximity/containment tests consider EXACTLY the replicas the
 * renderer painted (clip ⊇ draw ⊇ hit). Without one (legacy / single-frame tests) it
 * returns the canonical turn plus ±1 — the previous fixed probe — so behaviour is
 * unchanged for callers that did not draw wrap replicas.
 */
function drawnLonOffsets(lonMin: number, lonMax: number, wrap: WrapFrame): number[] {
  if (wrap === undefined) {
    return [0, LONGITUDE_PERIOD, -LONGITUDE_PERIOD];
  }
  const turns = wrapTurnsForLonSpan(lonMin, lonMax, wrap.camera, wrap.viewport);
  return turns.map((t) => t * LONGITUDE_PERIOD);
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
 * The renderer draws each polygon at its canonical longitude AND at every ±360°
 * replica its span overlaps the view; the hit-test must agree. A replica drawn at
 * `+offset°` covers the world `polygon.lon + offset`, so `worldPoint` lands inside it
 * iff `worldPoint.lon − offset` lands inside the canonical polygon. We therefore probe
 * the click at `worldPoint.lon − offset` for every offset the renderer drew THIS area
 * at (`drawnLonOffsets` — the SAME `wrapTurnsForLonSpan` the renderer uses, per the
 * area's OWN lon span, so a deep zoom-out replica at ±720° is not missed). Without a
 * `wrap` frame this falls back to the previous fixed ±1 probe.
 */
function drawnAreaAtPoint(
  areas: readonly ResolvedDisplayShape[],
  worldPoint: WorldCoordinate,
  wrap: WrapFrame,
): FeatureId | null {
  let hit: FeatureId | null = null;
  for (const area of areas) {
    const span = multiPolygonLonSpan(area.shape);
    const offsets =
      span === undefined ? [0] : drawnLonOffsets(span.min, span.max, wrap);
    const probes: WorldCoordinate[] = offsets.map((off) => ({
      lon: worldPoint.lon - off,
      lat: worldPoint.lat,
    }));
    const inside = area.shape.some((polygon) =>
      probes.some((p) => pointInPolygon(p, polygon) === POINT_LOCATION.Inside),
    );
    if (inside) hit = area.featureId; // keep scanning; a later (top) area wins
  }
  return hit;
}

/** The canonical-longitude span `[min, max]` over every ring of a multi-polygon, or undefined when empty. */
function multiPolygonLonSpan(
  shape: ResolvedDisplayShape['shape'],
): { min: number; max: number } | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (const polygon of shape) {
    for (const ring of polygon) {
      for (const c of ring) {
        if (c.lon < min) min = c.lon;
        if (c.lon > max) max = c.lon;
      }
    }
  }
  return min === Infinity ? undefined : { min, max };
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
  const { root, time, toScreen, point, wrap } = input;
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
  const owners = vertexOwners(features, grabbable, vertices);
  let bestVertex: { featureId: FeatureId; vertexId: VertexId } | null = null;
  let bestDistSq = radiusSq;
  for (const [vertexId, featureId] of owners) {
    const v = getVertex(vertices, vertexId);
    if (v === undefined) continue;
    const d = nearestDrawnDistSq(v.coordinate, point, toScreen, wrap);
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
  const area = drawnAreaAtPoint(areas, worldPoint, wrap);
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
      const d = nearestDrawnDistSq(v.coordinate, point, toScreen, wrap);
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
      // ALL-OR-NOTHING (bughunt 描画とヒットの不一致): committed-features drops the WHOLE
      // line primitive when ANY vertexId is unresolved (resolvable=false). The body
      // hit-test must do the same — otherwise a partially-corrupt line that is NOT
      // drawn would still be selectable via its surviving segments. Reject it before
      // contributing any segment so what-is-hit == what-is-drawn (clip ⊇ draw ⊇ hit).
      if (!lineFullyResolved(f.vertexIds, vertices)) continue;
      //
      // Resolve the line's vertices into a per-vertex {coord | gap} list, then unwrap
      // the longitudes of each CONTIGUOUS resolvable run independently (a gap breaks
      // the run, matching the segment-break below). Latitude is never wrapped.
      const resolved = f.vertexIds.map((vid) => getVertex(vertices, vid));
      // Per-run unwrapped runs (each a list of {lon (unwrapped), lat}).
      const runs: { lon: number; lat: number }[][] = [];
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
        runs.push(run.map((c, i) => ({ lon: unwrappedLons[i]!, lat: c.lat })));
        runStart = runEnd;
      }
      // WRAP 単一真実源 (bughunt): the renderer draws the WHOLE line primitive once per
      // ±360° turn its (unwrapped) longitude span overlaps the view — a seam line whose
      // canonical run is off-screen still shows its replica, so the body hit must test
      // every drawn replica. Derive the turns from the line's full unwrapped lon span
      // (the SAME span the renderer's `primitiveLonSpan` feeds `wrapTurnsForLonSpan`),
      // then offset every run's longitudes by each turn before projecting.
      let lonMin = Infinity;
      let lonMax = -Infinity;
      for (const run of runs) {
        for (const c of run) {
          if (c.lon < lonMin) lonMin = c.lon;
          if (c.lon > lonMax) lonMax = c.lon;
        }
      }
      const offsets =
        lonMin === Infinity ? [0] : drawnLonOffsets(lonMin, lonMax, wrap);
      for (const off of offsets) {
        for (const run of runs) {
          let prev: ScreenPoint | null = null;
          for (const c of run) {
            const cur = toScreen({ lon: c.lon + off, lat: c.lat });
            const d = prev === null ? distSq(cur, point) : distToSegmentSq(point, prev, cur);
            if (d <= bestDistSq) {
              bestDistSq = d;
              bestBody = f.id;
            }
            prev = cur;
          }
        }
      }
    }
  }
  if (bestBody !== null) return featureBodyHit(bestBody);

  return EMPTY_HIT;
}
