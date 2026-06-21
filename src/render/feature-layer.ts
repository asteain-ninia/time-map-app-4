// U19 feature drawing layer (FR-17 / FR-21 / FR-71 / FR-86, NFR 5.1 / 5.2).
//
// Render layer, PURE: turns the SELECTED-TIME evaluated feature state + a
// camera/viewport into declarative `DrawPrimitive`s for the `MapRenderer`
// (技術方針 2.4 / 2.5). There is NO Canvas API here — the actual painting lives in
// `canvas2d-renderer`; this module only decides WHAT to draw and WITH WHICH style,
// so the whole decision surface is Vitest-checkable without a Canvas (教訓 5.41 /
// NFR 5.8). Import direction is render → domain only (lint-enforced).
//
// RESPONSIBILITY (spec §やること): consume already-evaluated state and an
// already-resolved derived shape (U08) and an already-narrowed view-clipping
// candidate set (U10) and draw them. This module does NOT evaluate anchors (U16),
// does NOT compute aggregate union shapes (U08), does NOT build/maintain the
// spatial index (U10), does NOT own the camera (U17), does NOT fold longitude
// (U05), does NOT decide colors (FR-100/101) — it consumes those outputs (spec
// §やらないこと / §依存).
//
// KEY INVARIANTS encoded here:
//   - SINGLE size source (教訓 §4 / 5.30): point radius, line width and label font
//     are all screen-space constants carried on ONE `ScreenSizes` value, so a
//     point, a line and a label can never invent divergent zoom-dependent sizes
//     (FR-17). Areas (fills) scale with the map; only their OUTLINE width is
//     screen-fixed (開発ガイド §5.25: do not widen FR-17 past its named targets).
//   - HOLE TRANSPARENCY / ENCLAVE INDEPENDENCE (FR-21): an area is emitted as ONE
//     `PolygonShapePrimitive` carrying every piece (territory + holes + enclaves);
//     the renderer's even-odd fill makes holes透過 and enclaves independent with a
//     SINGLE fill color and NO connector line. The SELECTED state changes ONLY the
//     fill/stroke COLOR (selectedColor), never the ring structure (教訓 5.25): the
//     same shape resolution drives恒常 and ハイライト alike (教訓 5.29).
//   - SINGLE shape source (教訓 5.29): the `GeoMultiPolygon` handed in (whether a
//     leaf's own shape or U08's derived aggregate union) is the SAME geometry used
//     for the fill, the outline AND the label anchor/occupancy — drawing,
//     hit-test and label position can never drift apart.
//   - PURITY (受け入れ基準 6): every function is pure; inputs are never mutated and
//     the same input yields the same primitives.

import { LONGITUDE_PERIOD } from '../domain/geo/seam';
import { isDrawableLineVertexCount } from '../domain/feature';
import type { GeoMultiPolygon, GeoPolygon, GeoRing } from '../domain/geometry/types';

import type { Camera, Viewport } from './camera';
import type {
  DrawPrimitive,
  LabelPrimitive,
  LinePrimitive,
  PointPrimitive,
  PolygonShapePrimitive,
} from './map-renderer';
import type { WorldPoint } from './vtransform';
import { MAX_WRAP_REPLICAS, screenToWorld, worldToScreen } from './vtransform';

// --- single screen-size source (FR-17 / 教訓 5.30) ---------------------------

/**
 * The ONE place every screen-fixed size lives (FR-17 単一真実源). The renderer
 * keeps these constant across zoom: a point's radius, a polyline's / outline's
 * stroke width, and every label's font are all in CSS px, never multiplied by
 * `camera.zoom`. Sharing one value forbids per-type drift (教訓 5.30 過少共有の戒め).
 */
export interface ScreenSizes {
  /** Point marker radius in CSS px (FR-17 / FR-18). */
  readonly pointRadiusPx: number;
  /** Polyline + area outline stroke width in CSS px (FR-17 / FR-19). */
  readonly strokeWidthPx: number;
  /** Label font size in CSS px (FR-17 / FR-86). */
  readonly labelFontPx: number;
}

export const DEFAULT_SCREEN_SIZES: ScreenSizes = {
  pointRadiusPx: 5,
  strokeWidthPx: 1.5,
  labelFontPx: 12,
};

// --- per-type label visibility thresholds (FR-86) ---------------------------
//
// Label VISIBILITY is deliberately NOT a single shared predicate: the三種別
// conditions are本質的に異なる (点=最小ズーム倍率, 線=可視長, 面=リング占有率,
// FR-86) so we keep three separate predicates (教訓 5.30 過剰共有の戒め). Only the
// SIZE is shared (above), not the visibility rule.

/**
 * The thresholds that gate label drawing, all from project settings (FR-86 /
 * FR-109). Each is the INCLUSIVE lower bound: a value `>=` threshold shows the
 * label, `<` hides it (受け入れ基準 4 boundary-inclusive).
 */
export interface LabelThresholds {
  /** Point label appears when `camera.zoom >= pointMinZoom` (FR-86 点=最小ズーム倍率). */
  readonly pointMinZoom: number;
  /** Line label appears when its screen-projected length px `>=` this (FR-86 線=可視長). */
  readonly lineMinVisibleLengthPx: number;
  /**
   * Area-ring label appears when the ring's screen-projected occupancy
   * (ring screen area ÷ viewport area) `>=` this (FR-86 / FR-109 面占有率閾値).
   */
  readonly areaMinOccupancy: number;
}

