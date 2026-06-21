// BUG HUNT (discover-only): hole / enclave / ring-alternation.
//
// Focus: the territory -> hole -> territory -> ... alternation invariant and the
// deletion-reorganization that must preserve it (src/domain/ring.ts and
// src/domain/ring-hierarchy.ts). These property / stateful tests generate random
// hierarchies (both purely structural AND with real nested-rectangle geometry)
// and a vertex store, then assert the documented invariants after every public
// operation:
//   - alternation validity (FR-24): role flips along every parent->child path,
//     outermost rings are territories, no dangling/cyclic parents;
//   - referential integrity: no dangling parent reference survives deletion;
//   - forest validity: every ring reaches a root in finite steps (no cycle);
//   - geometry validity (FR-25): holes contained, siblings/enclaves non-overlap;
//   - coordinates never NaN/Infinity;
//   - metamorphic: delete-absent = identity, determinism, full deletion -> empty,
//     stateful multi-step deletion keeps the invariant at every step.
//
// Determinism: seed fixed to 2001, numRuns large. These tests are a permanent
// asset; they must NOT be relaxed to paint over a real defect.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../coordinate';
import { asRingId, asVertexId, type RingId, type VertexId } from '../ids';
import { ringHierarchyArb, ringIdFromShapeArb } from '../ring-hierarchy.arbitraries';
import {
  createHoleRing,
  createShape,
  createTerritoryRing,
  isAlternationValid,
  isTopLevelRing,
  RING_KIND,
  type Ring,
  type Shape,
} from '../ring';
import {
  childrenOf,
  deleteRingAndReorganize,
  ringDepth,
  topLevelRings,
  validateAlternation,
  validateGeometry,
  validateRingHierarchy,
} from '../ring-hierarchy';
import {
  getVertex,
  createVertex,
  createVertexStore,
  setVertex,
  withVertexCoordinate,
  type VertexStore,
} from '../vertex';
import { ringSelfIntersects, type GeoRing } from '../geometry/index';

const SEED = 2001;
const RUNS = 500;
const cfg = { seed: SEED, numRuns: RUNS } as const;

// Second, independent campaign — the task's focal seed/run budget. Kept separate
// from `cfg` so both seeds shrink/replay deterministically and a regression in
// either is attributable.
const SEED2 = 2002;
const RUNS2 = 600;
const cfg2 = { seed: SEED2, numRuns: RUNS2 } as const;

// ---------------------------------------------------------------------------
// Shared structural invariant checks
// ---------------------------------------------------------------------------

/** Every ring's parent (if any) is present in the shape. */
function noDanglingParents(shape: Shape): boolean {
  const ids = new Set(shape.rings.map((r) => r.id));
  for (const r of shape.rings) {
    const p = r.parentRingId;
    if (p !== undefined && !ids.has(p)) return false;
  }
  return true;
}

/** Every ring reaches a parentless root within shape.rings.length steps. */
function noCycles(shape: Shape): boolean {
  const byId = new Map(shape.rings.map((r) => [r.id, r] as const));
  const limit = shape.rings.length + 1;
  for (const start of shape.rings) {
    let cur: Ring | undefined = start;
    let steps = 0;
    while (cur !== undefined) {
      const p = cur.parentRingId;
      if (p === undefined) break;
      cur = byId.get(p);
      steps += 1;
      if (steps > limit) return false; // cycle
    }
  }
  return true;
}

/** All ring IDs are unique. */
function uniqueIds(shape: Shape): boolean {
  return new Set(shape.rings.map((r) => r.id)).size === shape.rings.length;
}

/** Bundle: a structurally well-formed alternating forest. */
function assertStructurallyValid(shape: Shape): void {
  expect(uniqueIds(shape)).toBe(true);
  expect(noDanglingParents(shape)).toBe(true);
  expect(noCycles(shape)).toBe(true);
  expect(isAlternationValid(shape)).toBe(true);
  expect(validateAlternation(shape).valid).toBe(true);
  // ringDepth must be defined (finite) for every ring in a valid forest.
  for (const r of shape.rings) {
    expect(ringDepth(shape, r.id)).not.toBeUndefined();
  }
}

// ---------------------------------------------------------------------------
// Geometry generator: concentric nested rectangles realize a valid hierarchy.
//
// A top-level territory is an axis-aligned rectangle. A hole is a strictly
// smaller rectangle centered inside it; an enclave is a strictly smaller
// rectangle centered inside the hole; recursion bounded by depth. Multiple
// top-level territories are placed in disjoint longitude bands so enclaves
// never overlap. All coordinates are finite by construction.
// ---------------------------------------------------------------------------

interface GeoShape {
  readonly shape: Shape;
  readonly store: VertexStore;
}

/** Build a centered rectangle ring (4 vertices) with fresh vertex IDs. */
function rectRing(
  id: RingId,
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  kind: typeof RING_KIND.Territory | typeof RING_KIND.Hole,
  parentId: RingId | undefined,
  vertices: { id: VertexId; lon: number; lat: number }[],
): Ring {
  const corners: ReadonlyArray<readonly [number, number]> = [
    [cx - halfW, cy - halfH],
    [cx + halfW, cy - halfH],
    [cx + halfW, cy + halfH],
    [cx - halfW, cy + halfH],
  ];
  const vids: VertexId[] = corners.map(([lon, lat], i) => {
    const vid = asVertexId(`${id}-v${i}`);
    vertices.push({ id: vid, lon, lat });
    return vid;
  });
  return kind === RING_KIND.Territory
    ? createTerritoryRing(id, vids, parentId)
    : createHoleRing(id, vids, parentId ?? asRingId('UNREACHABLE'));
}

/**
 * Generate a geometry-valid concentric hierarchy: an array of top-level
 * territories, each optionally containing a hole, each hole optionally an
 * enclave. Territories occupy disjoint longitude bands.
 */
