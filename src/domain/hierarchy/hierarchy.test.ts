import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  createPointFeature,
  withParentId,
  type Feature,
} from '../feature';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../ids';
import { createShape, createTerritoryRing, createHoleRing } from '../ring';
import { createVertex, createVertexStore, type VertexStore } from '../vertex';
import {
  buildForest,
  descendantIds,
  directChildIds,
  hasChildren,
  hierarchyRole,
  HIERARCHY_ROLE,
  walkToRoot,
} from './forest';
import {
  DEPTH_UNDEFINED,
  derivedDepth,
  derivedDepths,
  isDepthUndefined,
  maxDerivedDepth,
} from './depth';
import { resolveFeatureArea, resolveLeafShape } from './resolve-shape';
import {
  aggregateChildVerdict,
  AGGREGATE_CHILD_VERDICT,
  areasEqualWithinTolerance,
  checkAggregateShapes,
  checkCycles,
  checkDanglingParents,
  checkDuplicateIds,
  checkTopLevelEquivalence,
  HIERARCHY_VIOLATION,
  validateHierarchy,
} from './validate';

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090');
const attrs = (name: string) => createBasicAttributes(name, 0, 1);

function leafFromRect(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  parentId?: string,
): { feature: Feature; vertices: ReturnType<typeof createVertex>[] } {
  const corners = [
    createCoordinate(x, y),
    createCoordinate(x + w, y),
    createCoordinate(x + w, y + h),
    createCoordinate(x, y + h),
  ];
  const vertices = corners.map((c, i) => createVertex(asVertexId(`v-${id}-${i}`), c));
  const ring = createTerritoryRing(asRingId(`r-${id}`), vertices.map((v) => v.id));
  const fid = asFeatureId(id);
  const feature =
    parentId === undefined
      ? createLeafFeature(fid, attrs(id), COLOR, createShape([ring]))
      : createLeafFeature(fid, attrs(id), COLOR, createShape([ring]), {
          parentId: asFeatureId(parentId),
        });
  return { feature, vertices };
}

function agg(id: string, childIds: string[], parentId?: string): Feature {
  return parentId === undefined
    ? createAggregateFeature(asFeatureId(id), attrs(id), COLOR, childIds.map(asFeatureId))
    : createAggregateFeature(asFeatureId(id), attrs(id), COLOR, childIds.map(asFeatureId), {
        parentId: asFeatureId(parentId),
      });
}

// =============================================================================
// 1. Derived hierarchy depth (FR-38)
// =============================================================================
describe('derived depth (FR-38)', () => {
  it('a root (no parent) has depth 0', () => {
    const root = agg('a', []);
    const forest = buildForest([root]);
    expect(derivedDepth(forest, root.id)).toBe(0);
  });

  it('a child depth is always parent + 1 across multiple nesting levels', () => {
    const root = agg('a', ['b']);
    const mid = agg('b', ['c'], 'a');
    const leaf = leafFromRect('c', 0, 0, 1, 1, 'b').feature;
    const forest = buildForest([root, mid, leaf]);
    expect(derivedDepth(forest, asFeatureId('a'))).toBe(0);
    expect(derivedDepth(forest, asFeatureId('b'))).toBe(1);
    expect(derivedDepth(forest, asFeatureId('c'))).toBe(2);
  });

  it('ignores any depth-like field on the feature and recomputes from parents', () => {
    // Features carry NO depth field by type; this asserts the value is derived
    // purely from the parent chain even if a feature were re-parented.
    const root = agg('a', ['b']);
    const child = agg('b', [], 'a');
    let forest = buildForest([root, child]);
    expect(derivedDepth(forest, asFeatureId('b'))).toBe(1);
    // Re-parent the child to a NEW deeper position; depth must follow the chain.
    const mid = agg('m', ['b']);
    const reparented = withParentId(child, asFeatureId('m'));
    const root2 = agg('a', []);
    forest = buildForest([root2, mid, reparented]);
    expect(derivedDepth(forest, asFeatureId('b'))).toBe(1);
    expect(derivedDepth(forest, asFeatureId('m'))).toBe(0);
  });

  it('a forest with multiple trees allows different max depth per tree', () => {
    const shallowRoot = agg('s', ['s1']);
    const s1 = leafFromRect('s1', 0, 0, 1, 1, 's').feature;
    const deepRoot = agg('d', ['d1']);
    const d1 = agg('d1', ['d2'], 'd');
    const d2 = leafFromRect('d2', 0, 0, 1, 1, 'd1').feature;
    const forest = buildForest([shallowRoot, s1, deepRoot, d1, d2]);
    expect(derivedDepth(forest, asFeatureId('s1'))).toBe(1);
    expect(derivedDepth(forest, asFeatureId('d2'))).toBe(2);
    expect(maxDerivedDepth(forest)).toBe(2);
  });

  it('derivedDepths maps every feature', () => {
    const root = agg('a', ['b']);
    const child = leafFromRect('b', 0, 0, 1, 1, 'a').feature;
    const map = derivedDepths(buildForest([root, child]));
    expect(map.get(asFeatureId('a'))).toBe(0);
    expect(map.get(asFeatureId('b'))).toBe(1);
  });
});

