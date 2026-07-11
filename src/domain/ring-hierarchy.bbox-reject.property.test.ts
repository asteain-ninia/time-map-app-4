// U07 (S3e) — the sound bbox EARLY-REJECTS added to validateGeometry must be
// result-preserving (完全不変). Three rejects share one principle ("a bbox that
// proves no interaction lets us skip the robust O(n·m) geometry"):
//   1. ring-level strict-disjoint skip in the sibling/enclave loop (前任申し送り);
//   2. the per-edge AABB reject inside ringsProperlyCross (the blessed
//      geometry/predicates.ts ringSelfIntersects pattern) — this attacks the
//      MEASURED hotspot (hole-vs-parent containment over a multi-thousand-vertex
//      coastline), which the 申し送り mis-attributed to the enclave O(k²);
//   3. dropping the redundant second ringsProperlyCross in hole containment.
//
// The property below pins that the fast path (rejects ON, the production default)
// returns the SAME RingValidationResult — same `valid`, same violation kinds/ids,
// SAME ORDER — as the exhaustive reference (rejects OFF, `{ exhaustive: true }`),
// over a generator biased to the difficult classes: holes contained / crossing /
// outside their parent, sibling & enclave rings overlapping / touching / disjoint,
// coincident duplicates, and seam-folded representatives (±180 crossing). This is
// the ring-hierarchy analogue of overlap.test.ts's indexed===naive property.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createCoordinate } from './coordinate';
import { asRingId, asVertexId, type RingId, type VertexId } from './ids';
import {
  createHoleRing,
  createShape,
  createTerritoryRing,
  type Ring,
} from './ring';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from './vertex';
import { RING_VIOLATION, validateGeometry } from './ring-hierarchy';

// --- fixtures (real coordinates; every ring is a rectangle) ------------------

/** Fold a longitude into its [-180, 180) stored representative, so a rectangle that
 * spans ±180 gets the intra-ring 179 → −179 jump the seam-unwrap path must handle. */
function foldLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

interface RingSpec {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly kind: 'territory' | 'hole';
  /** Index of an EARLIER spec to parent under, or null for top-level. */
  readonly parent: number | null;
  /** Store the corner lons folded into [-180,180) (a seam-crossing representative). */
  readonly fold: boolean;
}

/** Build a Shape + matching VertexStore from ring specs. Each ring is a 4-corner
 * rectangle with its own unique vertex ids; a hole references its parent's ring id
 * (a spec whose parent index is out of range or points at itself becomes top-level
 * territory, which validateGeometry treats as an enclave — still a valid input for
 * the equivalence comparison). */
function build(specs: readonly RingSpec[]): { shape: ReturnType<typeof createShape>; store: VertexStore } {
  const rings: Ring[] = [];
  const vertices: Vertex[] = [];
  const ringIds: RingId[] = specs.map((_, i) => asRingId(`r${i}`));

  specs.forEach((s, i) => {
    const id = ringIds[i]!;
    const f = s.fold ? foldLon : (v: number): number => v;
    const corners: readonly [number, number][] = [
      [f(s.x0), s.y0],
      [f(s.x1), s.y0],
      [f(s.x1), s.y1],
      [f(s.x0), s.y1],
    ];
    const vids: VertexId[] = corners.map((_, k) => asVertexId(`v${i}-${k}`));
    corners.forEach(([lon, lat], k) => {
      vertices.push(createVertex(vids[k]!, createCoordinate(lon, lat)));
    });

    const parentValid =
      s.kind === 'hole' && s.parent !== null && s.parent >= 0 && s.parent < i;
    if (parentValid) {
      rings.push(createHoleRing(id, vids, ringIds[s.parent!]!));
    } else {
      // territory: top-level, or nested under an earlier ring when one is named.
      const parentTerr = s.parent !== null && s.parent >= 0 && s.parent < i;
      rings.push(parentTerr ? createTerritoryRing(id, vids, ringIds[s.parent!]!) : createTerritoryRing(id, vids));
    }
  });

  return { shape: createShape(rings), store: createVertexStore(vertices) };
}

// --- generator (difficult classes) ------------------------------------------

const ringSpecArb = (index: number): fc.Arbitrary<RingSpec> =>
  fc
    .record({
      // A small coordinate range so rectangles FREQUENTLY overlap / nest / touch,
      // exercising both the skip (disjoint) and the kernel (overlap) branches.
      x0: fc.integer({ min: -20, max: 20 }),
      y0: fc.integer({ min: -20, max: 20 }),
      w: fc.integer({ min: 1, max: 18 }),
      h: fc.integer({ min: 1, max: 18 }),
      kind: fc.constantFrom('territory' as const, 'hole' as const),
      // Parent among earlier rings (or top-level). index 0 is always top-level.
      parent:
        index === 0
          ? fc.constant(null)
          : fc.option(fc.integer({ min: 0, max: index - 1 }), { nil: null }),
      // Occasionally place the rectangle near +180 and fold it, so some rings are
      // seam-crossing stored representatives (172..197 continuous → folded).
      seam: fc.boolean(),
    })
    .map(({ x0, y0, w, h, kind, parent, seam }) => {
      if (seam) {
        const sx = 172 + (((x0 % 8) + 8) % 8); // 172..179
        return { x0: sx, y0, x1: sx + w, y1: y0 + h, kind, parent, fold: true };
      }
      return { x0, y0, x1: x0 + w, y1: y0 + h, kind, parent, fold: false };
    });

const specsArb: fc.Arbitrary<RingSpec[]> = fc
  .integer({ min: 0, max: 7 })
  .chain((n) => (n === 0 ? fc.constant([]) : fc.tuple(...Array.from({ length: n }, (_, i) => ringSpecArb(i)))))
  .map((t) => [...t]);

