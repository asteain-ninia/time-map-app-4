import { describe, expect, it } from 'vitest';

import { coordinatesEqual, createCoordinate } from '../coordinate';
import {
  LONGITUDE_PERIOD,
  isRepresentativeRing,
  maxAdjacentLonGap,
  normalizeCoordinate,
  rewrapReplicas,
  rewrapRing,
  ringsShareVertexAcrossSeam,
  unwrapRing,
  worldWrapReplicas,
} from './seam';

const ring = (...lonLat: [number, number][]) =>
  lonLat.map(([lon, lat]) => createCoordinate(lon, lat));

// --- Criterion 1: ±360° normalization into [-180, +180) ---------------------

describe('normalizeCoordinate', () => {
  it('folds arbitrary longitudes into [-180, +180)', () => {
    expect(normalizeCoordinate(createCoordinate(540, 10)).lon).toBe(180 - 360 + 0); // 540 -> 180 -> -180
    expect(normalizeCoordinate(createCoordinate(540, 10)).lon).toBe(-180);
    expect(normalizeCoordinate(createCoordinate(-450, 10)).lon).toBe(-90);
    expect(normalizeCoordinate(createCoordinate(0, 10)).lon).toBe(0);
  });

  it('uses the [-180, +180) boundary convention: +180 -> -180, -180 stays', () => {
    expect(normalizeCoordinate(createCoordinate(180, 5)).lon).toBe(-180);
    expect(normalizeCoordinate(createCoordinate(-180, 5)).lon).toBe(-180);
  });

  it('passes latitude through unchanged (no latitude wrapping, FR-05)', () => {
    expect(normalizeCoordinate(createCoordinate(540, 91.5)).lat).toBe(91.5);
    expect(normalizeCoordinate(createCoordinate(540, -123)).lat).toBe(-123);
  });

  it('rejects non-finite longitude rather than producing NaN', () => {
    expect(() => normalizeCoordinate(createCoordinate(NaN, 0))).toThrow();
    expect(() => normalizeCoordinate(createCoordinate(Infinity, 0))).toThrow();
  });
});

// --- Criterion 2: seam-crossing ring continuation ---------------------------

describe('unwrapRing', () => {
  it('makes an east->west seam crossing continuous (gap < 180)', () => {
    const r = ring([179, 0], [-179, 0], [-178, 1]);
    const u = unwrapRing(r);
    expect(maxAdjacentLonGap(u)).toBeLessThan(180);
    // +179 -> -179 is a +2° eastward step => continuous 181.
    expect(u[1]!.lon).toBeCloseTo(181, 9);
    expect(u[2]!.lon).toBeCloseTo(182, 9);
  });

  it('makes a west->east seam crossing continuous (gap < 180)', () => {
    const r = ring([-179, 0], [179, 0], [178, 1]);
    const u = unwrapRing(r);
    expect(maxAdjacentLonGap(u)).toBeLessThan(180);
    // -179 -> 179 is a -2° westward step => continuous -181.
    expect(u[1]!.lon).toBeCloseTo(-181, 9);
  });

  it('leaves a non-crossing ring unchanged', () => {
    const r = ring([10, 0], [20, 1], [30, 2], [10, 0]);
    const u = unwrapRing(r);
    for (let i = 0; i < r.length; i++) {
      expect(coordinatesEqual(u[i]!, r[i]!)).toBe(true);
    }
  });

  it('handles multi-wind input with monotone accumulation', () => {
    // representative form of a continuous 0,90,180->-180,270->-90,360->0 walk.
    const r = ring([0, 0], [90, 0], [-180, 0], [-90, 0], [0, 0], [90, 0], [-180, 0]);
    const u = unwrapRing(r);
    expect(maxAdjacentLonGap(u)).toBeLessThanOrEqual(180);
    expect(Number.isFinite(u[u.length - 1]!.lon)).toBe(true);
    // monotonically increasing by ~90 each step.
    for (let i = 1; i < u.length; i++) {
      expect(u[i]!.lon - u[i - 1]!.lon).toBeCloseTo(90, 6);
    }
  });

  it('handles degenerate rings (0, 1, 2 vertices) without error', () => {
    expect(unwrapRing([])).toEqual([]);
    expect(unwrapRing(ring([5, 5]))).toHaveLength(1);
    expect(unwrapRing(ring([5, 5], [6, 6]))).toHaveLength(2);
  });

  it('does not mutate the input array', () => {
    const r = ring([179, 0], [-179, 0]);
    const snapshot = r.map((c) => ({ ...c }));
    unwrapRing(r);
    r.forEach((c, i) => {
      expect(c.lon).toBe(snapshot[i]!.lon);
      expect(c.lat).toBe(snapshot[i]!.lat);
    });
  });
});

