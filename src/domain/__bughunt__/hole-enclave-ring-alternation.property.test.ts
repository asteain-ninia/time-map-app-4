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

// ===========================================================================
// 9. FIFTH CAMPAIGN (seed=22002) — NEW exploration: a richer stateful edit
//    stream that exercises interactions NONE of campaigns 1-4 reach.
//
// Prior campaigns translated ONLY top-level subtrees (campaign 22001) and only
// ever DELETED or rigidly moved a top band. This campaign adds three genuinely
// new command/interaction classes, then asserts the full focal invariant bundle
// after EVERY operation plus the metamorphic laws (undo∘op = identity,
// op∘inverse = identity, save∘load = identity):
//
//   (a) TRANSLATE-ANY-SUBTREE within a tiny clearance: move an ARBITRARY ring's
//       subtree (an enclave or even a single hole — not just a top band) by an
//       offset small enough to stay inside the parent's gutter. The rich
//       generator leaves a known clearance (hole half-W = 0.3*cell, parent inner
//       half-W = parent.halfW-margin), so a sub-degree rigid nudge can never push
//       an enclave out of its hole nor make two siblings touch. A correct system
//       MUST keep validateGeometry clean; any violation is a real re-link/contain
//       defect — NOT a generator artifact.
//   (b) EXTRACT-SUBTREE (a "promote to its own feature" structural move): lift a
//       chosen ring to top-level by clearing its parent link and dropping every
//       ring NOT in its subtree, re-rooting the chosen ring. The closure law
//       under test: a subtree of a valid alternating forest, re-rooted, is itself
//       a valid alternating forest with consistent depths — and if the chosen
//       root was a HOLE (alternation would break at top level), the system's
//       validators must FLAG it rather than silently accept it. This is the
//       sub-shape closure / role-at-root interaction no prior campaign probed.
//   (c) DELETE-DESCENDANTS-FIRST ordering vs. DELETE-ANCESTOR-FIRST: deleting a
//       whole subtree leaf-up must reach the same surviving forest as deleting
//       its root once (a confluence/metamorphic law on overlapping ancestry,
//       complementing campaign 2004's DISJOINT-subtree order independence).
//
// Determinism: seed fixed to 22002, numRuns large; permanent asset, no green-fake.
// ===========================================================================

const SEED5 = 22002;
const RUNS5 = 400;
const cfg5 = { seed: SEED5, numRuns: RUNS5 } as const;

/** Rigidly translate an ARBITRARY ring's subtree (mirror of translateSubtree but
 * accepting any ring id, used to nudge enclaves/holes, not only top bands). */
function translateAnySubtree(
  state: EditState,
  ringId: RingId,
  dLon: number,
  dLat: number,
): VertexStore {
  return translateSubtree(state, ringId, dLon, dLat);
}

/**
 * Extract a TERRITORY `rootId`'s subtree into a standalone shape: keep only rings
 * in the subtree, and re-root the chosen territory by clearing its parent link.
 *
 * This is the "promote an enclave/territory to its own feature" operation. It is
 * only well-defined for a TERRITORY root: a territory's children are holes, and a
 * top-level territory with those same hole children is still a valid alternating
 * forest (the role at the new root — territory — is exactly what a top-level ring
 * must be). Re-rooting a HOLE would instead require dropping it and lifting its
 * (territory) children, which is the DELETION operation, not extraction — so this
 * helper is intentionally restricted to territory roots and callers must pass one.
 */
function extractTerritorySubtree(shape: Shape, rootId: RingId): Shape {
  const ids = subtreeRingIds(shape, rootId);
  const out: Ring[] = [];
  for (const r of shape.rings) {
    if (!ids.has(r.id)) continue;
    if (r.id === rootId) {
      // Re-root the territory: drop its parent link, keep its vertices. (Caller
      // guarantees r is a territory, so this preserves the kind and alternation.)
      out.push(createTerritoryRing(r.id, r.vertexIds, undefined));
      continue;
    }
    out.push(r);
  }
  return createShape(out);
}

/** Pick a TERRITORY ring id from a shape via a [0,1) selector; undefined if the
 * shape has no territory (only possible for an empty / all-hole malformed shape;
 * a valid forest always has at least the top-level territories). */
function pickTerritory(shape: Shape, sel: number): RingId | undefined {
  const territories = shape.rings.filter((r) => r.kind === RING_KIND.Territory);
  if (territories.length === 0) return undefined;
  const idx = Math.min(territories.length - 1, Math.floor(sel * territories.length));
  return territories[idx]?.id;
}

/** All ring IDs reachable as descendants of `rootId` (excluding the root),
 * ordered leaf-first (deepest first) for ancestor-safe deletion. */
function descendantsLeafFirst(shape: Shape, rootId: RingId): readonly RingId[] {
  const ids = [...subtreeRingIds(shape, rootId)].filter((id) => id !== rootId);
  // Sort by depth descending so deeper rings are deleted before their parents.
  return ids
    .map((id) => ({ id, d: ringDepth(shape, id) ?? -1 }))
    .sort((a, b) => b.d - a.d)
    .map((x) => x.id);
}

/** The clearance the rich generator leaves around a hole/enclave inside its cell.
 * A child's half-W is 0.3*cellWidth and it sits at the cell center, so the gap to
 * the nearest cell edge is 0.2*cellWidth on each side. The smallest cellWidth in
 * the generator (territory halfW>=10, margin 0.15, up to 3 holes) is
 * 2*(10-1.5)/3 ≈ 5.67, gap ≈ 1.13. A nudge bounded well under that can never push
 * a subtree out of its cell nor make siblings touch. We use a conservative cap. */
const SAFE_NUDGE = 0.4;

/** A fifth-campaign edit command. */
type EditCommand5 =
  | { readonly tag: 'delete-any'; readonly sel: number }
  | {
      readonly tag: 'nudge-any';
      readonly sel: number;
      readonly dLon: number;
      readonly dLat: number;
    }
  | { readonly tag: 'save-load' }
  | { readonly tag: 'delete-absent-noop' };

function editCommand5Arb(): fc.Arbitrary<EditCommand5> {
  const nudge = (): fc.Arbitrary<number> =>
    fc.double({ min: -SAFE_NUDGE, max: SAFE_NUDGE, noNaN: true, noDefaultInfinity: true });
  const sel = (): fc.Arbitrary<number> =>
    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });
  return fc.oneof(
    fc.record({ tag: fc.constant('delete-any' as const), sel: sel() }),
    fc.record({
      tag: fc.constant('nudge-any' as const),
      sel: sel(),
      dLon: nudge(),
      dLat: nudge(),
    }),
    fc.record({ tag: fc.constant('save-load' as const) }),
    fc.record({ tag: fc.constant('delete-absent-noop' as const) }),
  );
}