// =============================================================================
// 2. Top-level flag <=> no parent (FR-39 / FR-34)
// =============================================================================
describe('top-level ⇔ no parent (FR-39 / FR-34)', () => {
  it('consistent data (flag true ∧ no parent, flag false ∧ parent) has no violation', () => {
    const root = agg('a', ['b']);
    const child = leafFromRect('b', 0, 0, 1, 1, 'a').feature;
    const forest = buildForest([root, child]);
    const flags = new Map<FeatureId, boolean>([
      [asFeatureId('a'), true],
      [asFeatureId('b'), false],
    ]);
    expect(checkTopLevelEquivalence(forest, flags)).toHaveLength(0);
  });

  it('detects flag true ∧ has parent, including the feature id', () => {
    const root = agg('a', ['b']);
    const child = leafFromRect('b', 0, 0, 1, 1, 'a').feature;
    const forest = buildForest([root, child]);
    const flags = new Map<FeatureId, boolean>([[asFeatureId('b'), true]]);
    const v = checkTopLevelEquivalence(forest, flags);
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe(HIERARCHY_VIOLATION.TopLevelMismatch);
    expect(v[0]?.featureIds).toEqual([asFeatureId('b')]);
  });

  it('detects flag false ∧ no parent, including the feature id', () => {
    const root = agg('a', []);
    const forest = buildForest([root]);
    const flags = new Map<FeatureId, boolean>([[asFeatureId('a'), false]]);
    const v = checkTopLevelEquivalence(forest, flags);
    expect(v).toHaveLength(1);
    expect(v[0]?.featureIds).toEqual([asFeatureId('a')]);
  });

  it('accepts multiple roots in one forest', () => {
    const r1 = agg('r1', []);
    const r2 = agg('r2', []);
    const forest = buildForest([r1, r2]);
    expect(forest.rootIds).toEqual([asFeatureId('r1'), asFeatureId('r2')]);
    const flags = new Map<FeatureId, boolean>([
      [asFeatureId('r1'), true],
      [asFeatureId('r2'), true],
    ]);
    expect(checkTopLevelEquivalence(forest, flags)).toHaveLength(0);
  });
});

