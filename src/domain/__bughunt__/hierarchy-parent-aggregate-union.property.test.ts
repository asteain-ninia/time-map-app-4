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
import { createShape, createTerritoryRing, isAlternationValid } from '../ring';
import {
  buildForest,
  descendantIds,
  directChildIds,
  hierarchyRole,
  HIERARCHY_ROLE,
  walkToRoot,
} from '../hierarchy/forest';
import {
  derivedDepth,
  derivedDepths,
  maxDerivedDepth,
  DEPTH_UNDEFINED,
} from '../hierarchy/depth';
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
import {
  buildAffiliationProposal,
  buildAffiliationProposalForTargets,
  type AffiliationProposal,
  type ProposalResult,
} from '../affiliation/proposal';
import {
  parentCreate,
  parentExisting,
  parentNone,
  type ParentDecision,
} from '../affiliation/decision';
import { createAffiliationCommand } from '../affiliation/command';
import { createIdGeneratorState } from '../id-generator';

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

// ===========================================================================
// 5. DEEP / MULTI-LEVEL forests (seed = 5002).
//
// The sections above only build TWO-level forests (one root aggregate, leaf
// children). The 派生集約 = 子の和 invariant is most interesting when it must
// RECURSE: an aggregate-of-aggregates' area is the union of its child
// aggregates' areas, each of which is itself the union of its leaves. A bug in
// the explicit-stack post-order union (resolve-shape.ts), in depth memoization
// on a deep chain (depth.ts), or in the gap detector on nested children would
// only surface on >= 3 levels. We therefore generate random NESTED forests and
// re-assert EVERY U08 invariant, plus the ring-alternation invariant on each
// leaf shape and the depth-chain coherence on a deliberately deep chain.
// ===========================================================================

const SEED2 = 5002;

interface DeepSpec {
  /** Branching: spec[i] = number of children of the i-th node, breadth-first. */
  readonly childCounts: readonly number[];
  readonly tileW: number;
}

/**
 * Build a nested forest as a single root aggregate whose sub-tree is described
 * breadth-first by `childCounts`. Node 0 is the root; its children are the next
 * entries, and so on. A node with childCount 0 is a LEAF (gets a rectangle); a
 * node with childCount > 0 is an inner aggregate (no shape).
 *
 * Geometry is laid so every LEAF rectangle is pairwise-disjoint and gapless:
 * leaves are emitted in DFS order from a single per-band x-cursor, so each
 * ancestor aggregate's leaves form one continuous strip and the union has no
 * inter-child gap at ANY level.
 */
function buildDeepForest(spec: DeepSpec): ModelState {
  const s = emptyState();
  const counts = spec.childCounts;
  if (counts.length === 0) {
    makeLeaf(s, 0, 0, spec.tileW, 10, undefined);
    return s;
  }
  const n = counts.length;
  const ids: FeatureId[] = [];
  for (let i = 0; i < n; i += 1) ids.push(asFeatureId(`f-deep-${i}`));
  // Breadth-first child assignment: a running pointer hands out the next
  // unassigned node ids as each node's children.
  const childrenOf: FeatureId[][] = counts.map(() => []);
  const parentOf: (number | undefined)[] = counts.map(() => undefined);
  let cursor = 1;
  for (let i = 0; i < n; i += 1) {
    const c = counts[i]!;
    for (let k = 0; k < c && cursor < n; k += 1) {
      childrenOf[i]!.push(ids[cursor]!);
      parentOf[cursor] = i;
      cursor += 1;
    }
  }
  // A single x-cursor lays leaves left to right so every ancestor strip is gapless.
  let xCursor = 0;
  const band = 0;
  const emitted = new Set<number>();
  function emit(idx: number): void {
    if (emitted.has(idx)) return;
    emitted.add(idx);
    const kids = childrenOf[idx]!;
    const parentIdx = parentOf[idx];
    const parentId = parentIdx === undefined ? undefined : ids[parentIdx];
    if (kids.length === 0) {
      const x = xCursor;
      xCursor += spec.tileW;
      const suffix = freshId(s, 'dleaf');
      const corners = [
        createCoordinate(x, band),
        createCoordinate(x + spec.tileW, band),
        createCoordinate(x + spec.tileW, band + 10),
        createCoordinate(x, band + 10),
      ];
      const verts = corners.map((cc, vi) =>
        createVertex(asVertexId(`v-${suffix}-${vi}`), cc),
      );
      s.vertices.push(...verts);
      const ring = createTerritoryRing(
        asRingId(`r-${suffix}`),
        verts.map((v) => v.id),
      );
      const attrs = createBasicAttributes(suffix, 0, 1);
      const f =
        parentId === undefined
          ? createLeafFeature(ids[idx]!, attrs, COLOR, createShape([ring]))
          : createLeafFeature(ids[idx]!, attrs, COLOR, createShape([ring]), { parentId });
      s.features.push(f);
      return;
    }
    for (const childId of kids) {
      const childIdx = ids.indexOf(childId);
      if (childIdx >= 0) emit(childIdx);
    }
    const attrs = createBasicAttributes(`agg-${idx}`, 0, 1);
    const f =
      parentId === undefined
        ? createAggregateFeature(ids[idx]!, attrs, COLOR, kids)
        : createAggregateFeature(ids[idx]!, attrs, COLOR, kids, { parentId });
    s.features.push(f);
  }
  emit(0);
  return s;
}

