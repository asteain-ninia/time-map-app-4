// VTransform: pure world↔screen coordinate math for the equirectangular map
// (U17, FR-05 / FR-07 / FR-08 / FR-11 / FR-17).
//
// EVERY function here is pure (no `CanvasRenderingContext2D`, no globals, no
// clock, no mutation — 教訓 5.17). The Canvas 2D renderer (and any future WebGL
// renderer) consumes these results to issue draw commands; the transform itself
// is renderer-independent so the WebGL退避路 (技術方針 R1) reuses it verbatim and
// the math is unit/property-testable in plain Node (NFR 5.8).
//
// Coordinate model (spec §3 / §実装方針):
//   - World = (lon, lat) in degrees. Longitude is a CONTINUOUS scalar (U03's
//     WorldCoordinate); the camera centerLon is likewise continuous and is NOT
//     folded here. Display-time longitude normalization and ±360° wrap counting
//     go exclusively through U05 (`seam`/`longitude`); this module never
//     re-implements seam detection or ±360° folding (教訓 §4 / §5.30 単一真実源).
//   - Screen = (x, y) in CSS pixels, origin at the surface top-left, x→right,
//     y→down. devicePixelRatio is NOT involved (spec §HiDPI): the transform is
//     CSS-pixel based so FR-17's one-constant on-screen size is device-stable.
//   - zoom = CSS pixels per degree (same scale for lon-x and lat-y, the
//     equirectangular linearity, FR-05). Latitude increases UPWARD, so screen y
//     decreases as lat increases (the y axis is flipped).
//
// This single transform pair backs drawing, hit-testing and (later) selection
// (教訓 5.29 派生形状は単一判定): worldToScreen / screenToWorld are exact inverses
// so "drawn here ⇒ clickable here" can never drift.

import { wrapLonDeg } from '../domain/geo/longitude';
import { LONGITUDE_PERIOD } from '../domain/geo/seam';

import type { Camera, Viewport, ZoomRange } from './camera';
import { clampZoom, WORLD_LAT_SPAN_DEG, WORLD_LON_SPAN_DEG } from './camera';

/** A point in CSS-pixel screen space (origin top-left, y down). */
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/** A point in world space (continuous-scalar longitude, latitude in degrees). */
export interface WorldPoint {
  readonly lon: number;
  readonly lat: number;
}

/**
 * World → screen (CSS pixels). The viewport center maps to the camera center;
 * one degree of longitude or latitude spans `zoom` CSS pixels. Longitude uses the
 * RAW continuous difference `lon - centerLon` (no ±360° fold) so panning across
 * the seam and the wrap-replica drawing (see {@link wrapTurnsForViewport}) stay
 * continuous — folding here would tear a feature that straddles ±180°.
 *
 * Latitude is flipped (lat up ⇒ y down). Pure; the inverse is
 * {@link screenToWorld}.
 */
export function worldToScreen(
  world: WorldPoint,
  camera: Camera,
  viewport: Viewport,
): ScreenPoint {
  const cx = viewport.widthCss / 2;
  const cy = viewport.heightCss / 2;
  const x = cx + (world.lon - camera.centerLon) * camera.zoom;
  const y = cy - (world.lat - camera.centerLat) * camera.zoom;
  return { x, y };
}

/**
 * Screen (CSS pixels) → world. Exact algebraic inverse of {@link worldToScreen};
 * the round-trip world→screen→world (and screen→world→screen) is the identity up
 * to float rounding (受け入れ基準 1, property-tested). The returned longitude is a
 * CONTINUOUS scalar (it can fall outside [-180, 180)) — callers that need a
 * representative longitude pass it through U05's normalization, never an ad-hoc
 * fold here.
 */
export function screenToWorld(
  screen: ScreenPoint,
  camera: Camera,
  viewport: Viewport,
): WorldPoint {
  const cx = viewport.widthCss / 2;
  const cy = viewport.heightCss / 2;
  const lon = camera.centerLon + (screen.x - cx) / camera.zoom;
  const lat = camera.centerLat - (screen.y - cy) / camera.zoom;
  return { lon, lat };
}

/**
 * The fit-everything zoom for FR-11's initial view: the LARGEST zoom (CSS px per
 * degree) at which the whole world — 360° of longitude AND 180° of latitude —
 * fits inside the viewport. Whichever axis is the tighter constraint wins
 * (横長⇒緯度が制約, 縦長⇒経度が制約), so the result never overflows either axis and
 * is never needlessly small (受け入れ基準 4).
 *
 * Pure and viewport-only (independent of camera). A degenerate viewport (zero or
 * non-finite width/height) yields 0 rather than NaN/Infinity so callers can
 * detect "not yet measured" by `zoom === 0` (病的入力の安全性).
 */