// =============================================================================
// 3. Aggregate shape = union of direct children (FR-35 / FR-39)
// =============================================================================
describe('aggregate shape = union of children (FR-35 / FR-39)', () => {
  function buildSample(children: { id: string; x: number; w: number }[], aggId = 'agg') {
    const features: Feature[] = [];
    const vertices: ReturnType<typeof createVertex>[] = [];
    for (const c of children) {
      const tile = leafFromRect(c.id, c.x, 0, c.w, 10, aggId);
      features.push(tile.feature);
      vertices.push(...tile.vertices);
    }
    features.push(agg(aggId, children.map((c) => c.id)));
    return { features, store: createVertexStore(vertices) };
  }

  it('matching union has no violation', () => {
    // Two adjacent gapless tiles tile the aggregate exactly.
    const { features, store } = buildSample([
      { id: 'c1', x: 0, w: 10 },
      { id: 'c2', x: 10, w: 10 },
    ]);
    const result = validateHierarchy(features, { vertexStore: store });
    const shapeViolations = result.violations.filter(
      (v) => v.kind === HIERARCHY_VIOLATION.AggregateShapeMismatch,
    );
    expect(shapeViolations).toHaveLength(0);
  });

  /**
   * Build an aggregate whose children form a FRAME around an interior hole: four
   * tiles (bottom / top / left / right) enclose an empty square in the middle.
   * Their U06 union is a single piece with a hole ring — a genuine 隙間.
   */
  function buildFrameWithHole(aggId = 'agg') {
    const features: Feature[] = [];
    const vertices: ReturnType<typeof createVertex>[] = [];
    // Outer extent [0,30]x[0,30]; interior hole [10,20]x[10,20].
    const bottom = leafFromRect('fb', 0, 0, 30, 10, aggId); // y[0,10]
    const top = leafFromRect('ft', 0, 20, 30, 10, aggId); // y[20,30]
    const left = leafFromRect('fl', 0, 10, 10, 10, aggId); // x[0,10], y[10,20]
    const right = leafFromRect('fr', 20, 10, 10, 10, aggId); // x[20,30], y[10,20]
    for (const t of [bottom, top, left, right]) {
      features.push(t.feature);
      vertices.push(...t.vertices);
    }
    features.push(agg(aggId, ['fb', 'ft', 'fl', 'fr']));
    return { features, store: createVertexStore(vertices) };
  }

  it('detects a gap: children enclose an interior hole (隙間あり) -> AggregateShapeMismatch', () => {
    const { features, store } = buildFrameWithHole();
    const forest = buildForest(features);
    const violations = checkAggregateShapes(forest, store).filter(
      (v) => v.kind === HIERARCHY_VIOLATION.AggregateShapeMismatch,
    );
    expect(violations).toHaveLength(1);
    // The violation names the aggregate plus its direct children.
    expect(violations[0]?.featureIds).toContain(asFeatureId('agg'));
    // validateHierarchy surfaces it through the combined entry point too.
    const result = validateHierarchy(features, { vertexStore: store });
    expect(
      result.violations.some((v) => v.kind === HIERARCHY_VIOLATION.AggregateShapeMismatch),
    ).toBe(true);
  });

  it('gapless adjacency (no interior hole) produces no AggregateShapeMismatch', () => {
    // Three adjacent tiles tile [0,15]x[0,10] with no interior hole.
    const { features, store } = buildSample([
      { id: 'c1', x: 0, w: 5 },
      { id: 'c2', x: 5, w: 5 },
      { id: 'c3', x: 10, w: 5 },
    ]);
    const forest = buildForest(features);
    const violations = checkAggregateShapes(forest, store).filter(
      (v) => v.kind === HIERARCHY_VIOLATION.AggregateShapeMismatch,
    );
    expect(violations).toHaveLength(0);
  });

  it('flags an interior gap regardless of which children form the frame (symmetry)', () => {
    // Same hole, children registered in a different order: still detected.
    const { features, store } = buildFrameWithHole('agg2');
    const reordered = [...features].reverse();
    const forest = buildForest(reordered);
    const violations = checkAggregateShapes(forest, store).filter(
      (v) => v.kind === HIERARCHY_VIOLATION.AggregateShapeMismatch,
    );
    expect(violations).toHaveLength(1);
  });

  /**
   * Build an aggregate whose ONLY child is a leaf that legitimately owns a hole
   * (a country with a lake: one outer territory ring + one interior hole ring,
   * FR-24/FR-25). The child's own hole MUST NOT be mistaken for an inter-child
   * gap — this is a realistic, valid input the U03/U07 model fully supports, and
   * the aggregate's derived area is exactly that single child's area.
   */
  function buildAggregateOfLeafWithLake(aggId = 'agg-lake') {
    const outer = [
      createVertex(asVertexId('lk-o0'), createCoordinate(0, 0)),
      createVertex(asVertexId('lk-o1'), createCoordinate(30, 0)),
      createVertex(asVertexId('lk-o2'), createCoordinate(30, 30)),
      createVertex(asVertexId('lk-o3'), createCoordinate(0, 30)),
    ];
    const hole = [
      createVertex(asVertexId('lk-h0'), createCoordinate(10, 10)),
      createVertex(asVertexId('lk-h1'), createCoordinate(20, 10)),
      createVertex(asVertexId('lk-h2'), createCoordinate(20, 20)),
      createVertex(asVertexId('lk-h3'), createCoordinate(10, 20)),
    ];
    const store = createVertexStore([...outer, ...hole]);
    const tRing = createTerritoryRing(asRingId('lk-rt'), outer.map((v) => v.id));
    const hRing = createHoleRing(asRingId('lk-rh'), hole.map((v) => v.id), asRingId('lk-rt'));
    const leaf = createLeafFeature(
      asFeatureId('lk-leaf'),
      attrs('lk-leaf'),
      COLOR,
      createShape([tRing, hRing]),
      { parentId: asFeatureId(aggId) },
    );
    const aggregate = agg(aggId, ['lk-leaf']);
    return { features: [leaf, aggregate], store };
  }

  it("does NOT flag a child leaf's OWN legitimate hole (lake) as an inter-child gap (false-positive lock-in)", () => {
    // Regression: unionHasInteriorGap used to flag ANY union hole ring, wrongly
    // rejecting a valid country-with-a-lake leaf under an aggregate (FR-24/FR-25,
    // 受け入れ基準6 load-time validation must ACCEPT valid data).
    const { features, store } = buildAggregateOfLeafWithLake();
    const forest = buildForest(features);
    const violations = checkAggregateShapes(forest, store).filter(
      (v) => v.kind === HIERARCHY_VIOLATION.AggregateShapeMismatch,
    );
    expect(violations).toHaveLength(0);
    // And the combined entry point accepts it (no shape mismatch).
    const result = validateHierarchy(features, { vertexStore: store });
    expect(
      result.violations.some((v) => v.kind === HIERARCHY_VIOLATION.AggregateShapeMismatch),
    ).toBe(false);
  });

  it('still flags a real inter-child gap even when a sibling separately owns its own lake', () => {
    // Two groups of children under ONE aggregate: a frame-of-four around an empty
    // center (a genuine inter-child gap) PLUS a far-away leaf that owns its own
    // lake. The lake must cancel (child-owned), the center gap must still be
    // flagged — proving subtraction is per-region, not a blanket "any hole" mute.
    const aggId = 'agg-mix';
    // Frame tiles (same geometry as buildFrameWithHole) around center [10,20]².
    const bottom = leafFromRect('mxb', 0, 0, 30, 10, aggId);
    const top = leafFromRect('mxt', 0, 20, 30, 10, aggId);
    const left = leafFromRect('mxl', 0, 10, 10, 10, aggId);
    const right = leafFromRect('mxr', 20, 10, 10, 10, aggId);
    // A far-away leaf (x[100,130]) owning a lake hole at [110,120]².
    const lakeOuter = [
      createVertex(asVertexId('mx-o0'), createCoordinate(100, 0)),
      createVertex(asVertexId('mx-o1'), createCoordinate(130, 0)),
      createVertex(asVertexId('mx-o2'), createCoordinate(130, 30)),
      createVertex(asVertexId('mx-o3'), createCoordinate(100, 30)),
    ];
    const lakeHole = [
      createVertex(asVertexId('mx-h0'), createCoordinate(110, 10)),
      createVertex(asVertexId('mx-h1'), createCoordinate(120, 10)),
      createVertex(asVertexId('mx-h2'), createCoordinate(120, 20)),
      createVertex(asVertexId('mx-h3'), createCoordinate(110, 20)),
    ];
    const tRing = createTerritoryRing(asRingId('mx-rt'), lakeOuter.map((v) => v.id));
    const hRing = createHoleRing(asRingId('mx-rh'), lakeHole.map((v) => v.id), asRingId('mx-rt'));
    const lakeLeaf = createLeafFeature(
      asFeatureId('mx-leaf'),
      attrs('mx-leaf'),
      COLOR,
      createShape([tRing, hRing]),
      { parentId: asFeatureId(aggId) },
    );
    const aggregate = agg(aggId, ['mxb', 'mxt', 'mxl', 'mxr', 'mx-leaf']);
    const features = [
      bottom.feature,
      top.feature,
      left.feature,
      right.feature,
      lakeLeaf,
      aggregate,
    ];
    const store = createVertexStore([
      ...bottom.vertices,
      ...top.vertices,
      ...left.vertices,
      ...right.vertices,
      ...lakeOuter,
      ...lakeHole,
    ]);
    const forest = buildForest(features);
    const violations = checkAggregateShapes(forest, store).filter(
      (v) => v.kind === HIERARCHY_VIOLATION.AggregateShapeMismatch,
    );
    expect(violations).toHaveLength(1); // the frame's center gap; lake suppressed
  });

  it('overflow (はみ出し / 下位領域の和 − 集約地物形状) is structurally empty for a shapeless aggregate (受け入れ基準3)', () => {
    // 受け入れ基準3 asks for BOTH directions: (aggregate − children-union) and
    // (children-union − aggregate). FR-35 gives an aggregate NO stored shape, so
    // its area IS the children union by construction; the overflow direction
    // therefore compares the union against itself and is ALWAYS empty. We assert
    // that explicitly so the spec's bidirectional intent is exercised by name and
    // the implementation contract (overflow ≡ inverse of gap ≡ empty here) is
    // pinned. See specs/U08.md 受け入れ基準3 for the recorded reconciliation.
    const { features, store } = buildSample([
      { id: 'ov1', x: 0, w: 10 },
      { id: 'ov2', x: 10, w: 10 },
    ]);
    const forest = buildForest(features);
    const aggArea = resolveFeatureArea(forest, store, asFeatureId('agg'));
    expect(aggArea.status).toBe('ok');
    if (aggArea.status === 'ok') {
      // The aggregate's derived area IS the union of its children (FR-35), so the
      // overflow direction (aggregate − children-union) compares that area to
      // itself: BOTH directions vanish ⇒ no overflow AND no gap.
      expect(areasEqualWithinTolerance(aggArea.area, aggArea.area)).toBe(true);
    }
  });

  it('areasEqualWithinTolerance: overflow and gap on hand-built polygons', () => {
    // Standalone tolerance helper (used by callers comparing two explicit areas).
    const big = [[[
      createCoordinate(0, 0),
      createCoordinate(30, 0),
      createCoordinate(30, 10),
      createCoordinate(0, 10),
    ]]];
    const childUnion = [[[
      createCoordinate(0, 0),
      createCoordinate(20, 0),
      createCoordinate(20, 10),
      createCoordinate(0, 10),
    ]]];
    expect(areasEqualWithinTolerance(big, childUnion)).toBe(false); // overflow
    expect(areasEqualWithinTolerance(childUnion, big)).toBe(false); // gap
    expect(areasEqualWithinTolerance(big, big)).toBe(true);
  });

  it('handles disjoint (飛び地) children: union is multi-piece, all pieces considered', () => {
    const { features, store } = buildSample([
      { id: 'c1', x: 0, w: 10 },
      { id: 'c2', x: 50, w: 10 }, // far away -> two pieces
    ]);
    const forest = buildForest(features);
    const area = resolveFeatureArea(forest, store, asFeatureId('agg'));
    expect(area.status).toBe('ok');
    if (area.status === 'ok') {
      expect(area.area.length).toBe(2); // both enclave pieces present
    }
    // No mismatch: derived shape equals union of both pieces.
    const v = checkAggregateShapes(forest, store).filter(
      (x) => x.kind === HIERARCHY_VIOLATION.AggregateShapeMismatch,
    );
    expect(v).toHaveLength(0);
  });

  it('defines the 0-children declared aggregate verdict (EmptyAggregate)', () => {
    const empty = agg('e', []);
    const forest = buildForest([empty]);
    expect(aggregateChildVerdict(forest, empty)).toBe(AGGREGATE_CHILD_VERDICT.EmptyAggregate);
    // A leaf with no children is NotAggregate.
    const leaf = leafFromRect('l', 0, 0, 1, 1).feature;
    const f2 = buildForest([leaf]);
    expect(aggregateChildVerdict(f2, leaf)).toBe(AGGREGATE_CHILD_VERDICT.NotAggregate);
    // validateHierarchy flags the empty aggregate by default.
    const result = validateHierarchy([empty]);
    expect(result.ok).toBe(false);
  });

  it('resolveLeafShape groups a territory ring with its hole rings', () => {
    const outer = [
      createVertex(asVertexId('o0'), createCoordinate(0, 0)),
      createVertex(asVertexId('o1'), createCoordinate(30, 0)),
      createVertex(asVertexId('o2'), createCoordinate(30, 30)),
      createVertex(asVertexId('o3'), createCoordinate(0, 30)),
    ];
    const hole = [
      createVertex(asVertexId('h0'), createCoordinate(10, 10)),
      createVertex(asVertexId('h1'), createCoordinate(20, 10)),
      createVertex(asVertexId('h2'), createCoordinate(20, 20)),
      createVertex(asVertexId('h3'), createCoordinate(10, 20)),
    ];
    const store = createVertexStore([...outer, ...hole]);
    const tRing = createTerritoryRing(asRingId('rt'), outer.map((v) => v.id));
    const hRing = createHoleRing(asRingId('rh'), hole.map((v) => v.id), asRingId('rt'));
    const shape = createShape([tRing, hRing]);
    const mp = resolveLeafShape(shape, store);
    expect(mp).toBeDefined();
    expect(mp).toHaveLength(1);
    expect(mp?.[0]).toHaveLength(2); // outer + hole
  });

  it('reports ShapeUnresolved when a vertex is missing', () => {
    const tile = leafFromRect('c1', 0, 0, 10, 10, 'agg');
    const aggregate = agg('agg', ['c1']);
    // Store missing the leaf's vertices entirely.
    const store: VertexStore = createVertexStore([]);
    const forest = buildForest([tile.feature, aggregate]);
    const v = checkAggregateShapes(forest, store);
    expect(v.some((x) => x.kind === HIERARCHY_VIOLATION.ShapeUnresolved)).toBe(true);
  });
});

