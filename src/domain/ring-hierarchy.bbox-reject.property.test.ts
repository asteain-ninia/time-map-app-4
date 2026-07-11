// U07 (S3e) — the sound bbox EARLY-REJECTS added to validateGeometry must be
// result-preserving (完全不変). The optimization has three parts:
//   1. ring-level strict-disjoint skip in the sibling/enclave loop (前任申し送り);
//   2. the per-edge AABB reject inside ringsProperlyCross (the blessed
//      geometry/predicates.ts ringSelfIntersects pattern) — this attacks the
//      MEASURED hotspot (hole-vs-parent containment over a multi-thousand-vertex
//      coastline), which the 申し送り mis-attributed to the enclave O(k²);
//   3. splitting the old `ringContains` so the hole-containment branch reuses the
//      crossing verdict the caller already holds, instead of re-running the same
//      O(hole·parent) crossing test a second time.
//
// WHAT EACH ORACLE COVERS (Codex LOW-2 precision): `{ exhaustive: true }` disables
// ONLY the bbox rejects (1) and (2) — both modes run the SAME post-(3) control
// flow, so the fast==exhaustive comparison proves (1)+(2) are result-preserving but
// is NOT an oracle for (3). Optimization (3) is an algebraic identity (in the
// no-cross branch the old `ringContains` reduced to the vertex test, because its
// internal second `ringsProperlyCross(hole, parent)` call repeated the exact call
// the caller had just seen return false); that identity is pinned EMPIRICALLY by
// the dedicated property at the bottom of this file, which replays the OLD
// pre-split control flow verbatim (second cross call included) as a test-local
// reference and compares hole classifications.
//
// The main property pins that the fast path (rejects ON, the production default)
// returns the SAME RingValidationResult — same `valid`, same violation kinds/ids,
// SAME ORDER — as the exhaustive reference (rejects OFF), over a generator biased
// to the difficult classes: holes contained / crossing / outside their parent,
// sibling & enclave rings overlapping / touching / disjoint, coincident duplicates,
// seam-folded representatives (±180 crossing), AND degenerate rings (Codex LOW-1:
// zero-length edges from consecutive duplicate vertices, 1–2 point rings, a
// duplicated closing vertex, zero-width / zero-height rectangles). This is the
// ring-hierarchy analogue of overlap.test.ts's indexed===naive property.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createCoordinate } from './coordinate';
import {
  pointInPolygon,
  POINT_LOCATION,
  segmentsIntersect,
  SEGMENT_RELATION,
  type GeoRing,
} from './geometry/index';
import { asRingId, asVertexId, type RingId, type VertexId } from './ids';
import {
  createHoleRing,
  createShape,
  createTerritoryRing,
  type Ring,
} from './ring';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from './vertex';
import { RING_VIOLATION, validateGeometry } from './ring-hierarchy';

// --- fixtures (real coordinates) ---------------------------------------------

/** Fold a longitude into its [-180, 180) stored representative, so a rectangle that
 * spans ±180 gets the intra-ring 179 → −179 jump the seam-unwrap path must handle. */
function foldLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Vertex-list shape of a generated ring. `rect` is the plain 4-corner rectangle;
 * every other variant is a DEGENERATE class (Codex LOW-1) the rejects must also be
 * result-preserving on: consecutive-duplicate vertex (zero-length edge), 1-point and
 * 2-point rings, an explicit duplicated closing vertex, and zero-width / zero-height
 * rectangles (zero-area strips). */
type RingVariant =
  | 'rect'
  | 'zeroLenEdge'
  | 'onePoint'
  | 'twoPoint'
  | 'dupClosing'
  | 'zeroWidth'
  | 'zeroHeight';