export function fitWorldZoom(viewport: Viewport): number {
  const { widthCss, heightCss } = viewport;
  if (
    !Number.isFinite(widthCss) ||
    !Number.isFinite(heightCss) ||
    widthCss <= 0 ||
    heightCss <= 0
  ) {
    return 0;
  }
  const zoomForLon = widthCss / WORLD_LON_SPAN_DEG;
  const zoomForLat = heightCss / WORLD_LAT_SPAN_DEG;
  return Math.min(zoomForLon, zoomForLat);
}

/**
 * The FR-11 initial camera: center longitude 0°, center latitude 0°, zoom =
 * {@link fitWorldZoom}. Returned as a fresh U16 `Camera` value (the render layer
 * proposes it; U16 stores it — 単一真実源). Pure.
 */
export function initialCamera(viewport: Viewport): Camera {
  return {
    centerLon: 0,
    centerLat: 0,
    zoom: fitWorldZoom(viewport),
  };
}

/**
 * Cursor-anchored wheel zoom (FR-08). Computes the NEW camera such that the world
 * point currently under the cursor stays under the same cursor screen position
 * after the zoom change — the "zoom toward the cursor" invariant (受け入れ基準 2,
 * property-tested for arbitrary cursor positions and zoom deltas).
 *
 * Algorithm (kept as pure algebra, spec §カーソル中心ズーム):
 *   1. Find the world point W under `cursor` at the OLD camera.
 *   2. Clamp the requested new zoom into `range`.
 *   3. Solve for the new center so that worldToScreen(W, newCamera) === cursor.
 *      With the equirectangular transform this is closed-form:
 *        newCenterLon = W.lon - (cursor.x - cx) / newZoom
 *        newCenterLat = W.lat + (cursor.y - cy) / newZoom
 *
 * centerLon stays a CONTINUOUS scalar (no fold), so zooming while the cursor sits
 * near the world seam never snaps the center back (受け入れ基準 2 末項). The input
 * camera is not mutated; a new `Camera` is returned (教訓 5.17). When the clamp
 * pins the zoom (already at a bound) the center is recomputed against the pinned
 * zoom, which leaves the camera unchanged — the cursor invariant still holds.
 */
export function zoomAtCursor(
  camera: Camera,
  viewport: Viewport,
  cursor: ScreenPoint,
  nextZoom: number,
  range?: ZoomRange,
): Camera {
  const world = screenToWorld(cursor, camera, viewport);
  const clampedZoom = clampZoom(nextZoom, range);
  const cx = viewport.widthCss / 2;
  const cy = viewport.heightCss / 2;
  return {
    zoom: clampedZoom,
    centerLon: world.lon - (cursor.x - cx) / clampedZoom,
    centerLat: world.lat + (cursor.y - cy) / clampedZoom,
  };
}

/**
 * Apply a multiplicative zoom STEP (e.g. one wheel notch = factor 1.1) anchored at
 * the cursor. Thin convenience over {@link zoomAtCursor}; the new target zoom is
 * `camera.zoom * factor` before clamping. Pure.
 */
export function zoomStepAtCursor(
  camera: Camera,
  viewport: Viewport,
  cursor: ScreenPoint,
  factor: number,
  range?: ZoomRange,
): Camera {
  return zoomAtCursor(camera, viewport, cursor, camera.zoom * factor, range);
}

/**
 * The set of ±360° world-turn offsets needed so the wrap-replicated map covers
 * the whole viewport without a gap at the world seam (FR-07 端ラップ表示).
 *
 * Returns an array of INTEGER turn counts (…, -1, 0, +1, …); the caller draws the
 * features/grid/base-map once per turn, each shifted by `turns * 360°` of
 * longitude. The period (360°) is U05's `LONGITUDE_PERIOD` — this unit holds no
 * private period constant (教訓 §4 / spec §連続スカラー経度と端ラップ 単一真実源).
 *
 * The list is computed in ONE pass from the viewport's covered longitude span
 * (no repeated ±360° stepping, so no float累積 — spec §量子化の落とし穴): we find
 * the continuous longitude at the left and right screen edges, divide each by the
 * period to get the bounding turn indices, and enumerate the inclusive integer
 * range. A viewport covering several world turns (deep zoom-out) yields several
 * offsets; one that stays within a single turn yields exactly `[0]` (lesson 5.18:
 * the single-offset, no-crossing case is returned explicitly as length 1, never
 * collapsed away). A degenerate/zero viewport yields `[0]`.
 *
 * NOTE: this returns turn OFFSETS, not folded longitudes. Display-time
 * normalization of the center longitude itself (FR-12 representative interval)
 * uses U05's `wrapLonDeg`; see {@link representativeCenterLon}.
 */