export const DEFAULT_LABEL_THRESHOLDS: LabelThresholds = {
  pointMinZoom: 2,
  lineMinVisibleLengthPx: 40,
  areaMinOccupancy: 0.01,
};

// --- evaluated input (renderer-independent contract, 教訓 5.33) --------------
//
// The render layer must not reach into U16's feature internals; it receives an
// already-evaluated, already-styled DRAW ITEM per existing feature. Time
// evaluation (which anchor is active / does it exist) happened upstream (U16); a
// feature that does NOT exist at the selected time is simply NOT in this list
// (受け入れ基準 1: 非存在は描画コマンドに現れない). The derived shape of an aggregate
// was resolved upstream by U08's single resolution (教訓 5.29) and arrives here as
// a plain `GeoMultiPolygon` — this module never unions anything.

/** Resolved visual style for one feature (colors already decided by FR-100/101). */
export interface FeatureStyle {
  /** Normal fill / point / outline base color. */
  readonly fill: string;
  /** Outline (border) color for areas and the stroke for lines/points outline. */
  readonly stroke: string;
  /** The color to use INSTEAD when selected (FR-82). Structure never changes. */
  readonly selectedColor: string;
}

/** An evaluated point feature at the selected time (FR-18). */
export interface EvaluatedPoint {
  readonly kind: 'point';
  readonly id: string;
  readonly at: WorldPoint;
  readonly style: FeatureStyle;
  /** Label text; empty string ⇒ no label even when the threshold passes. */
  readonly label: string;
  readonly selected: boolean;
}

/** An evaluated line feature at the selected time (FR-19). */
export interface EvaluatedLine {
  readonly kind: 'line';
  readonly id: string;
  /** World-space vertices (U05 wrap-展開 already applied upstream). */
  readonly points: readonly WorldPoint[];
  readonly style: FeatureStyle;
  readonly label: string;
  readonly selected: boolean;
}

/**
 * An evaluated area feature (leaf OR aggregate) at the selected time (FR-20 /
 * FR-35). `shape` is the SINGLE resolved geometry (教訓 5.29): for a leaf it is its
 * own rings; for an aggregate it is U08's derived union (which may be MULTIPLE
 * disjoint pieces — 教訓 5.1 — all carried here, none dropped). Each piece is
 * [territory, ...holes]; an enclave is its own piece (a separate territory ring).
 */
export interface EvaluatedArea {
  readonly kind: 'area';
  readonly id: string;
  readonly shape: GeoMultiPolygon;
  readonly style: FeatureStyle;
  readonly label: string;
  readonly selected: boolean;
}

export type EvaluatedFeature = EvaluatedPoint | EvaluatedLine | EvaluatedArea;

// --- viewport ↔ world rectangle (view clipping, NFR 5.1) --------------------

/** An axis-aligned world rectangle (continuous-scalar lon on X, lat on Y). */
export interface WorldRect {
  readonly minLon: number;
  readonly minLat: number;
  readonly maxLon: number;
  readonly maxLat: number;
}

/**
 * The world rectangle currently covered by the viewport, via the shared transform
 * (so what we clip against is exactly what is on screen, 教訓 5.29). The four
 * screen corners map back to world; we take the min/max. A degenerate viewport /
 * camera yields the whole world so a not-yet-measured frame still draws.
 *
 * NOTE: this is the SINGLE-replica rectangle in continuous longitude. Seam-wrap
 * (±360°) replicas are handled by the renderer's draw loop AND by widening the
 * U10 query upstream (spec §視野外クリッピング: ラップ複製も問い合わせ対象); this
 * module clips against the literal covered span and the renderer tiles the rest.
 */
export function viewportWorldRect(camera: Camera, viewport: Viewport): WorldRect {
  if (
    !Number.isFinite(viewport.widthCss) ||
    !Number.isFinite(viewport.heightCss) ||
    viewport.widthCss <= 0 ||
    viewport.heightCss <= 0 ||
    !Number.isFinite(camera.zoom) ||
    camera.zoom <= 0
  ) {
    return { minLon: -180, minLat: -90, maxLon: 180, maxLat: 90 };
  }
  const tl = screenToWorld({ x: 0, y: 0 }, camera, viewport);
  const br = screenToWorld({ x: viewport.widthCss, y: viewport.heightCss }, camera, viewport);
  return {
    minLon: Math.min(tl.lon, br.lon),
    maxLon: Math.max(tl.lon, br.lon),
    minLat: Math.min(tl.lat, br.lat),
    maxLat: Math.max(tl.lat, br.lat),
  };
}

/** True iff `a` and `b` overlap or touch (inclusive). */
export function worldRectsIntersect(a: WorldRect, b: WorldRect): boolean {
  return a.minLon <= b.maxLon && a.maxLon >= b.minLon && a.minLat <= b.maxLat && a.maxLat >= b.minLat;
}