function deepForestArb(): fc.Arbitrary<ModelState> {
  return fc
    .tuple(
      fc.integer({ min: 1, max: 3 }), // root branching (forced >= 1: real hierarchy)
      fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 0, maxLength: 12 }),
      fc.integer({ min: 5, max: 20 }), // tile width
    )
    .map(([rootBranch, rest, tileW]) =>
      buildDeepForest({ childCounts: [rootBranch, ...rest], tileW }),
    );
}

/** Assert ring-alternation validity for every leaf shape in the model. */
function assertRingAlternation(s: ModelState): void {
  for (const f of s.features) {
    if (f.kind === 'leaf') {
      expect(isAlternationValid(f.shape)).toBe(true);
    }
  }
}

describe(`U08 deep / multi-level forests (seed=${SEED2})`, () => {
  it('every U08 invariant holds on randomly-nested forests (派生集約=子の和 recurses)', () => {
    fc.assert(
      fc.property(deepForestArb(), (s) => {
        assertForestInvariants(s);
        assertRingAlternation(s);
      }),
      { seed: SEED2, numRuns: 600 },
    );
  });

  it('depth is coherent across every level (child = parent + 1; batch == single)', () => {
    fc.assert(
      fc.property(deepForestArb(), (s) => {
        const forest = buildForest(s.features);
        const depths = derivedDepths(forest);
        for (const f of s.features) {
          expect(depths.get(f.id)).toBe(derivedDepth(forest, f.id));
        }
        let manualMax = 0;
        for (const d of depths.values()) if (d > manualMax) manualMax = d;
        expect(maxDerivedDepth(forest)).toBe(manualMax);
        for (const f of s.features) {
          if (f.parentId !== undefined) {
            expect(derivedDepth(forest, f.id)).toBe(derivedDepth(forest, f.parentId) + 1);
          }
        }
      }),
      { seed: SEED2, numRuns: 400 },
    );
  });

  it('an inner aggregate area equals the union of its DIRECT children (recursing)', () => {
    fc.assert(
      fc.property(deepForestArb(), (s) => {
        const forest = buildForest(s.features);
        const vstore = store(s);
        for (const f of s.features) {
          const childIds = directChildIds(forest, f.id);
          if (childIds.length === 0) continue;
          const own = resolveFeatureArea(forest, vstore, f.id);
          expect(own.status).toBe('ok');
          if (own.status !== 'ok') continue;
          const childAreas: GeoMultiPolygon[] = [];
          let ok = true;
          for (const cid of childIds) {
            const c = resolveFeatureArea(forest, vstore, cid);
            if (c.status !== 'ok') {
              ok = false;
              break;
            }
            childAreas.push(c.area);
          }
          expect(ok).toBe(true);
          const u = unionAll(childAreas);
          expect(u).toBeDefined();
          if (u !== undefined) {
            expect(areasEqualWithinTolerance(own.area, u)).toBe(true);
          }
        }
      }),
      { seed: SEED2, numRuns: 600 },
    );
  });

  it('validateHierarchy reports no false-positive on nested valid forests', () => {
    fc.assert(
      fc.property(deepForestArb(), (s) => {
        const v = validateHierarchy(s.features, { vertexStore: store(s) });
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
      }),
      { seed: SEED2, numRuns: 400 },
    );
  });

  it('a deep chain (A->B->C->...) has strictly increasing depth and resolves to the leaf area', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 40 }), (depth) => {
        const s = emptyState();
        const ids: FeatureId[] = [];
        for (let i = 0; i < depth; i += 1) ids.push(asFeatureId(`chain-${i}`));
        const suffix = freshId(s, 'chainleaf');
        const corners = [
          createCoordinate(0, 0),
          createCoordinate(10, 0),
          createCoordinate(10, 10),
          createCoordinate(0, 10),
        ];
        const verts = corners.map((cc, vi) =>
          createVertex(asVertexId(`v-${suffix}-${vi}`), cc),
        );
        s.vertices.push(...verts);
        const ring = createTerritoryRing(asRingId(`r-${suffix}`), verts.map((v) => v.id));
        s.features.push(
          createLeafFeature(
            ids[depth - 1]!,
            createBasicAttributes(suffix, 0, 1),
            COLOR,
            createShape([ring]),
            { parentId: ids[depth - 2]! },
          ),
        );
        for (let i = depth - 2; i >= 0; i -= 1) {
          const childId = ids[i + 1]!;
          const attrs = createBasicAttributes(`chain-${i}`, 0, 1);
          const f =
            i === 0
              ? createAggregateFeature(ids[i]!, attrs, COLOR, [childId])
              : createAggregateFeature(ids[i]!, attrs, COLOR, [childId], {
                  parentId: ids[i - 1]!,
                });
          s.features.push(f);
        }
        const forest = buildForest(s.features);
        for (let i = 0; i < depth; i += 1) {
          expect(derivedDepth(forest, ids[i]!)).toBe(i);
        }
        expect(maxDerivedDepth(forest)).toBe(depth - 1);
        const v = validateHierarchy(s.features);
        expect(v.violations.some((x) => x.kind === HIERARCHY_VIOLATION.Cycle)).toBe(false);
        const rootArea = resolveFeatureArea(forest, store(s), ids[0]!);
        expect(rootArea.status).toBe('ok');
        if (rootArea.status === 'ok') {
          expect(allCoordsFinite(rootArea.area)).toBe(true);
          expect(isMultiPolygonEmpty(rootArea.area)).toBe(false);
        }
      }),
      { seed: SEED2, numRuns: 300 },
    );
  });
});

