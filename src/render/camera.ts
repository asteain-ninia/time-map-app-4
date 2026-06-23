// Render-layer camera + viewport value types (U17).
//
// CAMERA STATE truth (中心経度・中心緯度・ズーム) is owned by U16's session store
// (`src/ui/state/session.ts`, 単一の真実源, 技術方針 2.5). This unit does NOT hold
// that truth and does NOT mutate it: the render layer receives a camera VALUE,
// transforms with it, and returns a NEW camera value for U16 to store
// (教訓 5.17). The render layer is also `render → domain only` (技術方針 2.13,
// lint-enforced: render must not import from `ui`), so it cannot type-import
// U16's `Camera` directly.
//
// We therefore declare the render layer's camera PARAMETER contract here — the
// three fields the world↔screen transform actually needs (zoom + center). This is
// NOT a second copy of the session STATE (which additionally tracks pan offsets
// and is the dirty-tracked truth); it is the minimal transform input shape. U16's
// `Camera` is a structural SUPERSET of this (it adds panX/panY), so the ui-layer
// wiring unit (which may import both `ui` and `render`) bridges the two at the
// boundary without either layer importing the other's module. Keeping zoom +
// center single-sourced is satisfied because there is exactly ONE stored truth
// (U16) and this is just its read shape for transforms.
//
// `Viewport` and `ZoomRange` are purely render-side with no home in session state:
//   - `Viewport`: the CSS-pixel surface size plus devicePixelRatio. HiDPI
//     discipline (spec §HiDPI): the CSS-pixel size drives every world↔screen
//     transform; devicePixelRatio scales the backing buffer ONLY and is kept OUT
//     of the transform math.
//   - `ZoomRange`: the inclusive zoom clamp. The authoritative bounds live in
//     U16's settings; this unit only APPLIES a supplied range, defaulting to the
//     FR-10 provisional default (min 1× .. max 50×) when none is given.

/**
 * The camera transform input: center longitude (a CONTINUOUS scalar, FR-07) +
 * center latitude + zoom (CSS pixels per degree). Structurally compatible with
 * U16's session `Camera` (which is a superset); the stored truth stays in U16.
 */
export interface Camera {
  /** Camera center longitude (continuous scalar, never folded here). */
  readonly centerLon: number;
  /** Camera center latitude (degrees). */
  readonly centerLat: number;
  /** Zoom = CSS pixels per degree (lon-x and lat-y share this scale, FR-05). */
  readonly zoom: number;
}

/**
 * The drawing surface, measured in CSS pixels. World↔screen transforms are
 * defined entirely in CSS-pixel space; `devicePixelRatio` is carried here only
 * so the Canvas 2D implementation can size its backing buffer (physical pixels
 * = CSS pixels × dpr) without leaking dpr into the transform (spec §HiDPI: the
 * one-constant-size guarantee, FR-17, must not drift per device).
 */
export interface Viewport {
  /** Surface width in CSS pixels. */
  readonly widthCss: number;
  /** Surface height in CSS pixels. */
  readonly heightCss: number;
  /** Device pixel ratio (backing-buffer scale only; never in the transform). */
  readonly devicePixelRatio: number;
}

/** Inclusive zoom clamp bounds (zoom = CSS pixels per longitude/latitude degree). */
export interface ZoomRange {
  readonly minZoom: number;
  readonly maxZoom: number;
}

/**
 * FR-10 default zoom clamp when U16 supplies none. The spec fixes this provisional
 * default as min 1× .. max 50×. It is the ONLY place the fallback lives so a
 * missing range can never silently mean "unclamped" (教訓 5.18: a missing range is
 * a real, named default, not a falsy short-circuit to無制限).
 */
export const DEFAULT_ZOOM_RANGE: ZoomRange = {
  minZoom: 1,
  maxZoom: 50,
};

/** Full longitude span of the world in degrees (one turn). Mirrors U05's period. */
export const WORLD_LON_SPAN_DEG = 360;
/** Full latitude span of the world in degrees (−90 .. +90). */
export const WORLD_LAT_SPAN_DEG = 180;