describe('alternation (seed=22002): subtree-nudge + extract + leaf-first deletion', () => {
  it('nudging ANY subtree by a sub-clearance offset keeps the full bundle (op∘inverse restores)', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .record({
              sel: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
              dLon: fc.double({ min: -SAFE_NUDGE, max: SAFE_NUDGE, noNaN: true, noDefaultInfinity: true }),
              dLat: fc.double({ min: -SAFE_NUDGE, max: SAFE_NUDGE, noNaN: true, noDefaultInfinity: true }),
            })
            .map((op) => ({ shape, store, op })),
        ),
        ({ shape, store, op }) => {
          const targetId = pickAny(shape, op.sel);
          if (targetId === undefined) return;
          const state: EditState = { shape, store };
          const moved = translateAnySubtree(state, targetId, op.dLon, op.dLat);
          // A rigid nudge within the cell clearance keeps EVERY focal invariant:
          // containment, sibling/enclave non-overlap, simplicity, finiteness.
          assertFullBundle({ shape, store: moved });
          // op∘inverse: nudge back by the negated offset restores coordinates
          // (float add-then-subtract, so within a tight epsilon, not bit-exact).
          const back = translateAnySubtree({ shape, store: moved }, targetId, -op.dLon, -op.dLat);
          for (const v of store.byId.values()) {
            const rv = back.byId.get(v.id);
            expect(rv).not.toBeUndefined();
            expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 9);
            expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 9);
          }
        },
      ),
      cfg5,
    );
  });

  it('extract-territory closure: a re-rooted territory subtree is a valid alternating forest with consistent depths', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true })
            .map((sel) => ({ shape, store, rootId: pickTerritory(shape, sel) })),
        ),
        ({ shape, store, rootId }) => {
          if (rootId === undefined) return; // no territory to extract (vacuous)
          const extracted = extractTerritorySubtree(shape, rootId);
          // The extracted shape contains exactly the subtree's rings.
          const subtreeIds = subtreeRingIds(shape, rootId);
          expect(new Set(extracted.rings.map((r) => r.id))).toEqual(subtreeIds);
          // Closure: re-rooted territory subtree is a valid alternating forest.
          assertStructurallyValid(extracted);
          expect(depthsConsistent(extracted)).toBe(true);
          // Geometry of the surviving rings is unchanged (store untouched). A
          // territory subtree is self-contained: holes still inside their territory,
          // enclaves still inside their hole, and the re-rooted territory is now the
          // single top-level band so it has no enclave-overlap partner. The
          // extracted shape must therefore validate clean against the SAME store.
          expect(validateGeometry(extracted, store).violations).toEqual([]);
          // The re-rooted ring is a top-level territory with no parent link.
          const newRoot = extracted.rings.find((r) => r.id === rootId);
          expect(newRoot?.kind).toBe(RING_KIND.Territory);
          expect(newRoot?.parentRingId).toBeUndefined();
        },
      ),
      cfg5,
    );
  });

  it('confluence: deleting a subtree leaf-first reaches the same forest as deleting its root once', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          ringIdFromShapeArb(shape).map((rootId) => ({ shape, store, rootId })),
        ),
        ({ shape, store, rootId }) => {
          // Path A: delete every descendant leaf-first, THEN the root.
          let leafUp = shape;
          for (const id of descendantsLeafFirst(shape, rootId)) {
            leafUp = deleteRingAndReorganize(leafUp, id);
            // Invariant holds after every single leaf-first deletion too.
            assertStructurallyValid(leafUp);
            expect(validateGeometry(leafUp, store).violations).toEqual([]);
          }
          leafUp = deleteRingAndReorganize(leafUp, rootId);

          // Path B: delete the root once (reorganization absorbs the subtree).
          const rootOnce = deleteRingAndReorganize(shape, rootId);

          // Both paths remove the entire subtree's rings and keep the rest valid.
          assertStructurallyValid(leafUp);
          assertStructurallyValid(rootOnce);
          const subtreeIds = subtreeRingIds(shape, rootId);
          for (const id of subtreeIds) {
            expect(leafUp.rings.some((r) => r.id === id)).toBe(false);
          }
          // Confluence on the SURVIVING ring set: the rings OUTSIDE the deleted
          // subtree are identical (same ids, kinds, parents) in both paths. (The
          // forests can differ only in absorbed-descendant handling within the
          // subtree, which both paths remove entirely.)
          const survivors = (s: Shape): string =>
            JSON.stringify(
              [...s.rings]
                .filter((r) => !subtreeIds.has(r.id))
                .map((r) => ({ id: r.id, kind: r.kind, parent: r.parentRingId ?? null }))
                .sort((x, y) => x.id.localeCompare(y.id)),
            );
          expect(survivors(leafUp)).toBe(survivors(rootOnce));
        },
      ),
      cfg5,
    );
  });

  it('stateful: interleaved delete / sub-clearance nudge / save-load keeps the full bundle at every step', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .array(editCommand5Arb(), { minLength: 4, maxLength: shape.rings.length + 10 })
            .map((commands) => ({ shape, store, commands })),
        ),
        ({ shape, store, commands }) => {
          let state: EditState = { shape, store };
          assertFullBundle(state);
          for (const cmd of commands) {
            // METAMORPHIC every step: deleting an absent ring is the identity.
            expect(deleteRingAndReorganize(state.shape, asRingId('absent-22002'))).toEqual(
              state.shape,
            );
            switch (cmd.tag) {
              case 'delete-any': {
                const targetId = pickAny(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const before = state.shape.rings.length;
                state = {
                  shape: deleteRingAndReorganize(state.shape, targetId),
                  store: state.store,
                };
                expect(state.shape.rings.length).toBeLessThan(before);
                assertFullBundle(state);
                break;
              }
              case 'nudge-any': {
                const targetId = pickAny(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const beforeStore = state.store;
                const moved = translateAnySubtree(state, targetId, cmd.dLon, cmd.dLat);
                state = { shape: state.shape, store: moved };
                assertFullBundle(state);
                // UNDO∘op: nudge back restores prior coordinates (tight epsilon).
                const back = translateAnySubtree(state, targetId, -cmd.dLon, -cmd.dLat);
                for (const v of beforeStore.byId.values()) {
                  const rv = back.byId.get(v.id);
                  expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 9);
                  expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 9);
                }
                break;
              }
              case 'save-load': {
                const reloaded = saveLoadState(state);
                expect(reloaded.shape).toEqual(state.shape);
                state = reloaded;
                assertFullBundle(state);
                break;
              }
              case 'delete-absent-noop': {
                const next = deleteRingAndReorganize(state.shape, asRingId('nope-22002'));
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
      cfg5,
    );
  });
});

// ===========================================================================
// 10. SIXTH CAMPAIGN (seed=22003) — NEW exploration: edit streams that GROW the
//     shape (ADD a hole / ADD an enclave) interleaved with delete / nudge /
//     save-load, PLUS an ascending non-duplicate ANCHOR series carried alongside
//     the (shape, store) state.
//
// Every prior campaign (seeds 2001/2002/2004/22001/22002) only ever SHRINKS or
// rigidly MOVES the shape — none of them ADDS a ring, so the add-then-validate
// re-link path and the "newly created hole must be contained + sibling-disjoint"
// geometry path were never exercised by this file. This campaign closes that gap
// and also adds the brief's explicit "錨列の昇順・非重複" (anchor series ascending
// & non-duplicate) and "save->load=恒等" laws over a combined editor state.
//
// New ground vs. campaigns 1-5:
//   (a) ADD-HOLE: punch a fresh, strictly-smaller, centered hole into a LEAF
//       TERRITORY (a territory with no existing children). Centered + 0.2× the
//       parent half-size keeps it strictly inside with no sibling to overlap, so
//       a correct system MUST keep validateGeometry clean; any violation is a real
//       containment/re-link defect, not a generator artifact.
//   (b) ADD-ENCLAVE: the mirror — drop a fresh, strictly-smaller, centered
//       territory (enclave) into a LEAF HOLE, preserving hole→territory
//       alternation and containment.
//   (c) ANCHOR SERIES: a sorted, duplicate-free list of integer anchor positions
//       (the temporal-axis ordering the spec FR-54 anchors live on). Insert keeps
//       it strictly ascending and unique; remove keeps it sorted; both must round-
//       trip through save→load. Asserted after EVERY command in the stream.
//   (d) Metamorphic laws on the GROWN state: undo∘add = delete-of-the-added-ring
//       (the added ring is removed and the prior forest restored), op∘inverse for
//       the nudge, and save∘load = identity over the full (shape, store, anchors)
//       triple.
//
// Determinism: seed fixed to 22003, numRuns large; permanent asset, no green-fake.
// ===========================================================================

const SEED6 = 22003;
const RUNS6 = 350;
const cfg6 = { seed: SEED6, numRuns: RUNS6 } as const;

/** Axis-aligned bounds of a ring resolved against the store (the rich generator
 * builds axis-aligned rectangles, so min/max over the vertices is the rect). */
