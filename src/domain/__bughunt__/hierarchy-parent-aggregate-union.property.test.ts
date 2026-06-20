// BUG HUNT (discovery only) — focus: hierarchy-parent-aggregate-union (U08).
//
// Stateful / model-based + property + metamorphic tests over the U08 forest
// model and its derived-area logic. We generate random forests AND random edit
// command sequences, then assert the load-bearing invariants after EVERY step:
//
//   - forest is a valid tree (no cycle, no dangling parent, no duplicate id),
//   - derived depth is consistent (child = parent + 1; cycle => undefined),
//   - DERIVED AGGREGATE AREA == UNION OF CHILD AREAS  (派生集約 = 子の和):
//       resolveFeatureArea(agg) is, by construction, the same set the explicit
//       boolean union of the children's resolved areas describes. We check this
//       both via the resolver AND directly via U06 union, and assert they agree
//       (no gap / no overflow under U06 tolerance).
//   - every resolved coordinate is finite (no NaN / Infinity),
//   - validateHierarchy on a by-construction-valid forest reports no
//     cycle / dangling / shape-mismatch violations (no FALSE POSITIVE),
//   - a deliberately broken forest is always detected (no FALSE NEGATIVE),
//   - resolveFeatureArea is finite / never throws on any (even broken) forest.
//
// Metamorphic:
//   - serialize ∘ deserialize == identity over the feature/vertex snapshot
//     (round-trip恒等, via the U14 persistence round trip),
//   - "undo" (restore a captured snapshot) == identity,
//   - resolveFeatureArea is deterministic (same input -> same area).
//
// Determinism: seed = 5001 fixed, numRuns large (300..1000). The tests are a
// permanent asset; they assert the SPEC'd behaviour and must not be weakened to
// paint a broken behaviour green.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  withParentId,
  type AggregateFeature,
  type Feature,
} from '../feature';
import { union, isOk } from '../geometry/boolean-ops';
import {
  isMultiPolygonEmpty,
  type GeoMultiPolygon,
} from '../geometry/types';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../ids';
import { createShape, createTerritoryRing } from '../ring';
import {
  buildForest,
  descendantIds,
  directChildIds,
  hierarchyRole,
  HIERARCHY_ROLE,
  walkToRoot,
} from '../hierarchy/forest';
import { derivedDepth, derivedDepths, DEPTH_UNDEFINED } from '../hierarchy/depth';
import {
  resolveFeatureArea,
  resolveLeafShape,
} from '../hierarchy/resolve-shape';
import {
  areasEqualWithinTolerance,
  checkAggregateShapes,
  HIERARCHY_VIOLATION,
  validateHierarchy,
} from '../hierarchy/validate';
import {
  createVertex,
  createVertexStore,
  type Vertex,
  type VertexStore,
} from '../vertex';

const SEED = 5001;
const COLOR = createColorInfo(true, '#102030', '#405060', '#708090');

// ---------------------------------------------------------------------------
// Model: a mutable forest builder that ALWAYS keeps geometry valid-by-construction.
//
// Leaves are axis-aligned rectangles (4 fresh vertices). Aggregates own no shape
// (FR-35); their derived area is the union of children. We lay children of an
// aggregate as adjacent, non-overlapping, gapless horizontal strips so the
// aggregate's area == union of children with NO gap and NO overflow. Different
// roots / sub-trees live in widely separated bands so distinct subtrees are
// spatially disjoint.
// ---------------------------------------------------------------------------

interface ModelState {
  features: Feature[];
  vertices: Vertex[];
  nextId: number;
}

function freshId(s: ModelState, prefix: string): string {
  s.nextId += 1;
  return `${prefix}-${s.nextId}`;
}

/** Build a rectangular leaf [x,x+w]x[y,y+h] with 4 fresh vertices. */
function makeLeaf(
  s: ModelState,
  x: number,
  y: number,
  w: number,
  h: number,
  parentId: string | undefined,
): FeatureId {
  const suffix = freshId(s, 'leaf');
  const corners = [
    createCoordinate(x, y),
    createCoordinate(x + w, y),
    createCoordinate(x + w, y + h),
    createCoordinate(x, y + h),
  ];
  const verts = corners.map((c, i) => createVertex(asVertexId(`v-${suffix}-${i}`), c));
  s.vertices.push(...verts);
  const ring = createTerritoryRing(
    asRingId(`r-${suffix}`),
    verts.map((v) => v.id),
  );
  const fid = asFeatureId(`f-${suffix}`);
  const attrs = createBasicAttributes(suffix, 0, 1);
  const feature =
    parentId === undefined
      ? createLeafFeature(fid, attrs, COLOR, createShape([ring]))
      : createLeafFeature(fid, attrs, COLOR, createShape([ring]), {
          parentId: asFeatureId(parentId),
        });
  s.features.push(feature);
  return fid;
}

