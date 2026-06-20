// BUG HUNT regression — a parent leaf must NOT lose its own footprint when it
// gains a child (U08 resolveFeatureArea / U34 display pipeline).
//
// Repro (discovered via e2e r1): commit a face as a leaf (its own square), then
// commit a SECOND, spatially DISJOINT face whose parentId points at the first.
// The first face is now a DECLARED LEAF (kind === 'leaf', owns a shape) that has
// a child — the「末端→集約」transition state the add flow leaves behind (FR-35
// 末端→集約 is owned by another unit and need not have run). The old
// resolveFeatureArea treated ANY feature-with-children as a pure aggregate and
// unioned ONLY the children, silently dropping the parent's own square: at the
// default display depth N=0 the parent rounded to its child's shape, so the
// parent's orange footprint vanished from the map and only the child remained.
//
// The fix: a declared leaf that has children contributes its OWN shape to the
// derived area too, so the parent's territory survives. A PURE aggregate
// (createAggregateFeature, no shape field — FR-35) is unaffected: it still
// resolves to exactly the union of its children.
//
// These tests pin both: the leaf-with-children keeps its footprint (and the N=0
// display pipeline draws the parent's area, not just the child), AND a pure
// aggregate's area is still exactly the union of children (no regression).

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  FEATURE_KIND,
  type Feature,
} from '../feature';
import { difference, isOk, union } from '../geometry/boolean-ops';
import { isMultiPolygonEmpty, type GeoMultiPolygon } from '../geometry/types';
import { asFeatureId, asRingId, asVertexId } from '../ids';
import { createShape, createTerritoryRing } from '../ring';
import { buildForest } from '../hierarchy/forest';
import { resolveFeatureArea } from '../hierarchy/resolve-shape';
import { createVertex, createVertexStore, type VertexStore } from '../vertex';

import { DISPLAY_VERDICT, buildDisplayDecisions } from '../display/depth-focus';
import { resolveDisplayShapes } from '../display/resolve-display-shapes';

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090');
const attrs = (name: string) => createBasicAttributes(name, 0, 1);

// Two spatially DISJOINT unit squares: parent at [0,1]², child far away at [10,11]².
const VERTICES = [
  createVertex(asVertexId('p0'), createCoordinate(0, 0)),
  createVertex(asVertexId('p1'), createCoordinate(1, 0)),
  createVertex(asVertexId('p2'), createCoordinate(1, 1)),
  createVertex(asVertexId('p3'), createCoordinate(0, 1)),
  createVertex(asVertexId('c0'), createCoordinate(10, 10)),
  createVertex(asVertexId('c1'), createCoordinate(11, 10)),
  createVertex(asVertexId('c2'), createCoordinate(11, 11)),
  createVertex(asVertexId('c3'), createCoordinate(10, 11)),
];

function store(): VertexStore {
  return createVertexStore(VERTICES);
}

function squareLeaf(id: string, vids: readonly string[], parentId?: string): Feature {
  const ring = createTerritoryRing(asRingId(`r-${id}`), vids.map(asVertexId));
  const shape = createShape([ring]);
  return parentId === undefined
    ? createLeafFeature(asFeatureId(id), attrs(id), COLOR, shape)
    : createLeafFeature(asFeatureId(id), attrs(id), COLOR, shape, {
        parentId: asFeatureId(parentId),
      });
}

/** parent = declared LEAF with its own square + a disjoint child leaf. */
function leafWithChildForest() {
  return buildForest([
    squareLeaf('parent', ['p0', 'p1', 'p2', 'p3']), // declared leaf, OWNS a shape
    squareLeaf('child', ['c0', 'c1', 'c2', 'c3'], 'parent'),
  ]);
}

/** Whether `area` covers the point (px, py) (point-in-polygon via a tiny probe diff). */
function areaContains(area: GeoMultiPolygon, px: number, py: number): boolean {
  // Probe square fully inside a unit cell around the point.
  const probe: GeoMultiPolygon = [
    [
      [
        createCoordinate(px - 0.1, py - 0.1),
        createCoordinate(px + 0.1, py - 0.1),
        createCoordinate(px + 0.1, py + 0.1),
        createCoordinate(px - 0.1, py + 0.1),
      ],
    ],
  ];
  // probe is covered iff probe \ area is empty.
  const diff = difference(probe, area);
  return isOk(diff) && isMultiPolygonEmpty(diff.result);
}

