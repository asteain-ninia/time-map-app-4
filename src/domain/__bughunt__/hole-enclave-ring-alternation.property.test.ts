// hole-enclave-ring-alternation の検査 1/9。全体の説明と共有の生成器は hole-enclave-ring-alternation.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド「テストの速さ」）。

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { asRingId, asVertexId, type RingId } from '../ids';
import { ringHierarchyArb, ringIdFromShapeArb } from '../ring-hierarchy.arbitraries';
import { createHoleRing, createShape, createTerritoryRing, isAlternationValid, isTopLevelRing, RING_KIND, type Ring, type Shape } from '../ring';
import { childrenOf, deleteRingAndReorganize, topLevelRings, validateAlternation, validateGeometry, validateRingHierarchy } from '../ring-hierarchy';
import {
  allRingsFinite,
  assertStructurallyValid,
  cfg,
  cfg2,
  cfg3,
  depthsConsistent,
  geoShapeArb,
  jsonRoundTrip,
  noCycles,
  noDanglingParents,
  noRingSelfIntersects,
  richGeoShapeArb,
  storeFinite,
  uniqueIds,
} from './hole-enclave-ring-alternation.arbitraries';

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