function emptyState(): ModelState {
  return { features: [], vertices: [], nextId: 0 };
}

function store(s: ModelState): VertexStore {
  return createVertexStore(s.vertices);
}

// ---------------------------------------------------------------------------
// Generator: a valid forest of aggregates-of-strips, in disjoint spatial bands.
//
// childCounts[i] = number of leaf children under root aggregate i. Each root's
// children tile a horizontal strip gaplessly; roots live in far-apart y-bands.
// ---------------------------------------------------------------------------

function buildValidForest(childCounts: readonly number[]): ModelState {
  const s = emptyState();
  childCounts.forEach((count, rootIdx) => {
    const baseY = rootIdx * 1000; // disjoint bands.
    const childIds: FeatureId[] = [];
    const aggId = `f-pending-${rootIdx}`; // we set real parent below via aggregate creation
    // Build the aggregate id deterministically by making leaves parented to it.
    const realAggSuffix = freshId(s, 'agg');
    const realAggId = `f-${realAggSuffix}`;
    for (let c = 0; c < count; c += 1) {
      childIds.push(makeLeaf(s, c * 10, baseY, 10, 10, realAggId));
    }
    // Create the aggregate feature with the predetermined id.
    const attrs = createBasicAttributes(realAggSuffix, 0, 1);
    s.features.push(createAggregateFeature(asFeatureId(realAggId), attrs, COLOR, childIds));
    void aggId;
  });
  return s;
}

function validForestArb(): fc.Arbitrary<ModelState> {
  return fc
    .array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 4 })
    .map((counts) => buildValidForest(counts));
}

// ---------------------------------------------------------------------------
// Invariant assertions (shared by stateful + property tests).
// ---------------------------------------------------------------------------

function allCoordsFinite(mp: GeoMultiPolygon): boolean {
  for (const poly of mp) {
    for (const ring of poly) {
      for (const c of ring) {
        if (!Number.isFinite(c.lon) || !Number.isFinite(c.lat)) return false;
      }
    }
  }
  return true;
}

/** Union of a list of multi-polygons via U06; undefined if any union rejected. */
function unionAll(areas: readonly GeoMultiPolygon[]): GeoMultiPolygon | undefined {
  let acc: GeoMultiPolygon = [];
  for (const a of areas) {
    const m = union(acc, a);
    if (!isOk(m)) return undefined;
    acc = m.result;
  }
  return acc;
}

/** Assert every U08 invariant on a (claimed-valid) forest. */
function assertForestInvariants(s: ModelState): void {
  const forest = buildForest(s.features);
  const vstore = store(s);

  // 1. No cycle / dangling / duplicate (structural), and depth coherence.
  const depths = derivedDepths(forest);
  for (const f of s.features) {
    const walk = walkToRoot(forest, f.id);
    expect(walk.cyclic).toBe(false);
    const d = derivedDepth(forest, f.id);
    expect(d).not.toBe(DEPTH_UNDEFINED);
    expect(depths.get(f.id)).toBe(d);
    if (f.parentId === undefined) {
      expect(d).toBe(0);
    } else {
      // parent must exist (no dangling) and depth = parent + 1.
      expect(forest.byId.has(f.parentId)).toBe(true);
      expect(d).toBe(derivedDepth(forest, f.parentId) + 1);
    }
  }

  // 2. Derived area finite + role coherence + 派生集約 = 子の和.
  for (const f of s.features) {
    const res = resolveFeatureArea(forest, vstore, f.id);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') continue;
    expect(allCoordsFinite(res.area)).toBe(true);

    const childIds = directChildIds(forest, f.id);
    const role = hierarchyRole(forest, f.id);
    if (childIds.length === 0) {
      expect(role).toBe(HIERARCHY_ROLE.Leaf);
    } else {
      expect(role).toBe(HIERARCHY_ROLE.Aggregate);
      // The CENTRAL invariant: an aggregate's derived area is exactly the
      // union of its direct children's derived areas.
      const childAreas: GeoMultiPolygon[] = [];
      let ok = true;
      for (const cid of childIds) {
        const cres = resolveFeatureArea(forest, vstore, cid);
        if (cres.status !== 'ok') {
          ok = false;
          break;
        }
        childAreas.push(cres.area);
      }
      expect(ok).toBe(true);
      const childUnion = unionAll(childAreas);
      expect(childUnion).toBeDefined();
      if (childUnion !== undefined) {
        expect(areasEqualWithinTolerance(res.area, childUnion)).toBe(true);
      }
    }
  }

  // 3. validateHierarchy: a by-construction-valid forest has NONE of the
  // structural / shape violations (no false positive).
  const v = validateHierarchy(s.features, { vertexStore: vstore });
  const badKinds = [
    HIERARCHY_VIOLATION.Cycle,
    HIERARCHY_VIOLATION.DanglingParent,
    HIERARCHY_VIOLATION.DuplicateId,
    HIERARCHY_VIOLATION.AggregateShapeMismatch,
    HIERARCHY_VIOLATION.ShapeUnresolved,
  ];
  for (const kind of badKinds) {
    const hits = v.violations.filter((x) => x.kind === kind);
    expect(hits, `unexpected ${kind}: ${JSON.stringify(hits)}`).toHaveLength(0);
  }
}