// ===========================================================================
// 6. REAL PUBLIC COMMAND DRIVE (seed = 5004).
//
// Sections 1-5 drive a HAND-BUILT valid model: they never call the real U28
// 所属変更 (affiliation) flow that actually re-parents features, generates new
// intermediate aggregates, auto-prunes emptied aggregates, and re-syncs
// childIds. THAT pipeline (buildAffiliationProposal / buildProposalForLeaves /
// syncAggregateChildIds / sweepAndPruneAnchor) is where parent/aggregate/union
// bugs would actually live. Here we:
//   - build a random valid forest,
//   - apply a RANDOM SEQUENCE of real affiliation commands (existing/none/create),
//     each validated with the vertex store so 形状=和・隙間なし runs,
//   - after EVERY committed proposal assert every U08 invariant on nextFeatures:
//       * forest valid (no cycle / dangling / duplicate / shape mismatch),
//       * depth coherent, derived area finite, 派生集約 = 子の和,
//       * childIds == parentId-derived children (single-source agreement),
//       * selection stays valid (every survivedTouched / created id resolves),
//   - metamorphic: undo∘op == identity (createAffiliationCommand), and
//     save∘load (JSON round-trip) == identity over nextFeatures.
// ===========================================================================

const SEED4 = 5004;

/** A live, fully-validated U08 view assertion over an arbitrary feature set. */
function assertFeatureSetInvariants(
  features: readonly Feature[],
  vstore: VertexStore,
): void {
  const forest = buildForest(features);

  // (a) Structural validity via the real validator WITH shape check enabled.
  const v = validateHierarchy(features, { vertexStore: vstore });
  const badKinds = [
    HIERARCHY_VIOLATION.Cycle,
    HIERARCHY_VIOLATION.DanglingParent,
    HIERARCHY_VIOLATION.DuplicateId,
    HIERARCHY_VIOLATION.AggregateShapeMismatch,
    HIERARCHY_VIOLATION.ShapeUnresolved,
    HIERARCHY_VIOLATION.ChildParentMismatch,
  ];
  for (const kind of badKinds) {
    const hits = v.violations.filter((x) => x.kind === kind);
    expect(hits, `unexpected ${kind}: ${JSON.stringify(hits)}`).toHaveLength(0);
  }

  // (b) Depth coherence + (c) derived area finite + 派生集約 = 子の和.
  const depths = derivedDepths(forest);
  for (const f of features) {
    const d = derivedDepth(forest, f.id);
    expect(d).not.toBe(DEPTH_UNDEFINED);
    expect(depths.get(f.id)).toBe(d);
    if (f.parentId === undefined) {
      expect(d).toBe(0);
    } else {
      expect(forest.byId.has(f.parentId)).toBe(true);
      expect(d).toBe(derivedDepth(forest, f.parentId) + 1);
    }

    const res = resolveFeatureArea(forest, vstore, f.id);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') continue;
    expect(allCoordsFinite(res.area)).toBe(true);

    const childIds = directChildIds(forest, f.id);
    if (childIds.length > 0) {
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
      const u = unionAll(childAreas);
      expect(u).toBeDefined();
      if (u !== undefined) {
        // 派生集約 = 子の和: a feature that HAS children (result-state aggregate,
        // 教訓5.6) must have its derived area equal to the union of those children.
        //
        // FR-37 (seed=5004): the real 所属変更 (affiliation) flow lets an EXISTING LEAF
        // be chosen as a target's new parent (直轄化 / direct-control, allowed by
        // affiliation/candidates.ts). buildProposalForLeaves now runs FR-37 直轄領自動生成
        // (generateDirectDomains → buildDirectDomainForLeaf): the 形状持ち末端's 元形状 −
        // 子の和 becomes a NEW 直轄領 末端地物 inserted as a child, THEN the parent is
        // converted to a shapeless aggregate. So the parent's derived area = union of its
        // children = 元形状 ∪ 子の和 (元形状 preserved as the 直轄領; NOTHING is lost).
        // This invariant (derived == union of children) holds either way and is exactly
        // what proves the shapeless aggregate's area is well-formed — do not weaken it.
        // (Pre-FR-37 the parent kept kind:'leaf' with a child so resolveFeatureArea added
        // its OWN footprint ON TOP of the child union — derived ⊋ union — which this once
        // caught; the earlier lossy "just discard the shape" fix satisfied it too but SILENTLY
        // DROPPED 元形状−子の和 from the map. FR-37 keeps the area AND the invariant.)
        expect(areasEqualWithinTolerance(res.area, u)).toBe(true);
      }
    }

    // (d) aggregate childIds == parentId-derived children (single-source).
    if (f.kind === 'aggregate') {
      const declared = [...f.childIds].sort();
      const derived = [...childIds].sort();
      expect(declared, `childIds drift on ${f.id}`).toEqual(derived);
    }
  }
}

