import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../coordinate';
import { asRingId, asVertexId } from '../ids';
import { createHoleRing, createShape, createTerritoryRing } from '../ring';
import type { VertexId } from '../ids';
import type { WorldCoordinate } from '../coordinate';
import { createGeoParams, deriveScalars } from './geo-params';
import {
  shortestLonDeltaDeg,
  unwrapLonSequence,
  wrapLonDeg,
} from './longitude';
import {
  DISTANCE_MEASURE,
  equirectangularDistanceKm,
  greatCircleDistanceKm,
  lineLengthKm,
  polygonAreaKm2,
  ringAreaKm2,
  shapeAreaKm2,
} from './geodesy';

const EARTH = createGeoParams(40000, 0); // Earth-scale, true sphere.
const c = createCoordinate;

// --- longitude helpers ------------------------------------------------------

describe('wrapLonDeg (base range [-180, 180))', () => {
  it('leaves in-range values unchanged', () => {
    expect(wrapLonDeg(0)).toBe(0);
    expect(wrapLonDeg(90)).toBe(90);
    expect(wrapLonDeg(-90)).toBe(-90);
  });
  it('folds +180 to -180 and keeps -180', () => {
    expect(wrapLonDeg(180)).toBe(-180);
    expect(wrapLonDeg(-180)).toBe(-180);
  });
  it('folds out-of-range scalars (e.g. +540 -> 180-fold = -180)', () => {
    expect(wrapLonDeg(540)).toBe(-180);
    expect(wrapLonDeg(360)).toBe(0);
    expect(wrapLonDeg(-360)).toBe(0);
    expect(wrapLonDeg(200)).toBeCloseTo(-160, 9);
    expect(wrapLonDeg(-200)).toBeCloseTo(160, 9);
  });
});

describe('shortestLonDeltaDeg (signed, (-180, 180])', () => {
  it('is the plain difference inside range', () => {
    expect(shortestLonDeltaDeg(10, 30)).toBeCloseTo(20, 9);
    expect(shortestLonDeltaDeg(30, 10)).toBeCloseTo(-20, 9);
  });
  it('takes the short way round across the seam (east<->west edge)', () => {
    // +179 to -179 is +2°, not -358°.
    expect(shortestLonDeltaDeg(179, -179)).toBeCloseTo(2, 9);
    expect(shortestLonDeltaDeg(-179, 179)).toBeCloseTo(-2, 9);
  });
  it('reports a perfect 180° separation as +180', () => {
    expect(shortestLonDeltaDeg(0, 180)).toBe(180);
    expect(shortestLonDeltaDeg(0, -180)).toBe(180);
  });
});

describe('unwrapLonSequence', () => {
  it('returns empty for empty input (5.18: empty is a true value)', () => {
    expect(unwrapLonSequence([])).toEqual([]);
  });
  it('keeps the first element and continues monotonically across the seam', () => {
    // 170 -> 179 -> -179 -> -170 unwraps to 170,179,181,190 (continuous).
    expect(unwrapLonSequence([170, 179, -179, -170])).toEqual([170, 179, 181, 190]);
  });
});

// --- derived scalars --------------------------------------------------------

describe('deriveScalars (single source of km/deg scalars)', () => {
  it('matches the spec formulas', () => {
    const s = deriveScalars(createGeoParams(36000, 0.1));
    expect(s.kmPerLonDegAtEquator).toBeCloseTo(100, 9);
    expect(s.kmPerLatDeg).toBeCloseTo(90, 9); // 100 * (1 - 0.1)
    expect(s.sphereRadiusKm).toBeCloseTo(36000 / (2 * Math.PI), 6);
  });
});

// --- AC-1: equirectangular distance -----------------------------------------

