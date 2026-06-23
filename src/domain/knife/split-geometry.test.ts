import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../coordinate';
import type { GeoMultiPolygon } from '../geometry/index';
import {
  SPLIT_CHECK_STATUS,
  SPLIT_REJECT,
  SPLIT_REJECT_MESSAGE,
  checkSplittable,
  collectOpenPieces,
  executeSplit,
  smallerSide,
} from './split-geometry';
import {
  createClosedKnifeLine,
  createOpenKnifeLine,
} from './knife-line';
import { aggregate, squareLeaf, squareWithHole, squareWithHoleEnclave, unitSquare } from './fixtures';

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

describe('checkSplittable — OPEN cut must transit outside→outside (FR-90; Codex H1)', () => {
  it('rejects a cut wholly INSIDE the face (no boundary transit)', () => {
    const { feature, store } = unitSquare();
    // [2,5]→[8,5] lives entirely inside [0,10]²: it has interior points but never
    // crosses the boundary, so it cannot divide the face. The old interior-contact
    // gate accepted it and manufactured a split along the extrusion edges.
    const res = checkSplittable(feature, store, createOpenKnifeLine([c(2, 5), c(8, 5)]));
    expect(res.status).toBe(SPLIT_CHECK_STATUS.NotSplittable);
    if (res.status === SPLIT_CHECK_STATUS.NotSplittable) {
      expect(res.reason).toBe(SPLIT_REJECT.DoesNotPierce);
    }
  });

  it('rejects a cut DANGLING inside (one endpoint inside, only one transit)', () => {
    const { feature, store } = unitSquare();
    // [2,5]→[15,5]: starts inside, exits once. A "T into the face" does not bisect.
    const res = checkSplittable(feature, store, createOpenKnifeLine([c(2, 5), c(15, 5)]));
    expect(res.status).toBe(SPLIT_CHECK_STATUS.NotSplittable);
    if (res.status === SPLIT_CHECK_STATUS.NotSplittable) {
      expect(res.reason).toBe(SPLIT_REJECT.DoesNotPierce);
    }
  });

  it('still accepts a genuine outside→outside vertical cut', () => {
    const { feature, store } = unitSquare();
    const res = checkSplittable(feature, store, createOpenKnifeLine([c(5, -5), c(5, 15)]));
    expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
  });
});

describe('checkSplittable — degenerate looping OPEN cut (bug-hunt2: zero-area clip)', () => {
  it('rejects a U-shaped OPEN cut whose first and last points coincide', () => {
    const { feature, store } = unitSquare();
    // A U-shaped OPEN polyline whose ENDS are the SAME node (2,-5): it dips into the
    // [0,10]² square from below twice but loops back to its start. snapCutLine drops
    // only CONSECUTIVE duplicates for an open line, so first===last survives; both
    // endpoints are strictly outside and the path makes ≥2 boundary transits, so
    // linePiercesFace passes. The endpoint chord is then dx=dy=0, which used to make
    // openLineToClip's offset normal (0,0) → a ZERO-AREA clip ring whose boolean op
    // vanished and mis-reported as 貫通せず/不正形状. It must now be the honest
    // DegenerateLine rejection instead. (This single-chord cut takes the EXISTING 2-way
    // path; the HB3-5/19 n-way path only engages for ≥2-chord / ≥3-piece cuts.)
    const line = createOpenKnifeLine([c(2, -5), c(2, 5), c(8, 5), c(8, -5), c(2, -5)]);
    const res = checkSplittable(feature, store, line);
    expect(res.status).toBe(SPLIT_CHECK_STATUS.NotSplittable);
    if (res.status === SPLIT_CHECK_STATUS.NotSplittable) {
      expect(res.reason).toBe(SPLIT_REJECT.DegenerateLine);
      expect(res.message).toBe(SPLIT_REJECT_MESSAGE[SPLIT_REJECT.DegenerateLine]);
    }
  });

  it('still accepts a non-looping outside→outside cut over the same square', () => {
    // Guard against over-rejection: a genuine vertical pierce (distinct endpoints)
    // remains splittable after the degenerate-clip guard.
    const { feature, store } = unitSquare();
    const res = checkSplittable(feature, store, createOpenKnifeLine([c(5, -5), c(5, 15)]));
    expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
  });
});

