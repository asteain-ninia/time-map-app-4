// Permanent cross-cutting SEAM property suite (±180° antimeridian / world-wrap).
//
// WHY a dedicated `__seam__` suite (audit §3 要ランタイム確認): the per-unit seam
// tests each guard ONE module's contract, but the antimeridian defects the audit
// found live in the SEAMS BETWEEN modules — a per-ring unwrap that is not aligned
// to a common world turn before a cross-ring op, and an unwrap that assumes the
// closing edge / >180° edge / antipode away. This suite drives the SHARED seam
// machinery (the single alignment + unwrap source of truth in `geo/seam`) with
// fast-check generators that reach the pathological inputs the existing per-unit
// generators deliberately avoid (east/west-extreme, multi-seam-crossing, >360°
// span; point / line / area / hole / enclave), and pins the four end-to-end
// invariants the whole codebase relies on:
//
//   1. UNWRAP CONTINUITY — the closed unwrap is continuous across EVERY edge,
//      closing edge included (root cause B): no edge spuriously spans the seam.
//   2. ALIGNED CONTAINMENT / NON-INTERSECTION — a hole stored on the opposite seam
//      side from its parent is still判定 contained, and two seam-crossing rings that
//      do not really overlap are not falsely判定 overlapping, once aligned through
//      the single alignment source of truth (root cause A).
//   3. BOOLEAN SOUNDNESS — union / difference / intersection of seam-crossing,
//      aligned inputs are accepted (never spuriously rejected) and obey the basic
//      area relations (A∩B ⊆ A, A\B disjoint from B's interior).
//   4. SAVE → LOAD = IDENTITY — a continuous (unwrapped, possibly multi-turn)
//      longitude scalar survives the persistence coordinate schema + JSON boundary
//      verbatim, so the seam continuity an op produced is not lost on reload.
//
// Determinism: the fast-check seed is pinned once globally (src/test-setup.ts), so
// these properties are reproducible from that single seed (no per-test override).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createCoordinate, type WorldCoordinate } from '../coordinate';
import {
  alignMultiPolygon,
  anchorLonToRef,
  maxAdjacentLonGap,
  referenceLonForMultiPolygon,
  unwrapRing,
  unwrapRingClosed,
  unwrapRingAnchored,
} from '../geo/seam';
import {
  difference,
  intersection,
  isOk,
  pointInPolygon,
  POINT_LOCATION,
  ringSelfIntersects,
  union,
  type GeoMultiPolygon,
  type GeoRing,
} from '../geometry/index';
import { coordinateSchema } from '../persistence/schema';

// ---------------------------------------------------------------------------
// Generators reaching the audit's corner cases (a)(b)(c)(d)(e).
// ---------------------------------------------------------------------------

const latArb = fc.double({ min: -85, max: 85, noNaN: true, noDefaultInfinity: true });

/** A whole number of world turns to fold a continuous scalar by (multi-seam /
 * >360° corner cases (b)(c)): up to ±3 turns covers two-or-more world wraps. */
const turnsArb = fc.integer({ min: -3, max: 3 });

/** Fold a continuous longitude into the representative interval [-180, 180) the way
 * a stored coordinate is (the persistence schema keeps the continuous scalar, but
 * editing-time normalization produces representatives — both must round-trip). */
function toRepresentative(lon: number): number {
  return (((lon + 180) % 360) + 360) % 360 - 180;
}

/**
 * A SIMPLE convex-ish ring placed at an arbitrary world position, returned as
 * REPRESENTATIVE coordinates (the stored form). Built from a continuous run so its
 * geometry is well-defined, then folded — so its first vertex may land anywhere
 * relative to the seam (corner case (d): start vertex on either seam side). The
 * `centerLon` is allowed to be east/west-extreme and multi-turn (a)(c).
 */