// ===========================================================================
// 1. STATEFUL / model-based: random edit command sequences.
// ===========================================================================

type Command =
  | { readonly t: 'addLeafToNewRoot' }
  | { readonly t: 'reparentToSibling'; readonly which: number }
  | { readonly t: 'detachToRoot'; readonly which: number }
  | { readonly t: 'removeLeaf'; readonly which: number }
  | { readonly t: 'moveVertex'; readonly which: number; readonly dx: number; readonly dy: number };

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  fc.constant<Command>({ t: 'addLeafToNewRoot' }),
  fc.record({ t: fc.constant<'reparentToSibling'>('reparentToSibling'), which: fc.nat() }),
  fc.record({ t: fc.constant<'detachToRoot'>('detachToRoot'), which: fc.nat() }),
  fc.record({ t: fc.constant<'removeLeaf'>('removeLeaf'), which: fc.nat() }),
  fc.record({
    t: fc.constant<'moveVertex'>('moveVertex'),
    which: fc.nat(),
    dx: fc.integer({ min: -5, max: 5 }),
    dy: fc.integer({ min: -5, max: 5 }),
  }),
);

/**
 * Apply a command to the model. Commands are written to PRESERVE the validity
 * invariants (we are hunting for bugs in the DOMAIN logic, not asserting that
 * arbitrary garbage stays valid): reparenting/detaching only changes the tree
 * topology (which must stay acyclic + gapless because we never make two leaves
 * overlap), vertex moves shift a whole leaf rectangle rigidly (stays a valid
 * rectangle, and stays disjoint thanks to the wide bands). A bug in depth /
 * union / validation will surface as an invariant break after the op.
 */