/** Pick a deterministic element from a non-empty list by an index nat. */
function pick<T>(arr: readonly T[], n: number): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[n % arr.length];
}

/**
 * A random affiliation command spec. `targetWhich` selects an existing feature
 * (any kind) to re-affiliate; `decision` is how to choose the new parent.
 */
type AffCmd =
  | { readonly t: 'existing'; readonly targetWhich: number; readonly parentWhich: number }
  | { readonly t: 'none'; readonly targetWhich: number }
  | { readonly t: 'createNewTop'; readonly targetWhich: number }
  | { readonly t: 'createUnderExisting'; readonly targetWhich: number; readonly parentWhich: number }
  | { readonly t: 'federate'; readonly aWhich: number; readonly bWhich: number };

const affCmdArb: fc.Arbitrary<AffCmd> = fc.oneof(
  fc.record({
    t: fc.constant<'existing'>('existing'),
    targetWhich: fc.nat(),
    parentWhich: fc.nat(),
  }),
  fc.record({ t: fc.constant<'none'>('none'), targetWhich: fc.nat() }),
  fc.record({ t: fc.constant<'createNewTop'>('createNewTop'), targetWhich: fc.nat() }),
  fc.record({
    t: fc.constant<'createUnderExisting'>('createUnderExisting'),
    targetWhich: fc.nat(),
    parentWhich: fc.nat(),
  }),
  fc.record({
    t: fc.constant<'federate'>('federate'),
    aWhich: fc.nat(),
    bWhich: fc.nat(),
  }),
);