/** The vertex coordinates of a ring variant over the rectangle [x0,x1]×[y0,y1]. */
function pointsFor(
  variant: RingVariant,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): readonly (readonly [number, number])[] {
  switch (variant) {
    case 'rect':
      return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    case 'zeroLenEdge':
      // Consecutive duplicate vertex => zero-length edge (the reviewer's example
      // class [(2,2),(2,2),(8,2),(8,8),(2,8)]).
      return [[x0, y0], [x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    case 'onePoint':
      return [[x0, y0]];
    case 'twoPoint':
      return [[x0, y0], [x1, y1]];
    case 'dupClosing':
      // The implicit closing vertex stored explicitly (last === first).
      return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
    case 'zeroWidth':
      return [[x0, y0], [x0, y1], [x0, y1], [x0, y0]];
    case 'zeroHeight':
      return [[x0, y0], [x1, y0], [x1, y0], [x0, y0]];
  }
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
  readonly variant: RingVariant;
}

/** Build a Shape + matching VertexStore from ring specs. Each ring's vertex list is
 * produced by its variant (rectangle or a degenerate class) with unique vertex ids;
 * a hole references its parent's ring id (a spec whose parent index is out of range
 * becomes a top-level territory, which validateGeometry treats as an enclave —
 * still a valid input for the equivalence comparison). */
function build(specs: readonly RingSpec[]): {
  shape: ReturnType<typeof createShape>;
  store: VertexStore;
} {
  const rings: Ring[] = [];
  const vertices: Vertex[] = [];
  const ringIds: RingId[] = specs.map((_, i) => asRingId(`r${i}`));

  specs.forEach((s, i) => {
    const id = ringIds[i]!;
    const f = s.fold ? foldLon : (v: number): number => v;
    const corners = pointsFor(s.variant, s.x0, s.y0, s.x1, s.y1);
    const vids: VertexId[] = corners.map((_, k) => asVertexId(`v${i}-${k}`));
    corners.forEach(([lon, lat], k) => {
      vertices.push(createVertex(vids[k]!, createCoordinate(f(lon), lat)));
    });

    const parentValid = s.parent !== null && s.parent >= 0 && s.parent < i;
    if (s.kind === 'hole' && parentValid) {
      rings.push(createHoleRing(id, vids, ringIds[s.parent!]!));
    } else if (parentValid) {
      rings.push(createTerritoryRing(id, vids, ringIds[s.parent!]!));
    } else {
      rings.push(createTerritoryRing(id, vids));
    }
  });

  return { shape: createShape(rings), store: createVertexStore(vertices) };
}

// --- generator (difficult classes incl. degenerates) --------------------------

// 'rect' is weighted so most rings still have area (the interesting overlap /
// containment interactions), while every degenerate class appears regularly.
const ringVariantArb: fc.Arbitrary<RingVariant> = fc.constantFrom(
  'rect',
  'rect',
  'rect',
  'rect',
  'zeroLenEdge',
  'onePoint',
  'twoPoint',
  'dupClosing',
  'zeroWidth',
  'zeroHeight',
);

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
      variant: ringVariantArb,
    })
    .map(({ x0, y0, w, h, kind, parent, seam, variant }) => {
      if (seam) {
        const sx = 172 + (((x0 % 8) + 8) % 8); // 172..179
        return { x0: sx, y0, x1: sx + w, y1: y0 + h, kind, parent, fold: true, variant };
      }
      return { x0, y0, x1: x0 + w, y1: y0 + h, kind, parent, fold: false, variant };
    });

const specsArb: fc.Arbitrary<RingSpec[]> = fc
  .integer({ min: 0, max: 7 })
  .chain((n) =>
    n === 0 ? fc.constant([]) : fc.tuple(...Array.from({ length: n }, (_, i) => ringSpecArb(i))),
  )
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

// --- targeted equivalence + soundness anchors ---------------------------------

const rid = (s: string) => asRingId(s);

function ringFromPoints(prefix: string, pts: readonly (readonly [number, number])[]) {
  const vids = pts.map((_, k) => asVertexId(`${prefix}${k}`));
  const verts = pts.map(([lon, lat], k) => createVertex(vids[k]!, createCoordinate(lon, lat)));
  return { vids, verts };
}

function rectVerts(prefix: string, x0: number, y0: number, x1: number, y1: number) {
  return ringFromPoints(prefix, [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]);
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
    const shape = createShape([
      createTerritoryRing(rid('A'), a.vids),
      createTerritoryRing(rid('B'), b.vids),
    ]);
    const res = validateGeometry(shape, store);
    expect(res.violations.map((v) => v.kind)).toContain(RING_VIOLATION.EnclavesOverlap);
    expect(res).toEqual(validateGeometry(shape, store, { exhaustive: true }));
  });
});