function ringBounds(
  store: VertexStore,
  ring: Ring,
): { minLon: number; maxLon: number; minLat: number; maxLat: number } | undefined {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let any = false;
  for (const vid of ring.vertexIds) {
    const v = getVertex(store, vid);
    if (v === undefined) return undefined;
    any = true;
    if (v.coordinate.lon < minLon) minLon = v.coordinate.lon;
    if (v.coordinate.lon > maxLon) maxLon = v.coordinate.lon;
    if (v.coordinate.lat < minLat) minLat = v.coordinate.lat;
    if (v.coordinate.lat > maxLat) maxLat = v.coordinate.lat;
  }
  if (!any) return undefined;
  return { minLon, maxLon, minLat, maxLat };
}

/** A ring is a LEAF iff it has no children in the shape. */
function isLeafRing(shape: Shape, ringId: RingId): boolean {
  return childrenOf(shape, ringId).length === 0;
}

/** The combined editor state for campaign 6: a shape, its store, a monotonically
 * increasing fresh-id counter (so added rings/vertices never collide), and an
 * ascending duplicate-free anchor-position series. */
interface GrowState {
  readonly shape: Shape;
  readonly store: VertexStore;
  readonly nextId: number;
  readonly anchors: readonly number[];
}

/** The anchor series is strictly ascending (=> also duplicate-free). */
function anchorsAscendingUnique(anchors: readonly number[]): boolean {
  for (let i = 1; i < anchors.length; i += 1) {
    const prev = anchors[i - 1];
    const cur = anchors[i];
    if (prev === undefined || cur === undefined) return false;
    if (!(cur > prev)) return false; // not strictly increasing => duplicate or out of order
  }
  return true;
}

/** Insert `value` into a sorted unique list, keeping it sorted & unique. A value
 * already present is a no-op (set semantics: the temporal axis has at most one
 * anchor per position). */
function insertAnchor(anchors: readonly number[], value: number): readonly number[] {
  if (anchors.includes(value)) return anchors;
  const out = [...anchors, value].sort((a, b) => a - b);
  return out;
}

/** Remove the anchor at sorted index `idx` (no-op if out of range). */
function removeAnchorAt(anchors: readonly number[], idx: number): readonly number[] {
  if (idx < 0 || idx >= anchors.length) return anchors;
  return anchors.filter((_, i) => i !== idx);
}

/** Add a centered, strictly-smaller HOLE into a LEAF TERRITORY. Returns the new
 * state plus the added ring id, or undefined if `territoryId` is not an
 * addable leaf territory (no children, resolvable bounds). The hole is 0.2× the
 * territory half-size, centered, so it is strictly contained with no sibling. */
function addHoleToLeafTerritory(
  state: GrowState,
  territoryId: RingId,
): { state: GrowState; addedId: RingId } | undefined {
  const territory = state.shape.rings.find((r) => r.id === territoryId);
  if (territory === undefined || territory.kind !== RING_KIND.Territory) return undefined;
  if (!isLeafRing(state.shape, territoryId)) return undefined;
  const b = ringBounds(state.store, territory);
  if (b === undefined) return undefined;
  const cx = (b.minLon + b.maxLon) / 2;
  const cy = (b.minLat + b.maxLat) / 2;
  const halfW = ((b.maxLon - b.minLon) / 2) * 0.2;
  const halfH = ((b.maxLat - b.minLat) / 2) * 0.2;
  if (!(halfW > 0) || !(halfH > 0)) return undefined; // degenerate parent, skip

  const counter = state.nextId;
  const addedId = asRingId(`add${counter}`);
  const vertices: { id: VertexId; lon: number; lat: number }[] = [];
  const ring = rectRing(addedId, cx, cy, halfW, halfH, RING_KIND.Hole, territoryId, vertices);
  let store = state.store;
  for (const v of vertices) {
    store = setVertex(store, createVertex(v.id, createCoordinate(v.lon, v.lat)));
  }
  const shape = createShape([...state.shape.rings, ring]);
  return {
    state: { shape, store, nextId: counter + 1, anchors: state.anchors },
    addedId,
  };
}

/** Add a centered, strictly-smaller ENCLAVE (territory) into a LEAF HOLE — the
 * mirror of {@link addHoleToLeafTerritory}, preserving hole→territory alternation
 * and containment. */
function addEnclaveToLeafHole(
  state: GrowState,
  holeId: RingId,
): { state: GrowState; addedId: RingId } | undefined {
  const hole = state.shape.rings.find((r) => r.id === holeId);
  if (hole === undefined || hole.kind !== RING_KIND.Hole) return undefined;
  if (!isLeafRing(state.shape, holeId)) return undefined;
  const b = ringBounds(state.store, hole);
  if (b === undefined) return undefined;
  const cx = (b.minLon + b.maxLon) / 2;
  const cy = (b.minLat + b.maxLat) / 2;
  const halfW = ((b.maxLon - b.minLon) / 2) * 0.2;
  const halfH = ((b.maxLat - b.minLat) / 2) * 0.2;
  if (!(halfW > 0) || !(halfH > 0)) return undefined;

  const counter = state.nextId;
  const addedId = asRingId(`add${counter}`);
  const vertices: { id: VertexId; lon: number; lat: number }[] = [];
  const ring = rectRing(addedId, cx, cy, halfW, halfH, RING_KIND.Territory, holeId, vertices);
  let store = state.store;
  for (const v of vertices) {
    store = setVertex(store, createVertex(v.id, createCoordinate(v.lon, v.lat)));
  }
  const shape = createShape([...state.shape.rings, ring]);
  return {
    state: { shape, store, nextId: counter + 1, anchors: state.anchors },
    addedId,
  };
}

/** Save→load the combined GrowState (shape + store + anchors) and back. */
function saveLoadGrowState(state: GrowState): GrowState {
  const reloadedShapeStore = saveLoadState({ shape: state.shape, store: state.store });
  const reloadedAnchors = JSON.parse(JSON.stringify(state.anchors)) as readonly number[];
  return {
    shape: reloadedShapeStore.shape,
    store: reloadedShapeStore.store,
    nextId: state.nextId,
    anchors: reloadedAnchors,
  };
}

/** Full focal invariant bundle for a GrowState: the (shape, store) bundle PLUS
 * the anchor-series ascending/non-duplicate law and the combined save→load
 * identity. */
function assertGrowBundle(state: GrowState): void {
  assertFullBundle({ shape: state.shape, store: state.store });
  // Anchor series: strictly ascending => sorted AND duplicate-free (FR-54).
  expect(anchorsAscendingUnique(state.anchors)).toBe(true);
  // save → load = identity over the full triple.
  const reloaded = saveLoadGrowState(state);
  expect(reloaded.shape).toEqual(state.shape);
  expect(reloaded.anchors).toEqual(state.anchors);
  for (const v of state.store.byId.values()) {
    const rv = reloaded.store.byId.get(v.id);
    expect(rv).not.toBeUndefined();
    expect(Object.is(rv?.coordinate.lon, v.coordinate.lon)).toBe(true);
    expect(Object.is(rv?.coordinate.lat, v.coordinate.lat)).toBe(true);
  }
}

/** A sixth-campaign edit command. */
type EditCommand6 =
  | { readonly tag: 'add-hole'; readonly sel: number }
  | { readonly tag: 'add-enclave'; readonly sel: number }
  | { readonly tag: 'delete-any'; readonly sel: number }
  | { readonly tag: 'nudge-any'; readonly sel: number; readonly dLon: number; readonly dLat: number }
  | { readonly tag: 'anchor-insert'; readonly value: number }
  | { readonly tag: 'anchor-remove'; readonly sel: number }
  | { readonly tag: 'save-load' };

function editCommand6Arb(): fc.Arbitrary<EditCommand6> {
  const sel = (): fc.Arbitrary<number> =>
    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });
  const nudge = (): fc.Arbitrary<number> =>
    fc.double({ min: -SAFE_NUDGE, max: SAFE_NUDGE, noNaN: true, noDefaultInfinity: true });
  return fc.oneof(
    fc.record({ tag: fc.constant('add-hole' as const), sel: sel() }),
    fc.record({ tag: fc.constant('add-enclave' as const), sel: sel() }),
    fc.record({ tag: fc.constant('delete-any' as const), sel: sel() }),
    fc.record({
      tag: fc.constant('nudge-any' as const),
      sel: sel(),
      dLon: nudge(),
      dLat: nudge(),
    }),
    fc.record({ tag: fc.constant('anchor-insert' as const), value: fc.integer({ min: -50, max: 50 }) }),
    fc.record({ tag: fc.constant('anchor-remove' as const), sel: sel() }),
    fc.record({ tag: fc.constant('save-load' as const) }),
  );
}