function geoShapeArb(): fc.Arbitrary<GeoShape> {
  return fc
    .array(
      fc.record({
        // half-size of the top territory rectangle
        halfW: fc.double({ min: 4, max: 8, noNaN: true, noDefaultInfinity: true }),
        halfH: fc.double({ min: 4, max: 8, noNaN: true, noDefaultInfinity: true }),
        hasHole: fc.boolean(),
        hasEnclave: fc.boolean(),
        enclaveHasHole: fc.boolean(),
      }),
      { minLength: 1, maxLength: 3 },
    )
    .map((specs) => {
      const rings: Ring[] = [];
      const vertices: { id: VertexId; lon: number; lat: number }[] = [];
      let counter = 0;
      const fresh = (): RingId => asRingId(`g${counter++}`);

      // Disjoint longitude bands (width 40 each, well separated) keep top-level
      // territories non-overlapping enclaves.
      let bandCenter = -120;
      for (const spec of specs) {
        const cx = bandCenter;
        const cy = 0;
        bandCenter += 40;

        const tId = fresh();
        rings.push(
          rectRing(tId, cx, cy, spec.halfW, spec.halfH, RING_KIND.Territory, undefined, vertices),
        );

        if (!spec.hasHole) continue;
        // Hole strictly inside the territory (half the size, centered).
        const hHalfW = spec.halfW * 0.5;
        const hHalfH = spec.halfH * 0.5;
        const hId = fresh();
        rings.push(rectRing(hId, cx, cy, hHalfW, hHalfH, RING_KIND.Hole, tId, vertices));

        if (!spec.hasEnclave) continue;
        // Enclave strictly inside the hole.
        const eHalfW = hHalfW * 0.5;
        const eHalfH = hHalfH * 0.5;
        const eId = fresh();
        rings.push(
          rectRing(eId, cx, cy, eHalfW, eHalfH, RING_KIND.Territory, hId, vertices),
        );

        if (!spec.enclaveHasHole) continue;
        // Hole strictly inside the enclave.
        const ehId = fresh();
        rings.push(
          rectRing(ehId, cx, cy, eHalfW * 0.5, eHalfH * 0.5, RING_KIND.Hole, eId, vertices),
        );
      }

      const store = createVertexStore(
        vertices.map((v) => createVertex(v.id, createCoordinate(v.lon, v.lat))),
      );
      return { shape: createShape(rings), store };
    });
}

