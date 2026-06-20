import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../coordinate';
import {
  SPLIT_CHECK_STATUS,
  SPLIT_REJECT,
  SPLIT_REJECT_MESSAGE,
  checkSplittable,
  executeSplit,
  smallerSide,
} from './split-geometry';
import {
  createClosedKnifeLine,
  createOpenKnifeLine,
} from './knife-line';
import { aggregate, squareWithHole, squareWithHoleEnclave, unitSquare } from './fixtures';

const c = (lon: number, lat: number) => createCoordinate(lon, lat);

describe('checkSplittable — open line piercing a convex square (受け入れ基準1)', () => {
  it('splits a [0,10]² square with a vertical cut into two pieces', () => {
    const { feature, store } = unitSquare();
    // A vertical line from below the square to above it through x=5.
    const line = createOpenKnifeLine([c(5, -5), c(5, 15)]);
    const res = checkSplittable(feature, store, line);
    expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
    if (res.status === SPLIT_CHECK_STATUS.Splittable) {
      expect(res.sideA.area.length).toBeGreaterThanOrEqual(1);
      expect(res.sideB.area.length).toBeGreaterThanOrEqual(1);
      // Both halves are ~half the area.
      expect(res.sideA.areaKm2).toBeGreaterThan(0);
      expect(res.sideB.areaKm2).toBeGreaterThan(0);
    }
  });
});

describe('checkSplittable — cut through existing vertices (FR-77 grid-snap; 受け入れ基準1/4)', () => {
  it('accepts a corner-to-corner diagonal that pierces through two polygon corners', () => {
    const { feature, store } = unitSquare();
    // Diagonal entering through corner (0,0) and exiting through (10,10): every
    // boundary contact is at an EXISTING vertex (Endpoint, never Proper). The old
    // Proper-only gate wrongly rejected this; it geometrically bisects the square.
    const line = createOpenKnifeLine([c(-5, -5), c(15, 15)]);
    const res = checkSplittable(feature, store, line);
    expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
    if (res.status === SPLIT_CHECK_STATUS.Splittable) {
      expect(res.sideA.areaKm2).toBeGreaterThan(0);
      expect(res.sideB.areaKm2).toBeGreaterThan(0);
    }
  });

  it('accepts a cut entering through corner (0,0) and exiting the opposite top edge', () => {
    const { feature, store } = unitSquare();
    // Enters at the existing corner (0,0) (Endpoint), exits the top edge at (8,10)
    // (Proper). The thru-vertex entry must not be mis-detected as a non-pierce.
    const line = createOpenKnifeLine([c(-5, -5), c(8, 15)]);
    const res = checkSplittable(feature, store, line);
    expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
  });

  it('still rejects a line that only grazes a corner without entering (貫通せず)', () => {
    const { feature, store } = unitSquare();
    // Touches corner (0,0) but stays entirely outside (lower-left), no interior.
    const line = createOpenKnifeLine([c(-5, 5), c(5, -5)]);
    const res = checkSplittable(feature, store, line);
    // Grazes the corner (0,0) only as a single boundary touch → not 2 transits,
    // no interior midpoint → correctly NOT a pierce.
    expect(res.status).toBe(SPLIT_CHECK_STATUS.NotSplittable);
  });
});

describe('checkSplittable — rejection cases (受け入れ基準4)', () => {
  it('rejects an aggregate target (FR-44 / 教訓5.25)', () => {
    const { store } = unitSquare();
    const res = checkSplittable(aggregate(), store, createOpenKnifeLine([c(5, -5), c(5, 15)]));
    expect(res.status).toBe(SPLIT_CHECK_STATUS.NotSplittable);
    if (res.status === SPLIT_CHECK_STATUS.NotSplittable) {
      expect(res.reason).toBe(SPLIT_REJECT.NotTerminal);
      expect(res.message).toBe(SPLIT_REJECT_MESSAGE[SPLIT_REJECT.NotTerminal]);
    }
  });

  it('rejects a line that does not pierce the face (貫通せず)', () => {
    const { feature, store } = unitSquare();
    // A line entirely below the square: no crossing.
    const line = createOpenKnifeLine([c(-5, -5), c(15, -5)]);
    const res = checkSplittable(feature, store, line);
    expect(res.status).toBe(SPLIT_CHECK_STATUS.NotSplittable);
    if (res.status === SPLIT_CHECK_STATUS.NotSplittable) {
      expect(res.reason).toBe(SPLIT_REJECT.DoesNotPierce);
    }
  });

  it('rejects a degenerate (single-point) line', () => {
    const { feature, store } = unitSquare();
    const res = checkSplittable(feature, store, createOpenKnifeLine([c(5, 5)]));
    expect(res.status).toBe(SPLIT_CHECK_STATUS.NotSplittable);
    if (res.status === SPLIT_CHECK_STATUS.NotSplittable) {
      expect(res.reason).toBe(SPLIT_REJECT.DegenerateLine);
    }
  });

  it('每 rejection carries a Japanese message (FR-115 / 教訓5.26)', () => {
    for (const kind of Object.values(SPLIT_REJECT)) {
      expect(SPLIT_REJECT_MESSAGE[kind].length).toBeGreaterThan(0);
    }
  });
});