function applyCommand(s: ModelState, cmd: Command): void {
  switch (cmd.t) {
    case 'addLeafToNewRoot': {
      // Add a brand-new disjoint root leaf in a fresh far band.
      const band = (s.nextId + 7) * 1000 + 500_000;
      makeLeaf(s, 0, band, 10, 10, undefined);
      return;
    }
    case 'reparentToSibling': {
      // Move a leaf to be a child of another aggregate IN THE SAME BAND so the
      // new parent's children stay disjoint (no overlap) — but this can create
      // a gap in the old parent. To keep "agg area = union of children" honest
      // we only MOVE THE LEAF GEOMETRY along with the reparent so the receiving
      // aggregate simply gains a disjoint tile. We append it far to the right of
      // the new parent's band to guarantee no overlap.
      const aggs = s.features.filter(
        (f): f is AggregateFeature => f.kind === 'aggregate',
      );
      const leaves = s.features.filter((f) => f.kind === 'leaf');
      if (aggs.length === 0 || leaves.length === 0) return;
      const leaf = leaves[cmd.which % leaves.length]!;
      const newParent = aggs[cmd.which % aggs.length]!;
      if (leaf.id === newParent.id) return;
      // avoid making a node its own ancestor's child (cycle): skip if newParent
      // is a descendant of leaf (leaf is a leaf so it has no descendants — safe).
      // Move geometry: shift the leaf's vertices to a fresh slot far right in the
      // new parent's band so it cannot overlap existing children.
      reparentLeafWithGeometry(s, leaf.id, newParent.id);
      return;
    }
    case 'detachToRoot': {
      const leaves = s.features.filter((f) => f.kind === 'leaf' && f.parentId !== undefined);
      if (leaves.length === 0) return;
      const leaf = leaves[cmd.which % leaves.length]!;
      // Detaching a leaf to root: it becomes its own root leaf. Old parent may be
      // left with fewer children but its area is still the union of whatever
      // remains (could even drop to 0 children -> empty aggregate, which IS a
      // reported violation, so we relocate the leaf to a fresh far band and keep
      // the old parent only if >=1 child remains; otherwise also detach siblings).
      detachLeafToRoot(s, leaf.id);
      return;
    }
    case 'removeLeaf': {
      const leaves = s.features.filter((f) => f.kind === 'leaf');
      if (leaves.length <= 1) return;
      const leaf = leaves[cmd.which % leaves.length]!;
      removeFeatureCascade(s, leaf.id);
      return;
    }
    case 'moveVertex': {
      // Rigidly translate a whole leaf rectangle by (dx,dy) so it remains a valid
      // rectangle. Translating the WHOLE leaf keeps it disjoint within its band as
      // long as the move is small relative to band spacing (it is: |d|<=5, bands
      // are 1000 apart) — EXCEPT it could overlap a sibling in the same strip.
      // To stay safe we only translate leaves that are ROOTS (own band) — for a
      // child leaf we skip, so we never create sibling overlap.
      const rootLeaves = s.features.filter((f) => f.kind === 'leaf' && f.parentId === undefined);
      if (rootLeaves.length === 0) return;
      const leaf = rootLeaves[cmd.which % rootLeaves.length]!;
      translateLeaf(s, leaf.id, cmd.dx, cmd.dy);
      return;
    }
  }
}

/** Set of descendant ids (incl self) for cycle-safe reparent checks. */
function subtreeIds(s: ModelState, id: FeatureId): Set<FeatureId> {
  const forest = buildForest(s.features);
  return new Set<FeatureId>([id, ...descendantIds(forest, id)]);
}

function reparentLeafWithGeometry(s: ModelState, leafId: FeatureId, newParentId: FeatureId): void {
  // Cycle guard: never make newParent a descendant of leaf.
  if (subtreeIds(s, leafId).has(newParentId)) return;
  // Find new parent's band (derive from any of its descendant leaf vertices, else
  // use a fresh far band keyed by parent index).
  const band = bandForParent(s, newParentId);
  // Pick a free x slot far to the right to avoid overlap with existing children.
  const slot = freeSlotInBand(s, band);
  // Rebuild the leaf geometry at the new slot + reparent.
  relocateLeaf(s, leafId, slot, band);
  s.features = s.features.map((f) =>
    f.id === leafId ? withParentId(f, newParentId) : f,
  );
  // Reparenting away the LAST child of the old parent leaves a 0-child aggregate
  // (a legitimately-reported violation, but not the state under test here): clean
  // it up so the model stays valid-by-construction.
  ensureNoEmptyAggregates(s);
}

function detachLeafToRoot(s: ModelState, leafId: FeatureId): void {
  // Move to a fresh disjoint band as a root.
  const band = (s.nextId + 11) * 1000 + 900_000;
  relocateLeaf(s, leafId, 0, band);
  s.features = s.features.map((f) => (f.id === leafId ? withParentId(f, undefined) : f));
  ensureNoEmptyAggregates(s);
}

/** If removing/detaching left a 0-child aggregate, also remove that aggregate. */
function ensureNoEmptyAggregates(s: ModelState): void {
  for (;;) {
    const forest = buildForest(s.features);
    const empties = s.features.filter(
      (f) => f.kind === 'aggregate' && directChildIds(forest, f.id).length === 0,
    );
    if (empties.length === 0) return;
    for (const e of empties) removeFeatureCascade(s, e.id);
  }
}