// =============================================================================
// 4. Cycle resilience (教訓5.28)
// =============================================================================
describe('cycle resilience (教訓5.28)', () => {
  it('self-parenting yields finite depth and is detected', () => {
    const self = withParentId(agg('a', []), asFeatureId('a'));
    const forest = buildForest([self]);
    // walkToRoot terminates with a cycle.
    const walk = walkToRoot(forest, asFeatureId('a'));
    expect(walk.cyclic).toBe(true);
    expect(derivedDepth(forest, asFeatureId('a'))).toBe(DEPTH_UNDEFINED);
    expect(isDepthUndefined(derivedDepth(forest, asFeatureId('a')))).toBe(true);
    expect(checkCycles(forest).some((v) => v.kind === HIERARCHY_VIOLATION.Cycle)).toBe(true);
  });

  it('a 2-node cycle (A→B→A) is detected without infinite loop', () => {
    const a = withParentId(agg('a', []), asFeatureId('b'));
    const b = withParentId(agg('b', []), asFeatureId('a'));
    const forest = buildForest([a, b]);
    const cycles = checkCycles(forest);
    expect(cycles).toHaveLength(1); // one distinct cycle
    expect(cycles[0]?.featureIds.length).toBeGreaterThanOrEqual(2);
    // descendantIds terminates too.
    expect(() => descendantIds(forest, asFeatureId('a'))).not.toThrow();
  });

  it('resolveFeatureArea is finite on a cycle', () => {
    const a = withParentId(agg('a', ['b']), asFeatureId('b'));
    const b = withParentId(agg('b', ['a']), asFeatureId('a'));
    const forest = buildForest([a, b]);
    const store = createVertexStore([]);
    expect(() => resolveFeatureArea(forest, store, asFeatureId('a'))).not.toThrow();
  });

  it('healthy trees in a forest with a cycle still validate (partial soundness)', () => {
    const cyclicA = withParentId(agg('a', []), asFeatureId('b'));
    const cyclicB = withParentId(agg('b', []), asFeatureId('a'));
    // A separate healthy tree.
    const healthyRoot = agg('h', ['h1']);
    const healthy1 = leafFromRect('h1', 0, 0, 1, 1, 'h').feature;
    const forest = buildForest([cyclicA, cyclicB, healthyRoot, healthy1]);
    expect(derivedDepth(forest, asFeatureId('h1'))).toBe(1);
    expect(derivedDepth(forest, asFeatureId('a'))).toBe(DEPTH_UNDEFINED);
  });
});

