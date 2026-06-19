import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createGeoParams } from '../geo/geo-params';
import {
  equirectangularDistanceKm,
  greatCircleDistanceKm,
} from '../geo/geodesy';
import { measureSurveyPair } from './measure';

const GEO = createGeoParams(40075, 0.0034);

describe('measureSurveyPair (FR-14, delegates to U04)', () => {
  it('returns both distances equal to U04 (no re-implemented formula, AC-1)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -179, max: 179, noNaN: true }),
        fc.double({ min: -85, max: 85, noNaN: true }),
        fc.double({ min: -179, max: 179, noNaN: true }),
        fc.double({ min: -85, max: 85, noNaN: true }),
        (lonA, latA, lonB, latB) => {
          const a = { lon: lonA, lat: latA };
          const b = { lon: lonB, lat: latB };
          const m = measureSurveyPair(a, b, GEO);
          expect(m.equirectangularKm).toBe(equirectangularDistanceKm(a, b, GEO));
          expect(m.greatCircleKm).toBe(greatCircleDistanceKm(a, b, GEO));
        },
      ),
    );
  });

  it('is symmetric and non-negative (reflects U04, AC-1)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -179, max: 179, noNaN: true }),
        fc.double({ min: -85, max: 85, noNaN: true }),
        fc.double({ min: -179, max: 179, noNaN: true }),
        fc.double({ min: -85, max: 85, noNaN: true }),
        (lonA, latA, lonB, latB) => {
          const a = { lon: lonA, lat: latA };
          const b = { lon: lonB, lat: latB };
          const ab = measureSurveyPair(a, b, GEO);
          const ba = measureSurveyPair(b, a, GEO);
          expect(ab.equirectangularKm).toBeCloseTo(ba.equirectangularKm, 6);
          expect(ab.greatCircleKm).toBeCloseTo(ba.greatCircleKm, 6);
          expect(ab.equirectangularKm).toBeGreaterThanOrEqual(0);
          expect(ab.greatCircleKm).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it('identical points -> both distances 0 (退化入力, §4.6)', () => {
    const p = { lon: 100, lat: 10 };
    const m = measureSurveyPair(p, p, GEO);
    expect(m.equirectangularKm).toBe(0);
    expect(m.greatCircleKm).toBe(0);
  });

  it('±360k wrap-invariance of both distances (AC-2)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -150, max: 150, noNaN: true }),
        fc.double({ min: -70, max: 70, noNaN: true }),
        fc.double({ min: -150, max: 150, noNaN: true }),
        fc.double({ min: -70, max: 70, noNaN: true }),
        fc.integer({ min: -3, max: 3 }),
        (lonA, latA, lonB, latB, k) => {
          const a = { lon: lonA, lat: latA };
          const b = { lon: lonB, lat: latB };
          const base = measureSurveyPair(a, b, GEO);
          const shifted = measureSurveyPair(
            { lon: lonA + 360 * k, lat: latA },
            { lon: lonB + 360 * k, lat: latB },
            GEO,
          );
          expect(shifted.equirectangularKm).toBeCloseTo(base.equirectangularKm, 6);
          expect(shifted.greatCircleKm).toBeCloseTo(base.greatCircleKm, 6);
        },
      ),
    );
  });

  it('east-edge<->west-edge is the folded (~short) distance, not the 358° detour (AC-2)', () => {
    const a = { lon: 179, lat: 0 };
    const b = { lon: -179, lat: 0 };
    const naive = { lon: 179, lat: 0 };
    const farB = { lon: -179 + 360, lat: 0 }; // 181, the long-way placement
    const m = measureSurveyPair(a, b, GEO);
    const longWay = measureSurveyPair(naive, { lon: farB.lon - 360 + 360, lat: 0 }, GEO);
    void longWay;
    // 2° apart at the equator: equirectangular ≈ 2 * equatorKm/360.
    const expectKm = 2 * (40075 / 360);
    expect(m.equirectangularKm).toBeCloseTo(expectKm, 0);
    // Definitely not the ~358° detour.
    expect(m.equirectangularKm).toBeLessThan(expectKm * 10);
  });
});
