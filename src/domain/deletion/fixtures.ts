// U31 deletion — shared test fixtures (教訓 5.39: build via real factories, not
// hand-written literals). Consumed only by *.test.ts files.

import { createAnchor, createAnchorSnapshot, type Anchor } from '../anchor';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  type Feature,
} from '../feature';
import { asAnchorId, asFeatureId, asRingId, asVertexId, type FeatureId } from '../ids';
import { createShape, createTerritoryRing } from '../ring';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../vertex';

import { createDeletionState, type DeletionState } from './state';

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090');

export function fid(raw: string): FeatureId {
  return asFeatureId(raw);
}

/** A square leaf tile [x,x+w]x[y,y+h] with 4 fresh vertices, optional parent. */
export function leafTile(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  parentId?: string,
): { feature: Feature; vertices: Vertex[] } {
  const corners = [
    createCoordinate(x, y),
    createCoordinate(x + w, y),
    createCoordinate(x + w, y + h),
    createCoordinate(x, y + h),
  ];
  const vertices = corners.map((c, i) => createVertex(asVertexId(`v-${id}-${i}`), c));
  const ring = createTerritoryRing(asRingId(`r-${id}`), vertices.map((v) => v.id));
  const attrs = createBasicAttributes(`leaf-${id}`, 0, 1);
  const feature =
    parentId === undefined
      ? createLeafFeature(asFeatureId(id), attrs, COLOR, createShape([ring]))
      : createLeafFeature(asFeatureId(id), attrs, COLOR, createShape([ring]), {
          parentId: asFeatureId(parentId),
        });
  return { feature, vertices };
}

/** An aggregate over the given child ids, optional parent. */
export function aggregate(
  id: string,
  childIds: readonly string[],
  parentId?: string,
): Feature {
  const attrs = createBasicAttributes(`agg-${id}`, 0, 1);
  return parentId === undefined
    ? createAggregateFeature(asFeatureId(id), attrs, COLOR, childIds.map(asFeatureId))
    : createAggregateFeature(asFeatureId(id), attrs, COLOR, childIds.map(asFeatureId), {
        parentId: asFeatureId(parentId),
      });
}

/** Build a single anchor from features + the vertices its leaves reference. */
export function anchorOf(
  anchorId: string,
  features: readonly Feature[],
  vertices: readonly Vertex[],
): Anchor {
  const store: VertexStore = createVertexStore(vertices);
  return createAnchor(asAnchorId(anchorId), createAnchorSnapshot(features, store));
}

/** A deletion state from a list of anchors. */
export function stateOf(...anchors: readonly Anchor[]): DeletionState {
  return createDeletionState(anchors);
}

/**
 * A simple 2-strip forest: aggregate `agg` over two adjacent gapless leaves
 * `a` (left) and `b` (right), so the aggregate's shape = union of children with no
 * gap. Returns the features + vertices for one anchor.
 */
export function aggregateOfTwoLeaves(): { features: Feature[]; vertices: Vertex[] } {
  const a = leafTile('a', 0, 0, 10, 10, 'agg');
  const b = leafTile('b', 10, 0, 10, 10, 'agg');
  const agg = aggregate('agg', ['a', 'b']);
  return { features: [agg, a.feature, b.feature], vertices: [...a.vertices, ...b.vertices] };
}

/**
 * A 3x3 tiling forest whose aggregate `agg` owns all NINE 10x10 leaves of a 30x30
 * square (a ring of 8 border tiles around one CENTER tile `center`). The children
 * currently tile the whole square with no gap (valid). Deleting the center tile
 * leaves the 8 border tiles enclosing an empty 10x10 hole — a genuine INTER-CHILD
 * gap that {@link checkAggregateShapes} flags as AggregateShapeMismatch, so the
 * post-deletion state cannot pass U08's invariants (再編不能). This is the fixture
 * for the ReorganizationImpossible rejection path (受け入れ基準 1, 拒否経路).
 *
 * Returns the features, vertices, the aggregate id and the center tile id so the
 * test can delete the center and assert the structured rejection.
 */
export function aggregateRingWithCenter(): {
  features: Feature[];
  vertices: Vertex[];
  aggId: FeatureId;
  centerId: FeatureId;
} {
  const tiles: { feature: Feature; vertices: Vertex[] }[] = [];
  const childIds: string[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const id = row === 1 && col === 1 ? 'center' : `t-${col}-${row}`;
      childIds.push(id);
      tiles.push(leafTile(id, col * 10, row * 10, 10, 10, 'agg'));
    }
  }
  const agg = aggregate('agg', childIds);
  const features: Feature[] = [agg, ...tiles.map((t) => t.feature)];
  const vertices: Vertex[] = tiles.flatMap((t) => t.vertices);
  return { features, vertices, aggId: asFeatureId('agg'), centerId: asFeatureId('center') };
}