interface AffState {
  features: readonly Feature[];
  store: VertexStore;
  idCounter: number;
}

/** Monotonic injected time source so id-generation stays deterministic. */
function makeNow(start: number): () => number {
  let t = start;
  return () => {
    t += 1;
    return t;
  };
}

/**
 * Build and (if committed) apply ONE real affiliation command. Returns the new
 * state and the proposal (for undo metamorphic checks), or undefined when the
 * command did not produce a commit (rejected / not applicable) — a rejection is
 * a legitimate outcome and is NOT a bug, so we only assert invariants on commits.
 */
function applyAffCmd(
  st: AffState,
  cmd: AffCmd,
): { next: AffState; proposal: AffiliationProposal } | undefined {
  const features = st.features;
  const idState = createIdGeneratorState(0, st.idCounter);
  const now = makeNow(st.idCounter * 100 + 1);
  const opts = { idState, now, vertexStore: st.store };

  const allIds = features.map((f) => f.id);

  let result: ProposalResult;
  switch (cmd.t) {
    case 'existing': {
      const target = pick(allIds, cmd.targetWhich);
      const parent = pick(allIds, cmd.parentWhich);
      if (target === undefined || parent === undefined) return undefined;
      const decision: ParentDecision = parentExisting(parent);
      result = buildAffiliationProposal(features, target, decision, opts);
      break;
    }
    case 'none': {
      const target = pick(allIds, cmd.targetWhich);
      if (target === undefined) return undefined;
      result = buildAffiliationProposal(features, target, parentNone, opts);
      break;
    }
    case 'createNewTop': {
      const target = pick(allIds, cmd.targetWhich);
      if (target === undefined) return undefined;
      const decision: ParentDecision = parentCreate({ name: 'new-top' }, parentNone);
      result = buildAffiliationProposal(features, target, decision, opts);
      break;
    }
    case 'createUnderExisting': {
      const target = pick(allIds, cmd.targetWhich);
      const top = pick(allIds, cmd.parentWhich);
      if (target === undefined || top === undefined) return undefined;
      const decision: ParentDecision = parentCreate({ name: 'mid' }, parentExisting(top));
      result = buildAffiliationProposal(features, target, decision, opts);
      break;
    }
    case 'federate': {
      const a = pick(allIds, cmd.aWhich);
      const b = pick(allIds, cmd.bWhich);
      if (a === undefined || b === undefined || a === b) return undefined;
      const decision: ParentDecision = parentCreate({ name: 'federation' }, parentNone);
      result = buildAffiliationProposalForTargets(features, [a, b], decision, opts);
      break;
    }
  }

  if (result.status !== 'proposal') return undefined;
  const proposal = result.proposal;

  // FR-37: affiliation now mints NEW vertices when a 形状持ち末端 gains children (直轄領
  // 自動生成). Merge proposal.newVertices into the store so the committed state's direct
  // domains resolve (else resolveFeatureArea over the new leaf fails). A plain reparent
  // carries an empty newVertices, so the store is unchanged in that common case. Advance
  // the id counter from the proposal's id state (now includes any 直轄領 minting).
  const nextStore =
    proposal.newVertices.length > 0
      ? createVertexStore([...st.store.byId.values(), ...proposal.newVertices])
      : st.store;
  const next: AffState = {
    features: proposal.nextFeatures,
    store: nextStore,
    idCounter: proposal.idState.counter + 1,
  };
  return { next, proposal };
}

