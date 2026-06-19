// Domain (U08): shared fast-check generators for forest invariant property tests
// (R7 / 受け入れ基準5). Defined ONCE and derived FROM the invariants so a "valid
// forest" is valid by construction (top-level⇔no-parent, child depth = parent+1,
// aggregate shape = union of children) and the破った森 mutators are the only
// source of violations. Built through the REAL factories (教訓5.39), never bare
// literals. Imports fast-check (devDependency); consumed only by *.test.ts.

import fc from 'fast-check';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  type Feature,
} from '../feature';
import { asFeatureId, asRingId, asVertexId } from '../ids';
import { createShape, createTerritoryRing } from '../ring';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../vertex';

/** A valid forest sample: features + the vertex store their shapes resolve in. */
export interface ForestSample {
  readonly features: readonly Feature[];
  readonly store: VertexStore;
}

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090');

/**
 * Build an axis-aligned square LEAF whose territory ring is 4 fresh vertices.
 * Each vertex id is unique to this leaf, so shapes never accidentally share
 * geometry. Returns the feature and the vertices to register in the store.
 */
function makeLeafTile(
  idSuffix: string,
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
  const vertices = corners.map((coord, i) =>
    createVertex(asVertexId(`v-${idSuffix}-${i}`), coord),
  );
  const ring = createTerritoryRing(
    asRingId(`r-${idSuffix}`),
    vertices.map((v) => v.id),
  );
  const fid = asFeatureId(`f-${idSuffix}`);
  const attrs = createBasicAttributes(`leaf-${idSuffix}`, 0, 1);
  const feature =
    parentId === undefined
      ? createLeafFeature(fid, attrs, COLOR, createShape([ring]))
      : createLeafFeature(fid, attrs, COLOR, createShape([ring]), { parentId: asFeatureId(parentId) });
  return { feature, vertices };
}

/**
 * Generate a VALID forest: a set of root aggregates, each tiling a horizontal
 * strip with N adjacent (gapless, non-overlapping) leaf tiles so the aggregate's
 * shape equals the union of its children with no gap and no overflow. Multiple
 * roots exercise the multi-root forest (FR-34); per-root child counts vary so
 * tree max-depths differ (FR-38). Depth here is 0 (root agg) / 1 (leaf children),
 * which is sufficient for the topology invariants; deeper nesting is covered by
 * the explicit unit tests.
 */
export function validForestArb(): fc.Arbitrary<ForestSample> {
  return fc
    .array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 4 })
    .map((childCounts) => buildStripForest(childCounts));
}

function buildStripForest(childCounts: readonly number[]): ForestSample {
  const features: Feature[] = [];
  const vertices: Vertex[] = [];
  childCounts.forEach((count, rootIdx) => {
    const aggId = `agg-${rootIdx}`;
    const childIds: string[] = [];
    const baseY = rootIdx * 100; // separate roots vertically (disjoint).
    for (let c = 0; c < count; c += 1) {
      const tile = makeLeafTile(`${rootIdx}-${c}`, c * 10, baseY, 10, 10, aggId);
      features.push(tile.feature);
      vertices.push(...tile.vertices);
      childIds.push(`f-${rootIdx}-${c}`);
    }
    const agg = createAggregateFeature(
      asFeatureId(aggId),
      createBasicAttributes(`agg-${rootIdx}`, 0, 1),
      COLOR,
      childIds.map(asFeatureId),
    );
    features.push(agg);
  });
  return { features, store: createVertexStore(vertices) };
}

/**
 * Mutator (受け入れ基準5 反証): introduce a genuine INTERIOR GAP by appending a
 * NEW root aggregate whose four children frame an empty interior square. An
 * aggregate stores no shape (FR-35), so a "gap" is not a stored-shape mismatch —
 * it is the children enclosing a region none of them covers. Four tiles laid as a
 * frame (bottom / top / left / right) leave a hole in the middle; their U06 union
 * is a single piece WITH a hole ring, which {@link checkAggregateShapes} reports
 * as an AggregateShapeMismatch. This is the inverse of the gapless strip
 * {@link validForestArb} builds, so a valid forest passes and the mutated one
 * must fail — exactly the no-false-negative guarantee.
 *
 * The new aggregate's ids are namespaced (`gap-*`) so they never collide with the
 * base sample's `agg-*` / `f-*` ids. The base features and store are preserved
 * and merged with the frame's; the result is a strictly larger forest that
 * differs from the input by exactly one holed aggregate.
 */
export function withGap(sample: ForestSample): ForestSample {
  const aggId = 'gap-agg';
  // Outer extent [0,30]x[0,30]; interior hole [10,20]x[10,20]. The base sample's
  // roots live at y = rootIdx*100 with width <= 40 deg, so this frame at a far
  // offset cannot touch them.
  const baseY = 10_000;
  const frame: { feature: Feature; vertices: Vertex[] }[] = [
    makeLeafTile('gap-b', 0, baseY + 0, 30, 10, aggId), // bottom strip
    makeLeafTile('gap-t', 0, baseY + 20, 30, 10, aggId), // top strip
    makeLeafTile('gap-l', 0, baseY + 10, 10, 10, aggId), // left strip
    makeLeafTile('gap-r', 20, baseY + 10, 10, 10, aggId), // right strip
  ];
  const childIds = ['f-gap-b', 'f-gap-t', 'f-gap-l', 'f-gap-r'];
  const gapAgg = createAggregateFeature(
    asFeatureId(aggId),
    createBasicAttributes(aggId, 0, 1),
    COLOR,
    childIds.map(asFeatureId),
  );

  const features: Feature[] = [...sample.features];
  const vertices: Vertex[] = [];
  for (const v of sample.store.byId.values()) vertices.push(v);
  for (const tile of frame) {
    features.push(tile.feature);
    vertices.push(...tile.vertices);
  }
  features.push(gapAgg);
  return { features, store: createVertexStore(vertices) };
}

/** The id of the aggregate {@link withGap} makes holed — for targeted assertions. */
export const GAP_AGGREGATE_ID = asFeatureId('gap-agg');