describe('checkSplittable — HB3-5/19 n-way: a comb cut crossing the boundary 2k times → k+1 pieces', () => {
  it('a 4-crossing comb cut yields 3 pieces (was grouped into one exclave-bearing side by the 2-way)', () => {
    const { feature, store } = unitSquare();
    // Enter left @ (0,5) → exit bottom @ (5,0) → re-enter bottom @ (8,0) → exit right @ (10,5):
    // 4 boundary crossings = 2 interior chords ⇒ 3 separate pieces (the user's corrected
    // contract, HB3-5/19). The single-clip 2-way returned only 2 sides, one a 2-part exclave.
    const line = createOpenKnifeLine([
      c(-1, 5), c(5, 5), c(5, -1), c(8, -1), c(8, 5), c(11, 5),
    ]);
    const res = checkSplittable(feature, store, line);
    expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
    if (res.status === SPLIT_CHECK_STATUS.Splittable) {
      expect(res.pieces?.length).toBe(3);
      // sideA/sideB aliases remain the first two pieces (back-compat during migration).
      expect(res.sideA).toBe(res.pieces?.[0]);
      expect(res.sideB).toBe(res.pieces?.[1]);
    }
  });

  it('a plain 2-crossing cut still yields exactly 2 pieces (n-way is additive, not disruptive)', () => {
    const { feature, store } = unitSquare();
    const res = checkSplittable(feature, store, createOpenKnifeLine([c(5, -1), c(5, 11)]));
    expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
    if (res.status === SPLIT_CHECK_STATUS.Splittable) {
      expect(res.pieces?.length).toBe(2);
    }
  });
});

describe('collectOpenPieces — n-way direct invariants (HB3-5/19; ported from scratch probe)', () => {
  // Direct unit coverage of the iterative-per-chord core: a 2k-boundary-crossing open
  // line yields k+1 pieces and conserves area (sum of piece areas ≈ original). These
  // example cases were promoted from a disposable scratch probe (D36 hygiene sweep);
  // they assert the same invariants without console output or ghost-replay risk.
  const square: GeoMultiPolygon = [[[c(0, 0), c(10, 0), c(10, 10), c(0, 10)]]];
  const line = (pts: ReadonlyArray<readonly [number, number]>) => pts.map(([x, y]) => c(x, y));
  const totalArea = (pieces: readonly GeoMultiPolygon[]): number => {
    let acc = 0;
    for (const mp of pieces)
      for (const poly of mp) {
        const ring = poly[0]!;
        let a = 0;
        for (let i = 0; i < ring.length; i++) {
          const p = ring[i]!;
          const q = ring[(i + 1) % ring.length]!;
          a += p.lon * q.lat - q.lon * p.lat;
        }
        acc += Math.abs(a) / 2;
      }
    return acc;
  };
  // FR-44: every piece's outer ring must clear the ≥3-vertex floor (ported probe invariant).
  const everyPieceHasMinVertices = (pieces: readonly GeoMultiPolygon[]): void => {
    for (const mp of pieces) for (const poly of mp) expect(poly[0]!.length).toBeGreaterThanOrEqual(3);
  };

  it('a 2-crossing straight cut → 2 pieces, area preserved', () => {
    const r = collectOpenPieces(line([[5, -1], [5, 11]]), square, 100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pieces.length).toBe(2);
      expect(totalArea(r.pieces)).toBeCloseTo(100, 1);
      everyPieceHasMinVertices(r.pieces);
    }
  });

  it('a 4-crossing comb cut → 3 pieces, area preserved', () => {
    // enter left @ (0,5), exit bottom @ (5,0), re-enter bottom @ (8,0), exit right @ (10,5).
    const r = collectOpenPieces(line([[-1, 5], [5, 5], [5, -1], [8, -1], [8, 5], [11, 5]]), square, 100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pieces.length).toBe(3);
      expect(totalArea(r.pieces)).toBeCloseTo(100, 1);
      everyPieceHasMinVertices(r.pieces);
    }
  });

  it('a 6-crossing comb cut (3 teeth) → 4 pieces, area preserved', () => {
    const r = collectOpenPieces(
      line([[-1, 5], [2, 5], [2, -1], [4, -1], [4, 5], [6, 5], [6, -1], [8, -1], [8, 5], [11, 5]]),
      square,
      100,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pieces.length).toBe(4);
      expect(totalArea(r.pieces)).toBeCloseTo(100, 1);
      everyPieceHasMinVertices(r.pieces);
    }
  });

  it('a 2-crossing HORIZONTAL straight cut → 2 pieces (orthogonal direction)', () => {
    const r = collectOpenPieces(line([[-1, 5], [11, 5]]), square, 100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pieces.length).toBe(2);
      expect(totalArea(r.pieces)).toBeCloseTo(100, 1);
      everyPieceHasMinVertices(r.pieces);
    }
  });

  it('a dangling cut that starts inside and crosses the boundary only once → rejected', () => {
    const r = collectOpenPieces(line([[5, 5], [5, 11]]), square, 100);
    expect(r.ok).toBe(false);
  });
});