/**
 * Period-aware rect intersection (FR-07 端ラップ表示). Latitude is tested exactly;
 * longitude is tested against EVERY ±360° replica of `a` that could fall inside the
 * `view` span, mirroring the renderer's `wrapTurnsForViewport` turn-loop
 * (canvas2d-renderer): the renderer draws a feature's +360°·k replica wherever it
 * lands on screen, so the clip must KEEP a feature whose replica is visible even
 * when its raw bbox (lon=0) sits outside a view that has been panned past one world
 * period (e.g. view lon-span [180, 540]). Without this, panning more than one world
 * turn made on-screen features vanish (Codex high #1).
 *
 * Implemented in closed form (no per-turn loop, so no float累積 — same discipline as
 * `wrapTurnsForViewport`): the replica `[a.minLon + k·360, a.maxLon + k·360]`
 * overlaps `[view.minLon, view.maxLon]` for some integer k iff the smallest such
 * shifted interval that can reach the view does so. We compute the minimal k that
 * pushes `a.maxLon` to or past `view.minLon` and check that shifted `a.minLon` does
 * not overshoot `view.maxLon`. Pure.
 *
 * CLIP ⊇ DRAW AT THE DEGENERATE BOUNDARY (M1 root fix): the closed form above
 * reports an intersection for ANY integer k, but the RENDERER only paints the turns
 * `wrapTurnsForLonSpan` enumerates — and that path BAILS to the identity turn `[0]`
 * once the inclusive turn count reaches `MAX_WRAP_REPLICAS` or the bounds leave
 * safe-integer precision (otherwise its `t += 1` loop hangs / over-allocates). At
 * that pathological boundary the closed-form clip would keep a feature whose only
 * intersecting replica is some k ≠ 0 that the renderer NEVER draws → "kept by clip
 * but not painted", the exact invariant `wrapTurnsForLonSpan` exists to protect
 * (教訓 5.29 単一真実源). So we mirror the SAME degenerate guard here: when the draw
 * path would collapse to `[0]`, the clip likewise tests ONLY the identity-turn
 * replica (`a` itself vs `view`), keeping clip and draw in lock-step.
 */
export function worldRectIntersectsViewWrapped(a: WorldRect, view: WorldRect): boolean {
  // Latitude is never wrapped: a quick reject keeps the common case cheap.
  if (a.minLat > view.maxLat || a.maxLat < view.minLat) return false;
  // The inclusive turn range the renderer would enumerate for this content span vs
  // this view (identical formula to wrapTurnsForLonSpan). Used only to detect the
  // degenerate-collapse boundary; the actual intersection uses the O(1) form below.
  const minTurn = Math.ceil((view.minLon - a.maxLon) / LONGITUDE_PERIOD);
  const maxTurn = Math.floor((view.maxLon - a.minLon) / LONGITUDE_PERIOD);
  if (
    !Number.isSafeInteger(minTurn) ||
    !Number.isSafeInteger(maxTurn) ||
    maxTurn - minTurn >= MAX_WRAP_REPLICAS
  ) {
    // Draw collapses to turn [0]; keep iff the identity-turn replica is visible.
    return worldRectsIntersect(a, view);
  }
  // Smallest integer k with (a.maxLon + k·360) >= view.minLon: the first replica
  // whose right edge reaches the view's left edge.
  const k = Math.ceil((view.minLon - a.maxLon) / LONGITUDE_PERIOD);
  const shiftedMinLon = a.minLon + k * LONGITUDE_PERIOD;
  // That replica overlaps iff its left edge does not run past the view's right edge.
  return shiftedMinLon <= view.maxLon;
}

/** Bounding world rect of a point (degenerate, used for uniform clipping). */
export function pointRect(at: WorldPoint): WorldRect {
  return { minLon: at.lon, maxLon: at.lon, minLat: at.lat, maxLat: at.lat };
}

// --- bounding-rect MEMOIZATION (bughunt3 #low: per-frame recompute) ----------
//
// `featureIntersectsViewport` is called from `selectVisibleFeatures` on EVERY
// frame for EVERY feature; for an area it walks every vertex of every ring of
// every piece (triple-nested) and for a line every vertex, even though the
// geometry is IMMUTABLE until the next domain change rebuilds the feature. The
// bounding rect is a pure function of that geometry, so we memoize it KEYED BY
// THE GEOMETRY OBJECT REFERENCE in a WeakMap: the same `shape` / `points` array
// that survives across frames hits the cache (O(1)), while a domain change that
// recreates the feature produces a fresh array reference that misses and is
// recomputed exactly once. Purity is preserved (same input ⇒ same output) and
// the readonly `EvaluatedArea` / `EvaluatedLine` types are NOT mutated; the
// WeakMap also lets a feature that scrolls out of the live set be GC'd with its
// cached rect (no unbounded growth, 教訓 5.18 absence-not-leak). `undefined`
// (empty geometry) is itself a valid cached result, so we store a sentinel and
// distinguish "absent from cache" via `.has`.
const shapeRectCache = new WeakMap<GeoMultiPolygon, WorldRect | undefined>();
const pointsRectCache = new WeakMap<readonly WorldPoint[], WorldRect | undefined>();

/** Bounding world rect of a vertex list, or undefined when empty (教訓 5.18). */
export function pointsRect(points: readonly WorldPoint[]): WorldRect | undefined {
  if (pointsRectCache.has(points)) return pointsRectCache.get(points);
  const r = computePointsRect(points);
  pointsRectCache.set(points, r);
  return r;
}

