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
 * when already in range. A degenerate range (min > max) collapses to `min` so the
 * result is always well-defined rather than NaN.
 */
export function clampZoom(zoom: number, range: ZoomRange = DEFAULT_ZOOM_RANGE): number {
  const { minZoom, maxZoom } = range;
  if (zoom < minZoom) return minZoom;
  if (zoom > maxZoom) return maxZoom;
  return zoom;
}