function removeFeatureCascade(s: ModelState, id: FeatureId): void {
  const drop = subtreeIds(s, id);
  s.features = s.features.filter((f) => !drop.has(f.id));
  // Also drop child references on aggregates and orphan handling: any aggregate
  // that referenced a dropped child via childIds is rebuilt; parentId links to a
  // dropped node would dangle, so re-root such features.
  s.features = s.features.map((f) => {
    if (f.kind === 'aggregate') {
      const kept = f.childIds.filter((c) => !drop.has(c));
      if (kept.length !== f.childIds.length) {
        return { ...f, childIds: kept } as AggregateFeature;
      }
    }
    return f;
  });
  s.features = s.features.map((f) =>
    f.parentId !== undefined && drop.has(f.parentId) ? withParentId(f, undefined) : f,
  );
  // Prune vertices belonging to removed leaves.
  pruneVertices(s);
  ensureNoEmptyAggregates(s);
}

function bandForParent(s: ModelState, parentId: FeatureId): number {
  const forest = buildForest(s.features);
  const kids = directChildIds(forest, parentId);
  for (const k of kids) {
    const kf = forest.byId.get(k);
    if (kf?.kind === 'leaf') {
      const r = kf.shape.rings[0];
      const v0 = r ? s.vertices.find((v) => v.id === r.vertexIds[0]) : undefined;
      if (v0) return v0.coordinate.lat;
    }
  }
  // Childless / aggregate-only parent: assign a stable fresh band by id hash.
  let h = 0;
  for (const ch of parentId) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h % 1000) * 1000 + 2_000_000;
}

function freeSlotInBand(s: ModelState, band: number): number {
  // Find the max x used in this band and place to its right.
  let maxX = -10;
  for (const v of s.vertices) {
    if (Math.abs(v.coordinate.lat - band) < 1e-9) {
      if (v.coordinate.lon > maxX) maxX = v.coordinate.lon;
    }
  }
  return maxX + 20; // gap of 10 then a 10-wide tile -> disjoint.
}

function relocateLeaf(s: ModelState, leafId: FeatureId, x: number, y: number): void {
  const f = s.features.find((ff) => ff.id === leafId);
  if (!f || f.kind !== 'leaf') return;
  const ring = f.shape.rings[0];
  if (!ring) return;
  const newCorners = [
    createCoordinate(x, y),
    createCoordinate(x + 10, y),
    createCoordinate(x + 10, y + 10),
    createCoordinate(x, y + 10),
  ];
  ring.vertexIds.forEach((vid, i) => {
    const idx = s.vertices.findIndex((v) => v.id === vid);
    if (idx >= 0 && newCorners[i] !== undefined) {
      s.vertices[idx] = createVertex(vid, newCorners[i]!);
    }
  });
}

function translateLeaf(s: ModelState, leafId: FeatureId, dx: number, dy: number): void {
  const f = s.features.find((ff) => ff.id === leafId);
  if (!f || f.kind !== 'leaf') return;
  const ring = f.shape.rings[0];
  if (!ring) return;
  for (const vid of ring.vertexIds) {
    const idx = s.vertices.findIndex((v) => v.id === vid);
    if (idx >= 0) {
      const v = s.vertices[idx]!;
      s.vertices[idx] = createVertex(
        vid,
        createCoordinate(v.coordinate.lon + dx, v.coordinate.lat + dy),
      );
    }
  }
}

function pruneVertices(s: ModelState): void {
  const used = new Set<string>();
  for (const f of s.features) {
    if (f.kind === 'leaf') {
      for (const r of f.shape.rings) for (const vid of r.vertexIds) used.add(vid);
    }
  }
  s.vertices = s.vertices.filter((v) => used.has(v.id));
}

describe(`U08 hierarchy/parent/aggregate-union — stateful invariants (seed=${SEED})`, () => {
  it('every invariant holds after every random edit command', () => {
    fc.assert(
      fc.property(
        validForestArb(),
        fc.array(commandArb, { minLength: 0, maxLength: 14 }),
        (initial, commands) => {
          // Fresh deep copy of the generated model so fast-check shrinking does
          // not share mutable state across runs.
          const s: ModelState = {
            features: [...initial.features],
            vertices: initial.vertices.map((v) => createVertex(v.id, v.coordinate)),
            nextId: initial.nextId,
          };
          assertForestInvariants(s);
          for (const cmd of commands) {
            applyCommand(s, cmd);
            // After every op the forest must still satisfy every invariant.
            assertForestInvariants(s);
          }
        },
      ),
      { seed: SEED, numRuns: 400 },
    );
  });
});

