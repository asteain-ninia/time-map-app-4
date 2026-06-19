import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../coordinate';
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
});