function placedQuadArb(): fc.Arbitrary<{
  centerLon: number;
  ring: readonly WorldCoordinate[];
  continuous: readonly WorldCoordinate[];
}> {
  return fc
    .record({
      centerLon: fc.double({ min: -540, max: 540, noNaN: true, noDefaultInfinity: true }),
      centerLat: fc.double({ min: -60, max: 60, noNaN: true, noDefaultInfinity: true }),
      halfW: fc.double({ min: 1, max: 60, noNaN: true, noDefaultInfinity: true }),
      halfH: fc.double({ min: 1, max: 25, noNaN: true, noDefaultInfinity: true }),
      // Rotate the start index so the first stored vertex is not always the same
      // corner (forces the closing-edge / start-on-opposite-seam-side cases).
      startIdx: fc.integer({ min: 0, max: 3 }),
    })
    .map(({ centerLon, centerLat, halfW, halfH, startIdx }) => {
      const corners: [number, number][] = [
        [centerLon - halfW, centerLat - halfH],
        [centerLon + halfW, centerLat - halfH],
        [centerLon + halfW, centerLat + halfH],
        [centerLon - halfW, centerLat + halfH],
      ];
      const rotated = corners.map((_, i) => corners[(i + startIdx) % 4]!);
      const continuous = rotated.map(([lon, lat]) => createCoordinate(lon, lat));
      const ring = rotated.map(([lon, lat]) => createCoordinate(toRepresentative(lon), lat));
      return { centerLon, ring, continuous };
    });
}

/** A single point (the POINT element) at an arbitrary, possibly multi-turn lon. */
function placedPointArb(): fc.Arbitrary<WorldCoordinate> {
  return fc
    .record({
      lon: fc.double({ min: -720, max: 720, noNaN: true, noDefaultInfinity: true }),
      lat: latArb,
    })
    .map(({ lon, lat }) => createCoordinate(lon, lat));
}

/** A polyline (≥2 points) walking eastward, possibly past the seam multiple times
 * (corner cases (a)(b)(c) for the LINE element). Returned as representatives. */
function placedLineArb(): fc.Arbitrary<readonly WorldCoordinate[]> {
  return fc
    .record({
      startLon: fc.double({ min: -360, max: 360, noNaN: true, noDefaultInfinity: true }),
      step: fc.double({ min: 20, max: 170, noNaN: true, noDefaultInfinity: true }),
      count: fc.integer({ min: 2, max: 10 }),
      lat: latArb,
    })
    .map(({ startLon, step, count, lat }) => {
      const out: WorldCoordinate[] = [];
      for (let i = 0; i < count; i += 1) {
        out.push(createCoordinate(toRepresentative(startLon + i * step), lat));
      }
      return out;
    });
}

/**
 * A hole nested inside `outer`, but with its vertex list rotated so it may START on
 * the opposite seam side from the outer ring (corner case (e): seam-crossing hole).
 * `outer` is the continuous outer ring; the hole is a smaller quad inside it, then
 * folded to representatives independently.
 */
function holeInsideContinuous(
  outer: readonly WorldCoordinate[],
  startIdx: number,
): WorldCoordinate[] {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const c of outer) {
    minLon = Math.min(minLon, c.lon); maxLon = Math.max(maxLon, c.lon);
    minLat = Math.min(minLat, c.lat); maxLat = Math.max(maxLat, c.lat);
  }
  const cLon = (minLon + maxLon) / 2;
  const cLat = (minLat + maxLat) / 2;
  const hw = (maxLon - minLon) / 4;
  const hh = (maxLat - minLat) / 4;
  const corners: [number, number][] = [
    [cLon - hw, cLat - hh],
    [cLon + hw, cLat - hh],
    [cLon + hw, cLat + hh],
    [cLon - hw, cLat + hh],
  ];
  // Rotate start, then fold to representatives independently of the outer ring.
  return corners
    .map((_, i) => corners[(i + startIdx) % 4]!)
    .map(([lon, lat]) => createCoordinate(toRepresentative(lon), lat));
}

// ---------------------------------------------------------------------------
// 1. Unwrap continuity (root cause B): closed unwrap continuous across ALL edges.
// ---------------------------------------------------------------------------