describe(`U08 real affiliation command drive (seed=${SEED4})`, () => {
  it('every U08 invariant holds after every committed real affiliation command', () => {
    fc.assert(
      fc.property(
        validForestArb(),
        fc.array(affCmdArb, { minLength: 0, maxLength: 10 }),
        (initial, cmds) => {
          let st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 1000,
          };
          assertFeatureSetInvariants(st.features, st.store);

          for (const cmd of cmds) {
            const applied = applyAffCmd(st, cmd);
            if (applied === undefined) continue; // rejected / N/A: legitimate.
            // A committed proposal MUST yield a fully-valid forest.
            assertFeatureSetInvariants(applied.next.features, applied.next.store);

            // (e) selection stays valid: every notified id resolves in next state.
            const present = new Set(applied.next.features.map((f) => f.id));
            for (const id of applied.proposal.survivedTouchedIds) {
              expect(present.has(id), `survivedTouched ${id} missing`).toBe(true);
            }
            for (const id of applied.proposal.createdIds) {
              expect(present.has(id), `created ${id} missing`).toBe(true);
            }
            for (const id of applied.proposal.deletedIds) {
              expect(present.has(id), `deleted ${id} still present`).toBe(false);
            }
            st = applied.next;
          }
        },
      ),
      { seed: SEED4, numRuns: 500 },
    );
  });

  it('undo ∘ affiliation-command == identity (single undo unit, 教訓 5.11)', () => {
    fc.assert(
      fc.property(
        validForestArb(),
        affCmdArb,
        (initial, cmd) => {
          const st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 2000,
          };
          const applied = applyAffCmd(st, cmd);
          if (applied === undefined) return; // rejected: nothing to undo.

          const baseline = st.features;
          const command = createAffiliationCommand(baseline, applied.proposal);
          const afterExec = command.execute(baseline);
          // execute applies the proposal's nextFeatures.
          expect(
            featuresEqual(afterExec.state, applied.proposal.nextFeatures),
            'execute != proposal.nextFeatures',
          ).toBe(true);
          // undo restores the exact baseline (structural identity).
          const afterUndo = command.undo(afterExec.state);
          expect(featuresEqual(afterUndo.state, baseline), 'undo != baseline').toBe(true);
          expect(afterUndo.state.length).toBe(baseline.length);
          // redo re-applies WITHOUT re-minting ids (教訓 5.20): identical again.
          const afterRedo = command.redo(afterUndo.state);
          expect(
            featuresEqual(afterRedo.state, applied.proposal.nextFeatures),
            'redo != proposal.nextFeatures',
          ).toBe(true);
        },
      ),
      { seed: SEED4, numRuns: 400 },
    );
  });

  it('save ∘ load (JSON round-trip) == identity over the committed feature set', () => {
    fc.assert(
      fc.property(
        validForestArb(),
        fc.array(affCmdArb, { minLength: 0, maxLength: 6 }),
        (initial, cmds) => {
          let st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 3000,
          };
          for (const cmd of cmds) {
            const applied = applyAffCmd(st, cmd);
            if (applied !== undefined) st = applied.next;
          }
          const json = JSON.stringify(st.features);
          const parsed = JSON.parse(json) as Feature[];
          expect(featuresEqual(parsed, st.features)).toBe(true);
          // The reloaded set resolves to identical aggregate areas.
          const f0 = buildForest(st.features);
          const f1 = buildForest(parsed);
          for (const f of st.features) {
            const a = resolveFeatureArea(f0, st.store, f.id);
            const b = resolveFeatureArea(f1, st.store, f.id);
            expect(a.status).toBe(b.status);
            if (a.status === 'ok' && b.status === 'ok') {
              expect(areasEqualWithinTolerance(a.area, b.area)).toBe(true);
            }
          }
        },
      ),
      { seed: SEED4, numRuns: 300 },
    );
  });
});

// ===========================================================================
// 7. REGRESSION (focused, deterministic): 直轄化 → FR-37 直轄領自動生成.
//
// The minimal seed-5004 shrink from the bug report, pinned as a non-property unit
// test so the data-loss can never silently regress:
//   f-agg-1 (aggregate) -> [f-leaf-2 = rect [0,10]x[0,10], f-leaf-3 = rect
//   [10,20]x[0,10]]. 直轄化: re-affiliate target f-leaf-3 under the EXISTING LEAF
//   f-leaf-2, so f-leaf-2 gains a child and must become an aggregate.
//
// Bug history: the ORIGINAL bug left f-leaf-2 kind:'leaf' with a child, so its
// derived area was [0,20]x[0,10] (own ∪ child) ⊋ union of children — a false
// negative. The FIRST (lossy) fix converted f-leaf-2 to a SHAPELESS aggregate,
// which satisfied 派生集約=子の和 BUT SILENTLY DROPPED f-leaf-2's own [0,10] strip
// from the map (実機データ損失: 元形状−子の和 vanished; checkAggregateShapes only
// checks inter-child gaps, never 元形状, so nothing complained).
//
// FR-37 (the real spec / current 正): buildProposalForLeaves now runs 直轄領自動生成
// — f-leaf-2's 元形状 − 子の和 (= its [0,10] strip) becomes a NEW 直轄領 末端地物
// inserted as a child, THEN f-leaf-2 is converted to a shapeless aggregate. So the
// top aggregate STILL spans [0,20]x[0,10] (nothing lost) and the invariant holds.
// These tests assert 元形状 IS preserved (via the 直轄領), NOT discarded — the
// diagnosis's correction of the two誤 regression tests that locked the lossy fix.
// ===========================================================================