export function wrapTurnsForViewport(camera: Camera, viewport: Viewport): number[] {
  if (
    !Number.isFinite(viewport.widthCss) ||
    viewport.widthCss <= 0 ||
    !Number.isFinite(camera.zoom) ||
    camera.zoom <= 0
  ) {
    return [0];
  }
  // Continuous longitudes at the left and right screen edges.
  const leftLon = screenToWorld({ x: 0, y: 0 }, camera, viewport).lon;
  const rightLon = screenToWorld({ x: viewport.widthCss, y: 0 }, camera, viewport).lon;

  // A base replica drawn at turn `t` shifts every longitude by `t * period`. For
  // the replica's content (which natively lives in [-180, 180)) to intersect the
  // covered span [leftLon, rightLon], we need turns spanning the covered range
  // divided by the period. Compute the inclusive integer turn range once.
  const minTurn = Math.floor((leftLon + 180) / LONGITUDE_PERIOD);
  const maxTurn = Math.floor((rightLon + 180) / LONGITUDE_PERIOD);

  const turns: number[] = [];
  for (let t = minTurn; t <= maxTurn; t += 1) {
    turns.push(t);
  }
  // Defensive: an empty range cannot occur for a positive-width viewport (right ≥
  // left), but never return [] — a frame must draw at least the identity turn.
  return turns.length === 0 ? [0] : turns;
}

/**
 * The set of ±360° turn offsets at which a primitive whose CONTENT spans the
 * continuous longitudes `[lonMin, lonMax]` must be drawn so every on-screen replica
 * is painted (HB-14 ROOT FIX — 拡大すると地物が消える).
 *
 * WHY THIS EXISTS (the recurring classic): {@link wrapTurnsForViewport} assumes a
 * primitive's content lives in the base range `[-180, 180)` and enumerates the turns
 * that tile THAT base across the seam. But feature primitives carry CONTINUOUS-scalar
 * longitudes (U03 never folds them, and `committed-features` passes them through
 * verbatim — a point can sit at lon = 360, a seam-crossing line at lon ∈ [179, 181]).
 * For such content the base-range turn list is WRONG: at a zoomed-in camera whose view
 * span is a single turn, `wrapTurnsForViewport` collapses to `[0]`, so a feature at
 * lon = 360 was drawn at screen x = (360 − centerLon)·zoom — far off-screen — and
 * VANISHED on zoom-in even though the view-clip (which checks every replica) kept it.
 * Clip ⊇ draw was violated: the candidate set kept the feature but the renderer never
 * painted the turn that would land it on screen.
 *
 * This helper makes the turn enumeration RELATIVE TO THE PRIMITIVE'S OWN longitude
 * span, so the replica `[lonMin + k·360, lonMax + k·360]` is enumerated for exactly
 * the integers k where it can intersect the covered view span `[leftLon, rightLon]`.
 * The result therefore covers any continuous longitude, and — crucially — AGREES with
 * the period-aware view clip (which keeps a feature iff some replica intersects), so
 * "kept by clip ⇒ painted by renderer" holds at every zoom (教訓 5.29 単一真実源).
 *
 * Closed form (no per-turn float累積, same discipline as {@link wrapTurnsForViewport}):
 *   minTurn = ceil((leftLon  − lonMax) / period)   // first replica reaching the left edge
 *   maxTurn = floor((rightLon − lonMin) / period)  // last replica still touching the right edge
 * The inclusive integer range [minTurn, maxTurn] is exactly the overlapping replicas.
 * A degenerate viewport/camera, or a non-finite span, yields `[0]` (a frame always
 * draws at least the identity turn — 教訓 5.18). When the span is empty (lonMin >
 * lonMax, which cannot arise from a min/max bbox) the identity turn is returned.
 */
export function wrapTurnsForLonSpan(
  lonMin: number,
  lonMax: number,
  camera: Camera,
  viewport: Viewport,
): number[] {
  if (
    !Number.isFinite(viewport.widthCss) ||
    viewport.widthCss <= 0 ||
    !Number.isFinite(camera.zoom) ||
    camera.zoom <= 0 ||
    !Number.isFinite(lonMin) ||
    !Number.isFinite(lonMax) ||
    lonMin > lonMax
  ) {
    return [0];
  }
  const leftLon = screenToWorld({ x: 0, y: 0 }, camera, viewport).lon;
  const rightLon = screenToWorld({ x: viewport.widthCss, y: 0 }, camera, viewport).lon;
  const minTurn = Math.ceil((leftLon - lonMax) / LONGITUDE_PERIOD);
  const maxTurn = Math.floor((rightLon - lonMin) / LONGITUDE_PERIOD);
  const turns: number[] = [];
  for (let t = minTurn; t <= maxTurn; t += 1) turns.push(t);
  return turns.length === 0 ? [0] : turns;
}

/**
 * The display-time representative center longitude (FR-12): fold the continuous
 * scalar center into [-180, +180) via U05's `wrapLonDeg`. The render layer does
 * NOT decide the representative interval itself — it delegates entirely to U05 so
 * the seam convention (+180 → -180) lives in one place. Pure.
 */
export function representativeCenterLon(camera: Camera): number {
  return wrapLonDeg(camera.centerLon);
}