function computePointsRect(points: readonly WorldPoint[]): WorldRect | undefined {
  let r: WorldRect | undefined;
  for (const p of points) {
    r =
      r === undefined
        ? { minLon: p.lon, maxLon: p.lon, minLat: p.lat, maxLat: p.lat }
        : {
            minLon: Math.min(r.minLon, p.lon),
            maxLon: Math.max(r.maxLon, p.lon),
            minLat: Math.min(r.minLat, p.lat),
            maxLat: Math.max(r.maxLat, p.lat),
          };
  }
  return r;
}

/** Bounding world rect of a multi-polygon (every ring), or undefined when empty. */
export function shapeRect(shape: GeoMultiPolygon): WorldRect | undefined {
  if (shapeRectCache.has(shape)) return shapeRectCache.get(shape);
  const r = computeShapeRect(shape);
  shapeRectCache.set(shape, r);
  return r;
}

function computeShapeRect(shape: GeoMultiPolygon): WorldRect | undefined {
  let r: WorldRect | undefined;
  for (const piece of shape) {
    for (const ring of piece) {
      for (const c of ring) {
        r =
          r === undefined
            ? { minLon: c.lon, maxLon: c.lon, minLat: c.lat, maxLat: c.lat }
            : {
                minLon: Math.min(r.minLon, c.lon),
                maxLon: Math.max(r.maxLon, c.lon),
                minLat: Math.min(r.minLat, c.lat),
                maxLat: Math.max(r.maxLat, c.lat),
              };
      }
    }
  }
  return r;
}

/**
 * Whether an evaluated feature's geometry intersects the viewport rect (view
 * clipping, 受け入れ基準 5 / 教訓 5.3 操作対象は表示状態に限定). A feature with no
 * geometry (empty line / empty area) is NOT visible (教訓 5.18: absence, not a
 * crash). The aggregate's derived shape is clipped by ITS resolved bbox (spec
 * §視野外クリッピング: 集約は U08 解決後の bbox).
 */
export function featureIntersectsViewport(feature: EvaluatedFeature, view: WorldRect): boolean {
  switch (feature.kind) {
    case 'point':
      return worldRectIntersectsViewWrapped(pointRect(feature.at), view);
    case 'line': {
      const r = pointsRect(feature.points);
      return r !== undefined && worldRectIntersectsViewWrapped(r, view);
    }
    case 'area': {
      const r = shapeRect(feature.shape);
      return r !== undefined && worldRectIntersectsViewWrapped(r, view);
    }
    default:
      return assertNeverFeature(feature);
  }
}

/**
 * Inflate a clip `WorldRect` by a screen-space MARGIN converted to world degrees at
 * the current zoom (Codex medium #4). The bare viewport rect is the exact span of
 * pixel CENTERS; a point with `pointRadiusPx`, a stroke of `strokeWidthPx`, or a
 * label drawn a few px outside that span is still partly visible yet would clip and
 * pop. We widen the rect by the largest screen-fixed half-extent (point radius,
 * stroke half-width, plus a small label allowance) ÷ zoom so a feature straddling
 * the edge keeps drawing until it is fully off-screen. Pure; `zoom <= 0` returns
 * the rect unchanged (degenerate frame, handled upstream).
 */
export function inflateViewRect(
  view: WorldRect,
  sizes: ScreenSizes,
  zoom: number,
): WorldRect {
  if (!Number.isFinite(zoom) || zoom <= 0) return view;
  // The widest screen-fixed half-extent any feature can paint past its anchor:
  // point radius, half the stroke width, and a coarse label bound allowance so a
  // label anchored just off-screen is not dropped (FR-86 ラベル境界).
  const LABEL_BOUND_PX = 64;
  const marginPx = Math.max(
    sizes.pointRadiusPx,
    sizes.strokeWidthPx / 2,
    LABEL_BOUND_PX,
  );
  const marginDeg = marginPx / zoom;
  return {
    minLon: view.minLon - marginDeg,
    maxLon: view.maxLon + marginDeg,
    minLat: view.minLat - marginDeg,
    maxLat: view.maxLat + marginDeg,
  };
}

// --- LOD (詳細度制御, NFR 5.1 / R1) -----------------------------------------

/**
 * The LOD level for a zoom. Higher = more detail. The level only changes the
 * SIMPLIFICATION tolerance, never the topology: holes stay holes, enclaves stay
 * separate pieces, aggregate pieces are never merged (spec §LOD: 正しさを壊さない).
 */
export const LOD_LEVEL = {
  Coarse: 0,
  Medium: 1,
  Full: 2,
} as const;

export type LodLevel = (typeof LOD_LEVEL)[keyof typeof LOD_LEVEL];

/**
 * Decide the LOD level from zoom (CSS px per degree). Zoomed-out (small zoom) ⇒
 * coarser. Thresholds are deliberately simple constants; the harness measures the
 * cost difference between levels (受け入れ基準 5). Pure.
 */
export function lodLevelForZoom(zoom: number): LodLevel {
  if (!Number.isFinite(zoom) || zoom <= 2) return LOD_LEVEL.Coarse;
  if (zoom <= 16) return LOD_LEVEL.Medium;
  return LOD_LEVEL.Full;
}

/**
 * The vertex-simplification tolerance (in DEGREES) for a LOD level. Vertices
 * closer together than the tolerance collapse at coarse zoom (頂点列簡略化). 0 at
 * Full means no simplification. Pure.
 */