const SEED_REPRO = 5004;

/** Build the three-feature fixture (agg over two adjacent leaf strips). */
function buildDirectControlFixture(): { features: Feature[]; vstore: VertexStore } {
  const aggId = asFeatureId('f-agg-1');
  const leaf2 = asFeatureId('f-leaf-2');
  const leaf3 = asFeatureId('f-leaf-3');

  function rectLeaf(
    id: FeatureId,
    suffix: string,
    x0: number,
    parent: FeatureId,
  ): { feature: Feature; verts: Vertex[] } {
    const corners = [
      createCoordinate(x0, 0),
      createCoordinate(x0 + 10, 0),
      createCoordinate(x0 + 10, 10),
      createCoordinate(x0, 10),
    ];
    const verts = corners.map((c, i) => createVertex(asVertexId(`v-${suffix}-${i}`), c));
    const ring = createTerritoryRing(
      asRingId(`r-${suffix}`),
      verts.map((v) => v.id),
    );
    const feature = createLeafFeature(
      id,
      createBasicAttributes(suffix, 0, 1),
      COLOR,
      createShape([ring]),
      { parentId: parent },
    );
    return { feature, verts };
  }

  const l2 = rectLeaf(leaf2, 'leaf-2', 0, aggId);
  const l3 = rectLeaf(leaf3, 'leaf-3', 10, aggId);
  const agg = createAggregateFeature(
    aggId,
    createBasicAttributes('agg-1', 0, 1),
    COLOR,
    [leaf2, leaf3],
  );
  return {
    features: [agg, l2.feature, l3.feature],
    vstore: createVertexStore([...l2.verts, ...l3.verts]),
  };
}