describe('validateGeometry bbox early-rejects are result-preserving (property)', () => {
  it('fast path == exhaustive reference: same violations, same order (完全不変)', () => {
    fc.assert(
      fc.property(specsArb, (specs) => {
        const { shape, store } = build(specs);
        const fast = validateGeometry(shape, store); // rejects ON (production default)
        const exhaustive = validateGeometry(shape, store, { exhaustive: true }); // rejects OFF
        // Whole structured result must match: valid flag AND the violations array
        // element-for-element in the same order (the skip only omits pairs that
        // produce no violation, so order is invariant).
        expect(fast).toEqual(exhaustive);
      }),
      { numRuns: 500 },
    );
  });
});

// --- targeted equivalence + soundness anchors -------------------------------

const rid = (s: string) => asRingId(s);
function rectVerts(prefix: string, x0: number, y0: number, x1: number, y1: number) {
  const corners: readonly [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const vids = corners.map((_, k) => asVertexId(`${prefix}${k}`));
  const verts = corners.map(([lon, lat], k) => createVertex(vids[k]!, createCoordinate(lon, lat)));
  return { vids, verts };
}

describe('bbox early-reject: soundness anchors (detection never dropped)', () => {
  it('still flags a hole whose edge CROSSES the parent boundary (edge-reject keeps the crossing pair)', () => {
    // Parent [0,100]²; hole spans x 90..110 (pokes out the right edge): the hole's
    // right/top/bottom edges cross the parent's x=100 edge. The per-edge AABB reject
    // must NOT skip those crossing edge pairs.
    const p = rectVerts('p', 0, 0, 100, 100);
    const h = rectVerts('h', 90, 40, 110, 60);
    const parent = createTerritoryRing(rid('P'), p.vids);
    const hole = createHoleRing(rid('H'), h.vids, rid('P'));
    const store = createVertexStore([...p.verts, ...h.verts]);
    const res = validateGeometry(createShape([parent, hole]), store);
    expect(res.valid).toBe(false);
    expect(res.violations.map((v) => v.kind)).toContain(RING_VIOLATION.HoleCrossesParent);
    // exhaustive reference agrees exactly.
    expect(res).toEqual(validateGeometry(createShape([parent, hole]), store, { exhaustive: true }));
  });

  it('still flags a hole lying WHOLLY OUTSIDE its parent (bbox-disjoint) as not-contained', () => {
    // Hole far from the parent: bboxes strictly disjoint, no crossing. The check
    // must report HoleNotContained (not silently skip via the edge reject).
    const p = rectVerts('p', 0, 0, 20, 20);
    const h = rectVerts('h', 100, 100, 110, 110);
    const parent = createTerritoryRing(rid('P'), p.vids);
    const hole = createHoleRing(rid('H'), h.vids, rid('P'));
    const store = createVertexStore([...p.verts, ...h.verts]);
    const res = validateGeometry(createShape([parent, hole]), store);
    expect(res.violations.map((v) => v.kind)).toContain(RING_VIOLATION.HoleNotContained);
    expect(res).toEqual(validateGeometry(createShape([parent, hole]), store, { exhaustive: true }));
  });

  it('still flags two OVERLAPPING enclaves whose bboxes intersect', () => {
    const a = rectVerts('a', 0, 0, 40, 40);
    const b = rectVerts('b', 20, 20, 60, 60);
    const store = createVertexStore([...a.verts, ...b.verts]);
    const shape = createShape([createTerritoryRing(rid('A'), a.vids), createTerritoryRing(rid('B'), b.vids)]);
    const res = validateGeometry(shape, store);
    expect(res.violations.map((v) => v.kind)).toContain(RING_VIOLATION.EnclavesOverlap);
    expect(res).toEqual(validateGeometry(shape, store, { exhaustive: true }));
  });
});

describe('bbox skip collapses the sibling/enclave O(k^2) kernel calls', () => {
  it('spread-out disjoint holes run far fewer full ringsOverlap kernels than k(k-1)/2', () => {
    // A parent territory with K disjoint sibling holes laid far apart in a row (all
    // within one world so seam alignment is a no-op): no pair overlaps, so every
    // pair is bbox-disjoint and the sibling kernel is skipped.
    const K = 12;
    const parent = rectVerts('P', 0, 0, 160, 100);
    const rings: Ring[] = [createTerritoryRing(rid('P'), parent.vids)];
    const verts: Vertex[] = [...parent.verts];
    for (let i = 0; i < K; i += 1) {
      const hx = 5 + i * 12; // holes 12 apart, width 3 => a 9-wide gap between bboxes
      const h = rectVerts(`h${i}_`, hx, 40, hx + 3, 60);
      rings.push(createHoleRing(rid(`H${i}`), h.vids, rid('P')));
      verts.push(...h.verts);
    }
    const store = createVertexStore(verts);
    const shape = createShape(rings);

    const counter = { count: 0 };
    const res = validateGeometry(shape, store, { overlapKernelCounter: counter });
    expect(res.valid).toBe(true); // all holes contained, none overlap
    const allPairs = (K * (K - 1)) / 2; // 66
    expect(counter.count).toBeLessThan(allPairs);
    expect(counter.count).toBe(0); // fully spread: every pair skipped by the bbox

    // The exhaustive reference runs every kernel and reaches the same verdict.
    const refCounter = { count: 0 };
    const ref = validateGeometry(shape, store, { exhaustive: true, overlapKernelCounter: refCounter });
    expect(refCounter.count).toBe(allPairs);
    expect(ref).toEqual(res);
  });
});