export function lodToleranceDeg(level: LodLevel): number {
  switch (level) {
    case LOD_LEVEL.Coarse:
      return 2;
    case LOD_LEVEL.Medium:
      return 0.25;
    case LOD_LEVEL.Full:
      return 0;
    default:
      return 0;
  }
}

/**
 * Simplify a ring by dropping consecutive vertices nearer than `toleranceDeg`
 * (a cheap radial-distance decimation, NOT Douglas-Peucker — this stays linear).
 *
 * CONTRACT (corrected per Codex medium #3): the FIRST vertex (`ring[0]`) AND the
 * LAST vertex (`ring[ring.length - 1]`) are ALWAYS force-kept, so the ring's start
 * and closing edge are preserved regardless of where the distance test happens to
 * fall. Without the explicit last-vertex keep, the tail survived only if it passed
 * the distance test against the running anchor, which could shift the closing edge.
 * A ring never collapses below 3 points unless it truly has < 3 input points.
 *
 * SCOPE / LIMITATION (Codex medium #3): this is per-ring radial decimation, NOT a
 * topology-preserving simplifier. It does not guarantee that a heavily simplified
 * concave/holed polygon stays self-intersection-free at Coarse tolerance; outer
 * ring and holes are simplified independently. That trade-off is deliberate — the
 * coarse level is only used at far zoom-out where such artefacts are sub-pixel — and
 * is bounded by the small tolerances in {@link lodToleranceDeg}. A full
 * topology-preserving simplifier is out of scope (would change the LOD design).
 *
 * A tolerance of 0 returns the input ring unchanged (Full LOD). Pure: returns a new
 * array, never mutates the input (受け入れ基準 6).
 */
export function simplifyRing(ring: GeoRing, toleranceDeg: number): GeoRing {
  if (toleranceDeg <= 0 || ring.length <= 3) return ring;
  const tol2 = toleranceDeg * toleranceDeg;
  const first = ring[0]!;
  const lastIndex = ring.length - 1;
  const last = ring[lastIndex]!;
  const kept: GeoRing[number][] = [first];
  let anchor = first;
  // Iterate the INTERIOR only; the last vertex is force-appended below so the
  // closing edge is always preserved (contract above).
  for (let i = 1; i < lastIndex; i += 1) {
    const c = ring[i]!;
    const dlon = c.lon - anchor.lon;
    const dlat = c.lat - anchor.lat;
    if (dlon * dlon + dlat * dlat >= tol2) {
      kept.push(c);
      anchor = c;
    }
  }
  kept.push(last);
  // Keep at least a triangle if the input had one: re-pad from the original ring.
  if (kept.length < 3 && ring.length >= 3) {
    return ring;
  }
  return kept;
}

/** Simplify every ring of a piece at the given tolerance (holes included). */
function simplifyPiece(piece: GeoPolygon, toleranceDeg: number): GeoPolygon {
  if (toleranceDeg <= 0) return piece;
  return piece.map((ring) => simplifyRing(ring, toleranceDeg));
}

/** Simplify every piece of a shape (LOD); never drops a piece (教訓 5.1). */
export function simplifyShape(shape: GeoMultiPolygon, toleranceDeg: number): GeoMultiPolygon {
  if (toleranceDeg <= 0) return shape;
  return shape.map((piece) => simplifyPiece(piece, toleranceDeg));
}

// --- label visibility predicates (per-type, FR-86) --------------------------

/** Point label shows iff zoom is at/above the configured minimum (FR-86, 境界含む). */
export function pointLabelVisible(zoom: number, thresholds: LabelThresholds): boolean {
  return zoom >= thresholds.pointMinZoom;
}

/**
 * The on-screen projected length (CSS px) of a polyline at the current camera
 * (FR-86 線=可視長). Sums segment lengths in screen space. Pure.
 */
export function projectedLengthPx(
  points: readonly WorldPoint[],
  camera: Camera,
  viewport: Viewport,
): number {
  if (points.length < 2) return 0;
  let total = 0;
  let prev = worldToScreen(points[0]!, camera, viewport);
  for (let i = 1; i < points.length; i += 1) {
    const cur = worldToScreen(points[i]!, camera, viewport);
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    total += Math.sqrt(dx * dx + dy * dy);
    prev = cur;
  }
  return total;
}

/** Line label shows iff its projected length reaches the threshold (FR-86, 境界含む). */
export function lineLabelVisible(
  points: readonly WorldPoint[],
  camera: Camera,
  viewport: Viewport,
  thresholds: LabelThresholds,
): boolean {
  return projectedLengthPx(points, camera, viewport) >= thresholds.lineMinVisibleLengthPx;
}

/**
 * The screen-space area (CSS px²) of a ring at the current camera, via the shoelace
 * formula on projected vertices (FR-86 面=画面占有率). Absolute value (orientation-
 * independent). Pure.
 */