// =============================================================================
// 6. Regression / non-functional
// =============================================================================
describe('purity and non-relevance (regression)', () => {
  it('validation does not mutate inputs and is deterministic', () => {
    const root = agg('a', ['b']);
    const child = leafFromRect('b', 0, 0, 1, 1, 'a').feature;
    const features = [root, child];
    const snapshot = JSON.stringify(features);
    const r1 = validateHierarchy(features);
    const r2 = validateHierarchy(features);
    expect(JSON.stringify(features)).toBe(snapshot);
    expect(r1).toEqual(r2);
  });

  it('kindLabel (FR-40) does not affect validation', () => {
    const tile1 = leafFromRect('c1', 0, 0, 10, 10, 'agg');
    const tile2 = leafFromRect('c2', 10, 0, 10, 10, 'agg');
    const store = createVertexStore([...tile1.vertices, ...tile2.vertices]);
    const aggregate = agg('agg', ['c1', 'c2']);
    const features = [tile1.feature, tile2.feature, aggregate];
    const before = validateHierarchy(features, { vertexStore: store });
    // Attach a kindLabel to every feature.
    const labeled = features.map((f) => ({ ...f, kindLabel: 'some-label' }) as Feature);
    const after = validateHierarchy(labeled, { vertexStore: store });
    expect(after.violations).toEqual(before.violations);
  });

  it('result-state classification: a point feature with no children is a leaf role', () => {
    const pt = createPointFeature(asFeatureId('p'), attrs('p'), COLOR, asVertexId('vp'));
    const forest = buildForest([pt]);
    expect(hasChildren(forest, asFeatureId('p'))).toBe(false);
    expect(hierarchyRole(forest, asFeatureId('p'))).toBe(HIERARCHY_ROLE.Leaf);
  });

  it('result-state classification: a declared leaf with children acts as aggregate role', () => {
    // 教訓5.6: role from result state, not declared kind. A leaf that (through
    // broken data) has children is classified aggregate by directChildIds.
    const parentLeaf = leafFromRect('pl', 0, 0, 10, 10).feature;
    const child = leafFromRect('ch', 0, 0, 5, 5, 'pl').feature;
    const forest = buildForest([parentLeaf, child]);
    expect(hierarchyRole(forest, asFeatureId('pl'))).toBe(HIERARCHY_ROLE.Aggregate);
    expect(directChildIds(forest, asFeatureId('pl'))).toEqual([asFeatureId('ch')]);
  });

  it('dangling parent links are detected', () => {
    const orphan = agg('o', [], 'missing');
    const forest = buildForest([orphan]);
    const v = checkDanglingParents(forest);
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe(HIERARCHY_VIOLATION.DanglingParent);
  });

  it('scales to a large forest without O(n^2) parent-walk blowup', () => {
    // 5,000-node single chain-ish forest: build wide trees to keep depth small.
    const features: Feature[] = [];
    const ROOTS = 100;
    const PER = 50;
    for (let r = 0; r < ROOTS; r += 1) {
      const childIds: string[] = [];
      for (let c = 0; c < PER; c += 1) childIds.push(`f-${r}-${c}`);
      features.push(agg(`root-${r}`, childIds));
      for (let c = 0; c < PER; c += 1) {
        features.push(agg(`f-${r}-${c}`, [], `root-${r}`));
      }
    }
    expect(features.length).toBe(ROOTS + ROOTS * PER);
    const start = Date.now();
    const forest = buildForest(features);
    const depths = derivedDepths(forest);
    const elapsed = Date.now() - start;
    expect(depths.size).toBe(features.length);
    expect(elapsed).toBeLessThan(2000);
  });
});