describe('equirectangularDistanceKm', () => {
  it('is 0 between identical points', () => {
    expect(equirectangularDistanceKm(c(10, 20), c(10, 20), EARTH)).toBe(0);
  });
  it('is sqrt(dx^2+dy^2) for an axis-parallel pair (east-west)', () => {
    // 90° of lon at 40000km equator -> 10000km, lat unchanged.
    expect(equirectangularDistanceKm(c(0, 0), c(90, 0), EARTH)).toBeCloseTo(10000, 6);
  });
  it('is sqrt(dx^2+dy^2) for an axis-parallel pair (north-south)', () => {
    // 90° of lat -> 10000km on a true sphere.
    expect(equirectangularDistanceKm(c(0, 0), c(0, 90), EARTH)).toBeCloseTo(10000, 6);
  });
  it('is sqrt(dx^2+dy^2) for a diagonal pair', () => {
    const d = equirectangularDistanceKm(c(0, 0), c(90, 90), EARTH);
    expect(d).toBeCloseTo(Math.sqrt(10000 ** 2 + 10000 ** 2), 6);
  });
});

// --- AC-1: great-circle distance --------------------------------------------

describe('greatCircleDistanceKm', () => {
  it('is 0 between identical points', () => {
    expect(greatCircleDistanceKm(c(10, 20), c(10, 20), EARTH)).toBe(0);
  });
  it('equator 90° apart ~ 1/4 of equator length (10000km)', () => {
    expect(greatCircleDistanceKm(c(0, 0), c(90, 0), EARTH)).toBeCloseTo(10000, 3);
  });
  it('pole to equator ~ 1/4 of equator length', () => {
    expect(greatCircleDistanceKm(c(0, 0), c(0, 90), EARTH)).toBeCloseTo(10000, 3);
  });
  it('is stable near antipodes (no NaN)', () => {
    const d = greatCircleDistanceKm(c(0, 0), c(180, 0), EARTH);
    expect(Number.isNaN(d)).toBe(false);
    expect(d).toBeCloseTo(20000, 3); // half the equator.
  });
});

// --- AC-2: line length ------------------------------------------------------

describe('lineLengthKm', () => {
  it('is 0 for fewer than 2 points', () => {
    expect(lineLengthKm([], EARTH)).toBe(0);
    expect(lineLengthKm([c(0, 0)], EARTH)).toBe(0);
  });
  it('sums segments (equirectangular default)', () => {
    const len = lineLengthKm([c(0, 0), c(90, 0), c(90, 90)], EARTH);
    expect(len).toBeCloseTo(20000, 6);
  });
  it('supports the great-circle measure', () => {
    const len = lineLengthKm([c(0, 0), c(90, 0)], EARTH, DISTANCE_MEASURE.GreatCircle);
    expect(len).toBeCloseTo(10000, 3);
  });
});

// --- AC-2: area -------------------------------------------------------------

describe('ringAreaKm2', () => {
  it('is 0 for fewer than 3 vertices', () => {
    expect(ringAreaKm2([], EARTH)).toBe(0);
    expect(ringAreaKm2([c(0, 0), c(10, 0)], EARTH)).toBe(0);
  });
  it('matches the planar shoelace area of a rectangle', () => {
    // 10° lon x 20° lat rectangle. kmPerDeg = 40000/360.
    const k = 40000 / 360;
    const expected = 10 * k * (20 * k);
    const area = ringAreaKm2([c(0, 0), c(10, 0), c(10, 20), c(0, 20)], EARTH);
    expect(area).toBeCloseTo(expected, 3);
  });
  it('is winding-order independent (absolute area)', () => {
    const cw = ringAreaKm2([c(0, 0), c(10, 0), c(10, 20), c(0, 20)], EARTH);
    const ccw = ringAreaKm2([c(0, 0), c(0, 20), c(10, 20), c(10, 0)], EARTH);
    expect(cw).toBeCloseTo(ccw, 9);
  });
});