/**
 * Clamp a zoom value into an inclusive range. Pure; returns the input unchanged
 * when already in range. The result is ALWAYS finite (病的入力の安全性): this is
 * the single documented clamp boundary that every camera consumer trusts
 * (`zoomAtCursor` divides by the clamped zoom — see vtransform.ts — so a NaN/∞
 * result would propagate into a NaN camera center and corrupt every subsequent
 * world↔screen transform and wrap-turn enumeration). We therefore guard BOTH the
 * value and the bounds for finiteness rather than relying on `<`/`>` comparisons,
 * which silently pass `NaN` through (both `NaN < min` and `NaN > max` are false).
 *
 * Bounds are sanitized to a usable inclusive range first:
 *   - a non-finite OR non-positive `minZoom` falls back to the FR-10 default min;
 *   - a non-finite OR non-positive `maxZoom` falls back to the FR-10 default max;
 *   - a degenerate range (min > max) collapses to `min`.
 * Zoom is CSS pixels per degree, so a usable bound MUST be strictly positive: a
 * finite-but-degenerate range like {0,0} (or a negative / sign-crossing range)
 * would otherwise be accepted as-is and pin a positive zoom to 0, which then
 * divides into ±Infinity inside `zoomAtCursor` (newCenter = world − Δ/0) and
 * poisons every later world↔screen transform and wrap-turn enumeration. Treating
 * `<= 0` bounds the same as non-finite ones keeps the clamp window strictly
 * positive, so the result is guaranteed finite AND > 0.
 * Then a non-finite `zoom` is mapped to the bound implied by its SIGN before
 * clamping, so the returned zoom can never be NaN/Infinity AND never reverses the
 * caller's intent:
 *   - `+Infinity` is above every finite bound → it pins to the UPPER bound. (A
 *     wheel "zoom-in" notch whose factor overflowed to +∞ must end at MAX zoom,
 *     never MIN — see PointerDispatcher.wheel; the previous "always lower bound"
 *     behaviour silently REVERSED an extreme zoom-in into a full zoom-out.)
 *   - `-Infinity` is below every finite bound → it pins to the LOWER bound.
 *   - `NaN` has no position on the line → it pins to the LOWER bound (the safe,
 *     conservative default; there is no direction to honour).
 */
export function clampZoom(zoom: number, range: ZoomRange = DEFAULT_ZOOM_RANGE): number {
  // A usable zoom bound must be finite AND strictly positive (CSS px per degree).
  // `<= 0` (including a finite {0,0} / negative / sign-crossing range) falls back
  // to the FR-10 default so the clamp window can never collapse onto 0 and make a
  // later `Δ / zoom` non-finite in `zoomAtCursor`.
  const safeMin =
    Number.isFinite(range.minZoom) && range.minZoom > 0
      ? range.minZoom
      : DEFAULT_ZOOM_RANGE.minZoom;
  const safeMaxRaw =
    Number.isFinite(range.maxZoom) && range.maxZoom > 0
      ? range.maxZoom
      : DEFAULT_ZOOM_RANGE.maxZoom;
  // A degenerate range (min > max) collapses to `min` so the clamp window is
  // never empty and the result stays well-defined.
  const safeMax = safeMaxRaw < safeMin ? safeMin : safeMaxRaw;
  // A non-finite target zoom is resolved by its sign, not blindly to `min`:
  // +∞ saturates to the upper bound, -∞ to the lower, NaN (positionless) to the
  // lower. `<`/`>` would otherwise pass NaN straight through (both comparisons
  // are false for NaN), so we resolve finiteness explicitly first.
  if (!Number.isFinite(zoom)) {
    return zoom === Number.POSITIVE_INFINITY ? safeMax : safeMin;
  }
  if (zoom < safeMin) return safeMin;
  if (zoom > safeMax) return safeMax;
  return zoom;
}

/** Inclusive latitude bounds: the world spans −90° (south pole) .. +90° (north pole). */
export const WORLD_LAT_MIN_DEG = -90;
export const WORLD_LAT_MAX_DEG = 90;

/**
 * Clamp a camera center latitude into the world's physical [−90, +90] range. Pure;
 * returns the input unchanged when already in range.
 *
 * Unlike `centerLon` (a CONTINUOUS scalar with no bound — the seam wraps ±360°),
 * latitude is NOT periodic: there is nothing above the north pole or below the
 * south pole. `zoomAtCursor` and `panCameraTo` derive the new `centerLat` by
 * adding an unbounded screen-offset/zoom term to the old center, so a zoom-at-the-
 * top-edge near the pole or a northward pan past it can push `centerLat` beyond
 * ±90. Such a center scrolls the whole world off-screen with no recovery gesture
 * (every world latitude maps above/below the viewport), leaving a permanently
 * blank canvas. This is the single clamp boundary both camera writers route the
 * resulting latitude through, mirroring `clampZoom`'s role for zoom (病的入力の安全性).
 * Zoom behaviour is unchanged — only the bounded center latitude is affected.
 */
export function clampLat(lat: number): number {
  if (lat < WORLD_LAT_MIN_DEG) return WORLD_LAT_MIN_DEG;
  if (lat > WORLD_LAT_MAX_DEG) return WORLD_LAT_MAX_DEG;
  return lat;
}
