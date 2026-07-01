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
//      plus every point/line). Aggregated / omitted areas contribute none — EXCEPT the
//      ACTIVE feature, whose OWN vertex handles are drawn (active-feature-handles) and so
//      must be grabbable even when it is aggregation-omitted (draw ⊇ hit — same computeHandles
//      the draw path uses, FR-87 pattern extended from edges to vertices).
//   1.5. Else the nearest EDGE-MIDPOINT handle of the ACTIVE feature within the screen-px
//      radius (FR-87 add-a-new-vertex). Edge handles are a selection-scoped affordance
//      (only the active feature has them), so this step runs only when an active feature
//      is supplied; a vertex (step 1) still wins inside the same radius.
//   2. Else a POINT / LINE feature within the screen-px radius (no fillable body).
//   3. Else the topmost DRAWN AREA whose resolved shape contains the cursor (world
//      containment, 穴透過). For an aggregate that is the AGGREGATE's集約形状, so the
//      aggregate is selected — never a hidden child leaf.
//   4. Else {@link EMPTY_HIT} (empty space → clears selection downstream).
//
// BODY ORDER = REVERSE DRAW ORDER (bughunt 前面の line をクリックして背面の area が選ばれる,
// 教訓 5.14): the renderer paints AREAS first, then LINES, then POINTS (feature-layer
// buildFeaturePrimitives), so a point / line drawn over an area is visually ON TOP. The
// body hit-test therefore probes point / line bodies (step 2) BEFORE the area body
// (step 3) so the feature the user SEES on top is the one grabbed (『見えている＝掴める』).
// Vertices still win over every body (step 1).
//
// PURITY: no React, no store, no Canvas. It builds fresh arrays; inputs are never
// mutated.

import { FEATURE_KIND, type Feature } from '../../domain/feature';
import type { FeatureId, VertexId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import type { TimePoint } from '../../domain/time/time-point';
import { getVertex, type VertexStore } from '../../domain/vertex';
import { unwrapLonSequence } from '../../domain/geo/longitude';
import {
  EMPTY_HIT,
  featureBodyHit,
  vertexHit,
  edgeHit,
  type HitResult,
} from '../../domain/selection';
import {
  computeHandles,
  EMPTY_HANDLES,
  type EdgeHandle,
  type EditHandles,
} from '../../domain/editing/handles';
import type { ScreenPoint } from '../../render';
import type { WorldCoordinate } from '../../domain/coordinate';
import type { ResolvedDisplayShape } from '../../domain/display';
import { pointInPolygon, POINT_LOCATION } from '../../domain/geometry/predicates';
import type { DisplayControlInput } from '../../render/display-pipeline';
import {
  resolveDisplayFor,
  lineFullyResolved,
  vertexOwners,
} from './display-resolution-cache';
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
  /**
   * The currently-active feature (FR-87), or null / undefined when none is selected.
   * ONLY this feature exposes grabbable EDGE-midpoint handles (add-a-new-vertex, U24
   * EDIT_TOOL.EdgeAdd) — an edge handle is a selection-scoped affordance, unlike a
   * vertex / body which is grabbable for any drawn feature. When present its edge
   * midpoints are probed (step 1.5) between the vertex path and the body path, so a
   * click on an edge midpoint returns an {@link HIT_KIND.Edge} hit rather than the
   * feature body underneath it.
   */
  readonly activeFeature?: FeatureId | null;
}

/** Default screen-px grab radius for a vertex / point / line hit. */
export const DEFAULT_HIT_RADIUS_PX = 8;

/** The display-control fallback when none is supplied (= the store/renderer default). */
const DEFAULT_DISPLAY_CONTROL: DisplayControlInput = {
  globalDepth: 0,
  focus: { originId: null, depth: 0, emphasize: false },
};

// `lineFullyResolved` (the「描かれる線か」predicate) and `vertexOwners` (the grabbable
// vertex → owner map) now live in `display-resolution-cache` so the owner map is built
// ONCE per (root, time, displayControl) generation and shared by the draw + hit paths,
// instead of being rebuilt on every pointer event (bughunt3 — O(n·v) Map rebuild per
// pointerdown). They are re-exported here unchanged for the line-BODY probe below and
// for the per-frame default-control fallback / tests (single source, 教訓 5.30).
export { lineFullyResolved, vertexOwners };

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