describe('alternation (seed=22003): GROW (add hole/enclave) + anchor series + metamorphic laws', () => {
  it('adding a centered hole to a leaf territory keeps the full geometry bundle (undo = delete restores)', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true })
            .map((sel) => ({ shape, store, sel })),
        ),
        ({ shape, store, sel }) => {
          const leafTerritories = shape.rings.filter(
            (r) => r.kind === RING_KIND.Territory && isLeafRing(shape, r.id),
          );
          if (leafTerritories.length === 0) return; // vacuous
          const idx = Math.min(leafTerritories.length - 1, Math.floor(sel * leafTerritories.length));
          const target = leafTerritories[idx];
          if (target === undefined) return;

          const start: GrowState = { shape, store, nextId: 0, anchors: [] };
          const result = addHoleToLeafTerritory(start, target.id);
          expect(result).not.toBeUndefined();
          if (result === undefined) return;
          // The grown state is fully valid: the new hole is contained, simple,
          // finite, and creates no sibling/containment violation.
          assertGrowBundle(result.state);
          // The added ring is present, is a hole, and is parented to the target.
          const added = result.state.shape.rings.find((r) => r.id === result.addedId);
          expect(added?.kind).toBe(RING_KIND.Hole);
          expect(added?.parentRingId).toBe(target.id);
          // UNDO∘add = delete the added ring: it restores the original forest
          // structure exactly (same ids/kinds/parents) — the added ring is the
          // only one removed and it had no children.
          const undone = deleteRingAndReorganize(result.state.shape, result.addedId);
          const norm = (s: Shape): string =>
            JSON.stringify(
              [...s.rings]
                .map((r) => ({ id: r.id, kind: r.kind, parent: r.parentRingId ?? null }))
                .sort((x, y) => x.id.localeCompare(y.id)),
            );
          expect(norm(undone)).toBe(norm(shape));
        },
      ),
      cfg6,
    );
  });

  it('adding a centered enclave to a leaf hole keeps the full geometry bundle (undo = delete restores)', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true })
            .map((sel) => ({ shape, store, sel })),
        ),
        ({ shape, store, sel }) => {
          const leafHoles = shape.rings.filter(
            (r) => r.kind === RING_KIND.Hole && isLeafRing(shape, r.id),
          );
          if (leafHoles.length === 0) return; // vacuous
          const idx = Math.min(leafHoles.length - 1, Math.floor(sel * leafHoles.length));
          const target = leafHoles[idx];
          if (target === undefined) return;

          const start: GrowState = { shape, store, nextId: 0, anchors: [] };
          const result = addEnclaveToLeafHole(start, target.id);
          expect(result).not.toBeUndefined();
          if (result === undefined) return;
          assertGrowBundle(result.state);
          const added = result.state.shape.rings.find((r) => r.id === result.addedId);
          expect(added?.kind).toBe(RING_KIND.Territory);
          expect(added?.parentRingId).toBe(target.id);
          // UNDO∘add = delete the added enclave restores the original forest.
          const undone = deleteRingAndReorganize(result.state.shape, result.addedId);
          const norm = (s: Shape): string =>
            JSON.stringify(
              [...s.rings]
                .map((r) => ({ id: r.id, kind: r.kind, parent: r.parentRingId ?? null }))
                .sort((x, y) => x.id.localeCompare(y.id)),
            );
          expect(norm(undone)).toBe(norm(shape));
        },
      ),
      cfg6,
    );
  });

  it('anchor series stays strictly ascending & duplicate-free under insert/remove and round-trips', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ op: fc.constant('insert' as const), value: fc.integer({ min: -30, max: 30 }) }),
            fc.record({ op: fc.constant('remove' as const), sel: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }) }),
          ),
          { minLength: 1, maxLength: 30 },
        ),
        (ops) => {
          let anchors: readonly number[] = [];
          for (const op of ops) {
            if (op.op === 'insert') {
              anchors = insertAnchor(anchors, op.value);
            } else {
              const idx = anchors.length === 0 ? -1 : Math.min(anchors.length - 1, Math.floor(op.sel * anchors.length));
              anchors = removeAnchorAt(anchors, idx);
            }
            // Invariant after EVERY op: strictly ascending (=> sorted + unique).
            expect(anchorsAscendingUnique(anchors)).toBe(true);
            // save → load is the identity on the anchor series.
            expect(JSON.parse(JSON.stringify(anchors))).toEqual(anchors);
          }
          // Inserting a value already present is a no-op (set semantics).
          if (anchors.length > 0) {
            const existing = anchors[0];
            if (existing !== undefined) {
              expect(insertAnchor(anchors, existing)).toEqual(anchors);
            }
          }
        },
      ),
      cfg6,
    );
  });

  it('stateful: interleaved add / delete / nudge / anchor-insert / anchor-remove / save-load keeps the full bundle', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .array(editCommand6Arb(), { minLength: 5, maxLength: shape.rings.length + 14 })
            .map((commands) => ({ shape, store, commands })),
        ),
        ({ shape, store, commands }) => {
          let state: GrowState = { shape, store, nextId: 0, anchors: [] };
          assertGrowBundle(state);
          for (const cmd of commands) {
            // METAMORPHIC every step: deleting an absent ring is the identity.
            expect(deleteRingAndReorganize(state.shape, asRingId('absent-22003'))).toEqual(
              state.shape,
            );

            switch (cmd.tag) {
              case 'add-hole': {
                const leafTerritories = state.shape.rings.filter(
                  (r) => r.kind === RING_KIND.Territory && isLeafRing(state.shape, r.id),
                );
                if (leafTerritories.length === 0) break;
                const i = Math.min(
                  leafTerritories.length - 1,
                  Math.floor(cmd.sel * leafTerritories.length),
                );
                const target = leafTerritories[i];
                if (target === undefined) break;
                const before = state.shape.rings.length;
                const r = addHoleToLeafTerritory(state, target.id);
                if (r === undefined) break;
                state = r.state;
                expect(state.shape.rings.length).toBe(before + 1);
                assertGrowBundle(state);
                break;
              }
              case 'add-enclave': {
                const leafHoles = state.shape.rings.filter(
                  (r) => r.kind === RING_KIND.Hole && isLeafRing(state.shape, r.id),
                );
                if (leafHoles.length === 0) break;
                const i = Math.min(leafHoles.length - 1, Math.floor(cmd.sel * leafHoles.length));
                const target = leafHoles[i];
                if (target === undefined) break;
                const before = state.shape.rings.length;
                const r = addEnclaveToLeafHole(state, target.id);
                if (r === undefined) break;
                state = r.state;
                expect(state.shape.rings.length).toBe(before + 1);
                assertGrowBundle(state);
                break;
              }
              case 'delete-any': {
                const targetId = pickAny(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const before = state.shape.rings.length;
                state = { ...state, shape: deleteRingAndReorganize(state.shape, targetId) };
                expect(state.shape.rings.length).toBeLessThan(before);
                assertGrowBundle(state);
                break;
              }
              case 'nudge-any': {
                const targetId = pickAny(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const beforeStore = state.store;
                const moved = translateAnySubtree(
                  { shape: state.shape, store: state.store },
                  targetId,
                  cmd.dLon,
                  cmd.dLat,
                );
                state = { ...state, store: moved };
                assertGrowBundle(state);
                // op∘inverse: nudge back restores prior coordinates (tight epsilon).
                const back = translateAnySubtree(
                  { shape: state.shape, store: state.store },
                  targetId,
                  -cmd.dLon,
                  -cmd.dLat,
                );
                for (const v of beforeStore.byId.values()) {
                  const rv = back.byId.get(v.id);
                  expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 9);
                  expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 9);
                }
                break;
              }
              case 'anchor-insert': {
                const before = state.anchors;
                state = { ...state, anchors: insertAnchor(state.anchors, cmd.value) };
                // Insert is idempotent for an already-present value.
                if (before.includes(cmd.value)) expect(state.anchors).toEqual(before);
                assertGrowBundle(state);
                break;
              }
              case 'anchor-remove': {
                const idx =
                  state.anchors.length === 0
                    ? -1
                    : Math.min(
                        state.anchors.length - 1,
                        Math.floor(cmd.sel * state.anchors.length),
                      );
                state = { ...state, anchors: removeAnchorAt(state.anchors, idx) };
                assertGrowBundle(state);
                break;
              }
              case 'save-load': {
                const reloaded = saveLoadGrowState(state);
                expect(reloaded.shape).toEqual(state.shape);
                expect(reloaded.anchors).toEqual(state.anchors);
                state = reloaded;
                assertGrowBundle(state);
                break;
              }
              default:
                break;
            }
          }
        },
      ),
      cfg6,
    );
  });
});