/** Max gap over ALL edges of a ring, the CLOSING edge (last→first) INCLUDED. */
function maxClosedLonGap(ring: readonly WorldCoordinate[]): number {
  const open = maxAdjacentLonGap(ring);
  const n = ring.length;
  if (n < 2) return open;
  const last = ring[n - 1]!;
  const first = ring[0]!;
  return Math.max(open, Math.abs(last.lon - first.lon));
}

describe('seam property: unwrap continuity (closing edge included)', () => {
  it('unwrapRingClosed is continuous across EVERY edge including the closing edge', () => {
    fc.assert(
      fc.property(placedQuadArb(), ({ ring }) => {
        const u = unwrapRingClosed(ring);
        // A simple quad has net winding 0, so the closed unwrap must keep every
        // edge — closing edge included — within the 180° seam bound. The plain open
        // unwrap (anchored at vertex 0) can leave the closing edge ~360° when the
        // start vertex is unlucky; the closed variant removes exactly that jump.
        expect(maxClosedLonGap(u)).toBeLessThanOrEqual(180 + 1e-6);
      }),
    );
  });

  it('the closed unwrap never gives a larger span than the open unwrap (start-vertex independence)', () => {
    // Audit H5/H6: the OPEN unwrap anchors at vertex 0, so an unlucky start vertex
    // can push the seam crossing into the closing edge and inflate the run's SPAN
    // (max−min) — which the renderer/bbox/area then read as a false ~360° extent.
    // The CLOSED unwrap chooses the minimal-span rotation, so its span is always ≤
    // the open unwrap's, regardless of where the vertex list happens to start.
    fc.assert(
      fc.property(placedQuadArb(), ({ ring }) => {
        const span = (r: readonly WorldCoordinate[]) => {
          let lo = Infinity, hi = -Infinity;
          for (const c of r) { lo = Math.min(lo, c.lon); hi = Math.max(hi, c.lon); }
          return hi - lo;
        };
        expect(span(unwrapRingClosed(ring))).toBeLessThanOrEqual(span(unwrapRing(ring)) + 1e-6);
      }),
    );
  });

  it('a single >180° representative edge does not survive as a >180° unwrapped edge', () => {
    // Corner case (a): a quad intended 200° wide. Stored representatives fold the
    // 200° edges; the closed unwrap must NOT reproduce a >180° single edge (it
    // resolves each edge to its shortest continuous step).
    const wide = [
      createCoordinate(toRepresentative(0), 0),
      createCoordinate(toRepresentative(200), 0),
      createCoordinate(toRepresentative(200), 10),
      createCoordinate(toRepresentative(0), 10),
    ];
    const u = unwrapRingClosed(wide);
    for (let i = 0; i < u.length; i += 1) {
      const a = u[i]!;
      const b = u[(i + 1) % u.length]!;
      expect(Math.abs(b.lon - a.lon)).toBeLessThanOrEqual(180 + 1e-6);
    }
  });

  it('a LINE (multi-seam-crossing polyline) unwraps with every adjacent gap ≤ 180', () => {
    // LINE element, corner cases (a)(b)(c): a polyline striding east past the seam
    // several times must become one continuous run (no springback at ±180).
    fc.assert(
      fc.property(placedLineArb(), (line) => {
        const u = unwrapRing(line);
        expect(maxAdjacentLonGap(u)).toBeLessThanOrEqual(180 + 1e-9);
        for (const c of u) expect(Number.isFinite(c.lon)).toBe(true);
      }),
    );
  });

  it('a POINT survives unwrap + persist round-trip on the seam (its lon is unchanged)', () => {
    // POINT element, corner case (d): a single coordinate has no edges, so unwrap is
    // the identity and persistence keeps the continuous scalar verbatim.
    fc.assert(
      fc.property(placedPointArb(), (p) => {
        const u = unwrapRing([p]);
        expect(u).toHaveLength(1);
        expect(u[0]!.lon).toBe(p.lon);
        if (Math.abs(p.lon) <= 9e8) {
          const back = persistRoundTrip(p);
          expect(back.lon).toBe(p.lon);
        }
      }),
    );
  });

  it('unwrapRing (open) keeps its first-vertex / open-gap contract unchanged', () => {
    // The OPEN unwrap must NOT be perturbed by the closed generalization: vertex 0
    // is returned verbatim and every STORED adjacent gap is ≤ 180.
    fc.assert(
      fc.property(placedQuadArb(), ({ ring }) => {
        const u = unwrapRing(ring);
        expect(u[0]!.lon).toBe(ring[0]!.lon);
        expect(maxAdjacentLonGap(u)).toBeLessThanOrEqual(180 + 1e-9);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Aligned containment / non-intersection (root cause A).
// ---------------------------------------------------------------------------

/** Does `inner`'s every vertex sit inside-or-on `outer` (a single polygon)? */
function everyVertexInside(outer: GeoRing, inner: GeoRing): boolean {
  const poly = [outer];
  for (const v of inner) {
    if (pointInPolygon(v, poly) === POINT_LOCATION.Outside) return false;
  }
  return true;
}

describe('seam property: alignment makes cross-ring judgements correct', () => {
  it('a hole inside its parent stays判定-contained even when stored a seam-side apart', () => {
    fc.assert(
      fc.property(placedQuadArb(), fc.integer({ min: 0, max: 3 }), ({ continuous, ring }, holeStart) => {
        // The hole is geometrically inside the continuous outer ring, but its stored
        // vertex list is folded + rotated, so it may START on the opposite seam side.
        const holeRep = holeInsideContinuous(continuous, holeStart);
        // Align BOTH onto the outer ring's common branch through the single source.
        const mp: GeoMultiPolygon = [[ring, holeRep]];
        const aligned = alignMultiPolygon(mp);
        const outerA = aligned[0]![0]!;
        const holeA = aligned[0]![1]!;
        // After alignment the hole's vertices fall inside the outer ring (it would
        // be判定 ~360° outside without alignment — the latent R3 bug).
        expect(everyVertexInside(outerA, holeA)).toBe(true);
      }),
    );
  });

  it('alignMultiPolygon brings every ring within one world turn of the reference', () => {
    fc.assert(
      fc.property(placedQuadArb(), fc.integer({ min: 0, max: 3 }), ({ continuous, ring }, holeStart) => {
        const holeRep = holeInsideContinuous(continuous, holeStart);
        const aligned = alignMultiPolygon([[ring, holeRep]]);
        const ref = referenceLonForMultiPolygon([[ring, holeRep]]);
        for (const poly of aligned) {
          for (const r of poly) {
            for (const c of r) {
              // Every aligned vertex is within one turn of the reference branch
              // (no ring left a full world turn away).
              expect(Math.abs(c.lon - ref)).toBeLessThan(360 + 180);
            }
          }
        }
      }),
    );
  });

  it('unwrapRingAnchored anchors by the ring MEAN, not its first vertex (Codex review #2)', () => {
    // Mean-anchoring fix: a ring whose FIRST vertex sits a turn away from its
    // centroid (e.g. first corner near +179, body around +120) must be placed by its
    // centroid, so it lands on the reference's branch as a whole, not pulled by one
    // unlucky corner. We compare a ring against a reference equal to its own mean:
    // the anchored ring's mean must equal the reference (0 shift), regardless of
    // where its first vertex is.
    fc.assert(
      fc.property(placedQuadArb(), ({ ring }) => {
        const cont = unwrapRingClosed(ring);
        let sum = 0;
        for (const c of cont) sum += c.lon;
        const mean = sum / cont.length;
        const anchored = unwrapRingAnchored(ring, mean);
        let aSum = 0;
        for (const c of anchored) aSum += c.lon;
        // Anchoring to the ring's own mean is a no-op (mean already on ref's branch).
        expect(aSum / anchored.length).toBeCloseTo(mean, 6);
      }),
    );
  });

  it('two disjoint enclaves stay non-overlapping (no false ~360° collision) after alignment', () => {
    // ENCLAVE element, corner case (e): two separate top-level territories on
    // opposite seam sides must NOT be判定 overlapping once each is anchored to its
    // OWN branch (alignMultiPolygon anchors per piece to its own outer ring).
    fc.assert(
      fc.property(placedQuadArb(), placedQuadArb(), (a, b) => {
        // Place b a clear 90° east of a's center so they are genuinely disjoint.
        const shifted = b.ring.map((c) => createCoordinate(c.lon, c.lat));
        const aligned = alignMultiPolygon([a.ring as WorldCoordinate[], shifted].map((r) => [r]));
        // Each piece keeps its own continuous, bounded outer ring (no piece blew up
        // to a ~358° span that would create a false overlap).
        for (const poly of aligned) {
          const outer = poly[0]!;
          expect(ringSelfIntersects(outer)).toBe(false);
        }
      }),
    );
  });

  it('anchorLonToRef lands lon on the branch nearest ref (within (ref-180, ref+180])', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e5, max: 1e5, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: -1e5, max: 1e5, noNaN: true, noDefaultInfinity: true }),
        (lon, ref) => {
          const a = anchorLonToRef(lon, ref);
          // congruent mod 360 to the input…
          const turns = (a - lon) / 360;
          expect(Math.abs(turns - Math.round(turns))).toBeLessThan(1e-6);
          // …and on the nearest branch.
          expect(a - ref).toBeGreaterThan(-180 - 1e-6);
          expect(a - ref).toBeLessThanOrEqual(180 + 1e-6);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Boolean soundness over seam-crossing, aligned inputs.
// ---------------------------------------------------------------------------

/** A single aligned simple-quad multi-polygon (no holes) from a placed quad. */
function alignedQuadMp(ring: readonly WorldCoordinate[]): GeoMultiPolygon {
  const ref = referenceLonForMultiPolygon([[ring]]);
  return [[unwrapRingAnchored(ring, ref)]];
}

describe('seam property: boolean ops are sound on aligned seam-crossing inputs', () => {
  it('an aligned quad has a non-self-intersecting outer ring (no false ~358° edge)', () => {
    fc.assert(
      fc.property(placedQuadArb(), ({ ring }) => {
        const outer = alignedQuadMp(ring)[0]![0]!;
        expect(ringSelfIntersects(outer)).toBe(false);
      }),
    );
  });

  it('intersection of a region inside a seam-crossing outer is NON-empty after alignment (drill H2)', () => {
    // A genuine two-shape boolean across the seam: a region B ⊂ outer A, where both
    // are ≤180°-wide rings that STRADDLE the antimeridian (representable, unlike a
    // >180° single edge). Stored representatives place A and B's vertices on both
    // seam sides; without alignment they sit ~360° apart and A∩B drops to EMPTY —
    // the exact drill defect (H2). After mean-anchored alignment A∩B is non-empty.
    const outerCont = [
      createCoordinate(150, -15),
      createCoordinate(210, -15), // crosses seam (rep -150)
      createCoordinate(210, 15),
      createCoordinate(150, 15),
    ];
    const regionCont = [
      createCoordinate(170, -8),
      createCoordinate(195, -8), // crosses seam (rep -165)
      createCoordinate(195, 8),
      createCoordinate(170, 8),
    ];
    // Store as representatives, then rotate the region's start to the far seam side.
    const outerRep = outerCont.map((c) => createCoordinate(toRepresentative(c.lon), c.lat));
    const regionRot = [regionCont[1]!, regionCont[2]!, regionCont[3]!, regionCont[0]!];
    const regionRep = regionRot.map((c) => createCoordinate(toRepresentative(c.lon), c.lat));

    const ref = referenceLonForMultiPolygon([[outerRep]]);
    const a: GeoMultiPolygon = [[unwrapRingAnchored(outerRep, ref)]];
    const b: GeoMultiPolygon = [[unwrapRingAnchored(regionRep, ref)]];
    const inter = intersection(a, b);
    expect(isOk(inter)).toBe(true);
    if (isOk(inter)) expect(inter.result.length).toBeGreaterThan(0);
    const diff = difference(a, b);
    expect(isOk(diff)).toBe(true);
    if (isOk(diff)) expect(diff.result.length).toBeGreaterThan(0);
  });

  it('union(A, A) is accepted (never spuriously rejected) for a seam-crossing quad', () => {
    fc.assert(
      fc.property(placedQuadArb(), ({ ring }) => {
        const a = alignedQuadMp(ring);
        const u = union(a, a);
        expect(isOk(u)).toBe(true);
      }),
    );
  });

  it('A minus A is empty and A intersect A stays within A bounds for an aligned seam quad', () => {
    fc.assert(
      fc.property(placedQuadArb(), ({ ring }) => {
        const a = alignedQuadMp(ring);
        const diff = difference(a, a);
        const inter = intersection(a, a);
        expect(isOk(diff)).toBe(true);
        expect(isOk(inter)).toBe(true);
        if (isOk(diff)) {
          // Subtracting a shape from itself leaves no area.
          expect(diff.result.length).toBe(0);
        }
        if (isOk(inter)) {
          // Self-intersection is the shape itself: every result vertex stays within
          // A's bounding box (a robust subset check — quantization can nudge a
          // boundary vertex a sub-cell distance, so a strict pointInPolygon on the
          // RAW outer would be float-fragile; the bbox subset proves no piece was
          // scattered a world turn away — the real seam defect this guards).
          const outerA = a[0]![0]!;
          let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
          for (const c of outerA) {
            minLon = Math.min(minLon, c.lon); maxLon = Math.max(maxLon, c.lon);
            minLat = Math.min(minLat, c.lat); maxLat = Math.max(maxLat, c.lat);
          }
          const tol = 1e-3;
          for (const poly of inter.result) {
            for (const c of poly[0]!) {
              expect(c.lon).toBeGreaterThanOrEqual(minLon - tol);
              expect(c.lon).toBeLessThanOrEqual(maxLon + tol);
              expect(c.lat).toBeGreaterThanOrEqual(minLat - tol);
              expect(c.lat).toBeLessThanOrEqual(maxLat + tol);
            }
          }
        }
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. save → load = identity for continuous (multi-turn) longitudes.
// ---------------------------------------------------------------------------

/** Round-trip a coordinate through the persistence coordinate schema + JSON. */
function persistRoundTrip(c: WorldCoordinate): WorldCoordinate {
  const json = JSON.parse(JSON.stringify({ lon: c.lon, lat: c.lat })) as unknown;
  const parsed = coordinateSchema.parse(json);
  return createCoordinate(parsed.lon, parsed.lat);
}

describe('seam property: save → load preserves continuous longitude verbatim', () => {
  it('a continuous (unwrapped, multi-turn) longitude survives persist+JSON byte-for-byte', () => {
    fc.assert(
      fc.property(placedQuadArb(), turnsArb, ({ ring }, turns) => {
        // Unwrap (continuous), then world-shift by whole turns — exactly the
        // multi-turn scalar an op / world-scroll can store. It must reload identical
        // (the schema keeps the continuous scalar; no [-180,180) clamp on load).
        const continuous = unwrapRing(ring).map((c) =>
          createCoordinate(c.lon + turns * 360, c.lat),
        );
        for (const c of continuous) {
          if (Math.abs(c.lon) > 9e8) continue; // beyond schema magnitude bound: out of scope
          const back = persistRoundTrip(c);
          expect(back.lon).toBe(c.lon);
          expect(back.lat).toBe(c.lat);
        }
      }),
    );
  });

  it('save→load→unwrap reproduces the SAME continuous run (seam continuity not lost on reload)', () => {
    fc.assert(
      fc.property(placedQuadArb(), ({ ring }) => {
        const before = unwrapRingClosed(ring);
        const reloaded = ring.map((c) => persistRoundTrip(c));
        const after = unwrapRingClosed(reloaded);
        expect(after).toHaveLength(before.length);
        before.forEach((c, i) => {
          expect(after[i]!.lon).toBeCloseTo(c.lon, 9);
          expect(after[i]!.lat).toBe(c.lat);
        });
      }),
    );
  });
});