/**
 * The wrap configuration the hit-test resolves turns against (see LiveHitTestInput.wrap),
 * AUGMENTED with the cursor's continuous world longitude and a degree margin. The cursor
 * fields let {@link drawnLonOffsets} clamp the drawn-turn enumeration to ONLY the few
 * replicas whose on-screen footprint can actually reach the cursor — see the tail-latency
 * note on that function. They are derived once per `liveHitTestAt` call (the cursor world
 * point and the screen-px grab radius the caller already supplies), never per drawable.
 */
type WrapFrame =
  | {
      readonly camera: Camera;
      readonly viewport: Viewport;
      /** The cursor's continuous world longitude (degrees) — the click's world lon. */
      readonly cursorLon: number;
      /** Half-window in DEGREES around the cursor a replica may sit and still be hittable. */
      readonly marginDeg: number;
    }
  | undefined;

/** The public 2-field wrap input the caller supplies (camera + viewport only). */
type WrapInput = { readonly camera: Camera; readonly viewport: Viewport } | undefined;

/**
 * Build the internal {@link WrapFrame} from the caller's `wrap` input plus the cursor's
 * world longitude and the screen-px grab radius, deriving the per-call cursor window the
 * drawn-turn enumeration is clamped to (see {@link drawnLonOffsets} TAIL-LATENCY CLAMP).
 *
 * `marginDeg` converts the screen-px grab radius into degrees via the frame's zoom (px per
 * degree) so the same window serves both the proximity probes (a vertex/point/line is
 * hittable within `radiusPx`) and the area-body containment (margin only over-includes by
 * at most one turn on each side — never under-includes a replica that could contain the
 * cursor). A non-finite/≤0 zoom (unmeasured camera) yields a 0 margin: the cursor turn
 * itself still resolves, and such a frame draws no real replicas anyway.
 */
function buildWrapFrame(wrap: WrapInput, cursorLon: number, radiusPx: number): WrapFrame {
  if (wrap === undefined) return undefined;
  const zoom = wrap.camera.zoom;
  const marginDeg = Number.isFinite(zoom) && zoom > 0 ? radiusPx / zoom : 0;
  return { camera: wrap.camera, viewport: wrap.viewport, cursorLon, marginDeg };
}

/**
 * The ±360° world-turn offsets (in DEGREES) at which the renderer drew a drawable whose
 * continuous-longitude content spans `[lonMin, lonMax]` AND whose replica can actually
 * reach the cursor (bughunt 単一真実源 + tail-latency clamp).
 *
 * With a `wrap` frame this delegates to the SAME `wrapTurnsForLonSpan` the Canvas renderer
 * uses, so the proximity/containment tests consider the replicas the renderer painted
 * (clip ⊇ draw ⊇ hit). Without one (legacy / single-frame tests) it returns the canonical
 * turn plus ±1 — the previous fixed probe — so behaviour is unchanged for those callers.
 *
 * TAIL-LATENCY CLAMP (bughunt2 — 病的ズームでの O(features × wrap-replicas) 抑制):
 * `wrapTurnsForLonSpan` is BOUNDED (MAX_WRAP_REPLICAS) but can still return tens of
 * thousands of turns at a pathological full zoom-out. The hit-test would otherwise probe
 * EVERY such replica for EVERY vertex / line-vertex / polygon-ring on every pointerdown —
 * tens of millions of synchronous projections that jank the UI thread. But a replica only
 * matters to the hit-test if its shifted footprint `[lonMin + off, lonMax + off]` lies
 * within `marginDeg` of the cursor longitude (a vertex/point/line is grabbable only inside
 * the screen-px radius; an area body only when the cursor is inside it). Replicas are
 * spaced exactly one period apart, so the relevant turns form a TINY contiguous window:
 *   off ∈ [cursorLon − lonMax − margin, cursorLon − lonMin + margin]
 * i.e. turns ∈ [ceil(lo/period), floor(hi/period)]. We INTERSECT that cursor window with
 * the renderer's drawn turn range so the result is a SUBSET of what the renderer painted
 * (clip ⊇ draw ⊇ hit is preserved — we never probe a turn the renderer did NOT draw, and
 * we never drop a drawn turn that could be near the cursor). The probe count is now
 * O(span-in-turns) bounded by the cursor window (≈ 1 + 2·margin/period turns), independent
 * of how many total turns the viewport spans — so the per-pointerdown cost stays small even
 * at the cap.
 */
