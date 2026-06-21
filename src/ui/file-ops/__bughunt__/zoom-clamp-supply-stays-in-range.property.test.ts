// BUGHUNT R2 regression (explore2-r1) — locks the cross-module clamp invariant
// the live e2e exploration verified but no UNIT test pinned: the user-tightened
// zoom range (U16 settings) projected via `zoomRangeOf` (U39) and applied via
// `clampZoom` (U17) keeps EVERY pathological wheel-zoom value FINITE and inside
// the effective inclusive clamp [min, max].
//
// The explore2-r1.spec.ts plan tightened the FR-10 clamp to [0.5, 4] through the
// real settings dialog, then fired 65 wheel notches + extreme pan and gated
// `data-zoom` for NaN/Infinity and clamp adherence. That e2e found NO anomaly —
// this property test is the permanent, fast, deterministic guard that the same
// settings→camera supply chain can never let a clamped zoom escape the configured
// window or go non-finite, so the green state can never silently regress.
//
// It lives in the `ui` layer (which may import both `ui` and `render`, see the
// header of zoom-limit.ts) because it bridges the SAME two real modules the e2e
// chained — `zoomRangeOf` (settings → ZoomRange value) feeding `clampZoom` (the
// single clamp boundary). It does NOT re-derive the clamp. Pathological inputs
// cover ±Infinity, NaN, sub-floor / super-ceil zooms, and boundary endpoints.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { clampZoom } from '../../../render/camera';
import {
  DEFAULT_PROJECT_SETTINGS,
  ZOOM_LIMIT_CEIL,
  ZOOM_LIMIT_FLOOR,
} from '../../state/settings';
import { zoomRangeOf } from '../zoom-limit';

// A valid, user-settable in-boundary zoom value [0.1, 10000].
const validBound = fc.double({
  min: ZOOM_LIMIT_FLOOR,
  max: ZOOM_LIMIT_CEIL,
  noNaN: true,
  noDefaultInfinity: true,
});

// An ORDERED, valid range (min ≤ max) the same way validateZoomLimits accepts it.
const validRange = fc
  .tuple(validBound, validBound)
  .map(([a, b]) => (a <= b ? { zoomMin: a, zoomMax: b } : { zoomMin: b, zoomMax: a }));

// Pathological + ordinary zoom targets a wheel notch could produce.
const anyZoom = fc.oneof(
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
  fc.constant(0),
  fc.constant(-5),
  fc.double({ min: -1e9, max: 1e9, noNaN: true, noDefaultInfinity: true }),
  fc.double({ min: 1e-12, max: 1e12, noNaN: true, noDefaultInfinity: true }),
);

describe('BUGHUNT R2: settings→camera zoom supply stays finite & in-range (FR-10)', () => {
  it('clampZoom(zoom, zoomRangeOf(settings)) is always finite and within [min,max]', () => {
    fc.assert(
      fc.property(validRange, anyZoom, ({ zoomMin, zoomMax }, zoom) => {
        const settings = { ...DEFAULT_PROJECT_SETTINGS, zoomMin, zoomMax };
        const range = zoomRangeOf(settings);
        // The bridge supplies exactly the stored pair to U17 (no re-clamp here).
        expect(range).toEqual({ minZoom: zoomMin, maxZoom: zoomMax });

        const clamped = clampZoom(zoom, { minZoom: range.minZoom, maxZoom: range.maxZoom });
        // Never NaN/Infinity — the explorer gated data-zoom for exactly this.
        expect(Number.isFinite(clamped)).toBe(true);
        // Inside the configured inclusive window (the e2e's clamp-adherence gate).
        const eps = 1e-9;
        expect(clamped).toBeGreaterThanOrEqual(range.minZoom - eps);
        expect(clamped).toBeLessThanOrEqual(range.maxZoom + eps);
      }),
      { numRuns: 500 },
    );
  });

  it('reproduces the e2e clamp [0.5, 4]: 65-notch wheel extremes pin to the bounds', () => {
    // Mirrors explore2-r1: tighten to [0.5, 4], then drive far past both ends.
    const settings = { ...DEFAULT_PROJECT_SETTINGS, zoomMin: 0.5, zoomMax: 4 };
    const range = zoomRangeOf(settings);
    const r = { minZoom: range.minZoom, maxZoom: range.maxZoom };

    // Extreme zoom-in (factor overflow to +∞ must pin to MAX, never reverse to MIN).
    expect(clampZoom(Number.POSITIVE_INFINITY, r)).toBe(4);
    expect(clampZoom(1e300, r)).toBe(4);
    // Extreme zoom-out pins to MIN.
    expect(clampZoom(Number.NEGATIVE_INFINITY, r)).toBe(0.5);
    expect(clampZoom(1e-300, r)).toBe(0.5);
    // In-window value passes through unchanged.
    expect(clampZoom(2, r)).toBe(2);
    // NaN (positionless) resolves to the safe lower bound, never escapes.
    expect(clampZoom(Number.NaN, r)).toBe(0.5);
  });
});
