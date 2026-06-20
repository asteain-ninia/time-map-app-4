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
  validateAlternation,
  validateGeometry,
  validateRingHierarchy,
} from '../ring-hierarchy';
import { createVertex, createVertexStore, type VertexStore } from '../vertex';

const SEED = 2001;
const RUNS = 500;
const cfg = { seed: SEED, numRuns: RUNS } as const;

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