describe('polygonAreaKm2 (territory + / hole -)', () => {
  // Resolve vertex IDs through a store-like map (R6: rings hold IDs).
  const verts = new Map<VertexId, WorldCoordinate>([
    [asVertexId('o0'), c(0, 0)],
    [asVertexId('o1'), c(40, 0)],
    [asVertexId('o2'), c(40, 40)],
    [asVertexId('o3'), c(0, 40)],
    [asVertexId('h0'), c(10, 10)],
    [asVertexId('h1'), c(20, 10)],
    [asVertexId('h2'), c(20, 20)],
    [asVertexId('h3'), c(10, 20)],
  ]);
  const resolve = (id: VertexId): WorldCoordinate | undefined => verts.get(id);

  it('total = outer - hole', () => {
    const outer = createTerritoryRing(asRingId('t'), [
      asVertexId('o0'), asVertexId('o1'), asVertexId('o2'), asVertexId('o3'),
    ]);
    const hole = createHoleRing(
      asRingId('h'),
      [asVertexId('h0'), asVertexId('h1'), asVertexId('h2'), asVertexId('h3')],
      asRingId('t'),
    );
    const k = 40000 / 360;
    const outerArea = 40 * k * (40 * k);
    const holeArea = 10 * k * (10 * k);
    const total = polygonAreaKm2([outer, hole], resolve, EARTH);
    expect(total).toBeCloseTo(outerArea - holeArea, 2);
  });

  it('shapeAreaKm2 delegates to polygonAreaKm2', () => {
    const outer = createTerritoryRing(asRingId('t'), [
      asVertexId('o0'), asVertexId('o1'), asVertexId('o2'), asVertexId('o3'),
    ]);
    const shape = createShape([outer]);
    const k = 40000 / 360;
    expect(shapeAreaKm2(shape, resolve, EARTH)).toBeCloseTo(40 * k * (40 * k), 2);
  });
});

// --- AC-3: world-seam crossing ----------------------------------------------

describe('world-seam (±360) crossing', () => {
  it('east-edge <-> west-edge distance folds (1°, not 359°)', () => {
    const folded = equirectangularDistanceKm(c(179.5, 0), c(-179.5, 0), EARTH);
    const oneDeg = equirectangularDistanceKm(c(0, 0), c(1, 0), EARTH);
    expect(folded).toBeCloseTo(oneDeg, 6);
  });
  it('great-circle east<->west edge folds too', () => {
    const folded = greatCircleDistanceKm(c(179.5, 0), c(-179.5, 0), EARTH);
    const oneDeg = greatCircleDistanceKm(c(0, 0), c(1, 0), EARTH);
    expect(folded).toBeCloseTo(oneDeg, 6);
  });
  it('adding +360k to all longitudes does not change distance', () => {
    const base = equirectangularDistanceKm(c(10, 5), c(40, 25), EARTH);
    const shifted = equirectangularDistanceKm(c(370, 5), c(400, 25), EARTH);
    expect(shifted).toBeCloseTo(base, 6);
  });
  it('a seam-crossing ring computes a continuous (small) area', () => {
    // 3° lon x 10° lat strip straddling the seam.
    const area = ringAreaKm2(
      [c(179, 0), c(-178, 0), c(-178, 10), c(179, 10)],
      EARTH,
    );
    const k = 40000 / 360;
    expect(area).toBeCloseTo(3 * k * (10 * k), 2);
  });
});

// --- AC-5: flattening reflected, degenerate at f=0 --------------------------

describe('flattening (FR-109)', () => {
  it('f=0 matches the spherical km/lat scalar', () => {
    const s = deriveScalars(createGeoParams(40000, 0));
    expect(s.kmPerLatDeg).toBeCloseTo(40000 / 360, 9);
  });
  it('increasing f shrinks a purely north-south distance', () => {
    const sphere = createGeoParams(40000, 0);
    const oblate = createGeoParams(40000, 0.05);
    const dN0 = equirectangularDistanceKm(c(0, 0), c(0, 30), sphere);
    const dN1 = equirectangularDistanceKm(c(0, 0), c(0, 30), oblate);
    expect(dN1).toBeLessThan(dN0);
    expect(dN1).toBeCloseTo(dN0 * 0.95, 6);
  });
  it('east-west distance is independent of flattening', () => {
    const dE0 = equirectangularDistanceKm(c(0, 0), c(30, 0), createGeoParams(40000, 0));
    const dE1 = equirectangularDistanceKm(c(0, 0), c(30, 0), createGeoParams(40000, 0.05));
    expect(dE1).toBeCloseTo(dE0, 9);
  });
});