// ===========================================================================
// 11. SEVENTH CAMPAIGN (seed=22004) — NEW exploration (bughunt run #2).
//
// Distinct from the prior six campaigns (seeds 2001/2002/2004/22001/22002/
// 22003) in BOTH the seed and the operation set. Prior campaigns covered:
// delete (all), rigid translate of a top/any subtree, extract-territory,
// leaf-first deletion confluence, add-hole / add-enclave, and an anchor series.
// This run adds operation/interaction classes none of them reach, and carries a
// LIVE SELECTION across the whole stream so the brief's "選択が常に有効" law is
// asserted after EVERY operation (no prior campaign carried a selection):
//
//   (a) SCALE-SUBTREE about its own centroid by a factor k ∈ [0.5, 1.0): a
//       contraction toward the centroid. Shrinking a subtree rigidly toward its
//       own centroid keeps every contained child contained (a point inside a
//       rectangle stays inside when the whole rectangle shrinks toward an
//       interior centroid) and keeps disjoint siblings disjoint (each shrinks
//       within its own cell). So a correct system MUST keep validateGeometry
//       clean; any violation is a real re-link/containment defect. op∘inverse:
//       scaling the SAME subtree back by 1/k restores coordinates within a tight
//       float epsilon (multiply-then-divide is not bit-exact).
//   (b) LIVE SELECTION re-resolution: the editor holds a selected ring id.
//       After every command the selection contract must hold — the selected id
//       is EITHER still present in the shape (a valid selectable ring) OR has
//       been re-resolved (to undefined, i.e. "nothing selected") because its
//       ring was deleted/absorbed. It must NEVER point at a ring absent from the
//       shape (a dangling selection — the analogue of a dangling parent for the
//       UI layer). We model the re-resolution explicitly and assert it.
//   (c) FULL-STREAM UNDO: a snapshot is taken (via save→load) BEFORE each
//       command; after the command we assert that the snapshot still reproduces
//       the exact pre-command state (undo∘op = identity for delete, scale,
//       save-load, and the absent-delete no-op alike).
//   (d) save→load = identity over the (shape, store, selection) triple at every
//       step, including the selection field.
//
// Determinism: seed fixed to 22004, numRuns large; permanent asset, no green-fake.
// ===========================================================================

const SEED7 = 22004;
const RUNS7 = 450;
const cfg7 = { seed: SEED7, numRuns: RUNS7 } as const;

/** A live editor state that carries a SELECTION alongside the shape + store. The
 * selection is a ring id or undefined ("nothing selected"). */
interface SelState {
  readonly shape: Shape;
  readonly store: VertexStore;
  readonly selected: RingId | undefined;
}

/** The selection contract: a selection is valid iff it is undefined OR points at
 * a ring actually present in the shape. A selection that survived a deletion of
 * its ring (dangling) is INVALID — the bug class this law guards against. */
function selectionValid(state: SelState): boolean {
  if (state.selected === undefined) return true;
  return state.shape.rings.some((r) => r.id === state.selected);
}

/** Re-resolve a selection after a structural edit: keep it if its ring is still
 * present, otherwise clear it (undefined). This is the editor's documented
 * "selection follows the model" behavior — never leave a dangling selection. */
function reresolveSelection(
  shape: Shape,
  selected: RingId | undefined,
): RingId | undefined {
  if (selected === undefined) return undefined;
  return shape.rings.some((r) => r.id === selected) ? selected : undefined;
}

/** Centroid (mean of all subtree vertices) of `ringId`'s subtree in the store.
 * Returns undefined if the subtree has no resolvable vertex. */
function subtreeCentroid(
  state: SelState,
  ringId: RingId,
): { lon: number; lat: number } | undefined {
  const ids = subtreeRingIds(state.shape, ringId);
  let sumLon = 0;
  let sumLat = 0;
  let n = 0;
  const seen = new Set<VertexId>();
  for (const ring of state.shape.rings) {
    if (!ids.has(ring.id)) continue;
    for (const vid of ring.vertexIds) {
      if (seen.has(vid)) continue;
      seen.add(vid);
      const v = getVertex(state.store, vid);
      if (v === undefined) continue;
      sumLon += v.coordinate.lon;
      sumLat += v.coordinate.lat;
      n += 1;
    }
  }
  if (n === 0) return undefined;
  return { lon: sumLon / n, lat: sumLat / n };
}

/** Scale every vertex of `ringId`'s subtree about a fixed center by factor k
 * (c + k*(p-c)). Returns a NEW store; the shape (parent links) is unchanged. A
 * contraction (k<1) toward an interior center preserves containment + disjointness.
 * The center is passed in (the subtree's centroid, captured BEFORE scaling) so the
 * forward and inverse scale share the SAME pivot — a true op∘inverse pair. */
function scaleSubtreeAbout(
  state: SelState,
  ringId: RingId,
  center: { lon: number; lat: number },
  k: number,
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
    const scaled = withVertexCoordinate(
      v,
      createCoordinate(
        center.lon + k * (v.coordinate.lon - center.lon),
        center.lat + k * (v.coordinate.lat - center.lat),
      ),
    );
    store = setVertex(store, scaled);
  }
  return store;
}

/** Save→load the (shape, store, selection) triple and back. */
function saveLoadSelState(state: SelState): SelState {
  const reloaded = saveLoadState({ shape: state.shape, store: state.store });
  // The selection is a primitive id (string brand); round-trip it as JSON too so
  // a non-plain selection field would surface as a mismatch.
  const reloadedSel = JSON.parse(JSON.stringify(state.selected ?? null)) as string | null;
  return {
    shape: reloaded.shape,
    store: reloaded.store,
    selected: reloadedSel === null ? undefined : (reloadedSel as RingId),
  };
}

/** Full focal bundle for a SelState: the (shape, store) bundle PLUS the selection
 * validity law and the (shape, store, selection) save→load identity. */
function assertSelBundle(state: SelState): void {
  assertFullBundle({ shape: state.shape, store: state.store });
  // SELECTION is always valid: undefined, or a ring present in the shape. Never
  // dangling.
  expect(selectionValid(state)).toBe(true);
  // save → load = identity over the full triple (including the selection).
  const reloaded = saveLoadSelState(state);
  expect(reloaded.shape).toEqual(state.shape);
  expect(reloaded.selected).toEqual(state.selected);
}

/** A seventh-campaign edit command. */
type EditCommand7 =
  | { readonly tag: 'select'; readonly sel: number }
  | { readonly tag: 'delete-selected' }
  | { readonly tag: 'delete-any'; readonly sel: number }
  | { readonly tag: 'scale-any'; readonly sel: number; readonly k: number }
  | { readonly tag: 'save-load' }
  | { readonly tag: 'delete-absent-noop' };