describe('closed-line split (受け入れ基準3 — interior vs exterior)', () => {
  it('an interior closed loop yields an inside piece and an outside-with-hole piece', () => {
    const { feature, store } = unitSquare();
    // A small closed square fully inside the [0,10]² face.
    const line = createClosedKnifeLine([c(3, 3), c(7, 3), c(7, 7), c(3, 7)]);
    const res = checkSplittable(feature, store, line);
    expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
    if (res.status === SPLIT_CHECK_STATUS.Splittable) {
      // Inside piece (intersection) is smaller than the remainder (difference).
      const small = res.sideA.areaKm2 < res.sideB.areaKm2 ? res.sideA : res.sideB;
      const big = res.sideA.areaKm2 < res.sideB.areaKm2 ? res.sideB : res.sideA;
      expect(small.areaKm2).toBeLessThan(big.areaKm2);
    }
  });
});

describe('split through a hole — all pieces kept (FR-91 / 教訓5.1)', () => {
  it('splits a square-with-hole, keeping every returned piece on both sides', () => {
    const { feature, store } = squareWithHole();
    const line = createOpenKnifeLine([c(5, -5), c(5, 15)]);
    const res = checkSplittable(feature, store, line);
    expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
    if (res.status === SPLIT_CHECK_STATUS.Splittable) {
      // Each side has positive area (the hole removed area from both halves).
      expect(res.sideA.areaKm2).toBeGreaterThan(0);
      expect(res.sideB.areaKm2).toBeGreaterThan(0);
    }
  });
});

describe('split through a hole with an enclave + an untouched hole (FR-91 / 教訓5.1)', () => {
  it('splits a square whose left hole holds an enclave and right hole is untouched', () => {
    const { feature, store } = squareWithHoleEnclave();
    // Vertical cut at x=6 crosses the left hole [3,9]² (and its enclave [4,8]²),
    // leaving the right hole [12,16]×[4,8] untouched.
    const line = createOpenKnifeLine([c(6, -5), c(6, 25)]);
    const res = checkSplittable(feature, store, line);
    expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
    if (res.status === SPLIT_CHECK_STATUS.Splittable) {
      // Both sides have positive area and at least one piece each (片落とし禁止).
      expect(res.sideA.area.length).toBeGreaterThanOrEqual(1);
      expect(res.sideB.area.length).toBeGreaterThanOrEqual(1);
      expect(res.sideA.areaKm2).toBeGreaterThan(0);
      expect(res.sideB.areaKm2).toBeGreaterThan(0);
    }
  });
});

describe('executeSplit produces 共有辺途中切断点情報 (FR-95)', () => {
  it('records a mid-edge cut where the open line crosses an existing edge', () => {
    const { feature, store } = unitSquare();
    // Vertical cut at x=5 crosses the bottom edge (0,0)-(10,0) at (5,0) and the
    // top edge (10,10)-(0,10) at (5,10) — both mid-edge crossings.
    const line = createOpenKnifeLine([c(5, -5), c(5, 15)]);
    const result = executeSplit(feature, store, line);
    expect(result).toBeDefined();
    if (result) {
      expect(result.edgeCuts.length).toBe(2);
      const xs = result.edgeCuts.map((e) => e.coordinate.lon);
      expect(xs.every((x) => x === 5)).toBe(true);
      // Each cut identifies the ring + edge start index it crossed.
      for (const cut of result.edgeCuts) {
        expect(cut.edgeStartIndex).toBeGreaterThanOrEqual(0);
        expect(cut.ringId).toBeDefined();
      }
    }
  });

  it('has no edge cuts for a closed cut line', () => {
    const { feature, store } = unitSquare();
    const result = executeSplit(
      feature,
      store,
      createClosedKnifeLine([c(3, 3), c(7, 3), c(7, 7), c(3, 7)]),
    );
    expect(result).toBeDefined();
    if (result) expect(result.edgeCuts.length).toBe(0);
  });
});

describe('executeSplit / smallerSide', () => {
  it('re-validates and returns the same two sides (教訓5.26)', () => {
    const { feature, store } = unitSquare();
    const line = createOpenKnifeLine([c(3, -5), c(3, 15)]); // off-center → asymmetric
    const result = executeSplit(feature, store, line);
    expect(result).toBeDefined();
    if (result) {
      const smaller = smallerSide(result);
      const smallerArea = smaller === 'a' ? result.sideA.areaKm2 : result.sideB.areaKm2;
      const otherArea = smaller === 'a' ? result.sideB.areaKm2 : result.sideA.areaKm2;
      expect(smallerArea).toBeLessThanOrEqual(otherArea);
    }
  });

  it('returns undefined for a non-splittable input', () => {
    const { feature, store } = unitSquare();
    expect(executeSplit(feature, store, createOpenKnifeLine([c(-5, -5), c(15, -5)]))).toBeUndefined();
  });
});