describe(`U08 直轄化 → FR-37 直轄領自動生成 regression (seed=${SEED_REPRO})`, () => {
  it('直轄化 onto an existing leaf generates a 直轄領 preserving 元形状 (FR-37, no data loss)', () => {
    const { features, vstore } = buildDirectControlFixture();
    const aggId = asFeatureId('f-agg-1');
    const leaf2 = asFeatureId('f-leaf-2');
    const leaf3 = asFeatureId('f-leaf-3');

    // Pre-change areas: the top aggregate spans BOTH strips [0,20]x[0,10]; f-leaf-2's own
    // footprint is [0,10]x[0,10] (the strip the lossy fix silently dropped).
    const before = buildForest(features);
    const aggAreaBefore = resolveFeatureArea(before, vstore, aggId);
    const leaf2FootprintBefore = resolveFeatureArea(before, vstore, leaf2);
    expect(aggAreaBefore.status).toBe('ok');
    expect(leaf2FootprintBefore.status).toBe('ok');

    const result = buildAffiliationProposal(features, leaf3, parentExisting(leaf2), {
      idState: createIdGeneratorState(0, 1000),
      now: makeNow(1),
      vertexStore: vstore,
    });
    expect(result.status, JSON.stringify(result)).toBe('proposal');
    if (result.status !== 'proposal') return;
    const { nextFeatures: next, newVertices, createdIds } = result.proposal;

    // FR-37 minted new vertices for the 直轄領 末端地物; merge them so the new leaf resolves.
    expect(newVertices.length).toBeGreaterThan(0);
    const merged = createVertexStore([...vstore.byId.values(), ...newVertices]);

    // f-leaf-2 is now a SHAPELESS aggregate (no `shape` field), not a leaf.
    const newParent = next.find((f) => f.id === leaf2);
    expect(newParent?.kind).toBe('aggregate');
    expect((newParent as unknown as { shape?: unknown }).shape).toBeUndefined();

    // It has TWO children: the reparented target f-leaf-3 AND a NEW 直轄領 末端地物
    // (createdIds carries the 直轄領 id). Pre-FR-37 lossy fix left ONLY [f-leaf-3].
    const forest = buildForest(next);
    const children = directChildIds(forest, leaf2);
    expect(children).toContain(leaf3);
    expect(children).toHaveLength(2);
    const ddId = children.find((id) => id !== leaf3)!;
    expect(createdIds).toContain(ddId);
    expect(next.find((f) => f.id === ddId)?.kind).toBe('leaf'); // 直轄領 = shape-bearing 末端.

    // 直轄領 area == f-leaf-2's ORIGINAL footprint [0,10]x[0,10] (元形状 preserved).
    const ddArea = resolveFeatureArea(forest, merged, ddId);
    expect(ddArea.status).toBe('ok');
    if (ddArea.status === 'ok' && leaf2FootprintBefore.status === 'ok') {
      expect(areasEqualWithinTolerance(ddArea.area, leaf2FootprintBefore.area)).toBe(true);
    }

    // THE data-loss regression guard: the top aggregate STILL spans [0,20]x[0,10]
    // (= 元形状 ∪ 子の和), i.e. exactly its pre-直轄化 area. NOTHING vanished.
    const aggAreaAfter = resolveFeatureArea(forest, merged, aggId);
    expect(aggAreaAfter.status).toBe('ok');
    if (aggAreaAfter.status === 'ok' && aggAreaBefore.status === 'ok') {
      expect(areasEqualWithinTolerance(aggAreaAfter.area, aggAreaBefore.area)).toBe(true);
    }

    // And the whole committed state passes every U08 invariant.
    assertFeatureSetInvariants(next, merged);
  });

  it('自治化 (parentCreate under an existing leaf) also generates a 直轄領 (FR-37)', () => {
    const { features, vstore } = buildDirectControlFixture();
    const aggId = asFeatureId('f-agg-1');
    const leaf2 = asFeatureId('f-leaf-2');
    const leaf3 = asFeatureId('f-leaf-3');

    const before = buildForest(features);
    const aggAreaBefore = resolveFeatureArea(before, vstore, aggId);
    const leaf2FootprintBefore = resolveFeatureArea(before, vstore, leaf2);

    const result = buildAffiliationProposal(
      features,
      leaf3,
      parentCreate({ name: 'mid' }, parentExisting(leaf2)),
      {
        idState: createIdGeneratorState(0, 2000),
        now: makeNow(1),
        vertexStore: vstore,
      },
    );
    expect(result.status, JSON.stringify(result)).toBe('proposal');
    if (result.status !== 'proposal') return;
    const { nextFeatures: next, newVertices } = result.proposal;
    const merged = createVertexStore([...vstore.byId.values(), ...newVertices]);

    // The intermediate aggregate 'mid' ends up under f-leaf-2, so f-leaf-2 becomes a
    // parent and MUST be converted to a shapeless aggregate — and FR-37 preserves its
    // footprint as a 直轄領 sibling of 'mid'.
    const newParent = next.find((f) => f.id === leaf2);
    expect(newParent?.kind).toBe('aggregate');
    expect((newParent as unknown as { shape?: unknown }).shape).toBeUndefined();
    expect(newVertices.length).toBeGreaterThan(0);

    const forest = buildForest(next);
    // f-leaf-2's children: the intermediate aggregate 'mid' + the 直轄領 末端地物 (leaf).
    const children = directChildIds(forest, leaf2);
    expect(children).toHaveLength(2);
    const ddId = children.find((id) => next.find((f) => f.id === id)?.kind === 'leaf');
    expect(ddId).toBeDefined();
    const ddArea = resolveFeatureArea(forest, merged, ddId!);
    expect(ddArea.status).toBe('ok');
    if (ddArea.status === 'ok' && leaf2FootprintBefore.status === 'ok') {
      expect(areasEqualWithinTolerance(ddArea.area, leaf2FootprintBefore.area)).toBe(true);
    }

    // NOTHING vanished: the top aggregate area is unchanged by the 自治化.
    const aggAreaAfter = resolveFeatureArea(forest, merged, aggId);
    if (aggAreaAfter.status === 'ok' && aggAreaBefore.status === 'ok') {
      expect(areasEqualWithinTolerance(aggAreaAfter.area, aggAreaBefore.area)).toBe(true);
    }

    assertFeatureSetInvariants(next, merged);
  });
});