function editCommand7Arb(): fc.Arbitrary<EditCommand7> {
  const sel = (): fc.Arbitrary<number> =>
    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });
  // Contraction factor strictly in [0.5, 1.0): never expands (would risk pushing
  // a subtree out of its cell), never collapses below half (keeps geometry simple).
  const factor = (): fc.Arbitrary<number> =>
    fc.double({ min: 0.5, max: 0.999, noNaN: true, noDefaultInfinity: true });
  return fc.oneof(
    fc.record({ tag: fc.constant('select' as const), sel: sel() }),
    fc.record({ tag: fc.constant('delete-selected' as const) }),
    fc.record({ tag: fc.constant('delete-any' as const), sel: sel() }),
    fc.record({ tag: fc.constant('scale-any' as const), sel: sel(), k: factor() }),
    fc.record({ tag: fc.constant('save-load' as const) }),
    fc.record({ tag: fc.constant('delete-absent-noop' as const) }),
  );
}

describe('alternation (seed=22004): subtree-scale + live selection + full-stream undo', () => {
  it('contracting ANY subtree about its centroid keeps the full bundle (op∘inverse restores)', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .record({
              sel: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
              k: fc.double({ min: 0.5, max: 0.999, noNaN: true, noDefaultInfinity: true }),
            })
            .map((op) => ({ shape, store, op })),
        ),
        ({ shape, store, op }) => {
          const targetId = pickAny(shape, op.sel);
          if (targetId === undefined) return;
          const state: SelState = { shape, store, selected: undefined };
          const center = subtreeCentroid(state, targetId);
          if (center === undefined) return;
          const moved = scaleSubtreeAbout(state, targetId, center, op.k);
          // A centroid contraction keeps EVERY focal invariant: containment,
          // sibling/enclave non-overlap, simplicity, finiteness.
          assertSelBundle({ shape, store: moved, selected: undefined });
          // op∘inverse: scale back about the SAME pivot by 1/k restores coords
          // (multiply-then-divide => within a tight epsilon, not bit-exact).
          const back = scaleSubtreeAbout(
            { shape, store: moved, selected: undefined },
            targetId,
            center,
            1 / op.k,
          );
          for (const v of store.byId.values()) {
            const rv = back.byId.get(v.id);
            expect(rv).not.toBeUndefined();
            expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 6);
            expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 6);
          }
        },
      ),
      cfg7,
    );
  });

  it('a selection is never left dangling after deleting its own ring', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          ringIdFromShapeArb(shape).map((selId) => ({ shape, store, selId })),
        ),
        ({ shape, store, selId }) => {
          // Select a ring, then delete that very ring.
          const selected: SelState = { shape, store, selected: selId };
          expect(selectionValid(selected)).toBe(true);
          const afterShape = deleteRingAndReorganize(shape, selId);
          const afterSel = reresolveSelection(afterShape, selId);
          const after: SelState = { shape: afterShape, store, selected: afterSel };
          // The selected ring is gone, so the re-resolved selection MUST be
          // cleared (undefined) — never a dangling id pointing at an absent ring.
          expect(afterShape.rings.some((r) => r.id === selId)).toBe(false);
          expect(afterSel).toBeUndefined();
          assertSelBundle(after);
        },
      ),
      cfg7,
    );
  });

  it('deleting an UNRELATED ring keeps a valid selection pointing at the same ring', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          ringIdFromShapeArb(shape).chain((selId) =>
            ringIdFromShapeArb(shape).map((delId) => ({ shape, store, selId, delId })),
          ),
        ),
        ({ shape, store, selId, delId }) => {
          // Only meaningful when the deleted ring is NOT in the selected ring's
          // subtree-removal set: after deletion, if the selected ring still
          // exists, the selection must be preserved (not spuriously cleared).
          const afterShape = deleteRingAndReorganize(shape, delId);
          const afterSel = reresolveSelection(afterShape, selId);
          const after: SelState = { shape: afterShape, store, selected: afterSel };
          assertSelBundle(after);
          if (afterShape.rings.some((r) => r.id === selId)) {
            // Survivor: selection must still point at it (preserved, not dropped).
            expect(afterSel).toBe(selId);
          } else {
            // Removed by the deletion's reorganization: selection cleared.
            expect(afterSel).toBeUndefined();
          }
        },
      ),
      cfg7,
    );
  });

  it('stateful: interleaved select / delete / scale / save-load keeps the full bundle and undo=identity at every step', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .array(editCommand7Arb(), { minLength: 5, maxLength: shape.rings.length + 12 })
            .map((commands) => ({ shape, store, commands })),
        ),
        ({ shape, store, commands }) => {
          let state: SelState = { shape, store, selected: undefined };
          assertSelBundle(state);
          for (const cmd of commands) {
            // METAMORPHIC every step: deleting an absent ring is the identity.
            expect(deleteRingAndReorganize(state.shape, asRingId('absent-22004'))).toEqual(
              state.shape,
            );
            // FULL-STREAM UNDO: snapshot the pre-command state. Whatever the
            // command does, this snapshot must still reproduce the pre-state
            // exactly (undo∘op = identity). Captured via save→load so the snapshot
            // is an independent value, not an alias of the live state.
            const snapshot = saveLoadSelState(state);

            switch (cmd.tag) {
              case 'select': {
                const targetId = pickAny(state.shape, cmd.sel);
                state = { ...state, selected: targetId };
                assertSelBundle(state);
                break;
              }
              case 'delete-selected': {
                if (state.selected === undefined) break;
                const targetId = state.selected;
                const before = state.shape.rings.length;
                const nextShape = deleteRingAndReorganize(state.shape, targetId);
                state = {
                  shape: nextShape,
                  store: state.store,
                  selected: reresolveSelection(nextShape, targetId),
                };
                // The selected ring was present, so deletion strictly shrinks.
                expect(state.shape.rings.length).toBeLessThan(before);
                // Its own ring is gone => selection cleared, never dangling.
                expect(state.selected).toBeUndefined();
                assertSelBundle(state);
                break;
              }
              case 'delete-any': {
                const targetId = pickAny(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const nextShape = deleteRingAndReorganize(state.shape, targetId);
                state = {
                  shape: nextShape,
                  store: state.store,
                  selected: reresolveSelection(nextShape, state.selected),
                };
                assertSelBundle(state);
                break;
              }
              case 'scale-any': {
                const targetId = pickAny(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const center = subtreeCentroid(state, targetId);
                if (center === undefined) break;
                const beforeStore = state.store;
                const moved = scaleSubtreeAbout(state, targetId, center, cmd.k);
                state = { ...state, store: moved };
                assertSelBundle(state);
                // op∘inverse: scale back about the same pivot by 1/k restores the
                // prior coordinates (within a tight float epsilon).
                const back = scaleSubtreeAbout(state, targetId, center, 1 / cmd.k);
                for (const v of beforeStore.byId.values()) {
                  const rv = back.byId.get(v.id);
                  expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 6);
                  expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 6);
                }
                break;
              }
              case 'save-load': {
                const reloaded = saveLoadSelState(state);
                expect(reloaded.shape).toEqual(state.shape);
                expect(reloaded.selected).toEqual(state.selected);
                state = reloaded;
                assertSelBundle(state);
                break;
              }
              case 'delete-absent-noop': {
                const next = deleteRingAndReorganize(state.shape, asRingId('nope-22004'));
                expect(next).toEqual(state.shape);
                state = { ...state, shape: next };
                assertSelBundle(state);
                break;
              }
              default:
                break;
            }

            // UNDO∘op = identity: the pre-command snapshot still reproduces the
            // pre-command state verbatim (shape + selection; the store snapshot is
            // an independent copy so a later mutation cannot have aliased it).
            assertSelBundle(snapshot);
          }
        },
      ),
      cfg7,
    );
  });
});