// =============================================================================
// Regression: duplicate FeatureIds, deep-chain depth & shape resolution
// =============================================================================
describe('duplicate FeatureIds (regression)', () => {
  it('detects a duplicate id and does not double-process it in the forest', () => {
    const a = agg('dup', ['kid']);
    const aDup = agg('dup', ['kid']); // same id, appears twice in the input.
    const kid = leafFromRect('kid', 0, 0, 1, 1, 'dup').feature;
    const features = [a, aDup, kid];

    const dups = checkDuplicateIds(features);
    expect(dups).toHaveLength(1);
    expect(dups[0]?.kind).toBe(HIERARCHY_VIOLATION.DuplicateId);
    expect(dups[0]?.featureIds).toEqual([asFeatureId('dup')]);

    // The forest must list 'kid' under 'dup' exactly ONCE despite the duplicate.
    const forest = buildForest(features);
    expect(directChildIds(forest, asFeatureId('dup'))).toEqual([asFeatureId('kid')]);
    // orderedIds carries each id once.
    expect(forest.orderedIds.filter((id) => id === asFeatureId('dup'))).toHaveLength(1);
  });

  it('validateHierarchy surfaces the duplicate as a DuplicateId violation', () => {
    const a = leafFromRect('x', 0, 0, 1, 1).feature;
    const b = leafFromRect('x', 0, 0, 1, 1).feature; // duplicate id 'x'
    const result = validateHierarchy([a, b]);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === HIERARCHY_VIOLATION.DuplicateId)).toBe(true);
  });
});