/** Every coordinate in the store is finite (no NaN / Infinity). */
function storeFinite(store: VertexStore): boolean {
  for (const v of store.byId.values()) {
    if (!Number.isFinite(v.coordinate.lon) || !Number.isFinite(v.coordinate.lat)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// 1. Structural alternation + reorganization (purely structural generator)
// ---------------------------------------------------------------------------

describe('alternation: structural invariants under deletion', () => {
  it('generated forests are structurally valid by construction', () => {
    fc.assert(
      fc.property(ringHierarchyArb(), (shape) => {
        assertStructurallyValid(shape);
      }),
      cfg,
    );
  });

  it('deleting any ring preserves all structural invariants', () => {
    fc.assert(
      fc.property(
        ringHierarchyArb().chain((shape) =>
          ringIdFromShapeArb(shape).map((targetId) => ({ shape, targetId })),
        ),
        ({ shape, targetId }) => {
          const after = deleteRingAndReorganize(shape, targetId);
          expect(after.rings.some((r) => r.id === targetId)).toBe(false);
          assertStructurallyValid(after);
          // Deletion never increases ring count, and removes exactly the target
          // plus any structurally-absorbed descendants (never grows).
          expect(after.rings.length).toBeLessThan(shape.rings.length + 1);
        },
      ),
      cfg,
    );
  });

  it('deletion is deterministic (same input -> same output)', () => {
    fc.assert(
      fc.property(
        ringHierarchyArb().chain((shape) =>
          ringIdFromShapeArb(shape).map((targetId) => ({ shape, targetId })),
        ),
        ({ shape, targetId }) => {
          const a = deleteRingAndReorganize(shape, targetId);
          const b = deleteRingAndReorganize(shape, targetId);
          expect(a).toEqual(b);
        },
      ),
      cfg,
    );
  });

  it('metamorphic: deleting an absent ring is the identity', () => {
    fc.assert(
      fc.property(ringHierarchyArb(), (shape) => {
        const absent = asRingId('definitely-not-present-id');
        const after = deleteRingAndReorganize(shape, absent);
        expect(after).toEqual(shape);
      }),
      cfg,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. STATEFUL: random sequence of deletions -> invariant holds at every step
// ---------------------------------------------------------------------------

describe('alternation: stateful deletion sequences', () => {
  it('repeated random deletion keeps the forest valid at every step and reaches empty', () => {
    fc.assert(
      fc.property(
        // A forest plus a long stream of random selectors in [0,1) used to pick
        // which surviving ring to delete next.
        ringHierarchyArb().chain((shape) =>
          fc
            .array(fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }), {
              minLength: shape.rings.length + 3,
              maxLength: shape.rings.length + 8,
            })
            .map((selectors) => ({ shape, selectors })),
        ),
        ({ shape, selectors }) => {
          let current = shape;
          assertStructurallyValid(current);
          for (const sel of selectors) {
            if (current.rings.length === 0) break;
            const idx = Math.min(
              current.rings.length - 1,
              Math.floor(sel * current.rings.length),
            );
            const target = current.rings[idx];
            if (target === undefined) continue;
            const before = current.rings.length;
            current = deleteRingAndReorganize(current, target.id);
            // The forest is valid after every single operation.
            assertStructurallyValid(current);
            // Each deletion strictly shrinks the forest (target always removed).
            expect(current.rings.length).toBeLessThan(before);
          }
          // Deleting at least rings.length times empties the forest.
          expect(current.rings.length).toBe(0);
        },
      ),
      cfg,
    );
  });

  it('deleting every top-level territory in turn empties the forest', () => {
    fc.assert(
      fc.property(ringHierarchyArb(), (shape) => {
        let current = shape;
        let guard = current.rings.length + 5;
        while (current.rings.length > 0 && guard-- > 0) {
          const top = current.rings.find((r) => isTopLevelRing(r));
          // A non-empty valid forest ALWAYS has a top-level territory.
          expect(top).not.toBeUndefined();
          if (top === undefined) break;
          current = deleteRingAndReorganize(current, top.id);
          assertStructurallyValid(current);
        }
        expect(current.rings.length).toBe(0);
      }),
      cfg,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. GEOMETRY: nested-rectangle hierarchies + deletion preserves geometry
// ---------------------------------------------------------------------------

describe('alternation: geometry validity (FR-25)', () => {
  it('concentric nested rectangles are geometrically valid by construction', () => {
    fc.assert(
      fc.property(geoShapeArb(), ({ shape, store }) => {
        expect(storeFinite(store)).toBe(true);
        assertStructurallyValid(shape);
        const geo = validateGeometry(shape, store);
        expect(geo.violations).toEqual([]);
        expect(validateRingHierarchy(shape, store).valid).toBe(true);
      }),
      cfg,
    );
  });

  it('deleting any ring keeps the geometry valid (no manufactured overlaps)', () => {
    fc.assert(
      fc.property(
        geoShapeArb().chain(({ shape, store }) =>
          ringIdFromShapeArb(shape).map((targetId) => ({ shape, store, targetId })),
        ),
        ({ shape, store, targetId }) => {
          const after = deleteRingAndReorganize(shape, targetId);
          assertStructurallyValid(after);
          // The vertex store is unchanged by reorganization; remaining rings keep
          // their original geometry. Reorganization must not introduce overlaps
          // (the 教訓5.40 enclave-absorption defect class).
          const geo = validateGeometry(after, store);
          expect(geo.violations).toEqual([]);
        },
      ),
      cfg,
    );
  });

  it('childrenOf is consistent with parent links after deletion', () => {
    fc.assert(
      fc.property(
        geoShapeArb().chain(({ shape, store }) =>
          ringIdFromShapeArb(shape).map((targetId) => ({ shape, store, targetId })),
        ),
        ({ shape, targetId }) => {
          const after = deleteRingAndReorganize(shape, targetId);
          for (const r of after.rings) {
            const kids = childrenOf(after, r.id);
            for (const k of kids) {
              expect(k.parentRingId).toBe(r.id);
            }
          }
        },
      ),
      cfg,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. MALFORMED-INPUT ROBUSTNESS: deletion must always restore a valid forest.
//
// deleteRingAndReorganize documents that even malformed input (dangling parents,
// broken alternation) is repaired into a referentially-integral result. We feed
// it deliberately-broken shapes and assert the post-condition the doc promises.
// ---------------------------------------------------------------------------

describe('alternation: deletion repairs malformed input', () => {
  /** Generate a small, possibly-malformed shape: arbitrary kinds + parent links. */
  function malformedShapeArb(): fc.Arbitrary<Shape> {
    return fc
      .array(
        fc.record({
          kind: fc.constantFrom(RING_KIND.Territory, RING_KIND.Hole),
          // parent index relative to the ring list (or -1 = none); resolved later.
          parentIdx: fc.integer({ min: -1, max: 5 }),
        }),
        { minLength: 1, maxLength: 6 },
      )
      .map((specs) => {
        const ids = specs.map((_, i) => asRingId(`m${i}`));
        const rings: Ring[] = specs.map((spec, i) => {
          const vids = [asVertexId(`m${i}-a`), asVertexId(`m${i}-b`), asVertexId(`m${i}-c`)];
          const parentId =
            spec.parentIdx >= 0 && spec.parentIdx < ids.length
              ? ids[spec.parentIdx]
              : undefined;
          if (spec.kind === RING_KIND.Territory) {
            return createTerritoryRing(ids[i] as RingId, vids, parentId);
          }
          // A hole requires a parent id; use the resolved one or a self/dangling id.
          return createHoleRing(ids[i] as RingId, vids, parentId ?? asRingId(`dangling-${i}`));
        });
        return createShape(rings);
      });
  }

  // REGRESSION (bughunt seed=2001): a SELF-LOOPING ring (parentRingId === id)
  // used to make deleteTerritory / deleteHole compute liftTarget === the ring
  // being deleted, so any child lifted onto it became a dangling reference once
  // the ring was dropped. The deleted ring is now excluded from the grandparent
  // lookup, so children are demoted to top-level (territory) / re-targeted to
  // undefined instead of pointing at the removed ring.
  it('deleting a self-parent TERRITORY leaves no dangling child reference', () => {
    const vids = [asVertexId('m0-a'), asVertexId('m0-b'), asVertexId('m0-c')];
    const cids = [asVertexId('m1-a'), asVertexId('m1-b'), asVertexId('m1-c')];
    const shape = createShape([
      createTerritoryRing(asRingId('m0'), vids, asRingId('m0')), // self-loop
      createTerritoryRing(asRingId('m1'), cids, asRingId('m0')), // child of m0
    ]);
    const after = deleteRingAndReorganize(shape, asRingId('m0'));
    expect(after.rings.some((r) => r.id === asRingId('m0'))).toBe(false);
    expect(noDanglingParents(after)).toBe(true);
    expect(noCycles(after)).toBe(true);
    const m1 = after.rings.find((r) => r.id === asRingId('m1'));
    expect(m1?.parentRingId).toBeUndefined(); // lifted to top-level, not -> 'm0'
  });

  it('deleting a self-parent HOLE leaves no dangling child reference', () => {
    const hids = [asVertexId('h0-a'), asVertexId('h0-b'), asVertexId('h0-c')];
    const cids = [asVertexId('h1-a'), asVertexId('h1-b'), asVertexId('h1-c')];
    const shape = createShape([
      createHoleRing(asRingId('h0'), hids, asRingId('h0')), // self-loop
      createHoleRing(asRingId('h1'), cids, asRingId('h0')), // child of h0
    ]);
    const after = deleteRingAndReorganize(shape, asRingId('h0'));
    expect(after.rings.some((r) => r.id === asRingId('h0'))).toBe(false);
    expect(noDanglingParents(after)).toBe(true);
    expect(noCycles(after)).toBe(true);
  });

  it('deleting any ring of a malformed shape yields a referentially-integral, acyclic result', () => {
    fc.assert(
      fc.property(
        malformedShapeArb().chain((shape) =>
          shape.rings.length === 0
            ? fc.constant({ shape, targetId: asRingId('none') })
            : ringIdFromShapeArb(shape).map((targetId) => ({ shape, targetId })),
        ),
        ({ shape, targetId }) => {
          const after = deleteRingAndReorganize(shape, targetId);
          // Documented post-conditions, regardless of how broken the input was:
          // (1) the target is gone,
          expect(after.rings.some((r) => r.id === targetId)).toBe(false);
          // (2) no dangling parent reference survives (教訓5.21),
          expect(noDanglingParents(after)).toBe(true);
          // (3) the result is acyclic,
          expect(noCycles(after)).toBe(true);
          // (4) IDs stay unique.
          expect(uniqueIds(after)).toBe(true);
        },
      ),
      cfg,
    );
  });
});

// ===========================================================================
// 5. SECOND CAMPAIGN (seed=2002) — deeper invariants + metamorphic laws
//
// Focus per the bughunt brief: after every public operation the focal invariants
// hold (ring alternation, non-self-intersection, valid containment, valid forest
// = parent depth is child depth - 1, finite coordinates, selection-of-a-ring
// stays valid) and the metamorphic laws (delete-absent = identity, determinism,
// the boolean predicate agrees with the structured validator). These are NEW
// properties, not duplicates of campaign 1, and they run on seed 2002.
// ===========================================================================

/** Resolve a ring's vertices to a plain coordinate ring via the PUBLIC store
 * API (no seam unwrap / quantization — we only need the raw stored geometry for
 * finiteness + self-intersection checks). Returns undefined if any vertex is
 * missing (treated as not-geometrically-checkable, mirroring the unit). */
function rawRing(store: VertexStore, ring: Ring): GeoRing | undefined {
  const out: { lon: number; lat: number }[] = [];
  for (const vid of ring.vertexIds) {
    const v = getVertex(store, vid);
    if (v === undefined) return undefined;
    out.push(v.coordinate);
  }
  return out;
}

/** Every resolvable ring's stored coordinates are finite (no NaN / Infinity). */
function allRingsFinite(shape: Shape, store: VertexStore): boolean {
  for (const ring of shape.rings) {
    const geo = rawRing(store, ring);
    if (geo === undefined) continue;
    for (const c of geo) {
      if (!Number.isFinite(c.lon) || !Number.isFinite(c.lat)) return false;
    }
  }
  return true;
}

/** No resolvable ring self-intersects (each is a simple polygon). */
function noRingSelfIntersects(shape: Shape, store: VertexStore): boolean {
  for (const ring of shape.rings) {
    const geo = rawRing(store, ring);
    if (geo === undefined) continue;
    if (ringSelfIntersects(geo)) return false;
  }
  return true;
}

/**
 * Forest-shape law: a valid alternating forest is a tree-forest where every
 * non-root ring's depth is exactly one more than its parent's depth (the
 * "derived aggregate = sum/extension of children" structural analogue). Returns
 * false if any parent/child depth relationship is violated.
 */
function depthsConsistent(shape: Shape): boolean {
  const byId = new Map(shape.rings.map((r) => [r.id, r] as const));
  for (const r of shape.rings) {
    const d = ringDepth(shape, r.id);
    if (d === undefined) return false; // broken chain
    const parent = r.parentRingId;
    if (parent === undefined) {
      if (d !== 0) return false; // a root must be depth 0
      continue;
    }
    const pd = ringDepth(shape, parent);
    if (pd === undefined) return false;
    if (d !== pd + 1) return false;
    // The parent must actually be present (depth would also catch dangling).
    if (!byId.has(parent)) return false;
  }
  return true;
}

describe('alternation (seed=2002): deeper structural + geometric invariants', () => {
  it('generated geometry is finite, simple, and alternation-valid by construction', () => {
    fc.assert(
      fc.property(geoShapeArb(), ({ shape, store }) => {
        expect(storeFinite(store)).toBe(true);
        expect(allRingsFinite(shape, store)).toBe(true);
        expect(noRingSelfIntersects(shape, store)).toBe(true);
        assertStructurallyValid(shape);
        expect(depthsConsistent(shape)).toBe(true);
        expect(validateRingHierarchy(shape, store).violations).toEqual([]);
      }),
      cfg2,
    );
  });

  it('after deleting any ring: forest depths stay consistent and geometry simple+finite', () => {
    fc.assert(
      fc.property(
        geoShapeArb().chain(({ shape, store }) =>
          ringIdFromShapeArb(shape).map((targetId) => ({ shape, store, targetId })),
        ),
        ({ shape, store, targetId }) => {
          const after = deleteRingAndReorganize(shape, targetId);
          assertStructurallyValid(after);
          // Forest law: parent depth = child depth - 1 for every ring.
          expect(depthsConsistent(after)).toBe(true);
          // Reorganization never invents or mutates a vertex, so geometry stays
          // finite and simple; and it must not manufacture containment overlaps.
          expect(allRingsFinite(after, store)).toBe(true);
          expect(noRingSelfIntersects(after, store)).toBe(true);
          expect(validateGeometry(after, store).violations).toEqual([]);
        },
      ),
      cfg2,
    );
  });

  it('the boolean alternation predicate agrees with the structured validator', () => {
    // isAlternationValid (U06 cheap predicate) and validateAlternation (U07
    // structured) are documented to be the SAME judgement (教訓5.26). On any
    // (possibly-malformed) shape, the contract is: structured.valid implies the
    // cheap predicate is true, and whenever the cheap predicate is false the
    // structured one is false too (the structured one ALSO catches cycles /
    // dangling that the cheap predicate is not asked to judge).
    fc.assert(
      fc.property(
        fc
          .array(
            fc.record({
              kind: fc.constantFrom(RING_KIND.Territory, RING_KIND.Hole),
              parentIdx: fc.integer({ min: -1, max: 5 }),
            }),
            { minLength: 0, maxLength: 6 },
          )
          .map((specs) => {
            const ids = specs.map((_, i) => asRingId(`p${i}`));
            const rings: Ring[] = specs.map((spec, i) => {
              const vids = [asVertexId(`p${i}-a`), asVertexId(`p${i}-b`), asVertexId(`p${i}-c`)];
              const parentId =
                spec.parentIdx >= 0 && spec.parentIdx < ids.length ? ids[spec.parentIdx] : undefined;
              return spec.kind === RING_KIND.Territory
                ? createTerritoryRing(ids[i] as RingId, vids, parentId)
                : createHoleRing(ids[i] as RingId, vids, parentId ?? asRingId(`dangle-${i}`));
            });
            return createShape(rings);
          }),
        (shape) => {
          const cheap = isAlternationValid(shape);
          const structured = validateAlternation(shape);
          if (structured.valid) expect(cheap).toBe(true);
          if (!cheap) expect(structured.valid).toBe(false);
        },
      ),
      cfg2,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. STATEFUL (seed=2002): random deletion stream over REAL geometry, asserting
//    the full focal invariant bundle after every single operation.
// ---------------------------------------------------------------------------

describe('alternation (seed=2002): stateful geometry deletion stream', () => {
  it('every step keeps alternation, depths, simple+finite geometry, valid containment, valid selection', () => {
    fc.assert(
      fc.property(
        geoShapeArb().chain(({ shape, store }) =>
          fc
            .array(fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }), {
              minLength: shape.rings.length + 2,
              maxLength: shape.rings.length + 6,
            })
            .map((selectors) => ({ shape, store, selectors })),
        ),
        ({ shape, store, selectors }) => {
          let current = shape;
          const checkAll = (s: Shape): void => {
            assertStructurallyValid(s);
            expect(depthsConsistent(s)).toBe(true);
            expect(allRingsFinite(s, store)).toBe(true);
            expect(noRingSelfIntersects(s, store)).toBe(true);
            expect(validateGeometry(s, store).violations).toEqual([]);
            // SELECTION validity: a non-empty valid forest always has a top-level
            // territory available to select; childrenOf is consistent with links.
            if (s.rings.length > 0) {
              expect(topLevelRings(s).length).toBeGreaterThan(0);
            }
            for (const r of s.rings) {
              for (const k of childrenOf(s, r.id)) {
                expect(k.parentRingId).toBe(r.id);
              }
            }
          };
          checkAll(current);
          for (const sel of selectors) {
            if (current.rings.length === 0) break;
            const idx = Math.min(current.rings.length - 1, Math.floor(sel * current.rings.length));
            const target = current.rings[idx];
            if (target === undefined) continue;
            const before = current.rings.length;
            // METAMORPHIC at each step: deleting an absent ring is the identity.
            expect(deleteRingAndReorganize(current, asRingId('absent-step-id'))).toEqual(current);
            current = deleteRingAndReorganize(current, target.id);
            expect(current.rings.length).toBeLessThan(before);
            checkAll(current);
          }
          expect(current.rings.length).toBe(0);
        },
      ),
      cfg2,
    );
  });
});

// ===========================================================================
// 7. THIRD CAMPAIGN (seed=2004) — focal brief: richer multi-child geometry,
//    save->load identity, and op∘inverse metamorphic laws.
//
// The campaign-1/2 geometry generator only ever produces ONE hole per territory
// and ONE enclave per hole. The documented 教訓5.40 defect class (deletion
// MANUFACTURING an overlap by absorbing/lifting siblings) only fires when a ring
// has MULTIPLE same-parent siblings. This campaign therefore generates trees
// with up to 3 holes per territory and up to 3 enclaves per hole, all laid out
// in disjoint sub-columns so the starting shape is geometry-valid by
// construction, then asserts the full invariant bundle survives every deletion.
// ===========================================================================

const SEED3 = 2004;
const RUNS3 = 700;
const cfg3 = { seed: SEED3, numRuns: RUNS3 } as const;

interface Rect {
  readonly cx: number;
  readonly cy: number;
  readonly halfW: number;
  readonly halfH: number;
}

/** Split a rectangle into `n` disjoint child rectangles along the X axis, each
 * strictly inside the parent with a gutter between them so siblings never touch.
 * A child's half-height is also shrunk so it sits clear of the parent's top/
 * bottom edge. Returns [] for n<=0. Geometry-valid by construction. */
function disjointChildRects(parent: Rect, n: number): readonly Rect[] {
  if (n <= 0) return [];
  // Usable interior width with a margin on each side and gutters between cells.
  const margin = parent.halfW * 0.15;
  const innerHalfW = parent.halfW - margin;
  const cellWidth = (2 * innerHalfW) / n;
  const childHalfW = cellWidth * 0.3; // leaves a gutter (cell is 0.6 filled)
  const childHalfH = parent.halfH * 0.4;
  const out: Rect[] = [];
  for (let i = 0; i < n; i += 1) {
    const cellCenter = parent.cx - innerHalfW + cellWidth * (i + 0.5);
    out.push({ cx: cellCenter, cy: parent.cy, halfW: childHalfW, halfH: childHalfH });
  }
  return out;
}

/** A nested plan with explicit per-level child COUNTS and rectangles. */
interface GeoPlan {
  readonly rect: Rect;
  readonly kind: typeof RING_KIND.Territory | typeof RING_KIND.Hole;
  readonly children: readonly GeoPlan[];
}

/** Build a geo plan: a territory rect with `holeCounts.length` holes, each hole
 * carrying that many enclaves, each enclave carrying `enclaveHoles` holes. */
function buildTerritoryPlan(
  rect: Rect,
  holeCounts: readonly number[],
  enclaveHoles: number,
): GeoPlan {
  const holeRects = disjointChildRects(rect, holeCounts.length);
  const holes: GeoPlan[] = holeRects.map((hr, i) => {
    const enclaveCount = holeCounts[i] ?? 0;
    const enclaveRects = disjointChildRects(hr, enclaveCount);
    const enclaves: GeoPlan[] = enclaveRects.map((er) => {
      const innerHoleRects = disjointChildRects(er, enclaveHoles);
      const innerHoles: GeoPlan[] = innerHoleRects.map((ihr) => ({
        rect: ihr,
        kind: RING_KIND.Hole,
        children: [],
      }));
      return { rect: er, kind: RING_KIND.Territory, children: innerHoles };
    });
    return { rect: hr, kind: RING_KIND.Hole, children: enclaves };
  });
  return { rect, kind: RING_KIND.Territory, children: holes };
}

/** Materialize a GeoPlan into rings + vertices with globally-unique IDs. */
function materializePlan(
  plan: GeoPlan,
  parentId: RingId | undefined,
  fresh: () => RingId,
  rings: Ring[],
  vertices: { id: VertexId; lon: number; lat: number }[],
): void {
  const id = fresh();
  rings.push(
    rectRing(id, plan.rect.cx, plan.rect.cy, plan.rect.halfW, plan.rect.halfH, plan.kind, parentId, vertices),
  );
  for (const child of plan.children) {
    materializePlan(child, id, fresh, rings, vertices);
  }
}

/** Rich geometry generator: multiple top-level territories in disjoint longitude
 * bands; each territory has 0..3 holes; each hole has 0..3 enclaves; each enclave
 * has 0..2 inner holes. Geometry-valid by construction. */
function richGeoShapeArb(): fc.Arbitrary<GeoShape> {
  return fc
    .array(
      fc.record({
        halfW: fc.double({ min: 10, max: 16, noNaN: true, noDefaultInfinity: true }),
        halfH: fc.double({ min: 10, max: 16, noNaN: true, noDefaultInfinity: true }),
        // For each hole: how many enclaves it has (length => number of holes).
        holeCounts: fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 0, maxLength: 3 }),
        enclaveHoles: fc.integer({ min: 0, max: 2 }),
      }),
      { minLength: 1, maxLength: 3 },
    )
    .map((specs) => {
      const rings: Ring[] = [];
      const vertices: { id: VertexId; lon: number; lat: number }[] = [];
      let counter = 0;
      const fresh = (): RingId => asRingId(`x${counter++}`);
      // Disjoint longitude bands, wide enough (80 apart) that top territories of
      // half-width <=16 never touch.
      let bandCenter = -160;
      for (const spec of specs) {
        const rect: Rect = { cx: bandCenter, cy: 0, halfW: spec.halfW, halfH: spec.halfH };
        bandCenter += 80;
        const plan = buildTerritoryPlan(rect, spec.holeCounts, spec.enclaveHoles);
        materializePlan(plan, undefined, fresh, rings, vertices);
      }
      const store = createVertexStore(
        vertices.map((v) => createVertex(v.id, createCoordinate(v.lon, v.lat))),
      );
      return { shape: createShape(rings), store };
    });
}

/** Serialize a shape to plain JSON-safe data and back — the structural core of a
 * save->load round-trip (the model is "plain data" by design, lesson 5.20/5.31).
 * If the in-memory model is genuinely plain, JSON.parse(JSON.stringify(x)) must
 * reproduce it exactly. A non-plain field (a class instance, a Map, a function,
 * a -0, a non-finite number) would surface here as a round-trip mismatch. */
function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('alternation (seed=2004): rich multi-child geometry under deletion', () => {
  it('rich nested hierarchies are geometry-valid and structurally valid by construction', () => {
    fc.assert(
      fc.property(richGeoShapeArb(), ({ shape, store }) => {
        expect(storeFinite(store)).toBe(true);
        expect(allRingsFinite(shape, store)).toBe(true);
        expect(noRingSelfIntersects(shape, store)).toBe(true);
        assertStructurallyValid(shape);
        expect(depthsConsistent(shape)).toBe(true);
        // The whole point of the rich generator: starting geometry has NO
        // violations even with many siblings.
        expect(validateRingHierarchy(shape, store).violations).toEqual([]);
      }),
      cfg3,
    );
  });

  it('deleting ANY ring of a rich hierarchy never manufactures a geometry violation (教訓5.40)', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          ringIdFromShapeArb(shape).map((targetId) => ({ shape, store, targetId })),
        ),
        ({ shape, store, targetId }) => {
          const after = deleteRingAndReorganize(shape, targetId);
          assertStructurallyValid(after);
          expect(depthsConsistent(after)).toBe(true);
          expect(allRingsFinite(after, store)).toBe(true);
          expect(noRingSelfIntersects(after, store)).toBe(true);
          // The focal property: reorganization must NOT create siblings/enclaves
          // overlap nor break hole-containment. The store is untouched, so any
          // violation is purely a re-linking defect.
          const geo = validateGeometry(after, store);
          expect(geo.violations).toEqual([]);
        },
      ),
      cfg3,
    );
  });

  it('stateful: rich geometry survives a full random deletion stream to empty', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .array(fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }), {
              minLength: shape.rings.length + 2,
              maxLength: shape.rings.length + 6,
            })
            .map((selectors) => ({ shape, store, selectors })),
        ),
        ({ shape, store, selectors }) => {
          let current = shape;
          const checkAll = (s: Shape): void => {
            assertStructurallyValid(s);
            expect(depthsConsistent(s)).toBe(true);
            expect(allRingsFinite(s, store)).toBe(true);
            expect(noRingSelfIntersects(s, store)).toBe(true);
            expect(validateGeometry(s, store).violations).toEqual([]);
            if (s.rings.length > 0) expect(topLevelRings(s).length).toBeGreaterThan(0);
          };
          checkAll(current);
          for (const sel of selectors) {
            if (current.rings.length === 0) break;
            const idx = Math.min(current.rings.length - 1, Math.floor(sel * current.rings.length));
            const target = current.rings[idx];
            if (target === undefined) continue;
            current = deleteRingAndReorganize(current, target.id);
            checkAll(current);
          }
          expect(current.rings.length).toBe(0);
        },
      ),
      cfg3,
    );
  });
});

describe('alternation (seed=2004): metamorphic laws', () => {
  it('save -> load is the identity on the shape (plain-data round-trip)', () => {
    fc.assert(
      fc.property(richGeoShapeArb(), ({ shape }) => {
        const reloaded = jsonRoundTrip(shape);
        expect(reloaded).toEqual(shape);
        // The reloaded shape is still a valid alternating forest.
        assertStructurallyValid(reloaded);
      }),
      cfg3,
    );
  });

  it('save -> load is the identity on the vertex coordinates (no -0 / non-finite drift)', () => {
    fc.assert(
      fc.property(richGeoShapeArb(), ({ store }) => {
        for (const v of store.byId.values()) {
          const reloaded = jsonRoundTrip(v.coordinate);
          // Coordinates are plain finite numbers; round-trip must be exact,
          // including the +0 / -0 normalization the coordinate seam guarantees.
          expect(reloaded).toEqual(v.coordinate);
          expect(Object.is(reloaded.lon, v.coordinate.lon)).toBe(true);
          expect(Object.is(reloaded.lat, v.coordinate.lat)).toBe(true);
        }
      }),
      cfg3,
    );
  });

  it('metamorphic: delete(delete(s, t), t) == delete(s, t) (deletion is idempotent in its target)', () => {
    // Once the target is gone, deleting it again is a no-op on the result (the
    // target is absent => identity). This is the op∘op stability law for an
    // idempotent destructive operation.
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          ringIdFromShapeArb(shape).map((targetId) => ({ shape, store, targetId })),
        ),
        ({ shape, targetId }) => {
          const once = deleteRingAndReorganize(shape, targetId);
          const twice = deleteRingAndReorganize(once, targetId);
          expect(twice).toEqual(once);
        },
      ),
      cfg3,
    );
  });

  it('metamorphic: deletion order independence for two distinct top-level enclaves', () => {
    // Deleting two DISJOINT top-level territories (separate bands) in either
    // order yields the same forest — they share no ancestry, so reorganization of
    // one cannot affect the other (op_a ∘ op_b == op_b ∘ op_a).
    fc.assert(
      fc.property(richGeoShapeArb(), ({ shape }) => {
        const tops = topLevelRings(shape);
        if (tops.length < 2) return; // need two independent subtrees
        const a = tops[0];
        const b = tops[1];
        if (a === undefined || b === undefined) return;
        const ab = deleteRingAndReorganize(deleteRingAndReorganize(shape, a.id), b.id);
        const ba = deleteRingAndReorganize(deleteRingAndReorganize(shape, b.id), a.id);
        // Compare as ID-keyed sets (ring array order may differ between paths).
        const norm = (s: Shape): string =>
          JSON.stringify(
            [...s.rings]
              .map((r) => ({ id: r.id, kind: r.kind, parent: r.parentRingId ?? null }))
              .sort((x, y) => x.id.localeCompare(y.id)),
          );
        expect(norm(ab)).toBe(norm(ba));
      }),
      cfg3,
    );
  });
});

// ===========================================================================
// 8. FOURTH CAMPAIGN (seed=22001) — STATEFUL edit-command stream over a
//    (Shape, VertexStore) model, exploring a region NOT covered by campaigns
//    1-3 (seeds 2001/2002/2004, which only ever DELETE rings).
//
// The brief asks for "ランダムな編集コマンド列" (a random edit-command sequence) and
// the full invariant bundle after EVERY operation, plus the metamorphic laws
// undo∘op = identity, op∘inverse = identity, and save∘load = identity.
//
// New ground vs. prior campaigns:
//   - The model carries BOTH a shape and a mutable vertex store, and the command
//     set includes a geometry mutation (rigid translation of a whole top-level
//     subtree), not only structural deletion. A rigid translation by a finite
//     offset preserves containment / non-self-intersection WITHIN a subtree and,
//     because top-level bands start 80° apart with half-width ≤16 and the offset
//     is clamped to ±15, never collides two bands (min gap 80-30-30 = 20 > 0).
//     So a correct system MUST keep validateGeometry clean across the whole
//     stream — any violation is a real defect, not a generator artifact.
//   - undo is modelled by snapshotting state BEFORE each op and asserting the
//     snapshot reproduces the pre-state verbatim (the editor undo contract).
//   - op∘inverse for the translation command: translate by +d then by -d on the
//     SAME subtree must restore the exact prior store (a true inverse pair).
//   - save∘load identity is asserted on the live (Shape, store) state at every
//     step, not just the initial state.
//
// Determinism: seed fixed to 22001, numRuns large; permanent asset, no green-fake.
// ===========================================================================

const SEED4 = 22001;
const RUNS4 = 500;
const cfg4 = { seed: SEED4, numRuns: RUNS4 } as const;

/** Live editor state: a shape plus the vertex store its rings resolve against. */
interface EditState {
  readonly shape: Shape;
  readonly store: VertexStore;
}

/** The set of ring IDs in `ringId`'s subtree (itself + all descendants). */
function subtreeRingIds(shape: Shape, ringId: RingId): ReadonlySet<RingId> {
  const childrenByParent = new Map<RingId, RingId[]>();
  for (const r of shape.rings) {
    const p = r.parentRingId;
    if (p === undefined) continue;
    const bucket = childrenByParent.get(p);
    if (bucket === undefined) childrenByParent.set(p, [r.id]);
    else bucket.push(r.id);
  }
  const out = new Set<RingId>();
  const stack: RingId[] = [ringId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || out.has(id)) continue;
    out.add(id);
    for (const c of childrenByParent.get(id) ?? []) stack.push(c);
  }
  return out;
}

/** Rigidly translate every vertex of every ring in `ringId`'s subtree by
 * (dLon, dLat). Returns a NEW store; the shape is unchanged (geometry lives in
 * the store, parent links in the shape). A rigid translation preserves the
 * subtree's internal containment/simplicity exactly. */
function translateSubtree(
  state: EditState,
  ringId: RingId,
  dLon: number,
  dLat: number,
): VertexStore {
  const ids = subtreeRingIds(state.shape, ringId);
  const movedVertexIds = new Set<VertexId>();
  for (const ring of state.shape.rings) {
    if (!ids.has(ring.id)) continue;
    for (const vid of ring.vertexIds) movedVertexIds.add(vid);
  }
  let store = state.store;
  for (const vid of movedVertexIds) {
    const v = getVertex(store, vid);
    if (v === undefined) continue;
    const moved = withVertexCoordinate(
      v,
      createCoordinate(v.coordinate.lon + dLon, v.coordinate.lat + dLat),
    );
    store = setVertex(store, moved);
  }
  return store;
}

/** Serialize the whole editor state (shape + store as an array) and back — the
 * structural save→load round-trip over the LIVE state at any step. */
function saveLoadState(state: EditState): EditState {
  const savedShape = JSON.parse(JSON.stringify(state.shape)) as Shape;
  const vertexArray = [...state.store.byId.values()].map((v) => ({
    id: v.id,
    coordinate: { lon: v.coordinate.lon, lat: v.coordinate.lat },
  }));
  const reloadedVertices = (JSON.parse(JSON.stringify(vertexArray)) as typeof vertexArray).map(
    (v) => createVertex(v.id as VertexId, createCoordinate(v.coordinate.lon, v.coordinate.lat)),
  );
  return { shape: savedShape, store: createVertexStore(reloadedVertices) };
}

/** The full focal invariant bundle for one (shape, store) state. */
function assertFullBundle(state: EditState): void {
  // alternation + acyclic + unique + finite-depth forest
  assertStructurallyValid(state.shape);
  // forest law: parent depth = child depth - 1 (derived-aggregate analogue)
  expect(depthsConsistent(state.shape)).toBe(true);
  // coordinates never NaN/Infinity
  expect(storeFinite(state.store)).toBe(true);
  expect(allRingsFinite(state.shape, state.store)).toBe(true);
  // non self-intersection
  expect(noRingSelfIntersects(state.shape, state.store)).toBe(true);
  // valid containment / sibling & enclave non-overlap
  expect(validateGeometry(state.shape, state.store).violations).toEqual([]);
  // selection validity: a non-empty valid forest always exposes a selectable
  // top-level territory, and childrenOf agrees with the stored parent links.
  if (state.shape.rings.length > 0) {
    expect(topLevelRings(state.shape).length).toBeGreaterThan(0);
  }
  for (const r of state.shape.rings) {
    for (const k of childrenOf(state.shape, r.id)) {
      expect(k.parentRingId).toBe(r.id);
    }
  }
  // save -> load = identity over the LIVE state at this step.
  const reloaded = saveLoadState(state);
  expect(reloaded.shape).toEqual(state.shape);
  for (const v of state.store.byId.values()) {
    const rv = reloaded.store.byId.get(v.id);
    expect(rv).not.toBeUndefined();
    expect(Object.is(rv?.coordinate.lon, v.coordinate.lon)).toBe(true);
    expect(Object.is(rv?.coordinate.lat, v.coordinate.lat)).toBe(true);
  }
}

/** A generated edit command, resolved against the current state at run time. */
type EditCommand =
  | { readonly tag: 'delete'; readonly sel: number }
  | {
      readonly tag: 'translate';
      readonly sel: number;
      readonly dLon: number;
      readonly dLat: number;
    }
  | { readonly tag: 'saveLoad' }
  | { readonly tag: 'noop-delete-absent' };

function editCommandArb(): fc.Arbitrary<EditCommand> {
  const off = (): fc.Arbitrary<number> =>
    fc.double({ min: -15, max: 15, noNaN: true, noDefaultInfinity: true });
  const sel = (): fc.Arbitrary<number> =>
    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });
  return fc.oneof(
    fc.record({ tag: fc.constant('delete' as const), sel: sel() }),
    fc.record({
      tag: fc.constant('translate' as const),
      sel: sel(),
      dLon: off(),
      dLat: off(),
    }),
    fc.record({ tag: fc.constant('saveLoad' as const) }),
    fc.record({ tag: fc.constant('noop-delete-absent' as const) }),
  );
}

/** Pick a top-level ring ID from a selector in [0,1). undefined when empty. */
function pickTopLevel(shape: Shape, sel: number): RingId | undefined {
  const tops = topLevelRings(shape);
  if (tops.length === 0) return undefined;
  const idx = Math.min(tops.length - 1, Math.floor(sel * tops.length));
  return tops[idx]?.id;
}

/** Pick any ring ID from a selector in [0,1). undefined when empty. */
function pickAny(shape: Shape, sel: number): RingId | undefined {
  if (shape.rings.length === 0) return undefined;
  const idx = Math.min(shape.rings.length - 1, Math.floor(sel * shape.rings.length));
  return shape.rings[idx]?.id;
}

describe('alternation (seed=22001): stateful edit-command stream + metamorphic laws', () => {
  it('every command keeps the full invariant bundle and the absent-delete identity holds at each step', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .array(editCommandArb(), { minLength: 3, maxLength: shape.rings.length + 8 })
            .map((commands) => ({ shape, store, commands })),
        ),
        ({ shape, store, commands }) => {
          let state: EditState = { shape, store };
          assertFullBundle(state);
          for (const cmd of commands) {
            // METAMORPHIC (every step): deleting an absent ring is the identity.
            expect(deleteRingAndReorganize(state.shape, asRingId('absent-22001'))).toEqual(
              state.shape,
            );

            switch (cmd.tag) {
              case 'delete': {
                const targetId = pickAny(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const nextShape = deleteRingAndReorganize(state.shape, targetId);
                state = { shape: nextShape, store: state.store };
                assertFullBundle(state);
                break;
              }
              case 'translate': {
                const targetId = pickTopLevel(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const before = state.store;
                const movedStore = translateSubtree(state, targetId, cmd.dLon, cmd.dLat);
                state = { shape: state.shape, store: movedStore };
                assertFullBundle(state);
                // OP∘INVERSE = identity (modulo IEEE-754 rounding): translating the
                // same subtree back by the negated offset restores the prior store
                // coordinates. Float add-then-subtract is not bit-exact in general
                // (e.g. (-1.6 + 4) - 4 != -1.6), so the honest law is "equal within
                // a tight epsilon", asserted here — NOT exact equality, which would
                // be a false property of floating-point translation.
                const restored = translateSubtree(state, targetId, -cmd.dLon, -cmd.dLat);
                for (const v of before.byId.values()) {
                  const rv = restored.byId.get(v.id);
                  expect(rv).not.toBeUndefined();
                  expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 9);
                  expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 9);
                }
                break;
              }
              case 'saveLoad': {
                // SAVE∘LOAD = identity as an explicit command in the stream.
                const reloaded = saveLoadState(state);
                expect(reloaded.shape).toEqual(state.shape);
                state = reloaded;
                assertFullBundle(state);
                break;
              }
              case 'noop-delete-absent': {
                const next = deleteRingAndReorganize(state.shape, asRingId('absent-cmd'));
                expect(next).toEqual(state.shape);
                state = { shape: next, store: state.store };
                assertFullBundle(state);
                break;
              }
              default:
                break;
            }
          }
        },
      ),
      cfg4,
    );
  });

  it('op∘inverse: translate(+d) then translate(-d) on a subtree restores the store (within float epsilon)', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .record({
              sel: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
              dLon: fc.double({ min: -15, max: 15, noNaN: true, noDefaultInfinity: true }),
              dLat: fc.double({ min: -15, max: 15, noNaN: true, noDefaultInfinity: true }),
            })
            .map((op) => ({ shape, store, op })),
        ),
        ({ shape, store, op }) => {
          const state: EditState = { shape, store };
          const targetId = pickTopLevel(shape, op.sel);
          if (targetId === undefined) return;
          const moved = translateSubtree(state, targetId, op.dLon, op.dLat);
          // The whole state with the moved subtree must still be fully valid.
          assertFullBundle({ shape, store: moved });
          const back = translateSubtree({ shape, store: moved }, targetId, -op.dLon, -op.dLat);
          for (const v of store.byId.values()) {
            const rv = back.byId.get(v.id);
            // Equal within a tight epsilon (float add-then-subtract is not bit-exact).
            expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 9);
            expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 9);
          }
        },
      ),
      cfg4,
    );
  });

  it('undo∘delete: the pre-delete snapshot reproduces the original valid state verbatim', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          ringIdFromShapeArb(shape).map((targetId) => ({ shape, store, targetId })),
        ),
        ({ shape, store, targetId }) => {
          const before: EditState = { shape, store };
          const snapshot = saveLoadState(before);
          const afterShape = deleteRingAndReorganize(shape, targetId);
          const after: EditState = { shape: afterShape, store };
          assertFullBundle(after);
          // UNDO = restore snapshot: the snapshot reproduces the original state
          // exactly (what an undo of the delete must yield).
          expect(snapshot.shape).toEqual(shape);
          assertFullBundle(snapshot);
          // The delete only ever shrinks (or keeps) the forest.
          expect(after.shape.rings.length).toBeLessThanOrEqual(shape.rings.length);
        },
      ),
      cfg4,
    );
  });
});
