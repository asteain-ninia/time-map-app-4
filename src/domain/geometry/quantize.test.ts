import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createCoordinate, MAX_COORDINATE_MAGNITUDE } from '../coordinate';
import {
  QUANTIZE_SCALE,
  quantizeCoordinate,
  quantizeRing,
  quantizeScalar,
  quantizedEqual,
} from './quantize';

describe('quantize (R2 front-half, acceptance criterion 2)', () => {
  it('snaps a scalar to the shared integer grid', () => {
    // A value off-grid by a tiny residue collapses to the nearest grid node.
    const v = 10 + 1e-12;
    expect(quantizeScalar(v)).toBe(quantizeScalar(10));
  });

  it('uses a single shared tolerance constant', () => {
    expect(QUANTIZE_SCALE).toBe(1e7);
  });

  it('throws (does not silently snap) on a non-finite coordinate', () => {
    expect(() => quantizeCoordinate(createCoordinate(Number.NaN, 0))).toThrow();
    expect(() => quantizeCoordinate(createCoordinate(0, Infinity))).toThrow();
  });

  it('quantizedEqual is true for coordinates within one grid cell', () => {
    const a = createCoordinate(5, 5);
    const b = createCoordinate(5 + 1e-12, 5 - 1e-12);
    expect(quantizedEqual(a, b)).toBe(true);
  });

  it('removes zero-length edges created by snapping (consecutive duplicates)', () => {
    const ring = [
      createCoordinate(0, 0),
      createCoordinate(0 + 1e-12, 0 - 1e-12), // snaps onto (0,0) -> dropped
      createCoordinate(10, 0),
      createCoordinate(10, 10),
    ];
    const q = quantizeRing(ring);
    expect(q).toHaveLength(3);
    expect(q[0]).toEqual(createCoordinate(0, 0));
    expect(q[1]).toEqual(createCoordinate(10, 0));
    expect(q[2]).toEqual(createCoordinate(10, 10));
  });

  it('drops a trailing vertex equal to the first (implicit closing edge)', () => {
    const ring = [
      createCoordinate(0, 0),
      createCoordinate(10, 0),
      createCoordinate(10, 10),
      createCoordinate(0, 0), // explicit close -> removed (ring model is open)
    ];
    expect(quantizeRing(ring)).toHaveLength(3);
  });

  it('returns an empty ring for empty input (length-decided, lesson 5.18)', () => {
    expect(quantizeRing([])).toEqual([]);
  });

  // Regression for the bug-hunt finding:
  //   "quantizeScalar can produce Infinity for a finite input, throwing past the
  //    boolean-op rejection contract"
  //
  // quantizeScalar snaps via Math.round(value * 1e7) / 1e7. For a finite-but-huge
  // scalar (e.g. 1e302) the multiply overflows IEEE-754 to +Infinity, so a finite
  // input would yield a NON-finite grid value, which createCoordinate then throws
  // on — escaping union/difference/intersection's R2 "never throw" contract. The
  // fix bounds coordinate magnitude at the construction seam so such a coordinate
  // can never be born (and so quantizing any constructible coordinate stays finite).
  describe('quantization never turns a finite coordinate non-finite (Infinity overflow regression)', () => {
    it('the magnitude bound keeps the grid index finite (no overflow to ±Infinity)', () => {
      // The whole point of the bound: at the ceiling, |value| * scale must stay
      // finite (≈ MAX_SAFE_INTEGER, which is ~1e293 below MAX_VALUE), so the index
      // can never overflow to ±Infinity and Math.round stays finite. This is the
      // exact property whose absence caused the bug.
      const idx = MAX_COORDINATE_MAGNITUDE * QUANTIZE_SCALE;
      expect(Number.isFinite(idx)).toBe(true);
      expect(idx).toBeLessThan(Number.MAX_VALUE);
      expect(Number.isFinite(Math.round(idx) / QUANTIZE_SCALE)).toBe(true);
    });

    it('createCoordinate rejects a finite-but-overflowing scalar at birth', () => {
      // 1e302 is the documented repro: 1e302 * 1e7 === Infinity.
      expect(Number.isFinite(1e302 * QUANTIZE_SCALE)).toBe(false); // sanity
      expect(() => createCoordinate(1e302, 0)).toThrow(RangeError);
      expect(() => createCoordinate(0, -1e302)).toThrow(RangeError);
      // The exact ceiling is allowed; clearly beyond it is rejected.
      expect(() => createCoordinate(MAX_COORDINATE_MAGNITUDE, 0)).not.toThrow();
      expect(() => createCoordinate(-MAX_COORDINATE_MAGNITUDE, 0)).not.toThrow();
      expect(() => createCoordinate(MAX_COORDINATE_MAGNITUDE * 2, 0)).toThrow(RangeError);
    });

    it('property: quantizing any constructible coordinate stays finite (never overflows)', () => {
      fc.assert(
        fc.property(
          fc.double({
            noNaN: true,
            noDefaultInfinity: true,
            min: -MAX_COORDINATE_MAGNITUDE,
            max: MAX_COORDINATE_MAGNITUDE,
          }),
          fc.double({
            noNaN: true,
            noDefaultInfinity: true,
            min: -MAX_COORDINATE_MAGNITUDE,
            max: MAX_COORDINATE_MAGNITUDE,
          }),
          (lon, lat) => {
            // Every constructible coordinate must quantize without overflowing the
            // grid index to ±Infinity — the regression invariant.
            const q = quantizeCoordinate(createCoordinate(lon, lat));
            expect(Number.isFinite(q.lon)).toBe(true);
            expect(Number.isFinite(q.lat)).toBe(true);
          },
        ),
        { numRuns: 1000 },
      );
    });
  });
});