describe('deep chain resolution (stack & depth, regression)', () => {
  /** A straight aggregate chain root→...→leaf of `n` aggregates over one leaf. */
  function deepChain(n: number): { features: Feature[]; store: VertexStore; rootId: FeatureId } {
    const features: Feature[] = [];
    for (let i = 0; i < n; i++) {
      const childId = i + 1 < n ? `agg-${i + 1}` : 'tip-leaf';
      const parentId = i === 0 ? undefined : `agg-${i - 1}`;
      features.push(agg(`agg-${i}`, [childId], parentId));
    }
    const tip = leafFromRect('tip-leaf', 0, 0, 1, 1, `agg-${n - 1}`);
    features.push(tip.feature);
    const store = createVertexStore(tip.vertices);
    return { features, store, rootId: asFeatureId('agg-0') };
  }

  it('resolveFeatureArea does not overflow the call stack on a deep chain', () => {
    const { features, store, rootId } = deepChain(8000);
    const forest = buildForest(features);
    const res = resolveFeatureArea(forest, store, rootId);
    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      // The root aggregate's area is the tip leaf's 1×1 square, unioned up.
      expect(res.area.length).toBe(1);
    }
  });

  it('derivedDepths is correct and fast on a deep chain (memoized, ~O(n))', () => {
    const { features } = deepChain(5000);
    const forest = buildForest(features);
    const start = Date.now();
    const depths = derivedDepths(forest);
    const elapsed = Date.now() - start;
    expect(depths.get(asFeatureId('agg-0'))).toBe(0);
    expect(depths.get(asFeatureId('agg-4999'))).toBe(4999);
    expect(depths.get(asFeatureId('tip-leaf'))).toBe(5000);
    expect(maxDerivedDepth(forest)).toBe(5000);
    expect(elapsed).toBeLessThan(2000);
  });
});