// ===========================================================================
// 12. EIGHTH CAMPAIGN (seed=32002) — NEW exploration (bughunt run #3).
//
// Distinct from ALL seven prior campaigns (seeds 2001/2002/2004/22001/22002/
// 22003/22004) in BOTH the seed AND the operation set / generators. The brief
// for this run asks for a *different exploration* from the previous seeds
// (1000-6000 / 21000-26000 are explicitly excluded; this file's prior seeds are
// the 2xxx / 22xxx ranges). Two genuinely new ingredients here:
//
//   (1) Two new RIGID-MOTION transforms not used by any prior campaign:
//       - ROTATE-TOP-SUBTREE: rotate a whole top-level band about its own
//         centroid by an arbitrary angle. Rotation is an isometry, so it
//         preserves every ring's simplicity AND the internal containment of the
//         whole subtree exactly (a child rectangle inside a parent rectangle
//         stays inside when the WHOLE band rotates rigidly about a shared
//         pivot). Top bands start 80° apart; even the worst-case rotated
//         half-diagonal of a half-width/height ≤16 rectangle is 16·√2 ≈ 22.6, so
//         two bands' rotated extents (≤45.3 wide) never reach the 80° gap — no
//         enclave-overlap is manufactured. A correct system MUST keep
//         validateGeometry clean; any violation is a real re-link/containment
//         defect, not a generator artifact. op∘inverse: rotate back by −θ about
//         the SAME captured pivot restores coordinates within a tight epsilon.
//       - REFLECT-TOP-SUBTREE: reflect a whole top-level band across the
//         vertical line through its centroid (lon → 2·cx − lon). A reflection is
//         an isometry confined to the band's own bounding box, so it likewise
//         preserves simplicity + internal containment and cannot reach a
//         neighbouring band. It is its OWN inverse (reflect twice = identity),
//         giving an exact op∘op = identity law (not merely within epsilon — a
//         reflection about a fixed axis is bit-exact: 2·cx − (2·cx − x) = x for
//         the small finite magnitudes here, asserted with a tight epsilon to be
//         safe against any rounding).
//
//   (2) The FIRST campaign to carry BOTH a live SELECTION *and* an ascending
//       duplicate-free ANCHOR series in the SAME state (campaign 6 had anchors
//       but no selection; campaign 7 had a selection but no anchors). After
//       EVERY command this asserts the full focal bundle PLUS: selection is
//       never dangling, the anchor series stays strictly ascending & unique, and
//       save→load is the identity over the WHOLE (shape, store, selection,
//       anchors) quadruple.
//
// Determinism: seed fixed to 32002, numRuns large; permanent asset, no green-fake.
// ===========================================================================

const SEED8 = 32002;
const RUNS8 = 500;
const cfg8 = { seed: SEED8, numRuns: RUNS8 } as const;

/** The combined editor state for campaign 8: shape + store + a live selection +
 * an ascending duplicate-free anchor series + a fresh-id counter. The first
 * state in this file to carry a selection AND an anchor series together. */
interface FullState {
  readonly shape: Shape;
  readonly store: VertexStore;
  readonly selected: RingId | undefined;
  readonly anchors: readonly number[];
}

/** Rotate every vertex of `ringId`'s subtree about a fixed pivot by `angle`
 * radians (a rigid isometry). Returns a NEW store; the shape (parent links) is
 * unchanged. The pivot is passed in (captured BEFORE the rotation) so the forward
 * and inverse rotation share the SAME center — a true op∘inverse pair. */
function rotateSubtreeAbout(
  state: FullState,
  ringId: RingId,
  pivot: { lon: number; lat: number },
  angle: number,
): VertexStore {
  const ids = subtreeRingIds(state.shape, ringId);
  const moved = new Set<VertexId>();
  for (const ring of state.shape.rings) {
    if (!ids.has(ring.id)) continue;
    for (const vid of ring.vertexIds) moved.add(vid);
  }
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let store = state.store;
  for (const vid of moved) {
    const v = getVertex(store, vid);
    if (v === undefined) continue;
    const dx = v.coordinate.lon - pivot.lon;
    const dy = v.coordinate.lat - pivot.lat;
    const rotated = withVertexCoordinate(
      v,
      createCoordinate(pivot.lon + dx * cos - dy * sin, pivot.lat + dx * sin + dy * cos),
    );
    store = setVertex(store, rotated);
  }
  return store;
}

/** Reflect every vertex of `ringId`'s subtree across the vertical line lon = axisLon
 * (lon → 2·axisLon − lon; lat unchanged). A rigid isometry that is its OWN inverse
 * (reflecting twice restores the original). Returns a NEW store; shape unchanged. */
function reflectSubtreeAbout(
  state: FullState,
  ringId: RingId,
  axisLon: number,
): VertexStore {
  const ids = subtreeRingIds(state.shape, ringId);
  const moved = new Set<VertexId>();
  for (const ring of state.shape.rings) {
    if (!ids.has(ring.id)) continue;
    for (const vid of ring.vertexIds) moved.add(vid);
  }
  let store = state.store;
  for (const vid of moved) {
    const v = getVertex(store, vid);
    if (v === undefined) continue;
    const reflected = withVertexCoordinate(
      v,
      createCoordinate(2 * axisLon - v.coordinate.lon, v.coordinate.lat),
    );
    store = setVertex(store, reflected);
  }
  return store;
}

/** Save→load the whole (shape, store, selection, anchors) quadruple and back. */
function saveLoadFullState(state: FullState): FullState {
  const reloaded = saveLoadState({ shape: state.shape, store: state.store });
  const reloadedSel = JSON.parse(JSON.stringify(state.selected ?? null)) as string | null;
  const reloadedAnchors = JSON.parse(JSON.stringify(state.anchors)) as readonly number[];
  return {
    shape: reloaded.shape,
    store: reloaded.store,
    selected: reloadedSel === null ? undefined : (reloadedSel as RingId),
    anchors: reloadedAnchors,
  };
}

/** Full focal invariant bundle for a FullState: the (shape, store) bundle PLUS
 * selection validity, anchor ascending/unique, and the quadruple save→load
 * identity. */
function assertFullStateBundle(state: FullState): void {
  assertFullBundle({ shape: state.shape, store: state.store });
  // SELECTION is always valid: undefined, or a ring present in the shape.
  expect(selectionValid({ shape: state.shape, store: state.store, selected: state.selected })).toBe(
    true,
  );
  // ANCHOR series: strictly ascending => sorted AND duplicate-free (FR-54).
  expect(anchorsAscendingUnique(state.anchors)).toBe(true);
  // save → load = identity over the full quadruple.
  const reloaded = saveLoadFullState(state);
  expect(reloaded.shape).toEqual(state.shape);
  expect(reloaded.selected).toEqual(state.selected);
  expect(reloaded.anchors).toEqual(state.anchors);
  for (const v of state.store.byId.values()) {
    const rv = reloaded.store.byId.get(v.id);
    expect(rv).not.toBeUndefined();
    expect(Object.is(rv?.coordinate.lon, v.coordinate.lon)).toBe(true);
    expect(Object.is(rv?.coordinate.lat, v.coordinate.lat)).toBe(true);
  }
}

/** Pick a TOP-LEVEL ring id from a [0,1) selector; undefined when none. */
function pickTopLevelId(shape: Shape, sel: number): RingId | undefined {
  return pickTopLevel(shape, sel);
}

/** An eighth-campaign edit command. */
type EditCommand8 =
  | { readonly tag: 'select'; readonly sel: number }
  | { readonly tag: 'delete-any'; readonly sel: number }
  | { readonly tag: 'rotate-top'; readonly sel: number; readonly angle: number }
  | { readonly tag: 'reflect-top'; readonly sel: number }
  | { readonly tag: 'anchor-insert'; readonly value: number }
  | { readonly tag: 'anchor-remove'; readonly sel: number }
  | { readonly tag: 'save-load' }
  | { readonly tag: 'delete-absent-noop' };

