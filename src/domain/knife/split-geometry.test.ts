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

describe('checkSplittable — tilted / bent OPEN cut has NO phantom vertices (第8波 flagship)', () => {
  // The clip-construction invariant (openLineToClip): the ONLY boundary a resulting
  // piece may show inside the target is the USER'S drawn line. So every vertex of every
  // piece must lie either on an ORIGINAL square edge OR on a DRAWN cut segment; any other
  // vertex is a phantom the extrusion manufactured (the old single-normal offset chamfered
  // corners into false diagonals / triangle pieces on axis-non-parallel + bent cuts).
  const SQUARE_EDGES: ReadonlyArray<readonly [ReturnType<typeof c>, ReturnType<typeof c>]> = [
    [c(0, 0), c(10, 0)],
    [c(10, 0), c(10, 10)],
    [c(10, 10), c(0, 10)],
    [c(0, 10), c(0, 0)],
  ];
  const onSegment = (
    p: ReturnType<typeof c>,
    a: ReturnType<typeof c>,
    b: ReturnType<typeof c>,
  ): boolean => {
    // Collinear (cross ~0) AND within the segment's bounding box (small tolerance for
    // the U06 grid quantum). Endpoints count as on-segment.
    const cross = (b.lon - a.lon) * (p.lat - a.lat) - (b.lat - a.lat) * (p.lon - a.lon);
    if (Math.abs(cross) > 1e-6) return false;
    const within = (v: number, lo: number, hi: number) =>
      v >= Math.min(lo, hi) - 1e-6 && v <= Math.max(lo, hi) + 1e-6;
    return within(p.lon, a.lon, b.lon) && within(p.lat, a.lat, b.lat);
  };
  const drawnSegments = (
    pts: ReadonlyArray<readonly [number, number]>,
  ): ReadonlyArray<readonly [ReturnType<typeof c>, ReturnType<typeof c>]> => {
    const segs: [ReturnType<typeof c>, ReturnType<typeof c>][] = [];
    for (let i = 0; i + 1 < pts.length; i += 1) {
      segs.push([c(pts[i]![0], pts[i]![1]), c(pts[i + 1]![0], pts[i + 1]![1])]);
    }
    return segs;
  };
  const assertNoPhantomVertices = (
    res: ReturnType<typeof checkSplittable>,
    cutPts: ReadonlyArray<readonly [number, number]>,
  ): void => {
    expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
    if (res.status !== SPLIT_CHECK_STATUS.Splittable) return;
    const allowed = [...SQUARE_EDGES, ...drawnSegments(cutPts)];
    for (const piece of res.pieces ?? []) {
      for (const poly of piece.area) {
        for (const ring of poly) {
          for (const v of ring) {
            const ok = allowed.some(([a, b]) => onSegment(v, a, b));
            expect(
              ok,
              `phantom vertex (${v.lon},${v.lat}) not on any square edge or drawn cut segment`,
            ).toBe(true);
          }
        }
      }
    }
  };

  it('an axis-NON-parallel straight cut splits into two pieces (no invalid-shape rejection)', () => {
    const { feature, store } = unitSquare();
    // Diagonal [2,-1]→[8,11] enters the bottom edge and exits the top edge; a legitimate
    // straight bisection. The old single-normal offset copy landed on the wrong side and
    // the boolean op degenerated → wrongly rejected as invalid-shape.
    const res = checkSplittable(feature, store, createOpenKnifeLine([c(2, -1), c(8, 11)]));
    expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
    if (res.status === SPLIT_CHECK_STATUS.Splittable) {
      expect(res.pieces?.length).toBe(2);
      expect(res.sideA.areaKm2).toBeGreaterThan(0);
      expect(res.sideB.areaKm2).toBeGreaterThan(0);
    }
    assertNoPhantomVertices(res, [[2, -1], [8, 11]]);
  });

  it('an L-shaped cut splits into 2 pieces with NO phantom diagonal vertices', () => {
    const { feature, store } = unitSquare();
    // Enter bottom @ x=5, bend at (5,5), exit right edge @ y=5. Every piece vertex must
    // sit on a square edge or on the drawn L; the old offset connectors chamfered the
    // (0,0)/(10,10) corners into false diagonals and spun off phantom triangle pieces.
    const cutPts = [[5, -2], [5, 5], [12, 5]] as const;
    const res = checkSplittable(
      feature,
      store,
      createOpenKnifeLine(cutPts.map(([x, y]) => c(x, y))),
    );
    expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
    if (res.status === SPLIT_CHECK_STATUS.Splittable) expect(res.pieces?.length).toBe(2);
    assertNoPhantomVertices(res, cutPts);
  });

  it('a V-shaped cut splits into 2 pieces with NO phantom triangle pieces', () => {
    const { feature, store } = unitSquare();
    // Enter top-left, dip to apex (5,3) inside, exit top-right. No spurious triangle片.
    const cutPts = [[-2, 12], [5, 3], [12, 12]] as const;
    const res = checkSplittable(
      feature,
      store,
      createOpenKnifeLine(cutPts.map(([x, y]) => c(x, y))),
    );
    expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
    if (res.status === SPLIT_CHECK_STATUS.Splittable) expect(res.pieces?.length).toBe(2);
    assertNoPhantomVertices(res, cutPts);
  });

  it('the axis-parallel vertical cut is UNCHANGED (no degression)', () => {
    const { feature, store } = unitSquare();
    const cutPts = [[5, -5], [5, 15]] as const;
    const res = checkSplittable(
      feature,
      store,
      createOpenKnifeLine(cutPts.map(([x, y]) => c(x, y))),
    );
    expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
    if (res.status === SPLIT_CHECK_STATUS.Splittable) {
      expect(res.pieces?.length).toBe(2);
      // Both halves are exactly half (~equal area).
      expect(Math.abs(res.sideA.areaKm2 - res.sideB.areaKm2)).toBeLessThan(1);
    }
    assertNoPhantomVertices(res, cutPts);
  });
});