function drawnLonOffsets(lonMin: number, lonMax: number, wrap: WrapFrame): number[] {
  if (wrap === undefined) {
    return [0, LONGITUDE_PERIOD, -LONGITUDE_PERIOD];
  }
  const turns = wrapTurnsForLonSpan(lonMin, lonMax, wrap.camera, wrap.viewport);
  if (turns.length <= 1) return turns.map((t) => t * LONGITUDE_PERIOD);

  // Clamp the drawn turns to the cursor's reachable window (see TAIL-LATENCY CLAMP). The
  // window edges come from "the cursor lon lies within [lonMin+off−margin, lonMax+off+margin]".
  // `wrapTurnsForLonSpan` returns a CONTIGUOUS ascending integer range, so its bounds are
  // `turns[0]`..`turns[last]` — we intersect that range with the cursor window ARITHMETICALLY
  // and enumerate ONLY the (tiny) overlap, never walking the full (possibly huge) turn list.
  // A non-finite span/cursor (cannot happen for drawn geometry, but be defensive) skips the
  // clamp and keeps the full drawn set so correctness never depends on the optimisation.
  if (
    !Number.isFinite(lonMin) ||
    !Number.isFinite(lonMax) ||
    !Number.isFinite(wrap.cursorLon) ||
    !Number.isFinite(wrap.marginDeg)
  ) {
    return turns.map((t) => t * LONGITUDE_PERIOD);
  }
  const drawnMin = turns[0]!;
  const drawnMax = turns[turns.length - 1]!;
  const windowLo = Math.ceil((wrap.cursorLon - lonMax - wrap.marginDeg) / LONGITUDE_PERIOD);
  const windowHi = Math.floor((wrap.cursorLon - lonMin + wrap.marginDeg) / LONGITUDE_PERIOD);
  // Intersection of the drawn range [drawnMin, drawnMax] with the cursor window.
  const lo = windowLo > drawnMin ? windowLo : drawnMin;
  const hi = windowHi < drawnMax ? windowHi : drawnMax;
  // A drawn span with NO replica near the cursor contributes nothing (the drawable simply
  // is not under the cursor) — return the empty set rather than the full turn list.
  const result: number[] = [];
  for (let t = lo; t <= hi; t += 1) result.push(t * LONGITUDE_PERIOD);
  return result;
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
    // Probe each replica offset INLINE (no intermediate `probes[]` array): a replica
    // drawn at `+off°` covers `polygon.lon + off`, so the click lands inside it iff
    // `worldPoint.lon − off` lands inside the canonical polygon. Iterating offsets in
    // the outer loop lets the first matching (offset, polygon) pair exit early.
    const inside = offsets.some((off) => {
      const probe: WorldCoordinate = { lon: worldPoint.lon - off, lat: worldPoint.lat };
      return area.shape.some(
        (polygon) => pointInPolygon(probe, polygon) === POINT_LOCATION.Inside,
      );
    });
    if (inside) hit = area.featureId; // keep scanning; a later (top) area wins
  }
  return hit;
}

// Longitude-span MEMOIZATION (bughunt3 #medium: per-area-per-hit-test recompute).
// `drawnAreaAtPoint` calls `multiPolygonLonSpan(area.shape)` for EVERY area on EVERY
// pointerdown / pointermove that reaches the area-body probe, and the span is a
// triple-nested walk (polygon → ring → coord) over every vertex. The `shape` arrays
// are IMMUTABLE between display-resolution generations and are shared across frames
// via the `display-resolution-cache` memo (keyed on `(root, time, displayControl)`
// identity), so the SAME array reference recurs across a stream of pointer events.
// The span is a pure function of that array, so we cache it KEYED BY THE ARRAY
// REFERENCE: repeated events on a stable resolution hit the cache (O(1)); a fresh
// resolution brings fresh `shape` arrays that miss and recompute once. A WeakMap lets
// a shape dropped on the next resolution be GC'd with its cached span (no unbounded
// growth). This mirrors `lonSpanCache` in canvas2d-renderer.ts. `undefined` (empty
// shape) is a valid cached value, distinguished via `.has`.
const lonSpanCache = new WeakMap<
  ResolvedDisplayShape['shape'],
  { min: number; max: number } | undefined
>();

/**
 * The canonical-longitude span `[min, max]` over every ring of a multi-polygon, or
 * undefined when empty — MEMOIZED by the `shape` array reference (see `lonSpanCache`).
 * Exported for the regression that pins the reference-keyed cache contract.
 */