describe('checkSplittable — antimeridian seam alignment (R3; Codex seam-mismatch)', () => {
  it('splits a seam-crossing target (stored 170°..−170°) with a cut drawn at +180°', () => {
    // A thin box crossing the world seam, stored in representative form: its outer
    // ring jumps 170° → −170°. The cut is drawn on the +180° replica. Before the
    // fix the target kept its stored branch while only the line was unwrapped, so
    // the two were ~360° apart and the boolean ops saw no overlap → false 貫通せず.
    const { feature, store } = squareLeaf('seam', [
      c(170, 0),
      c(-170, 0),
      c(-170, 10),
      c(170, 10),
    ]);
    const res = checkSplittable(feature, store, createOpenKnifeLine([c(180, -5), c(180, 15)]));
    expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
    if (res.status === SPLIT_CHECK_STATUS.Splittable) {
      expect(res.sideA.areaKm2).toBeGreaterThan(0);
      expect(res.sideB.areaKm2).toBeGreaterThan(0);
    }
  });
});

describe('executeSplit — mid-edge ENDPOINT contact is a 共有辺途中切断点 (FR-95; Codex M1)', () => {
  it('records a cut where a cut-line VERTEX lands partway along an existing edge', () => {
    const { feature, store } = unitSquare();
    // A "V" whose middle vertex (5,0) lands exactly mid-way on the bottom edge
    // (0,0)-(10,0). That contact is an Endpoint (not Proper) and was dropped; it is
    // a real mid-edge cut node a 共有相手 edge would need.
    const result = executeSplit(feature, store, createOpenKnifeLine([c(3, 15), c(5, 0), c(7, 15)]));
    expect(result).toBeDefined();
    if (!result) return;
    const bottomCut = result.edgeCuts.find(
      (e) => e.coordinate.lon === 5 && e.coordinate.lat === 0,
    );
    expect(bottomCut).toBeDefined();
  });

  it('does NOT record a cut where the line passes through an existing corner', () => {
    const { feature, store } = unitSquare();
    // Diagonal through corner (0,0): the corner contact is an Endpoint AT an existing
    // vertex — no new node needed, so (0,0) must not appear as an edge cut.
    const result = executeSplit(feature, store, createOpenKnifeLine([c(-5, -5), c(8, 15)]));
    expect(result).toBeDefined();
    if (!result) return;
    const cornerCut = result.edgeCuts.find(
      (e) => e.coordinate.lon === 0 && e.coordinate.lat === 0,
    );
    expect(cornerCut).toBeUndefined();
  });

  it('does NOT record a cut for a PROPER crossing that quantizes onto an existing corner', () => {
    const { feature, store } = unitSquare();
    // A slanted segment (-1,-2)→(1,2.0000001) crosses the bottom edge (0,0)-(10,0)
    // PROPERLY (interiors cross, not at a line vertex) at x ≈ -2.5e-8, which the U06
    // grid (1e7 cells/deg) quantizes onto the existing corner (0,0). The old Proper
    // branch recorded that as a mid-edge cut, yielding an EdgeCutPoint AT an existing
    // vertex — a zero-length edge / duplicate-coordinate node on the 共有相手 edge
    // (bug-hunt: knife/split-geometry computeEdgeCuts). It must be skipped just like
    // the Endpoint-at-vertex case. The clean exit through the top edge stays a real cut.
    const line = createOpenKnifeLine([c(-1, -2), c(1, 2.0000001), c(6, 15)]);
    const result = executeSplit(feature, store, line);
    expect(result).toBeDefined();
    if (!result) return;
    const cornerCut = result.edgeCuts.find(
      (e) => e.coordinate.lon === 0 && e.coordinate.lat === 0,
    );
    expect(cornerCut).toBeUndefined();
    // No recorded cut sits on an existing edge endpoint (degenerate node).
    for (const cut of result.edgeCuts) {
      const startV = store.byId.get(cut.edgeStartVertexId);
      const endV = store.byId.get(cut.edgeEndVertexId);
      expect(startV).toBeDefined();
      expect(endV).toBeDefined();
      const onStart =
        startV !== undefined &&
        cut.coordinate.lon === startV.coordinate.lon &&
        cut.coordinate.lat === startV.coordinate.lat;
      const onEnd =
        endV !== undefined &&
        cut.coordinate.lon === endV.coordinate.lon &&
        cut.coordinate.lat === endV.coordinate.lat;
      expect(onStart).toBe(false);
      expect(onEnd).toBe(false);
    }
    // The genuine top-edge crossing is still recorded.
    expect(result.edgeCuts.some((e) => e.coordinate.lat === 10)).toBe(true);
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