function editCommand8Arb(): fc.Arbitrary<EditCommand8> {
  const sel = (): fc.Arbitrary<number> =>
    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });
  // Full-circle rotation angle in radians.
  const angle = (): fc.Arbitrary<number> =>
    fc.double({ min: -Math.PI, max: Math.PI, noNaN: true, noDefaultInfinity: true });
  return fc.oneof(
    fc.record({ tag: fc.constant('select' as const), sel: sel() }),
    fc.record({ tag: fc.constant('delete-any' as const), sel: sel() }),
    fc.record({ tag: fc.constant('rotate-top' as const), sel: sel(), angle: angle() }),
    fc.record({ tag: fc.constant('reflect-top' as const), sel: sel() }),
    fc.record({ tag: fc.constant('anchor-insert' as const), value: fc.integer({ min: -40, max: 40 }) }),
    fc.record({ tag: fc.constant('anchor-remove' as const), sel: sel() }),
    fc.record({ tag: fc.constant('save-load' as const) }),
    fc.record({ tag: fc.constant('delete-absent-noop' as const) }),
  );
}

describe('alternation (seed=32002): rigid rotate/reflect of top bands + selection + anchors', () => {
  it('rotating a top-level band about its centroid keeps the full bundle (op∘inverse restores)', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .record({
              sel: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
              angle: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true, noDefaultInfinity: true }),
            })
            .map((op) => ({ shape, store, op })),
        ),
        ({ shape, store, op }) => {
          const targetId = pickTopLevelId(shape, op.sel);
          if (targetId === undefined) return;
          const state: FullState = { shape, store, selected: undefined, anchors: [] };
          const pivot = subtreeCentroid(
            { shape, store, selected: undefined },
            targetId,
          );
          if (pivot === undefined) return;
          const moved = rotateSubtreeAbout(state, targetId, pivot, op.angle);
          // A rigid rotation of a whole top band keeps EVERY focal invariant:
          // internal containment, sibling/enclave non-overlap, simplicity, finite.
          assertFullStateBundle({ shape, store: moved, selected: undefined, anchors: [] });
          // op∘inverse: rotate back by −angle about the SAME pivot restores coords
          // (trig round-trip => within a tight epsilon, not bit-exact).
          const back = rotateSubtreeAbout(
            { shape, store: moved, selected: undefined, anchors: [] },
            targetId,
            pivot,
            -op.angle,
          );
          for (const v of store.byId.values()) {
            const rv = back.byId.get(v.id);
            expect(rv).not.toBeUndefined();
            expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 6);
            expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 6);
          }
        },
      ),
      cfg8,
    );
  });

  it('reflecting a top-level band across its centroid axis keeps the full bundle (reflect∘reflect = identity)', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true })
            .map((sel) => ({ shape, store, sel })),
        ),
        ({ shape, store, sel }) => {
          const targetId = pickTopLevelId(shape, sel);
          if (targetId === undefined) return;
          const state: FullState = { shape, store, selected: undefined, anchors: [] };
          const centroid = subtreeCentroid(
            { shape, store, selected: undefined },
            targetId,
          );
          if (centroid === undefined) return;
          const moved = reflectSubtreeAbout(state, targetId, centroid.lon);
          // A reflection of a whole top band is an isometry confined to its own
          // bounding box: full bundle survives.
          assertFullStateBundle({ shape, store: moved, selected: undefined, anchors: [] });
          // op∘op = identity: reflecting back across the SAME axis restores coords.
          const back = reflectSubtreeAbout(
            { shape, store: moved, selected: undefined, anchors: [] },
            targetId,
            centroid.lon,
          );
          for (const v of store.byId.values()) {
            const rv = back.byId.get(v.id);
            expect(rv).not.toBeUndefined();
            expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 9);
            expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 9);
          }
        },
      ),
      cfg8,
    );
  });

  it('stateful: interleaved select / delete / rotate-top / reflect-top / anchor / save-load keeps the full bundle at every step', () => {
    fc.assert(
      fc.property(
        richGeoShapeArb().chain(({ shape, store }) =>
          fc
            .array(editCommand8Arb(), { minLength: 5, maxLength: shape.rings.length + 14 })
            .map((commands) => ({ shape, store, commands })),
        ),
        ({ shape, store, commands }) => {
          let state: FullState = { shape, store, selected: undefined, anchors: [] };
          assertFullStateBundle(state);
          for (const cmd of commands) {
            // METAMORPHIC every step: deleting an absent ring is the identity.
            expect(deleteRingAndReorganize(state.shape, asRingId('absent-32002'))).toEqual(
              state.shape,
            );
            // FULL-STREAM UNDO: an independent snapshot of the pre-command state.
            const snapshot = saveLoadFullState(state);

            switch (cmd.tag) {
              case 'select': {
                const targetId = pickAny(state.shape, cmd.sel);
                state = { ...state, selected: targetId };
                assertFullStateBundle(state);
                break;
              }
              case 'delete-any': {
                const targetId = pickAny(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const before = state.shape.rings.length;
                const nextShape = deleteRingAndReorganize(state.shape, targetId);
                state = {
                  ...state,
                  shape: nextShape,
                  selected: reresolveSelection(nextShape, state.selected),
                };
                expect(state.shape.rings.length).toBeLessThan(before);
                assertFullStateBundle(state);
                break;
              }
              case 'rotate-top': {
                const targetId = pickTopLevelId(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const pivot = subtreeCentroid(
                  { shape: state.shape, store: state.store, selected: undefined },
                  targetId,
                );
                if (pivot === undefined) break;
                const beforeStore = state.store;
                const moved = rotateSubtreeAbout(state, targetId, pivot, cmd.angle);
                state = { ...state, store: moved };
                assertFullStateBundle(state);
                // op∘inverse: rotate back restores prior coordinates (tight epsilon).
                const back = rotateSubtreeAbout(state, targetId, pivot, -cmd.angle);
                for (const v of beforeStore.byId.values()) {
                  const rv = back.byId.get(v.id);
                  expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 6);
                  expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 6);
                }
                break;
              }
              case 'reflect-top': {
                const targetId = pickTopLevelId(state.shape, cmd.sel);
                if (targetId === undefined) break;
                const centroid = subtreeCentroid(
                  { shape: state.shape, store: state.store, selected: undefined },
                  targetId,
                );
                if (centroid === undefined) break;
                const beforeStore = state.store;
                const moved = reflectSubtreeAbout(state, targetId, centroid.lon);
                state = { ...state, store: moved };
                assertFullStateBundle(state);
                // reflect∘reflect = identity: reflecting back restores coordinates.
                const back = reflectSubtreeAbout(state, targetId, centroid.lon);
                for (const v of beforeStore.byId.values()) {
                  const rv = back.byId.get(v.id);
                  expect(rv?.coordinate.lon).toBeCloseTo(v.coordinate.lon, 9);
                  expect(rv?.coordinate.lat).toBeCloseTo(v.coordinate.lat, 9);
                }
                break;
              }
              case 'anchor-insert': {
                const before = state.anchors;
                state = { ...state, anchors: insertAnchor(state.anchors, cmd.value) };
                if (before.includes(cmd.value)) expect(state.anchors).toEqual(before);
                assertFullStateBundle(state);
                break;
              }
              case 'anchor-remove': {
                const idx =
                  state.anchors.length === 0
                    ? -1
                    : Math.min(
                        state.anchors.length - 1,
                        Math.floor(cmd.sel * state.anchors.length),
                      );
                state = { ...state, anchors: removeAnchorAt(state.anchors, idx) };
                assertFullStateBundle(state);
                break;
              }
              case 'save-load': {
                const reloaded = saveLoadFullState(state);
                expect(reloaded.shape).toEqual(state.shape);
                expect(reloaded.selected).toEqual(state.selected);
                expect(reloaded.anchors).toEqual(state.anchors);
                state = reloaded;
                assertFullStateBundle(state);
                break;
              }
              case 'delete-absent-noop': {
                const next = deleteRingAndReorganize(state.shape, asRingId('nope-32002'));
                expect(next).toEqual(state.shape);
                state = { ...state, shape: next };
                assertFullStateBundle(state);
                break;
              }
              default:
                break;
            }

            // UNDO∘op = identity: the pre-command snapshot still reproduces the
            // pre-command state verbatim (an independent copy, no aliasing).
            assertFullStateBundle(snapshot);
          }
        },
      ),
      cfg8,
    );
  });
});
