// Domain (U07): fast-check generators for ring-hierarchy property tests (R7).
// Built once from the domain invariants and reused so other ring-system property
// tests can share them. Rings are constructed through the REAL U06 factories
// (createTerritoryRing / createHoleRing / createShape), never as bare literals
// (教訓5.39), so a generated hierarchy is always alternation-valid by construction
// and any reorganization property tests a genuine structural value.
//
// Imports fast-check (a devDependency); consumed only by *.test.ts files.

import fc from 'fast-check';

import { asRingId, asVertexId, type RingId } from './ids';
import {
  createHoleRing,
  createShape,
  createTerritoryRing,
  type Ring,
  type Shape,
} from './ring';

/**
 * Generate a structurally-valid (alternation-correct) ring hierarchy.
 *
 * Shape: a forest of top-level territories (enclaves of one feature). Each
 * territory may have hole children; each hole may have territory children
 * (deeper enclaves); recursion bounded by `maxDepth`. Vertex IDs are unique per
 * ring so rings are distinguishable; the geometry is NOT meaningful here (this
 * generator targets the STRUCTURAL alternation invariant, which is the FR-24
 * property under test — geometry is exercised by the unit tests with real coords).
 *
 * Counts cover the 0 / 1 / many boundaries (教訓5.18): zero holes, zero enclaves,
 * and a single top-level territory are all reachable.
 */
export function ringHierarchyArb(maxDepth = 3): fc.Arbitrary<Shape> {
  return fc
    .array(territorySubtreeArb(maxDepth), { minLength: 1, maxLength: 3 })
    .chain((subtrees) => {
      // Re-key every ring ID across the whole forest so IDs are globally unique
      // even when independent subtrees were generated with overlapping local IDs.
      const rings: Ring[] = [];
      let counter = 0;
      const fresh = (): RingId => asRingId(`r${counter++}`);
      for (const subtree of subtrees) {
        appendRekeyed(subtree, undefined, fresh, rings);
      }
      return fc.constant(createShape(rings));
    });
}

/** A generated subtree as a nested plan (role + children) before ID assignment. */
interface SubtreePlan {
  readonly role: 'territory' | 'hole';
  readonly children: readonly SubtreePlan[];
}

function territorySubtreeArb(depthLeft: number): fc.Arbitrary<SubtreePlan> {
  if (depthLeft <= 0) {
    return fc.constant({ role: 'territory', children: [] });
  }
  return fc
    .array(holeSubtreeArb(depthLeft - 1), { minLength: 0, maxLength: 2 })
    .map((children) => ({ role: 'territory' as const, children }));
}

function holeSubtreeArb(depthLeft: number): fc.Arbitrary<SubtreePlan> {
  if (depthLeft <= 0) {
    return fc.constant({ role: 'hole', children: [] });
  }
  return fc
    .array(territorySubtreeArb(depthLeft - 1), { minLength: 0, maxLength: 2 })
    .map((children) => ({ role: 'hole' as const, children }));
}

/** Materialize a plan into real rings with globally-unique IDs and parent links.
 * Each ring gets three distinct vertex IDs so it is a non-degenerate placeholder. */
function appendRekeyed(
  plan: SubtreePlan,
  parentId: RingId | undefined,
  fresh: () => RingId,
  out: Ring[],
): void {
  const id = fresh();
  const vids = [asVertexId(`${id}-a`), asVertexId(`${id}-b`), asVertexId(`${id}-c`)];
  if (plan.role === 'territory') {
    out.push(createTerritoryRing(id, vids, parentId));
  } else {
    // A hole always has a parent by construction (the plan only nests holes under
    // territories), so parentId is defined here.
    out.push(createHoleRing(id, vids, parentId ?? asRingId('UNREACHABLE')));
  }
  for (const child of plan.children) {
    appendRekeyed(child, id, fresh, out);
  }
}

/** Pick an arbitrary existing ring ID from a shape (for "delete any ring"). Only
 * defined when the shape has at least one ring. */
export function ringIdFromShapeArb(shape: Shape): fc.Arbitrary<RingId> {
  return fc.constantFrom(...shape.rings.map((r) => r.id));
}