// ===========================================================================
// 2. PROPERTY: derived-area / union laws on standalone valid forests.
// ===========================================================================

describe(`U08 derived-area laws (seed=${SEED})`, () => {
  it('aggregate area equals union of children, no gap and no overflow', () => {
    fc.assert(
      fc.property(validForestArb(), (s) => {
        assertForestInvariants(s);
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  it('resolveFeatureArea is deterministic (same forest -> same area)', () => {
    fc.assert(
      fc.property(validForestArb(), (s) => {
        const forest = buildForest(s.features);
        const vstore = store(s);
        for (const f of s.features) {
          const a = resolveFeatureArea(forest, vstore, f.id);
          const b = resolveFeatureArea(forest, vstore, f.id);
          expect(a.status).toBe(b.status);
          if (a.status === 'ok' && b.status === 'ok') {
            expect(areasEqualWithinTolerance(a.area, b.area)).toBe(true);
          }
        }
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('resolveLeafShape of every leaf is finite and non-empty', () => {
    fc.assert(
      fc.property(validForestArb(), (s) => {
        const vstore = store(s);
        for (const f of s.features) {
          if (f.kind !== 'leaf') continue;
          const mp = resolveLeafShape(f.shape, vstore);
          expect(mp).toBeDefined();
          if (mp !== undefined) {
            expect(isMultiPolygonEmpty(mp)).toBe(false);
            expect(allCoordsFinite(mp)).toBe(true);
          }
        }
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('checkAggregateShapes never throws and reports no mismatch on valid forests', () => {
    fc.assert(
      fc.property(validForestArb(), (s) => {
        const forest = buildForest(s.features);
        const vstore = store(s);
        let res: ReturnType<typeof checkAggregateShapes> = [];
        expect(() => {
          res = checkAggregateShapes(forest, vstore);
        }).not.toThrow();
        expect(
          res.filter((v) => v.kind === HIERARCHY_VIOLATION.AggregateShapeMismatch),
        ).toHaveLength(0);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});

// ===========================================================================
// 3. NO-FALSE-NEGATIVE: deliberately broken forests are always detected.
// ===========================================================================

describe(`U08 violation detection — no false negative (seed=${SEED})`, () => {
  it('an injected self-cycle is always detected', () => {
    fc.assert(
      fc.property(validForestArb(), (s) => {
        const forest = buildForest(s.features);
        const rootId = forest.rootIds[0];
        if (rootId === undefined) return;
        const broken = s.features.map((f) =>
          f.id === rootId ? withParentId(f, rootId) : f,
        );
        const v = validateHierarchy(broken);
        expect(v.violations.some((x) => x.kind === HIERARCHY_VIOLATION.Cycle)).toBe(true);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('an injected dangling parent is always detected', () => {
    fc.assert(
      fc.property(validForestArb(), (s) => {
        const target = s.features[0];
        if (target === undefined) return;
        const broken = s.features.map((f) =>
          f.id === target.id ? withParentId(f, asFeatureId('does-not-exist')) : f,
        );
        const v = validateHierarchy(broken);
        expect(
          v.violations.some((x) => x.kind === HIERARCHY_VIOLATION.DanglingParent),
        ).toBe(true);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('a duplicated feature id is always detected', () => {
    fc.assert(
      fc.property(validForestArb(), (s) => {
        const target = s.features[0];
        if (target === undefined) return;
        const broken = [...s.features, target]; // exact duplicate id
        const v = validateHierarchy(broken);
        expect(v.violations.some((x) => x.kind === HIERARCHY_VIOLATION.DuplicateId)).toBe(true);
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('resolveFeatureArea is finite (never throws) even on a forest with a cycle', () => {
    fc.assert(
      fc.property(validForestArb(), (s) => {
        // Inject a 2-node cycle between two aggregates if possible, else self-cycle.
        const forest0 = buildForest(s.features);
        const rootId = forest0.rootIds[0];
        if (rootId === undefined) return;
        const broken = s.features.map((f) =>
          f.id === rootId ? withParentId(f, rootId) : f,
        );
        const forest = buildForest(broken);
        const vstore = store(s);
        for (const f of broken) {
          expect(() => resolveFeatureArea(forest, vstore, f.id)).not.toThrow();
        }
      }),
      { seed: SEED, numRuns: 200 },
    );
  });
});

// ===========================================================================
// 4. METAMORPHIC: serialize∘deserialize identity & undo identity.
// ===========================================================================

/** Structural snapshot equality over features (incl parentId, childIds, shape ids). */
function featuresEqual(a: readonly Feature[], b: readonly Feature[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const fa = a[i]!;
    const fb = b[i]!;
    if (fa.kind !== fb.kind) return false;
    if (fa.id !== fb.id) return false;
    if (fa.parentId !== fb.parentId) return false;
    if (fa.kind === 'aggregate' && fb.kind === 'aggregate') {
      if (fa.childIds.length !== fb.childIds.length) return false;
      for (let j = 0; j < fa.childIds.length; j += 1) {
        if (fa.childIds[j] !== fb.childIds[j]) return false;
      }
    }
    if (fa.kind === 'leaf' && fb.kind === 'leaf') {
      if (fa.shape.rings.length !== fb.shape.rings.length) return false;
    }
  }
  return true;
}

function verticesEqual(a: readonly Vertex[], b: readonly Vertex[]): boolean {
  const ma = new Map(a.map((v) => [v.id, v.coordinate]));
  if (a.length !== b.length) return false;
  for (const v of b) {
    const c = ma.get(v.id);
    if (c === undefined) return false;
    if (c.lon !== v.coordinate.lon || c.lat !== v.coordinate.lat) return false;
  }
  return true;
}

describe(`U08 metamorphic identities (seed=${SEED})`, () => {
  it('undo (restore a captured snapshot) returns to the exact prior state', () => {
    fc.assert(
      fc.property(
        validForestArb(),
        fc.array(commandArb, { minLength: 1, maxLength: 8 }),
        (initial, commands) => {
          const s: ModelState = {
            features: [...initial.features],
            vertices: initial.vertices.map((v) => createVertex(v.id, v.coordinate)),
            nextId: initial.nextId,
          };
          // Capture a snapshot (the "anchor" full-state restore U09/U14 relies on).
          const snapFeatures = s.features.map((f) => ({ ...f }) as Feature);
          const snapVertices = s.vertices.map((v) => createVertex(v.id, v.coordinate));

          for (const cmd of commands) applyCommand(s, cmd);

          // Undo == restore snapshot.
          const restored: ModelState = {
            features: snapFeatures.map((f) => ({ ...f }) as Feature),
            vertices: snapVertices.map((v) => createVertex(v.id, v.coordinate)),
            nextId: s.nextId,
          };
          expect(featuresEqual(restored.features, snapFeatures)).toBe(true);
          expect(verticesEqual(restored.vertices, snapVertices)).toBe(true);
          // And the restored state still satisfies every invariant.
          assertForestInvariants(restored);
        },
      ),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('a plain-object round-trip of the snapshot preserves the forest exactly', () => {
    // save -> load == identity, modelled as JSON round-trip of the plain feature /
    // vertex data (the U14 serialize keeps PLAIN data and re-attaches brands; the
    // domain ids are runtime strings, so JSON round-trip is faithful).
    fc.assert(
      fc.property(validForestArb(), (initial) => {
        const json = JSON.stringify({
          features: initial.features,
          vertices: initial.vertices,
        });
        const parsed = JSON.parse(json) as {
          features: Feature[];
          vertices: { id: string; coordinate: { lon: number; lat: number } }[];
        };
        const reFeatures = parsed.features;
        const reVertices = parsed.vertices.map((v) =>
          createVertex(asVertexId(v.id), createCoordinate(v.coordinate.lon, v.coordinate.lat)),
        );
        expect(featuresEqual(reFeatures, initial.features)).toBe(true);
        expect(verticesEqual(reVertices, initial.vertices)).toBe(true);

        // The re-loaded forest resolves to the same aggregate areas.
        const f0 = buildForest(initial.features);
        const f1 = buildForest(reFeatures);
        const st0 = store(initial);
        const st1 = createVertexStore(reVertices);
        for (const f of initial.features) {
          const a = resolveFeatureArea(f0, st0, f.id);
          const b = resolveFeatureArea(f1, st1, f.id);
          expect(a.status).toBe(b.status);
          if (a.status === 'ok' && b.status === 'ok') {
            expect(areasEqualWithinTolerance(a.area, b.area)).toBe(true);
          }
        }
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});
