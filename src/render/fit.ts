// Render-layer camera FIT (U17): compute the camera that frames a world bbox.
//
// FR-11's `initialCamera` frames the WHOLE world; this frames an ARBITRARY world
// bounding box (a selected feature's extent) so a「錨一覧」/ timeline-origin
// selection can snap the view onto that feature (task HB5-3). Pure and
// viewport-only (independent of the current camera), mirroring `fitWorldZoom` /
// `initialCamera`: it proposes a fresh U16 `Camera` value; U16 stores it through
// the single `writeCamera` path (単一真実源 — the render layer never holds camera
// STATE, 教訓 5.29 / camera.ts).
//
// LONGITUDE is a CONTINUOUS scalar (U05): the caller passes bounds already aligned
// to a continuous run (a feature straddling the antimeridian comes in as e.g.
// [170, 190], not the folded [170, −170]), so the midpoint / span are the natural
// short-way framing and the produced `centerLon` stays continuous (no fold here —
// the renderer wraps at draw time). LATITUDE is NOT periodic, so the center is
// clamped to the world's physical [−90, 90] via the single `clampLat` boundary.

import { clampLat, clampZoom, type Camera, type Viewport, type ZoomRange } from './camera';
import { initialCamera } from './vtransform';

/**
 * A world-space axis-aligned bounding box in the SAME continuous (lon, lat)
 * coordinates the renderer draws with. `minLon <= maxLon` and `minLat <= maxLat`;
 * a degenerate (zero-span) box is allowed (a point feature) — that axis then
 * imposes no zoom constraint and the clamp decides the final zoom.
 */
export interface WorldBounds {
  readonly minLon: number;
  readonly maxLon: number;
  readonly minLat: number;
  readonly maxLat: number;
}

/**
 * Default fit padding: the extra margin added on EACH side of the content, as a
 * fraction of the content's span (task HB5-3「パディング~20%」). At 0.2 the framed
 * feature occupies the central ~1/(1 + 2·0.2) ≈ 71% of each axis, leaving a ~20%
 * gutter on every side so the shape is not flush against the viewport edge.
 */
export const DEFAULT_FIT_PADDING_RATIO = 0.2;

/** Options for {@link cameraForBounds}. */
export interface FitOptions {
  /** Margin per side as a fraction of the span (default {@link DEFAULT_FIT_PADDING_RATIO}). */
  readonly paddingRatio?: number;
  /** The inclusive zoom clamp (FR-10 / U16 zoomMin/zoomMax). Applied via {@link clampZoom}. */
  readonly range?: ZoomRange;
}

/**
 * The camera that frames `bounds` inside `viewport`, centered on the box with the
 * LARGEST zoom (CSS px per degree) at which the padded box still fits BOTH axes —
 * whichever axis is the tighter constraint wins, so the content never overflows.
 *
 * Degenerate handling (病的入力の安全性, same discipline as `fitWorldZoom`):
 *   - a zero-span axis (e.g. a point feature, or a viewport not yet measured)
 *     imposes NO zoom constraint (its fit-zoom is +∞); if BOTH axes are degenerate
 *     the raw zoom is +∞, which {@link clampZoom} saturates to the range's MAX zoom
 *     — so a point snaps to the closest allowed zoom centered on itself, never NaN.
 *   - the result zoom is ALWAYS finite-positive (clampZoom guarantees it), so the
 *     produced camera is safe to feed straight into the world↔screen transform.
 *
 * Pure; the input is not mutated (a fresh `Camera` is returned, 教訓 5.17).
 */
export function cameraForBounds(
  bounds: WorldBounds,
  viewport: Viewport,
  options: FitOptions = {},
): Camera {
  const paddingRatio =
    Number.isFinite(options.paddingRatio) && (options.paddingRatio as number) >= 0
      ? (options.paddingRatio as number)
      : DEFAULT_FIT_PADDING_RATIO;

  const centerLon = (bounds.minLon + bounds.maxLon) / 2;
  const centerLat = clampLat((bounds.minLat + bounds.maxLat) / 2);

  // Padded span = content span grown by `paddingRatio` on each side.
  const spanFactor = 1 + 2 * paddingRatio;
  const paddedLon = Math.max(0, bounds.maxLon - bounds.minLon) * spanFactor;
  const paddedLat = Math.max(0, bounds.maxLat - bounds.minLat) * spanFactor;

  // Per-axis fit zoom (px/deg). A zero padded span or a degenerate viewport axis
  // yields +∞ (no constraint from that axis) rather than a 0/0 = NaN.
  const zoomForLon =
    paddedLon > 0 && Number.isFinite(viewport.widthCss) && viewport.widthCss > 0
      ? viewport.widthCss / paddedLon
      : Number.POSITIVE_INFINITY;
  const zoomForLat =
    paddedLat > 0 && Number.isFinite(viewport.heightCss) && viewport.heightCss > 0
      ? viewport.heightCss / paddedLat
      : Number.POSITIVE_INFINITY;

  // The tighter axis wins; clampZoom bounds it into the FR-10 / U16 range and
  // maps a degenerate +∞ (both axes unconstrained) to the range MAX.
  const zoom = clampZoom(Math.min(zoomForLon, zoomForLat), options.range);

  return { centerLon, centerLat, zoom };
}

/**
 * The camera for a fit that may have NOTHING to frame: `bounds` when there is an
 * extent, else the FR-11 既定視点 (`initialCamera` — world fit, center 0/0) with the
 * SAME zoom clamp applied. The 表示 →「全体表示」command uses it, so its two branches
 * cannot diverge on the FR-10 clamp policy (単一真実源).
 *
 * The clamp on the fallback is load-bearing (review fix). `initialCamera` is a pure
 * viewport→camera proposal and knows nothing of the user's zoomMin/zoomMax, so writing
 * it RAW could:
 *   - strand the camera OUTSIDE `effectiveZoomRange` when the settings' zoomMax is below
 *     this viewport's world-fit zoom (the schema allows it) — the defect class
 *     canvas2d-renderer already fixed once, where a stranded zoom makes the next wheel
 *     notch clamp in the OPPOSITE direction to the gesture; and
 *   - write zoom 0 when called before layout (`fitWorldZoom` reports 0 for an unmeasured
 *     viewport by design), which draws nothing until the next notch.
 * Routing it through `clampZoom` maps both cases into the allowed window.
 *
 * Pure; `bounds === null` is the explicit「枠にすべき物が無い」input (教訓 5.18 明示的空).
 */
export function cameraForFit(
  bounds: WorldBounds | null,
  viewport: Viewport,
  options: FitOptions = {},
): Camera {
  if (bounds !== null) return cameraForBounds(bounds, viewport, options);
  const world = initialCamera(viewport);
  return { ...world, zoom: clampZoom(world.zoom, options.range) };
}
