// Codex perf MED 根治の等価性ロック — ringSelfIntersects / ringsBoundaryCoincidentSameSide
// の列挙をソートスイープへ置き換えたが、ペアごとの厳密判定は不変のはず。ここで
// 「旧ナイーブ全対列挙のリファレンス実装」と結果一致することをプロパティで固定する
// (列挙順だけが変わり結果集合は不変、の証明)。加えて 10 万頂点級の単純リングが
// 実用時間で完走する性能スモークを置く (「10万頂点で固まる」の再発ロック)。

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ringSelfIntersects, segmentsIntersect, SEGMENT_RELATION } from './predicates';
import { checkMultiPolygonInvariants, ringsBoundaryCoincidentSameSide } from './invariants';
import type { GeoRing } from './types';

// --- reference (the pre-sweep naive scans, kept verbatim for comparison) -----

function naiveRingSelfIntersects(ring: GeoRing): boolean {
  const n = ring.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i += 1) {
    const a1 = ring[i];
    const a2 = ring[(i + 1) % n];
    if (a1 === undefined || a2 === undefined) continue;
    for (let j = i + 1; j < n; j += 1) {
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      const b1 = ring[j];
      const b2 = ring[(j + 1) % n];
      if (b1 === undefined || b2 === undefined) continue;
      const rel = segmentsIntersect(a1, a2, b1, b2).relation;
      if (adjacent) {
        if (rel === SEGMENT_RELATION.Collinear) return true;
        continue;
      }
      if (rel === SEGMENT_RELATION.Proper || rel === SEGMENT_RELATION.Collinear) return true;
      if (rel === SEGMENT_RELATION.Endpoint) return true;
    }
  }
  return false;
}

// Small integer coordinates provoke the interesting cases (collinear runs,
// endpoint touches, duplicate vertices) far more often than floats.
const smallCoordArb = fc.record({
  lon: fc.integer({ min: -6, max: 6 }),
  lat: fc.integer({ min: -6, max: 6 }),
});

const ringArb: fc.Arbitrary<GeoRing> = fc.array(smallCoordArb, {
  minLength: 3,
  maxLength: 12,
}) as fc.Arbitrary<GeoRing>;

describe('sort-and-sweep enumeration is result-equivalent to the naive all-pairs scan', () => {
  it('ringSelfIntersects(sweep) === naive reference for random small rings', () => {
    fc.assert(
      fc.property(ringArb, (ring) => {
        expect(ringSelfIntersects(ring)).toBe(naiveRingSelfIntersects(ring));
      }),
      { numRuns: 500 },
    );
  });

  it('ringsBoundaryCoincidentSameSide(sweep) === naive reference for random ring pairs', () => {
    const naive = (a: GeoRing, b: GeoRing): boolean => {
      // Reference: the pre-sweep all-pairs Collinear scan (winding logic identical).
      const areaX2 = (r: GeoRing): number => {
        let acc = 0;
        for (let i = 0; i < r.length; i += 1) {
          const p = r[i]!;
          const q = r[(i + 1) % r.length]!;
          acc += p.lon * q.lat - q.lon * p.lat;
        }
        return acc;
      };
      const wa = areaX2(a);
      const wb = areaX2(b);
      if (wa === 0 || wb === 0) return false;
      const sideA = wa > 0 ? 1 : -1;
      const sideB = wb > 0 ? 1 : -1;
      for (let i = 0; i < a.length; i += 1) {
        const a1 = a[i]!;
        const a2 = a[(i + 1) % a.length]!;
        for (let j = 0; j < b.length; j += 1) {
          const b1 = b[j]!;
          const b2 = b[(j + 1) % b.length]!;
          if (segmentsIntersect(a1, a2, b1, b2).relation !== SEGMENT_RELATION.Collinear) continue;
          const sameDir =
            (a2.lon - a1.lon) * (b2.lon - b1.lon) + (a2.lat - a1.lat) * (b2.lat - b1.lat) >= 0
              ? 1
              : -1;
          if (sideA === sideB * sameDir) return true;
        }
      }
      return false;
    };
    fc.assert(
      fc.property(ringArb, ringArb, (a, b) => {
        expect(ringsBoundaryCoincidentSameSide(a, b)).toBe(naive(a, b));
      }),
      { numRuns: 300 },
    );
  });
});

describe('性能スモーク — 10万頂点で固まらない (Codex MED 再発ロック)', () => {
  it('a 100k-vertex simple ring passes the full invariant check in seconds, not minutes', () => {
    const n = 100_000;
    const ring: { lon: number; lat: number }[] = [];
    // A large convex-ish circle: no self-intersection, no zero-length edges
    // (adjacent points are ~5e-3° apart — far above the quantization grid).
    for (let i = 0; i < n; i += 1) {
      const t = (2 * Math.PI * i) / n;
      ring.push({ lon: 170 * Math.cos(t) * 0.5, lat: 80 * Math.sin(t) });
    }
    const started = Date.now();
    const violations = checkMultiPolygonInvariants([[ring as unknown as GeoRing]]);
    const elapsedMs = Date.now() - started;
    expect(violations).toEqual([]);
    // The old all-pairs scan was ~5×10^9 pair visits here (minutes). The sweep
    // finishes in well under this bound on any dev machine; the generous limit
    // keeps CI-noise flake out while still catching an O(n²) regression cold.
    expect(elapsedMs).toBeLessThan(30_000);
  });
});