describe('U08 — a parent leaf keeps its own footprint after gaining a child', () => {
  it('resolveFeatureArea(parent) includes BOTH the parent square AND the child square', () => {
    const forest = leafWithChildForest();
    const vs = store();
    const parent = forest.byId.get(asFeatureId('parent'));
    // The parent is genuinely a DECLARED leaf (still carries its shape) that has a child.
    expect(parent?.kind).toBe(FEATURE_KIND.Leaf);

    const res = resolveFeatureArea(forest, vs, asFeatureId('parent'));
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;

    // Two disjoint pieces: the parent's own square AND the child's square (教訓5.1).
    expect(res.area.length).toBe(2);
    // The parent's own footprint at (0.5, 0.5) is NOT dropped (the bug: it vanished).
    expect(areaContains(res.area, 0.5, 0.5)).toBe(true);
    // The child's footprint at (10.5, 10.5) is present too.
    expect(areaContains(res.area, 10.5, 10.5)).toBe(true);

    // It equals union(parent own square, child square) exactly.
    const own = resolveFeatureArea(forest, vs, asFeatureId('child'));
    const parentSquare: GeoMultiPolygon = [
      [
        [
          createCoordinate(0, 0),
          createCoordinate(1, 0),
          createCoordinate(1, 1),
          createCoordinate(0, 1),
        ],
      ],
    ];
    if (own.status !== 'ok') throw new Error('child must resolve');
    const expected = union(parentSquare, own.area);
    expect(isOk(expected)).toBe(true);
    if (!isOk(expected)) return;
    const aMinusB = difference(res.area, expected.result);
    const bMinusA = difference(expected.result, res.area);
    expect(isOk(aMinusB) && isMultiPolygonEmpty(aMinusB.result)).toBe(true);
    expect(isOk(bMinusA) && isMultiPolygonEmpty(bMinusA.result)).toBe(true);
  });

  it('at default display depth N=0 the parent draws its OWN footprint, not just the child', () => {
    const forest = leafWithChildForest();
    const vs = store();
    // N=0: the whole forest rounds to the root (the parent) as an aggregate shape.
    const decisions = buildDisplayDecisions({ forest, globalThreshold: 0 });
    expect(decisions.get(asFeatureId('parent'))?.verdict).toBe(DISPLAY_VERDICT.Aggregate);

    const resolved = resolveDisplayShapes(forest, vs, decisions);
    const parentShape = resolved.shapes.find((s) => s.featureId === asFeatureId('parent'));
    expect(parentShape).toBeDefined();
    // The drawn aggregate shape contains the parent's own square — it did NOT vanish.
    expect(areaContains(parentShape!.shape, 0.5, 0.5)).toBe(true);
    expect(areaContains(parentShape!.shape, 10.5, 10.5)).toBe(true);
    // Two pieces drawn (parent + child), never collapsed to the child alone.
    expect(parentShape!.shape.length).toBe(2);
  });

  it('REGRESSION GUARD: a PURE aggregate (no own shape, FR-35) still equals union of children only', () => {
    const vs = store();
    // root is a pure aggregate (createAggregateFeature: no shape field).
    const forest = buildForest([
      createAggregateFeature(asFeatureId('root'), attrs('root'), COLOR, [
        asFeatureId('a'),
        asFeatureId('b'),
      ]),
      squareLeaf('a', ['p0', 'p1', 'p2', 'p3'], 'root'),
      squareLeaf('b', ['c0', 'c1', 'c2', 'c3'], 'root'),
    ]);
    const res = resolveFeatureArea(forest, vs, asFeatureId('root'));
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    // Exactly the union of the two child squares — no extra/own area introduced.
    const a = resolveFeatureArea(forest, vs, asFeatureId('a'));
    const b = resolveFeatureArea(forest, vs, asFeatureId('b'));
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('children must resolve');
    const expected = union(a.area, b.area);
    if (!isOk(expected)) throw new Error('union must be ok');
    const aMinusB = difference(res.area, expected.result);
    const bMinusA = difference(expected.result, res.area);
    expect(isOk(aMinusB) && isMultiPolygonEmpty(aMinusB.result)).toBe(true);
    expect(isOk(bMinusA) && isMultiPolygonEmpty(bMinusA.result)).toBe(true);
  });
});
