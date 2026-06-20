// U40 — pure PAN math: press-origin + screen-move → new camera center (FR-09).
//
// Panning drags the world under the cursor: as the pointer moves Δscreen from the
// press origin, the camera center moves the OPPOSITE world distance so the world
// point first grabbed stays under the pointer. The screen→world conversion is
// U17's VTransform (`screenToWorld`) — this unit does NOT re-implement any
// coordinate math or ±360° wrapping (受け入れ基準 7, 教訓 §4 / 5.30 単一真実源).
//
// The whole computation is PURE (no DOM, no store): the controller records the
// press-time camera + screen point, then on each move calls {@link panCameraTo}
// with the current screen point to get a fresh camera VALUE, which it writes back
// to U16. Because the new center is computed against the PRESS-TIME camera (not
// the previous frame's), float error does not accumulate across a long drag, and
// the move is idempotent for a given (origin, current) pair (受け入れ基準 4,
// property-tested).
//
// centerLon stays a CONTINUOUS scalar (R3 / FR-07 無限横スクロール): we add the
// raw world Δ to the press-time centerLon and never fold into [-180,180) here.
// Display-time normalization is U05/U17's job — folding mid-pan would tear a pan
// that crosses the ±180° seam (受け入れ基準 1 末項).

import {
  screenToWorld,
  type Camera,
  type ScreenPoint,
  type Viewport,
} from '../../render';

/**
 * The press-time pan reference captured on pointerdown: the camera as it was when
 * the pan started, the viewport at that moment, and the screen point pressed. All
 * subsequent moves are computed relative to THIS reference (受け入れ基準 4), so the
 * pan is stable and accumulation-free. Held by the controller as transient state
 * and discarded on every teardown path (受け入れ基準 6).
 */
export interface PanReference {
  /** The camera center+zoom at press time (the base every move offsets from). */
  readonly camera: Camera;
  /** The viewport at press time (px-per-degree scale source for the conversion). */
  readonly viewport: Viewport;
  /** The screen point pressed (the world-grab origin). */
  readonly origin: ScreenPoint;
}

/**
 * Compute the new camera center so the world point grabbed at the press origin
 * sits under `current`. Using the equirectangular VTransform this is the world
 * delta between the two screen points subtracted from the press-time center:
 *
 *   ΔworldLon = (current.x - origin.x) / zoom   (degrees, via screenToWorld)
 *   ΔworldLat = (origin.y - current.y) / zoom   (y is flipped: lat up ⇒ y down)
 *   newCenterLon = pressCenterLon - ΔworldLon
 *   newCenterLat = pressCenterLat - ΔworldLat
 *
 * We derive both world points through U17's `screenToWorld` (rather than dividing
 * by zoom inline) so the ONE transform definition is the single source — if U17's
 * projection ever changes, pan follows automatically (教訓 §4). The result keeps
 * the press-time zoom unchanged (pan never zooms) and centerLon continuous (no
 * fold). Pure; the input camera/reference are not mutated.
 */
export function panCameraTo(ref: PanReference, current: ScreenPoint): Camera {
  const { camera, viewport, origin } = ref;
  const worldAtOrigin = screenToWorld(origin, camera, viewport);
  const worldAtCurrent = screenToWorld(current, camera, viewport);
  const dLon = worldAtCurrent.lon - worldAtOrigin.lon;
  const dLat = worldAtCurrent.lat - worldAtOrigin.lat;
  return {
    zoom: camera.zoom,
    // Subtract: dragging the pointer right (world moves right under finger)
    // moves the camera center left, so content follows the pointer.
    centerLon: camera.centerLon - dLon,
    centerLat: camera.centerLat - dLat,
  };
}