describe('checkSplittable — degenerate / looping OPEN cut', () => {
  it('rejects a truly zero-extent line (every point on one grid node) as DegenerateLine', () => {
    const { feature, store } = unitSquare();
    // Two clicks within one U06 grid cell collapse onto the SAME node under snapCutLine,
    // leaving <2 distinct vertices — no usable cut. The honest reason is 分断線の点が足りません
    // (not 貫通せず/不正形状). This is the surviving bug-hunt2 degeneracy guard: with the
    // 第8波 frame clip, a NON-collapsed polyline can never yield a zero-area clip, so the
    // guard now fires only for input with no spatial extent at all.
    const line = createOpenKnifeLine([c(3, 3), c(3, 3.00000001)]);
    const res = checkSplittable(feature, store, line);
    expect(res.status).toBe(SPLIT_CHECK_STATUS.NotSplittable);
    if (res.status === SPLIT_CHECK_STATUS.NotSplittable) {
      expect(res.reason).toBe(SPLIT_REJECT.DegenerateLine);
      expect(res.message).toBe(SPLIT_REJECT_MESSAGE[SPLIT_REJECT.DegenerateLine]);
    }
  });

  it('correctly splits a U-shaped OPEN cut whose first and last points coincide', () => {
    const { feature, store } = unitSquare();
    // A U-shaped OPEN polyline whose ENDS are the SAME node (2,-5): it enters the [0,10]²
    // bottom edge at (2,0), traces up-across-down inside, and exits the bottom at (8,0) —
    // a genuine outside→through→outside transit carving the notch [2,8]×[0,5]. The OLD
    // single-normal offset made the endpoint chord dx=dy=0 → a ZERO-AREA clip that vanished
    // and was rejected as a degeneracy artifact. The 第8波 frame clip extends each END
    // SEGMENT along its OWN direction (last→left, first→down) and closes on the far frame,
    // so this cut is now honestly resolved into its two pieces (notch + remainder), with
    // NO phantom vertices — every piece vertex lands on the square edge or the drawn U.
    const line = createOpenKnifeLine([c(2, -5), c(2, 5), c(8, 5), c(8, -5), c(2, -5)]);
    const res = checkSplittable(feature, store, line);
    expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
    if (res.status === SPLIT_CHECK_STATUS.Splittable) {
      expect(res.pieces?.length).toBe(2);
      // The notch piece is [2,8]×[0,5] (30 of the 100 unit-square's area, scaled).
      const notchArea = Math.min(res.sideA.areaKm2, res.sideB.areaKm2);
      const remainderArea = Math.max(res.sideA.areaKm2, res.sideB.areaKm2);
      expect(notchArea).toBeGreaterThan(0);
      expect(remainderArea).toBeGreaterThan(notchArea);
    }
  });

  it('still accepts a non-looping outside→outside cut over the same square', () => {
    // Guard against over-rejection: a genuine vertical pierce (distinct endpoints)
    // remains splittable.
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