export function projectedRingAreaPx(
  ring: GeoRing,
  camera: Camera,
  viewport: Viewport,
): number {
  if (ring.length < 3) return 0;
  // Inline the world→screen projection into the shoelace accumulator so we never
  // allocate an intermediate ScreenPoint[] (this runs once per territory ring per
  // visible area feature per frame; see bughunt3). The projection MUST stay an
  // exact mirror of worldToScreen, including its unmeasured-camera guard: when
  // zoom is non-finite or ≤ 0 every vertex collapses to the viewport centre, so
  // the signed area is 0 — we short-circuit to preserve that contract.
  if (!Number.isFinite(camera.zoom) || camera.zoom <= 0) return 0;
  const cx = viewport.widthCss / 2;
  const cy = viewport.heightCss / 2;
  const { centerLon, centerLat, zoom } = camera;
  const c0 = ring[0]!;
  const firstX = cx + (c0.lon - centerLon) * zoom;
  const firstY = cy - (c0.lat - centerLat) * zoom;
  let prevX = firstX;
  let prevY = firstY;
  let twice = 0;
  for (let i = 1; i < ring.length; i += 1) {
    const c = ring[i]!;
    const curX = cx + (c.lon - centerLon) * zoom;
    const curY = cy - (c.lat - centerLat) * zoom;
    twice += prevX * curY - curX * prevY;
    prevX = curX;
    prevY = curY;
  }
  // Close the ring (last vertex → first).
  twice += prevX * firstY - firstX * prevY;
  return Math.abs(twice) / 2;
}

/**
 * A ring's screen-occupancy = its projected area ÷ the viewport area (FR-86 / FR-
 * 109). 0 when the viewport has no area. Pure.
 */
export function ringOccupancy(
  ring: GeoRing,
  camera: Camera,
  viewport: Viewport,
): number {
  const vpArea = viewport.widthCss * viewport.heightCss;
  if (!Number.isFinite(vpArea) || vpArea <= 0) return 0;
  return projectedRingAreaPx(ring, camera, viewport) / vpArea;
}

/** Area-ring label shows iff its occupancy reaches the threshold (FR-86, 境界含む). */
export function areaRingLabelVisible(
  ring: GeoRing,
  camera: Camera,
  viewport: Viewport,
  thresholds: LabelThresholds,
): boolean {
  return ringOccupancy(ring, camera, viewport) >= thresholds.areaMinOccupancy;
}

// --- label anchor (centroid) ------------------------------------------------

/** The world centroid of a ring (vertex average; finite-safe). Used as label anchor. */
export function ringCentroid(ring: GeoRing): WorldPoint {
  if (ring.length === 0) return { lon: 0, lat: 0 };
  let lon = 0;
  let lat = 0;
  for (const c of ring) {
    lon += c.lon;
    lat += c.lat;
  }
  return { lon: lon / ring.length, lat: lat / ring.length };
}

// --- the batch builder (the single entry point) -----------------------------

/** Options bundling the shared, per-frame inputs for {@link buildFeaturePrimitives}. */
export interface BuildOptions {
  readonly camera: Camera;
  readonly viewport: Viewport;
  readonly sizes: ScreenSizes;
  readonly thresholds: LabelThresholds;
  /**
   * When true, restrict drawing to features whose geometry intersects the viewport
   * (view clipping ON). When false, draw every supplied feature (clipping OFF) so
   * the harness can measure the cost difference (受け入れ基準 5). Default ON.
   */
  readonly clip?: boolean;
  /**
   * When true, apply LOD vertex simplification by zoom. When false, draw full
   * detail (LOD OFF) for the harness comparison (受け入れ基準 5). Default ON.
   */
  readonly lod?: boolean;
}

/** The active color for a feature: selectedColor when selected, else fill (FR-82). */
function activeColor(style: FeatureStyle, selected: boolean): string {
  return selected ? style.selectedColor : style.fill;
}

/**
 * Build the draw primitives for ONE point feature: the marker + (conditionally)
 * its label. Order: marker then label (label on top). The label is added only
 * when text is non-empty AND the point-label threshold passes (FR-86, 受け入れ基準 4).
 */
function buildPointPrimitives(
  f: EvaluatedPoint,
  opts: BuildOptions,
): DrawPrimitive[] {
  const fill = activeColor(f.style, f.selected);
  const marker: PointPrimitive = {
    kind: 'point',
    at: f.at,
    radiusPx: opts.sizes.pointRadiusPx,
    fill,
  };
  const out: DrawPrimitive[] = [marker];
  if (f.label !== '' && pointLabelVisible(opts.camera.zoom, opts.thresholds)) {
    out.push({
      kind: 'label',
      at: f.at,
      text: f.label,
      fontPx: opts.sizes.labelFontPx,
      fill,
    } satisfies LabelPrimitive);
  }
  return out;
}

/** Build the draw primitives for ONE line feature: the polyline + (conditional) label. */
function buildLinePrimitives(f: EvaluatedLine, opts: BuildOptions): DrawPrimitive[] {
  // A polyline needs ≥2 points to have a segment (FR-19); a degenerate 1-point line
  // draws nothing. The「2頂点未満は描かない」rule is the SINGLE domain predicate
  // `isDrawableLineVertexCount` (教訓 5.30), shared with the render bridge
  // (committed-features) and the hit-test so draw/hit cannot drift.
  if (!isDrawableLineVertexCount(f.points.length)) return [];
  const stroke = activeColor(f.style, f.selected);
  const line: LinePrimitive = {
    kind: 'line',
    points: f.points,
    widthPx: opts.sizes.strokeWidthPx,
    stroke,
  };
  const out: DrawPrimitive[] = [line];
  if (
    f.label !== '' &&
    lineLabelVisible(f.points, opts.camera, opts.viewport, opts.thresholds)
  ) {
    // Anchor the line label at its midpoint vertex.
    const mid = f.points[Math.floor(f.points.length / 2)]!;
    out.push({
      kind: 'label',
      at: mid,
      text: f.label,
      fontPx: opts.sizes.labelFontPx,
      fill: stroke,
    } satisfies LabelPrimitive);
  }
  return out;
}