// --- Criterion 3: round-trip ------------------------------------------------

describe('rewrapRing (inverse normalization)', () => {
  it('round-trips a representative ring through unwrap -> identity -> rewrap', () => {
    const r = ring([179, 0], [-179, 0], [-178, 1], [180 - 360, 2]);
    const normalized = rewrapRing(r); // ensure representative baseline
    const back = rewrapRing(unwrapRing(normalized));
    normalized.forEach((c, i) => expect(coordinatesEqual(back[i]!, c)).toBe(true));
  });

  it('round-trips a ±360°-offset replica back to the representative form', () => {
    const r = ring([10, 0], [-170, 1], [90, 2]);
    const shifted = r.map((c) => createCoordinate(c.lon + 720, c.lat));
    const back = rewrapRing(shifted);
    r.forEach((c, i) => expect(coordinatesEqual(back[i]!, c)).toBe(true));
  });
});

// --- Criterion 4 & 5: world-wrap replicas (multiple pieces) -----------------

describe('worldWrapReplicas', () => {
  it('produces one replica per requested turn, including the identity (turns=0)', () => {
    const r = ring([10, 0], [20, 1]);
    const replicas = worldWrapReplicas(r, [-1, 0, 1]);
    expect(replicas.map((x) => x.turns)).toEqual([-1, 0, 1]);
    // identity replica equals input longitudes.
    const identity = replicas.find((x) => x.turns === 0)!;
    expect(identity.ring[0]!.lon).toBe(10);
    // ±360 shifts.
    expect(replicas.find((x) => x.turns === -1)!.ring[0]!.lon).toBe(10 - 360);
    expect(replicas.find((x) => x.turns === 1)!.ring[0]!.lon).toBe(10 + 360);
  });

  it('keeps the zero-offset replica (lesson 5.18: no falsy drop)', () => {
    const replicas = worldWrapReplicas(ring([0, 0]), [0]);
    expect(replicas).toHaveLength(1);
    expect(replicas[0]!.turns).toBe(0);
  });

  it('an empty turns list yields no replicas (a valid result, not an error)', () => {
    expect(worldWrapReplicas(ring([1, 1]), [])).toEqual([]);
  });

  it('rewrapReplicas folds every piece back (no piece dropped, lesson 5.1)', () => {
    const r = ring([170, 0], [175, 1]);
    const folded = rewrapReplicas(worldWrapReplicas(r, [-1, 0, 1]));
    expect(folded).toHaveLength(3);
    for (const piece of folded) {
      expect(isRepresentativeRing(piece)).toBe(true);
    }
  });
});

// --- Criterion 5: minimal seam-overlap wiring -------------------------------

describe('ringsShareVertexAcrossSeam', () => {
  it('detects a shared vertex when both rings already coincide (identity replica)', () => {
    const a = ring([179, 10], [178, 11]);
    const b = ring([179, 10], [-179, 12]);
    expect(ringsShareVertexAcrossSeam(a, b)).toBe(true);
  });

  it('detects a vertex that only coincides after a ±360° world-turn (replicas are load-bearing)', () => {
    // `a` crosses the seam, so it unwraps into continuous lons [179, 181]: its
    // second vertex lives at +181 in continuous space. `b` stores that same point
    // in representative form as -179. They coincide ONLY when b is shifted +1 turn
    // (-179 + 360 = 181); with no shift there is no shared continuous vertex.
    const a = ring([179, 10], [-179, 10]);
    const b = ring([-179, 10]);
    // Without the ±360° replicas the world-turn is invisible and they look apart.
    expect(ringsShareVertexAcrossSeam(a, b, [0])).toBe(false);
    // The +1 replica aligns them in the common continuous coordinate system.
    expect(ringsShareVertexAcrossSeam(a, b, [-1, 0, 1])).toBe(true);
  });

  it('reports no overlap when no vertex coincides under any shift', () => {
    const a = ring([10, 10], [20, 20]);
    const b = ring([100, 30], [-100, 40]);
    expect(ringsShareVertexAcrossSeam(a, b)).toBe(false);
  });

  it('uses LONGITUDE_PERIOD = 360 as its single constant', () => {
    expect(LONGITUDE_PERIOD).toBe(360);
  });
});