export function multiPolygonLonSpan(
  shape: ResolvedDisplayShape['shape'],
): { min: number; max: number } | undefined {
  if (lonSpanCache.has(shape)) return lonSpanCache.get(shape);
  const span = computeMultiPolygonLonSpan(shape);
  lonSpanCache.set(shape, span);
  return span;
}

function computeMultiPolygonLonSpan(
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

/** The inputs the display-control-aware area lookup needs (the live root + time + control). */
export interface DrawnAreaAtPointInput {
  readonly root: DomainProject;
  readonly time: TimePoint;
  /**
   * The display-control (FR-42 / FR-43) the frame drew with: global depth N +
   * individual focus M. The lookup resolves the SAME aggregate/real shape set the
   * renderer fills (committed-features), so what is returned is exactly what is
   * drawn. When omitted, falls back to N=0 / no focus (the renderer default).
   */
  readonly displayControl?: DisplayControlInput | undefined;
  /**
   * The camera + viewport the frame drew with, used to enumerate the EXACT ±360°
   * wrap turns the renderer painted each area at (`wrapTurnsForLonSpan`). When
   * omitted, falls back to a fixed ±1 turn probe (the previous behaviour).
   */
  readonly wrap?: { readonly camera: Camera; readonly viewport: Viewport } | undefined;
}

/**
 * The topmost DRAWN AREA whose resolved (drawn) shape contains `worldPoint`, else
 * null — resolved through the U34 display pipeline against the supplied
 * display-control, i.e. the EXACT set the renderer draws and the main hit-test
 * (`liveHitTestAt`) area branch picks (単一真実源).
 *
 * WHY THIS EXISTS (bughunt — ナイフの対象面探索が displayControl を無視): the knife
 * `featureAtPoint` port previously used the raw `live-lookup.leafAtPoint`, which
 * tests every committed leaf body regardless of what is drawn. With the default
 * N=0 the map shows top-level AGGREGATES rolled up and OMITS the child leaves, so
 * clicking an aggregate body returned a HIDDEN child leaf as the split target
 * (描画されていないものが選ばれる, 二重真実源). Routing the knife through THIS lookup —
 * the same `drawnAreas` + `drawnAreaAtPoint` `liveHitTestAt` uses — makes 対象面選択
 * agree with both the renderer and the main hit-test: a body click resolves to the
 * AGGREGATE the user sees (which the hook's LEAF gate then rejects as unsplittable),
 * never to an undrawn child leaf. Aggregate vs leaf is the display verdict's job;
 * this returns whichever feature the user actually SEES under the cursor.
 */
export function drawnAreaAt(
  input: DrawnAreaAtPointInput,
  worldPoint: WorldCoordinate,
): FeatureId | null {
  const control = input.displayControl ?? DEFAULT_DISPLAY_CONTROL;
  // The SAME shared resolution committed-features draws and liveHitTestAt hits, computed
  // once per (root, time, control) generation (教訓 5.29, bughunt2 perf). The knife click
  // then reuses the frame's already-resolved area set instead of rebuilding the whole
  // hierarchy/display pipeline a second/third time per interaction.
  const areas = resolveDisplayFor(input.root, input.time, control).resolved.shapes;
  // The knife has no own grab radius; an area body click resolves by world containment, so
  // the cursor window margin is just the default grab radius (over-includes ≤1 turn, never
  // under-includes a containing replica — see drawnLonOffsets TAIL-LATENCY CLAMP).
  const wrap = buildWrapFrame(input.wrap, worldPoint.lon, DEFAULT_HIT_RADIUS_PX);
  return drawnAreaAtPoint(areas, worldPoint, wrap);
}

/**
 * The ACTIVE feature's OWN edit-handle set (vertex + edge handles), or EMPTY_HANDLES when
 * there is no active feature / it is not drawn / it is an aggregate. Resolved from the
 * SAME `computeHandles(feature, store)` the render layer (active-feature-handles) draws the
 * handles with, over the SAME shared display vertex store the hit-test grabs against
 * (単一真実源, 教訓 5.29 — 描画 ⊇ ヒット).
 *
 * WHY (active-leaf-handles-draw-hit): the active feature's handles are DRAWN regardless of
 * its display verdict (a user-selected leaf whose vertices are aggregation-omitted still
 * shows its own handles), so they must be grabbable regardless of verdict too — the
 * `owners`/`grabbable` set only carries verdict-Real vertices. FR-87 already routed the
 * EDGE hit through `computeHandles(activeFeature)` for exactly this reason; this shared
 * resolution feeds BOTH the vertex step and the edge step off the ONE call.
 */
function resolveActiveHandles(
  activeFeature: FeatureId | null | undefined,
  features: readonly Feature[],
  areaFeaturesById: ReadonlyMap<FeatureId, Feature>,
  vertices: VertexStore,
): EditHandles {
  if (activeFeature == null) return EMPTY_HANDLES;
  const feature =
    areaFeaturesById.get(activeFeature) ?? features.find((f) => f.id === activeFeature);
  if (feature === undefined) return EMPTY_HANDLES;
  return computeHandles(feature, vertices);
}

/**
 * Resolve what a screen click hit, vertex-first then feature body (受け入れ基準:
 * 頂点優先 → なければ地物). The set considered is EXACTLY what the renderer drew this
 * frame: areas through the U34 display pipeline (`displayControl` honoured —
 * aggregate/real/omit), points / lines directly. Vertex / point / line proximity uses
 * a SCREEN-px radius so the grab area is a constant on-screen size at every zoom; the
 * area body uses the drawn shape's world-space containment (穴透過 honoured).
 *
 * Feature BODIES are probed in REVERSE draw order — point / line BEFORE area — because
 * the renderer paints areas underneath lines and points (feature-layer); a point / line
 * drawn over an area is on top, so it must be grabbed first (bughunt 前面の line をクリック
 * して背面の area が選ばれる). Vertices (step 1) still win over every body.
 *
 * Returns {@link EMPTY_HIT} when nothing drawn is within reach.
 */
export function liveHitTestAt(
  input: LiveHitTestInput,
  worldPoint: WorldCoordinate,
): HitResult {
  const { root, time, toScreen, point, activeFeature } = input;
  const control = input.displayControl ?? DEFAULT_DISPLAY_CONTROL;
  const radius = input.radiusPx ?? DEFAULT_HIT_RADIUS_PX;
  const radiusSq = radius * radius;
  // Augment the caller's wrap input with the cursor world longitude + a degree margin so the
  // drawn-turn enumeration is clamped to the few replicas that can reach the cursor — keeping
  // a pathological full-zoom-out pointerdown O(features × cursor-window) instead of
  // O(features × total-turns) (bughunt2 tail-latency clamp; see drawnLonOffsets).
  const wrap = buildWrapFrame(input.wrap, worldPoint.lon, radius);

  // The SHARED resolution: featuresAt / verticesAt, the drawn area set (集約/実形状), AND
  // the selection-independent `grabbable` set + `owners` vertex→feature map — all computed
  // ONCE per (root, time, control) generation and reused by committed-features (draw). So a
  // pointerdown does NOT re-run the U34 hierarchy/display pipeline the just-drawn frame
  // already computed, AND does NOT rebuild the O(n·v) owner Map over every leaf ring vertex
  // on every pointer event (bughunt3 — a 5000-leaf × 100-vertex map was 500,000 Map
  // insertions PER pointer event before the proximity test even began). On an unchanged
  // domain a pointer-move is a cache HIT with zero re-insertions (教訓 5.29 単一真実源 =
  // 単一 COMPUTATION). `grabbable` / `owners` are exactly what this function built inline
  // before — same values, now memoised — so behaviour is unchanged (see vertexOwners).
  const { features, areaFeaturesById, vertices, resolved, owners } = resolveDisplayFor(
    root,
    time,
    control,
  );
  const areas = resolved.shapes;

  // The ACTIVE feature's OWN handle set (vertices + edges), computed ONCE from the SAME
  // `computeHandles` the render layer (active-feature-handles) draws with, over the SAME
  // shared display vertex store the vertex path uses (単一真実源, 教訓 5.29 — 描画 ⊇ ヒット).
  // Both the vertex step (1) and the edge step (1.5) probe against this, so a handle is
  // grabbable exactly where it is drawn — INCLUDING when the active leaf is aggregation-
  // omitted (its `owners`/`grabbable` membership is dropped, but its handles are still
  // drawn, so they must still be hittable; FR-87 established this for edges, this extends
  // the SAME pattern to vertices). `computeHandles` returns EMPTY_HANDLES for an aggregate
  // (no own shape, FR-35) and skips unresolved vertices, so an aggregate / undrawn active
  // feature contributes nothing.
  const activeHandles = resolveActiveHandles(
    activeFeature,
    features,
    areaFeaturesById,
    vertices,
  );

  // 1. Nearest DRAWN VERTEX within the screen-px radius (vertex-first priority). The
  //    grabbable `owners` map covers every feature drawn with its own shape; the active
  //    feature's own vertex handles are additionally probed so an aggregation-omitted
  //    active leaf's DRAWN vertices are grabbable too (draw ⊇ hit). A vertex claimed by
  //    both paths resolves to the SAME (featureId, vertexId), so the union is harmless.
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
  for (const vh of activeHandles.vertices) {
    const d = nearestDrawnDistSq(vh.position, point, toScreen, wrap);
    if (d <= bestDistSq) {
      bestDistSq = d;
      bestVertex = { featureId: vh.featureId, vertexId: vh.vertexId };
    }
  }
  if (bestVertex !== null) {
    return vertexHit(bestVertex.featureId, bestVertex.vertexId);
  }

  // 1.5. Nearest EDGE-MIDPOINT handle of the ACTIVE feature within the screen-px radius
  //      (FR-87 add-a-new-vertex). Edge handles are a SELECTION-scoped affordance — they
  //      exist only for the active feature (unlike vertices / bodies, grabbable for any
  //      drawn feature), so this probes ONLY when an active feature is supplied. Probed
  //      AFTER vertices so a vertex still wins inside the same radius (受け入れ基準: 頂点
  //      優先 — an edge midpoint that coincides with a vertex never steals the grab), and
  //      BEFORE the point/line/area bodies so a click on an edge midpoint starts an
  //      EdgeAdd rather than selecting the body underneath it (『見えている＝掴める』).
  //
  //      The midpoints come from the SAME `computeHandles` the render layer draws the
  //      edge handles with, resolved over the SAME shared display vertex store the vertex
  //      path used (単一真実源, 教訓 5.29 — 描画 ⊇ ヒット), so a handle is grabbable exactly
  //      where it is drawn (reused from `activeHandles` computed above — one computeHandles
  //      per hit-test). `computeHandles` returns EMPTY_HANDLES for an aggregate (no own
  //      shape, FR-35) and skips unresolved vertices, so an aggregate / omitted active
  //      feature contributes no edge handles.
  {
    let bestEdge: EdgeHandle | null = null;
    let bestEdgeDistSq = radiusSq;
    for (const edge of activeHandles.edges) {
      const d = nearestDrawnDistSq(edge.midpoint, point, toScreen, wrap);
      if (d <= bestEdgeDistSq) {
        bestEdgeDistSq = d;
        bestEdge = edge;
      }
    }
    if (bestEdge !== null) {
      return edgeHit(
        bestEdge.featureId,
        bestEdge.startVertexId,
        bestEdge.endVertexId,
        bestEdge.ringId,
      );
    }
  }

  // 2. A POINT / LINE feature near the cursor (screen-px proximity — no fillable
  //    body). Nearest representative vertex / segment wins, so a click on a stand-alone
  //    point / line selects that feature as its body.
  //
  // HIT/DRAW ORDER PARITY (bughunt 前面の line をクリックして背面の area が選ばれる):
  // the renderer paints AREAS first, then LINES, then POINTS, then LABELS
  // (feature-layer buildFeaturePrimitives `[...areas, ...lines, ...points, ...labels]`),
  // so a point / line drawn OVER an area sits visually ON TOP of it. The body hit-test
  // must therefore resolve in REVERSE draw order: probe the point / line bodies BEFORE
  // the area body so the feature the user SEES on top is the one selected
  // (『見えている＝掴める』, 教訓 5.14 描画順を hit-test の優先順位へ適用). Previously the
  // area body was probed first and returned immediately, so a click on the middle of a
  // line crossing an area selected the back area instead of the front line.
  //
  // Vertex-first (step 1) still wins over every body, per 受け入れ基準: 頂点 → 地物.
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

  // 3. Topmost DRAWN AREA body under the cursor (resolved-shape containment, 穴透過).
  //    Probed AFTER point / line bodies because areas are painted UNDERNEATH them
  //    (reverse draw order — see step 2). For an aggregate this is the AGGREGATE's
  //    集約形状 → the aggregate is selected, never a hidden child leaf.
  const area = drawnAreaAtPoint(areas, worldPoint, wrap);
  if (area !== null) return featureBodyHit(area);

  return EMPTY_HIT;
}