/**
 * Convert a domain `GeoRing` (WorldCoordinate[]) into the renderer's `WorldPoint[]`.
 * Same field names; this is a typed pass-through so the renderer never imports the
 * domain coordinate type (教訓 5.33 偶然の構造一致に頼らない — make the bridge explicit).
 */
function ringToWorldPoints(ring: GeoRing): WorldPoint[] {
  return ring.map((c) => ({ lon: c.lon, lat: c.lat }));
}

/**
 * Build the draw primitives for ONE area feature (FR-20 / FR-21 / FR-86). The
 * ENTIRE shape (every territory + every hole + every enclave) becomes ONE
 * `PolygonShapePrimitive` with a SINGLE fill/stroke color, so the renderer's
 * even-odd fill gives hole透過 + enclave independence with no per-ring color and
 * no connector line — identical for恒常 and selected (only the COLOR differs,
 * 教訓 5.25 / 5.29). Then, PER TERRITORY RING (外周 + 各飛び地), a label is added iff
 * its screen-occupancy passes the threshold (FR-86 リング単位). Hole rings never get
 * a label (they are negative space). `lod` simplifies vertices first (topology-safe).
 */
function buildAreaPrimitives(f: EvaluatedArea, opts: BuildOptions): DrawPrimitive[] {
  const useLod = opts.lod ?? true;
  const tol = useLod ? lodToleranceDeg(lodLevelForZoom(opts.camera.zoom)) : 0;
  const shape = simplifyShape(f.shape, tol);
  if (shape.length === 0) return [];

  const color = activeColor(f.style, f.selected);
  const pieces: WorldPoint[][][] = shape.map((piece) =>
    piece.map((ring) => ringToWorldPoints(ring)),
  );
  // Drop pieces that have no drawable territory (every ring < 3) — never the
  // non-empty pieces (教訓 5.1 片落とし禁止: we keep all real pieces).
  const drawable = pieces.filter((piece) => piece.some((ring) => ring.length >= 3));
  if (drawable.length === 0) return [];

  const shapePrim: PolygonShapePrimitive = {
    kind: 'shape',
    pieces: drawable,
    fill: color,
    stroke: f.style.stroke,
    strokeWidthPx: opts.sizes.strokeWidthPx,
  };
  const out: DrawPrimitive[] = [shapePrim];

  if (f.label !== '') {
    // Per TERRITORY ring (index 0 of each piece): a飛び地 is its own piece, so this
    // naturally labels外周 AND each飛び地 separately (FR-86 リング単位, 受け入れ基準 4).
    for (const piece of shape) {
      const territory = piece[0];
      if (territory === undefined || territory.length < 3) continue;
      if (areaRingLabelVisible(territory, opts.camera, opts.viewport, opts.thresholds)) {
        out.push({
          kind: 'label',
          at: ringCentroid(territory),
          text: f.label,
          fontPx: opts.sizes.labelFontPx,
          fill: color,
        } satisfies LabelPrimitive);
      }
    }
  }
  return out;
}

/**
 * The clip rect ACTUALLY used to narrow the per-frame feature set: the viewport's
 * covered world span inflated by the screen-fixed half-extents a feature can paint
 * past its anchor (Codex medium #4). Exposed as the SINGLE source of "what world
 * span survives clipping" so the visible-set selector below, the renderer's draw,
 * and the HB-14 regression property all agree on one rectangle (教訓 5.29). Pure.
 */
export function clipViewRect(camera: Camera, viewport: Viewport, sizes: ScreenSizes): WorldRect {
  return inflateViewRect(viewportWorldRect(camera, viewport), sizes, camera.zoom);
}

/**
 * Narrow an evaluated feature list to the ones whose geometry survives the
 * period-aware view clip for this camera (HB-14 — 拡大すると地物が消える 再発防止の
 * 単一真実源). `buildFeaturePrimitives` builds primitives from EXACTLY this list, and
 * the composition root publishes `selectVisibleFeatures(...).length` into the
 * `data-visible-feature-count` observation hook, so a behavioural E2E can assert
 * the count never falls to 0 while a committed feature is still on screen during a
 * zoom-in (既存 app-active-feature 方式).
 *
 * CONTRACT (the metamorphic invariant the HB-14 property pins): the returned set is
 * a SUPERSET of every feature actually visible on screen — clipping may KEEP a
 * marginally-offscreen feature (the inflate margin) but must NEVER DROP one whose
 * geometry, after ±360° wrap, lands inside the viewport. When `clip` is false the
 * input is returned unchanged. Pure: never mutates the input.
 */
export function selectVisibleFeatures(
  features: readonly EvaluatedFeature[],
  camera: Camera,
  viewport: Viewport,
  sizes: ScreenSizes,
  clip = true,
): readonly EvaluatedFeature[] {
  if (!clip) return features;
  const view = clipViewRect(camera, viewport, sizes);
  return features.filter((f) => featureIntersectsViewport(f, view));
}