describe('degenerate rings: fast == exhaustive (deterministic anchors, Codex LOW-1)', () => {
  // Each case builds a small shape featuring one degenerate ring class and asserts
  // the fast path equals the exhaustive reference EXACTLY (same structured result).
  // The degenerate ring is exercised BOTH as a hole (part (a): containment against
  // its parent) and as an enclave (part (b): the pair loop with the bbox skip).
  const degenerates: readonly { label: string; pts: readonly (readonly [number, number])[] }[] = [
    // The reviewer's zero-length-edge example: consecutive duplicate vertex.
    { label: 'zero-length edge [(2,2),(2,2),(8,2),(8,8),(2,8)]', pts: [[2, 2], [2, 2], [8, 2], [8, 8], [2, 8]] },
    { label: 'one-point ring', pts: [[5, 5]] },
    { label: 'two-point ring', pts: [[2, 2], [8, 8]] },
    { label: 'duplicated closing vertex', pts: [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]] },
    { label: 'zero-width rectangle (vertical strip)', pts: [[4, 2], [4, 8], [4, 8], [4, 2]] },
    { label: 'zero-height rectangle (horizontal strip)', pts: [[2, 4], [8, 4], [8, 4], [2, 4]] },
  ];

  for (const d of degenerates) {
    it(`as a HOLE inside a parent: ${d.label}`, () => {
      const p = rectVerts('p', 0, 0, 10, 10);
      const h = ringFromPoints('h', d.pts);
      const parent = createTerritoryRing(rid('P'), p.vids);
      const hole = createHoleRing(rid('H'), h.vids, rid('P'));
      const store = createVertexStore([...p.verts, ...h.verts]);
      const shape = createShape([parent, hole]);
      expect(validateGeometry(shape, store)).toEqual(
        validateGeometry(shape, store, { exhaustive: true }),
      );
    });

    it(`as an ENCLAVE next to rectangle enclaves: ${d.label}`, () => {
      // The degenerate ring is a top-level territory alongside a normal enclave
      // whose bbox INTERSECTS it (kernel branch) — plus a far-away enclave whose
      // bbox is strictly disjoint (skip branch). Both must agree with exhaustive.
      const a = ringFromPoints('a', d.pts);
      const near = rectVerts('n', 0, 0, 10, 10);
      const far = rectVerts('f', 100, 100, 110, 110);
      const store = createVertexStore([...a.verts, ...near.verts, ...far.verts]);
      const shape = createShape([
        createTerritoryRing(rid('A'), a.vids),
        createTerritoryRing(rid('N'), near.vids),
        createTerritoryRing(rid('F'), far.vids),
      ]);
      expect(validateGeometry(shape, store)).toEqual(
        validateGeometry(shape, store, { exhaustive: true }),
      );
    });
  }
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

// --- optimization (3): the ringContains split vs the OLD control flow, verbatim ---
//
// `{ exhaustive: true }` cannot exercise this (both modes share the post-split flow),
// so we replay the PRE-SPLIT part (a) control flow as a test-local reference:
//
//   old:  if (cross(holeGeo, parentGeo))                 -> HoleCrossesParent
//         else if (!oldRingContains(parentGeo, holeGeo)) -> HoleNotContained
//   where oldRingContains(outer, inner) =
//         every inner vertex not strictly Outside outer
//         AND !cross(inner, outer)   // the REDUNDANT second call the split removed
//
// In the else branch that second `cross(inner, outer)` repeats the exact same call
// (same symmetric edge sweep, same argument pair (holeGeo, parentGeo)) that just
// returned false, so the reference provably classifies every hole identically —
// the property below pins that identity empirically over generated contained /
// crossing / outside / touching / degenerate holes.
//
// The reference reads the RAW stored coordinates, which equals what validateGeometry
// compares only when resolveRing + world-turn alignment are the identity; the
// generator is therefore constrained to that regime: integer coordinates
// (quantization = identity), no seam folding and |lon| ≤ 85 (unwrap = identity,
// anchor gap < 180° so the alignment shift is 0).

function crossExhaustiveRef(a: GeoRing, b: GeoRing): boolean {
  const an = a.length;
  const bn = b.length;
  for (let i = 0; i < an; i += 1) {
    const a1 = a[i];
    const a2 = a[(i + 1) % an];
    if (a1 === undefined || a2 === undefined) continue;
    for (let j = 0; j < bn; j += 1) {
      const b1 = b[j];
      const b2 = b[(j + 1) % bn];
      if (b1 === undefined || b2 === undefined) continue;
      if (segmentsIntersect(a1, a2, b1, b2).relation === SEGMENT_RELATION.Proper) {
        return true;
      }
    }
  }
  return false;
}

/** The OLD `ringContains`, verbatim: vertex probe + the (redundant) second cross. */
function oldRingContainsRef(outer: GeoRing, inner: GeoRing): boolean {
  for (const v of inner) {
    if (pointInPolygon(v, [outer]) === POINT_LOCATION.Outside) return false;
  }
  if (crossExhaustiveRef(inner, outer)) return false;
  return true;
}

type PartAKind =
  | typeof RING_VIOLATION.HoleCrossesParent
  | typeof RING_VIOLATION.HoleNotContained;

interface PartAClassification {
  readonly kind: PartAKind;
  readonly ringId: string;
  readonly relatedRingId: string;
}

describe('optimization (3): hole classification equals the OLD pre-split control flow (property)', () => {
  const holeArb = fc.record({
    x0: fc.integer({ min: -25, max: 55 }),
    y0: fc.integer({ min: -25, max: 55 }),
    w: fc.integer({ min: 1, max: 30 }),
    h: fc.integer({ min: 1, max: 30 }),
    variant: ringVariantArb,
  });

  it('fast path part (a) verdicts == old ringContains control flow, hole by hole', () => {
    fc.assert(
      fc.property(
        fc.record({
          // Parent rectangle around the origin, big enough to contain some holes and
          // small enough that others cross it or fall outside.
          px: fc.integer({ min: -10, max: 0 }),
          py: fc.integer({ min: -10, max: 0 }),
          pw: fc.integer({ min: 20, max: 40 }),
          ph: fc.integer({ min: 20, max: 40 }),
          holes: fc.array(holeArb, { minLength: 0, maxLength: 5 }),
        }),
        ({ px, py, pw, ph, holes }) => {
          // Raw rings (identity regime: integer coords, no seam, |lon| ≤ 85).
          const parentPts = pointsFor('rect', px, py, px + pw, py + ph);
          const holePts = holes.map((h) =>
            pointsFor(h.variant, h.x0, h.y0, h.x0 + h.w, h.y0 + h.h),
          );

          const p = ringFromPoints('p', parentPts);
          const rings: Ring[] = [createTerritoryRing(rid('P'), p.vids)];
          const verts: Vertex[] = [...p.verts];
          holePts.forEach((pts, i) => {
            const h = ringFromPoints(`h${i}_`, pts);
            rings.push(createHoleRing(rid(`H${i}`), h.vids, rid('P')));
            verts.push(...h.verts);
          });
          const store = createVertexStore(verts);
          const shape = createShape(rings);

          // Production fast path; keep ONLY the part (a) verdicts.
          const actual: PartAClassification[] = validateGeometry(shape, store)
            .violations.filter(
              (v) =>
                (v.kind === RING_VIOLATION.HoleCrossesParent ||
                  v.kind === RING_VIOLATION.HoleNotContained) &&
                v.relatedRingId !== undefined,
            )
            .map((v) => ({
              kind: v.kind as PartAKind,
              ringId: String(v.ringId),
              relatedRingId: String(v.relatedRingId),
            }));

          // OLD control flow on the raw rings, in the same hole order.
          const parentGeo: GeoRing = parentPts.map(([lon, lat]) => createCoordinate(lon, lat));
          const expected: PartAClassification[] = [];
          holePts.forEach((pts, i) => {
            const holeGeo: GeoRing = pts.map(([lon, lat]) => createCoordinate(lon, lat));
            if (crossExhaustiveRef(holeGeo, parentGeo)) {
              expected.push({
                kind: RING_VIOLATION.HoleCrossesParent,
                ringId: `H${i}`,
                relatedRingId: 'P',
              });
            } else if (!oldRingContainsRef(parentGeo, holeGeo)) {
              expected.push({
                kind: RING_VIOLATION.HoleNotContained,
                ringId: `H${i}`,
                relatedRingId: 'P',
              });
            }
          });

          expect(actual).toEqual(expected);
        },
      ),
      { numRuns: 300 },
    );
  });
});
