// fast-check arbitraries for the render-layer VTransform property tests (U17).
//
// These generate well-formed camera / viewport / cursor inputs PLUS deliberately
// pathological ones (extreme continuous-scalar longitudes, clamp-edge zoom,
// degenerate viewports) so the round-trip / cursor-center / wrap invariants are
// exercised at the boundaries the spec calls out (病的入力・極端カメラ).

import fc from 'fast-check';

import type { Camera, Viewport } from './camera';
import type { ScreenPoint, WorldPoint } from './vtransform';

/** A positive, finite zoom (CSS px per degree) spanning world-view to city-view. */
export function zoomArb(): fc.Arbitrary<number> {
  return fc.double({ min: 0.05, max: 5000, noNaN: true, noDefaultInfinity: true });
}

/** A CONTINUOUS-scalar longitude that may wind many turns past ±180 (FR-07). */
export function continuousLonArb(): fc.Arbitrary<number> {
  return fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true });
}

/** A latitude in the world band (−90 .. +90). */
export function latArb(): fc.Arbitrary<number> {
  return fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true });
}

export function cameraArb(): fc.Arbitrary<Camera> {
  return fc.record({
    zoom: zoomArb(),
    centerLon: continuousLonArb(),
    centerLat: latArb(),
  });
}

/** A non-degenerate viewport (positive CSS size, plausible dpr including HiDPI). */
export function viewportArb(): fc.Arbitrary<Viewport> {
  return fc.record({
    widthCss: fc.double({ min: 1, max: 8000, noNaN: true, noDefaultInfinity: true }),
    heightCss: fc.double({ min: 1, max: 8000, noNaN: true, noDefaultInfinity: true }),
    devicePixelRatio: fc.constantFrom(1, 1.25, 1.5, 2, 3),
  });
}

export function worldPointArb(): fc.Arbitrary<WorldPoint> {
  return fc.record({ lon: continuousLonArb(), lat: latArb() });
}

/** A screen point inside a viewport of the given size. */
export function screenPointInArb(viewport: Viewport): fc.Arbitrary<ScreenPoint> {
  return fc.record({
    x: fc.double({ min: 0, max: viewport.widthCss, noNaN: true, noDefaultInfinity: true }),
    y: fc.double({ min: 0, max: viewport.heightCss, noNaN: true, noDefaultInfinity: true }),
  });
}