/**
 * The single entry point (spec §1 / 受け入れ基準 1): turn the selected-time
 * evaluated feature list into a flat primitive array for `MapRenderer.drawBatch`.
 *
 * Draw ORDER follows the layer契約 (spec §層をまたぐ契約 重なり順): AREAS first, then
 * LINES, then POINTS, then all LABELS on top — so labels are never hidden under a
 * later fill and points sit above areas (教訓 5.14 を描画順へ適用). View clipping
 * (when `clip`) drops features outside the viewport BEFORE building primitives
 * (教訓 5.3 操作対象は表示状態に限定); the harness flips `clip`/`lod` to measure cost
 * (受け入れ基準 5). Pure: the input array and features are never mutated (受け入れ基準 6).
 */
export function buildFeaturePrimitives(
  features: readonly EvaluatedFeature[],
  opts: BuildOptions,
): DrawPrimitive[] {
  return buildFeaturePrimitivesWithVisible(features, opts).primitives;
}

/** The result of {@link buildFeaturePrimitivesWithVisible}: the flat primitive
 * array PLUS the period-aware view-clip survivor count from the SAME pass. */
export interface FeaturePrimitivesResult {
  /** The flat primitive array for `MapRenderer.drawBatch` (same as {@link buildFeaturePrimitives}). */
  readonly primitives: DrawPrimitive[];
  /**
   * How many committed features SURVIVED the period-aware view clip this build
   * (`selectVisibleFeatures(...).length`). Exposed so a caller that needs the count
   * (the HB-14 `data-visible-feature-count` observation hook) reads it off the SAME
   * clip pass the primitives were built from instead of re-running the O(n) selector
   * a second time per frame (bughunt round-2: no double feature work). EXACTLY the
   * set whose primitives are in {@link primitives} — hook and draw cannot drift
   * (教訓 5.29 単一真実源).
   */
  readonly visibleCount: number;
}

/**
 * {@link buildFeaturePrimitives} PLUS the view-clip survivor count from the ONE
 * clip pass it already runs (教訓 5.29). `buildFeaturePrimitives` delegates here, so
 * the clip + LOD + per-band ordering live in a single place; callers that also need
 * the HB-14 visible count call this directly and read {@link FeaturePrimitivesResult.visibleCount}
 * rather than paying a second `selectVisibleFeatures` pass (bughunt round-2). Pure.
 */
export function buildFeaturePrimitivesWithVisible(
  features: readonly EvaluatedFeature[],
  opts: BuildOptions,
): FeaturePrimitivesResult {
  const clip = opts.clip ?? true;
  // Narrow to the period-aware, inflated view clip via the SINGLE selector the
  // observation hook + HB-14 property also use (教訓 5.29 — one truth source for
  // "what survives clipping"); intersection itself is period-aware (Codex high #1)
  // and inflated by screen-fixed half-extents so edge-straddlers do not pop (#4).
  const visible = selectVisibleFeatures(
    features,
    opts.camera,
    opts.viewport,
    opts.sizes,
    clip,
  );

  // Emit straight into ONE output array in the layer契約 band order (AREAS → LINES →
  // POINTS, then all LABELS on top). Bodies are appended in three kind-filtered
  // passes — the area bodies of EVERY feature precede the line bodies precede the
  // point bodies — so the final order is identical to the previous per-band staging
  // without the four intermediate arrays or the spread-concat copy that allocated a
  // fifth array every rendered frame (bughunt3: one output array, push() only).
  // Labels (from any kind) are deferred to a single staging array and appended last
  // so a later body fill never hides an earlier label.
  const primitives: DrawPrimitive[] = [];
  const labels: DrawPrimitive[] = [];

  // Append a feature's body primitives straight into the shared output and DEFER
  // its labels (any kind) to `labels`; labels are flushed last so a later fill
  // never hides an earlier label. `emit` keeps the routing in one place across the
  // three band passes so the body/label split cannot drift between kinds.
  const emit = (prims: readonly DrawPrimitive[]): void => {
    for (const p of prims) (p.kind === 'label' ? labels : primitives).push(p);
  };

  for (const f of visible) {
    if (f.kind === 'area') emit(buildAreaPrimitives(f, opts));
  }
  for (const f of visible) {
    if (f.kind === 'line') emit(buildLinePrimitives(f, opts));
  }
  for (const f of visible) {
    switch (f.kind) {
      case 'point':
        emit(buildPointPrimitives(f, opts));
        break;
      case 'area':
      case 'line':
        break; // already emitted in their band passes above
      default:
        // Compile-time exhaustiveness over the EvaluatedFeature union: a new kind
        // makes `f` non-`never` here and fails the build, so it can never be
        // silently dropped from the draw (教訓: 網羅性は型で保証).
        assertNeverFeature(f);
    }
  }
  for (const p of labels) primitives.push(p);

  return {
    primitives,
    visibleCount: visible.length,
  };
}

/** Compile-time exhaustiveness guard for the evaluated-feature union. */
function assertNeverFeature(value: never): never {
  throw new Error(`feature-layer: unhandled feature ${JSON.stringify(value)}`);
}
